import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateEnv, sign, verify, createGateway } from '../gateway/server.js';

const environment = {
  PORT: '3000', PUBLIC_URL: 'https://agents.example.com', APP_URL: 'https://app.example.com',
  GITHUB_REPO: 'team/butler', SESSION_SECRET: 'a'.repeat(64), IS_SANDBOX: '1'
};
const config = validateEnv(environment);
const future = () => Math.floor(Date.now() / 1000) + 600;
const cookie = (login = 'AliceGH', name = 'alice', exp = future()) =>
  `butler_session=${sign({ login, name, exp, version: members[name]?.version }, config.SESSION_SECRET)}`;
let dir, gateway, base;
const servers = [];
const sockets = new Set();
const members = {};
const tokens = {};

before(async () => {
  dir = await mkdtemp(`${tmpdir()}/butler-test-`);
  const { createInviteStore } = await import('../gateway/invites.js');
  config.members = createInviteStore(`${dir}/invites.json`);
  for (const [name, login] of [['alice', 'AliceGH'], ['bob', 'BobGH']]) {
    const result = await config.members.add(name, login);
    members[name] = result.member;
    tokens[name] = result.token;
  }
  for (const name of ['alice', 'bob']) {
    const server = createServer((req, res) => res.end(`${name}:${req.url}`));
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Test-User: ${name}\r\nX-Test-Path: ${req.url}\r\n\r\n`);
    });
    await new Promise(resolve => server.listen(`${dir}/${name}.sock`, resolve));
    servers.push(server);
  }
  const users = { ensureUser: async (name, login) => {
    assert.equal(members[name].login, login);
    return `${dir}/${name}.sock`;
  }, stop() {} };
  gateway = createGateway(config, { users });
  gateway.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${gateway.server.address().port}`;
});

after(async () => {
  gateway.proxy.close();
  for (const socket of sockets) socket.destroy();
  await Promise.all([gateway.server, ...servers].map(server => new Promise(resolve => server.close(resolve))));
  await rm(dir, { recursive: true, force: true });
});

test('startup validates settings without requiring a PAT or OAuth app', () => {
  for (const key of Object.keys(environment)) {
    const invalid = { ...environment }; delete invalid[key];
    assert.throws(() => validateEnv(invalid), new RegExp(key));
  }
  assert.throws(() => validateEnv({ ...environment, PUBLIC_URL: 'https://host.example/' }));
  assert.throws(() => validateEnv({ ...environment, SESSION_SECRET: 'short' }));
  assert.throws(() => validateEnv({ ...environment, PORT: '0' }));
  assert.equal(config.AGENT_CMD, '/usr/local/bin/run-agent codex');
});

test('session signatures and expiration reject changes', () => {
  const token = sign({ login: 'AliceGH', name: 'alice', exp: future() }, config.SESSION_SECRET);
  assert.equal(verify(token, config.SESSION_SECRET).name, 'alice');
  assert.equal(verify(token + 'x', config.SESSION_SECRET), null);
  assert.equal(verify(token, 'wrong secret'), null);
  assert.equal(verify(sign({ exp: 1 }, config.SESSION_SECRET), config.SESSION_SECRET), null);
});

test('health is public; terminal HTTP and API require a valid current member', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(await health.text(), 'ok');
  assert.equal(health.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal((await fetch(base, { redirect: 'manual' })).headers.get('location'), '/login');
  for (const route of ['/term/', '/term/ws', '/api/me']) {
    for (const value of ['', cookie('RemovedGH'), cookie('AliceGH', 'bob'), cookie('AliceGH', 'alice', 1), cookie() + 'tampered']) {
      assert.equal((await fetch(base + route, { headers: { cookie: value } })).status, 401);
    }
  }
});

test('invite secrets authenticate only their owner and set a secure session cookie', async () => {
  for (const token of ['', 'wrong', 'a'.repeat(43)]) {
    const response = await fetch(`${base}/auth/invite`, { method: 'POST', headers: {
      origin: config.PUBLIC_URL, 'Content-Type': 'application/json'
    }, body: JSON.stringify({ token }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const response = await fetch(`${base}/auth/invite`, { method: 'POST', headers: {
    origin: config.PUBLIC_URL, 'Content-Type': 'application/json'
  }, body: JSON.stringify({ token: tokens.alice, name: 'bob' }) });
  assert.equal(response.status, 200);
  const sessionCookie = response.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(sessionCookie.includes(flag));
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie: sessionCookie.split(';')[0] } })).json();
  assert.deepEqual(me, { name: 'alice', login: 'AliceGH', appUrl: config.APP_URL, repo: config.GITHUB_REPO });
  const { readFile } = await import('node:fs/promises');
  assert.ok(!(await readFile(`${dir}/invites.json`, 'utf8')).includes(tokens.alice));
});

test('invalid names are rejected and rotating an invite invalidates existing sessions immediately', async () => {
  for (const name of ['../alice', 'UPPER', 'a'.repeat(21), '']) await assert.rejects(config.members.add(name));
  const { member, token } = await config.members.add('rotate', 'RotateGH');
  const oldCookie = `butler_session=${sign({ login: member.login, name: member.name, version: member.version, exp: future() }, config.SESSION_SECRET)}`;
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: oldCookie } })).status, 200);
  await config.members.add('rotate', 'RotateGH');
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: oldCookie } })).status, 401);
  assert.equal(await config.members.findToken(token), null);
  const newer = await config.members.get('rotate');
  const newCookie = `butler_session=${sign({ login: newer.login, name: newer.name, version: newer.version, exp: future() }, config.SESSION_SECRET)}`;
  await config.members.revoke('rotate');
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: newCookie } })).status, 401);
});

test('terminal paths and query parameters never select another user; proxy preserves /term', async () => {
  for (const [login, name] of [['AliceGH', 'alice'], ['BobGH', 'bob']]) {
    const response = await fetch(`${base}/term/bob?name=bob`, { headers: { cookie: cookie(login, name) } });
    assert.equal(await response.text(), `${name}:/term/bob?name=bob`);
  }
});

test('all non-GET requests need our Origin; input and keys are validated', async () => {
  for (const route of ['/auth/invite', '/api/send', '/api/key', '/logout']) {
    for (const origin of ['', 'https://evil.example']) {
      assert.equal((await fetch(base + route, { method: 'POST', headers: { cookie: cookie(), origin } })).status, 403);
    }
  }
  for (const [route, body] of [['/api/send', { text: 'a'.repeat(20001) }], ['/api/send', { text: '' }],
    ['/api/send', { text: '\0' }], ['/api/key', { key: 'C-b; kill-session' }]]) {
    const response = await fetch(base + route, { method: 'POST', headers: {
      cookie: cookie(), origin: config.PUBLIC_URL, 'Content-Type': 'application/json'
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  const logout = await fetch(`${base}/logout`, { method: 'POST', redirect: 'manual', headers: { origin: config.PUBLIC_URL, cookie: cookie() } });
  assert.equal(logout.status, 302);
  assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
});

function upgrade(route, value, origin) {
  return new Promise((resolve, reject) => {
    const socket = connect(gateway.server.address().port, '127.0.0.1');
    let result = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('Upgrade timeout')); });
    socket.on('connect', () => socket.write(`GET ${route} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${value}\r\nOrigin: ${origin}\r\n\r\n`));
    socket.on('data', data => { result += data.toString(); socket.destroy(); });
    socket.on('close', () => resolve(result));
    socket.on('error', reject);
  });
}

test('WebSocket independently requires session, our Origin, and /term/', async () => {
  for (const [route, value, origin] of [
    ['/term/ws', '', config.PUBLIC_URL], ['/term/ws', cookie(), 'https://evil.example'],
    ['/api/me', cookie(), config.PUBLIC_URL], ['/term/ws', cookie('RemovedGH'), config.PUBLIC_URL]
  ]) assert.equal(await upgrade(route, value, origin), '');
  const response = await upgrade('/term/ws?name=bob', cookie(), config.PUBLIC_URL);
  assert.match(response, /101 Switching Protocols/);
  assert.match(response, /x-test-user: alice/i);
  assert.match(response, /x-test-path: \/term\/ws\?name=bob/i);
});
