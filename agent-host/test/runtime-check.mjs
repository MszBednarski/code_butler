// Run only inside a disposable instance of the built agent-host image.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway, validateEnv, sign } from '../gateway/server.js';

assert.equal(process.env.BUTLER_RUNTIME_TEST, '1', 'Use a disposable container with BUTLER_RUNTIME_TEST=1');
const exec = promisify(execFile);
const run = async (file, args) => (await exec(file, args)).stdout.trim();
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    try { const value = await fn(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error('Runtime check timed out');
}

await mkdir('/data', { recursive: true });
await mkdir('/run/ttyd', { recursive: true });
let phase = 'restart';
try { await access('/data/repo/.git'); }
catch {
  phase = 'initial';
  await run('git', ['init', '--bare', '--initial-branch=main', '/data/remote.git']);
  await run('git', ['clone', '/data/remote.git', '/data/repo']);
  await writeFile('/data/repo/README.md', 'fixture\n');
  await run('git', ['-C', '/data/repo', 'add', '.']);
  await run('git', ['-C', '/data/repo', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Fixture']);
  await run('git', ['-C', '/data/repo', 'push', 'origin', 'main']);
}
await writeFile('/tmp/butler-input.mjs', `
import fs from 'node:fs';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
fs.writeFileSync(process.env.HOME+'/ready', 'yes');
let input='';
process.stdin.on('data', data => {
  input += data.toString();
  if(input.endsWith('\\r')) {
    fs.writeFileSync(process.env.HOME+'/received', input);
    input='';
  }
});
`);
const config = validateEnv({
  ...process.env, PORT: '3000', PUBLIC_URL: 'https://agents.example.com', APP_URL: 'https://app.example.com',
  GITHUB_REPO: 'test/fixture', GH_TOKEN: 'test-only', GITHUB_OAUTH_CLIENT_ID: 'test-only',
  GITHUB_OAUTH_CLIENT_SECRET: 'test-only', SESSION_SECRET: 'test-secret-'.repeat(6),
  TEAM: 'AliceGH:alice,BobGH:bob', IS_SANDBOX: '1', AGENT_CMD: 'node /tmp/butler-input.mjs'
});
const gateway = createGateway(config);
await new Promise(resolve => gateway.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${gateway.server.address().port}`;
const headers = name => ({
  origin: config.PUBLIC_URL, 'Content-Type': 'application/json',
  cookie: `butler_session=${sign({ login: name === 'alice' ? 'AliceGH' : 'BobGH', name,
    exp: Math.floor(Date.now()/1000)+600 }, config.SESSION_SECRET)}`
});
try {
  await Promise.all(['alice', 'bob'].map(async name => {
    await unlink(`/data/home/${name}/ready`).catch(() => {});
    await unlink(`/data/home/${name}/received`).catch(() => {});
    const response = await fetch(base, { headers: headers(name) });
    assert.equal(response.status, 200);
    await until(() => readFile(`/data/home/${name}/ready`, 'utf8'));
    assert.equal(await run('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}']), `/data/wt/${name}`);
    assert.equal(await run('tmux', ['show-environment', '-t', `=${name}`, 'HOME']), `HOME=/data/home/${name}`);
    assert.equal(await run('tmux', ['show-environment', '-t', `=${name}`, 'BUTLER_USER']), `BUTLER_USER=${name}`);
    assert.equal(await run('tmux', ['show-environment', '-t', `=${name}`, 'GIT_AUTHOR_NAME']), `GIT_AUTHOR_NAME=${name === 'alice' ? 'AliceGH' : 'BobGH'}`);
    assert.equal((await fetch(`${base}/term/`, { headers: headers(name) })).status, 200);
  }));
  console.log('PASS: two lazy worktrees, separate homes, exact tmux sessions, authors, and real ttyd HTTP proxy');

  const messages = { alice: '--alice option\nsecond line 🦊', bob: '--bob option\nother line 🐻' };
  await Promise.all(Object.entries(messages).map(async ([name, text]) => {
    const response = await fetch(`${base}/api/send`, { method: 'POST', headers: headers(name), body: JSON.stringify({ text }) });
    assert.equal(response.status, 200, await response.text());
    const received = await until(() => readFile(`/data/home/${name}/received`, 'utf8'));
    assert.ok(received.startsWith('\x1b[200~'), 'Bracketed paste is enabled');
    assert.equal(received.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~\r$/, '').replaceAll('\r', '\n'), text);
  }));
  console.log('PASS: simultaneous multiline, leading-dash, Unicode Send input stays in the correct terminal and submits');

  // Keep dirty work and simulated credential data for the next container start.
  if (phase === 'initial') {
    await writeFile('/data/wt/alice/uncommitted.txt', 'do not lose this\n');
    await writeFile('/data/home/alice/login-sentinel', 'persistent login fixture\n');
  } else {
    assert.equal(await readFile('/data/wt/alice/uncommitted.txt', 'utf8'), 'do not lose this\n');
    assert.equal(await readFile('/data/home/alice/login-sentinel', 'utf8'), 'persistent login fixture\n');
    console.log('PASS: dirty worktree and per-user credential storage survive a container restart');
  }
  const ttydPid = (await run('pgrep', ['-f', '^ttyd -W -i /run/ttyd/alice.sock'])).split('\n')[0];
  process.kill(+ttydPid, 'SIGKILL');
  await until(async () => {
    const pid = (await run('pgrep', ['-f', '^ttyd -W -i /run/ttyd/alice.sock'])).split('\n')[0];
    return pid !== ttydPid;
  });
  assert.equal((await fetch(`${base}/term/`, { headers: headers('alice') })).status, 200);
  console.log('PASS: ttyd automatically respawns after an unexpected exit');
  console.log(`PASS: runtime check phase ${phase}`);
} finally {
  gateway.users.stop();
  gateway.proxy.close();
  gateway.server.closeAllConnections();
  await new Promise(resolve => gateway.server.close(resolve));
}
