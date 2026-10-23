import express from 'express';
import httpProxy from 'http-proxy';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, access, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createInviteStore, validName } from './invites.js';
import { startReconciler } from '../reconciler/loop.mjs';

const exec = promisify(execFile);
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const WEEK = 604800;
const KEYS = new Set(['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'BTab']);
const DEFAULT_AGENT = '/usr/local/bin/run-agent codex';

export function validateEnv(env = process.env) {
  for (const key of ['PORT', 'PUBLIC_URL', 'GITHUB_REPO', 'SESSION_SECRET', 'APP_URL', 'IS_SANDBOX']) {
    if (!env[key]?.trim()) throw new Error(`Missing required environment variable: ${key}`);
  }
  if (!/^\d+$/.test(env.PORT) || +env.PORT < 1 || +env.PORT > 65535) throw new Error('PORT must be 1–65535');
  for (const key of ['PUBLIC_URL', 'APP_URL']) {
    let url;
    try { url = new URL(env[key]); } catch { throw new Error(`${key} must be an HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (key === 'PUBLIC_URL' && url.origin !== env[key])) {
      throw new Error(`${key} must be HTTPS; PUBLIC_URL must be an origin with no trailing slash`);
    }
  }
  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]+$/i.test(env.GITHUB_REPO)) throw new Error('GITHUB_REPO must be owner/repo');
  if (Buffer.byteLength(env.SESSION_SECRET) < 32) throw new Error('SESSION_SECRET must contain at least 32 random bytes');
  if (env.IS_SANDBOX !== '1') throw new Error('IS_SANDBOX must be 1');
  if (env.AGENT_CMD !== undefined && !env.AGENT_CMD.trim()) throw new Error('AGENT_CMD must not be empty');
  return { ...env, PORT: +env.PORT, AGENT_CMD: env.AGENT_CMD || DEFAULT_AGENT, members: createInviteStore(env.INVITES_FILE) };
}

export function sign(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verify(value, secret) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const [payload, mac, extra] = value.split('.');
    if (!payload || !mac || extra !== undefined || !/^[\w-]+$/.test(payload)) return null;
    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    if (!equal(mac, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function cookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) result[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return result;
}

export async function session(req, config) {
  const data = verify(cookies(req).butler_session, config.SESSION_SECRET);
  if (!data || !validName(data.name) || typeof data.login !== 'string') return null;
  const member = await config.members.get(data.name);
  if (!member || member.login !== data.login || member.version !== data.version) return null;
  return { name: data.name, login: data.login };
}

function setCookie(res, name, value, maxAge) {
  res.append('Set-Cookie', `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function command(file, args) {
  return exec(file, args, { timeout: 90000, maxBuffer: 1024 * 1024 });
}

export function createUserManager(config) {
  const pending = new Map();
  const terminals = new Map();
  let repoQueue = Promise.resolve();
  let stopping = false;
  function withRepoLock(fn) {
    const job = repoQueue.then(fn);
    repoQueue = job.catch(() => {});
    return job;
  }

  async function startTerminal(name) {
    const current = terminals.get(name);
    if (current) return current.ready;
    const socketPath = `/run/ttyd/${name}.sock`;
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const child = spawn('ttyd', ['-W', '-i', socketPath, '-b', '/term', '-t', 'fontSize=15',
      '-t', 'disableLeaveAlert=true', '-t', `titleFixed=${name}`, 'tmux', 'attach', '-t', `=${name}`],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    const entry = { child, ready: null };
    terminals.set(name, entry);
    let failure;
    child.stderr.on('data', chunk => process.stderr.write(`[ttyd:${name}] ${chunk}`));
    child.once('error', error => { failure = error; });
    child.once('close', () => {
      if (terminals.get(name) === entry) terminals.delete(name);
      if (!stopping) {
        const timer = setTimeout(() => startTerminal(name).catch(error => {
          console.error(`Could not restart ttyd for ${name}: ${error.message}`);
        }), 1000);
        timer.unref();
      }
    });
    entry.ready = (async () => {
      for (let i = 0; i < 100; i++) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`ttyd exited for ${name}`);
        if (await exists(socketPath)) return socketPath;
        await delay(50);
      }
      child.kill();
      throw new Error(`Timed out waiting for terminal socket for ${name}`);
    })();
    return entry.ready;
  }

  async function provision(name, login) {
    // Callers derive both fields from a verified cookie; reject mismatches here too.
    if (!validName(name) || (await config.members.get(name))?.login !== login) throw new Error('Unknown team member');
    const home = `/data/home/${name}`;
    const cwd = `/data/wt/${name}`;
    // Codex requires an explicitly configured CODEX_HOME to exist before it
    // loads configuration, including before `codex login` runs.
    await Promise.all([home, `${home}/.codex`, `${home}/.config`, `${home}/.cache`, `${home}/.local/share`]
      .map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
    await withRepoLock(async () => {
      if (!await exists(cwd)) {
        await command('git', ['-C', '/data/repo', 'fetch', 'origin']);
        await command('git', ['-C', '/data/repo', 'worktree', 'add', '--detach', cwd, 'origin/main']);
      }
    });
    try { await command('tmux', ['has-session', '-t', `=${name}`]); }
    catch (error) {
      if (error.code === 'ENOENT') throw error;
      const env = { HOME: home, BUTLER_USER: name, NO_BROWSER: 'true', BROWSER: 'false', IS_SANDBOX: '1',
        XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share`,
        CODEX_HOME: `${home}/.codex`, GIT_AUTHOR_NAME: login, GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
        GIT_COMMITTER_NAME: login, GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com` };
      const args = ['new-session', '-d', '-s', name, '-c', cwd];
      for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
      // Only trusted deployment configuration is shell code. Request text is always sent via stdin.
      args.push('bash', '-lc', `${config.AGENT_CMD}; exec bash -l`);
      await command('tmux', args);
      await writeFile(`${home}/.butler-session`, 'active\n', { mode: 0o600 });
    }
    return startTerminal(name);
  }

  return {
    async restore() {
      let count = 0;
      for (const member of await config.members.list()) {
        if (await exists(`/data/home/${member.name}/.butler-session`)) {
          try { await this.ensureUser(member.name, member.login); count++; }
          catch (error) { console.error(`Could not restore ${member.name}: ${error.code || error.name}`); }
        }
      }
      console.log(`Restored ${count} team agent sessions from persistent storage`);
    },
    ensureUser(name, login) {
      if (stopping) return Promise.reject(new Error('Agent host is shutting down'));
      if (!pending.has(name)) {
        const job = provision(name, login).finally(() => pending.delete(name));
        pending.set(name, job);
      }
      return pending.get(name);
    },
    stop() {
      stopping = true;
      for (const { child } of terminals.values()) child.kill();
    }
  };
}

function loadBuffer(text) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', ['load-buffer', '-b', 'butler', '-'], { timeout: 10000 }, error => error ? reject(error) : resolve());
    child.stdin.on('error', reject);
    child.stdin.end(text, 'utf8');
  });
}

export function createGateway(config, { users = createUserManager(config) } = {}) {
  const app = express();
  const proxy = httpProxy.createProxyServer({ ws: true });
  const server = createServer(app);
  let inputQueue = Promise.resolve();
  const queueInput = fn => {
    const job = inputQueue.then(fn);
    inputQueue = job.catch(() => {});
    return job;
  };
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.headers.origin !== config.PUBLIC_URL) return res.status(403).send('Invalid Origin');
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
  app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(publicDir, 'manifest.webmanifest')));
  for (const icon of ['icon-192.png', 'icon-512.png']) {
    app.get(`/${icon}`, (req, res) => res.sendFile(path.join(publicDir, icon)));
  }
  app.post('/auth/invite', async (req, res) => {
    const member = await config.members.findToken(req.body?.token);
    if (!member) {
      await delay(150);
      return res.status(403).json({ error: 'Invalid invite. Ask the team lead for your private link.' });
    }
    setCookie(res, 'butler_session', sign({ login: member.login, name: member.name, version: member.version,
      exp: Math.floor(Date.now() / 1000) + WEEK }, config.SESSION_SECRET), WEEK);
    res.json({ ok: true });
  });
  app.post('/logout', (req, res) => {
    setCookie(res, 'butler_session', '', 0);
    res.redirect('/login');
  });
  app.use(async (req, res, next) => {
    req.user = await session(req, config);
    if (req.user) return next();
    if (req.path.startsWith('/api/') || req.path === '/term' || req.path.startsWith('/term/')) {
      return res.status(401).send('Open your private team invite first');
    }
    return res.redirect('/login');
  });
  app.get('/', async (req, res) => {
    await users.ensureUser(req.user.name, req.user.login);
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/api/me', (req, res) => res.json({ ...req.user, appUrl: config.APP_URL, repo: config.GITHUB_REPO }));
  app.post('/api/send', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 20000 || text.includes('\0')) {
      return res.status(400).json({ error: 'Send between 1 and 20,000 characters, without NUL bytes.' });
    }
    await users.ensureUser(req.user.name, req.user.login);
    await queueInput(async () => {
      await loadBuffer(text);
      await command('tmux', ['paste-buffer', '-b', 'butler', '-t', `=${req.user.name}:`, '-d', '-p']);
      await delay(150);
      await command('tmux', ['send-keys', '-t', `=${req.user.name}:`, 'Enter']);
    });
    res.json({ ok: true });
  });
  app.post('/api/key', async (req, res) => {
    if (!KEYS.has(req.body?.key)) return res.status(400).json({ error: 'Unsupported key' });
    await users.ensureUser(req.user.name, req.user.login);
    await queueInput(() => command('tmux', ['send-keys', '-t', `=${req.user.name}:`, req.body.key]));
    res.json({ ok: true });
  });
  app.use(async (req, res, next) => {
    if (req.path === '/term') return res.redirect('/term/');
    if (!req.path.startsWith('/term/')) return next();
    const socketPath = await users.ensureUser(req.user.name, req.user.login);
    proxy.web(req, res, { target: { socketPath } });
  });
  app.use((req, res) => res.status(404).send('Not found'));
  app.use((error, req, res, next) => {
    // Never log child-process args or GitHub response bodies: these can contain secrets.
    console.error(`Gateway request failed: ${error.code || error.name}`);
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    res.status(503).json({ error: 'The agent host could not complete this request. Reload and try again.' });
  });
  proxy.on('error', (error, req, res) => {
    console.error(`Terminal proxy failed: ${error.code || error.name}`);
    if (res?.writeHead && !res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    if (res?.end) res.end('Terminal reconnecting. Reload the page.');
    else res?.destroy();
  });
  server.on('upgrade', async (req, socket, head) => {
    // Verify independently: Express middleware never runs for WebSocket upgrades.
    try {
      const user = await session(req, config);
      if (!user || req.headers.origin !== config.PUBLIC_URL || !req.url.split('?')[0].startsWith('/term/')) {
        return socket.destroy();
      }
      socket.on('error', () => socket.destroy());
      const socketPath = await users.ensureUser(user.name, user.login);
      if (socket.destroyed) return;
      proxy.ws(req, socket, head, { target: { socketPath } });
    } catch { socket.destroy(); }
  });
  return { app, server, users, proxy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = validateEnv();
    if (process.argv.includes('--check-env')) {
      console.log('Agent host environment is valid');
    } else {
      const reconciler = startReconciler();
      const { server, users, proxy } = createGateway(config);
      server.listen(config.PORT, '0.0.0.0', () => console.log(`Pocket Butler gateway listening on port ${config.PORT}`));
      users.restore().catch(error => console.error(`Session restoration failed: ${error.code || error.name}`));
      const shutdown = () => {
        reconciler.stop();
        users.stop();
        proxy.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    }
  } catch (error) {
    console.error(`Agent host configuration error: ${error.message}`);
    process.exit(1);
  }
}
