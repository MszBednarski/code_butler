import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';

const directory = process.env.GH_CONFIG_DIR;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = `${directory}/connection.json`;
function save(value) {
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...value, updatedAt: Date.now() }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
function connected() {
  const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
  save({ state: 'connected', login });
}
try {
  execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
  connected();
} catch {
  save({ state: 'starting' });
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage'], {
    env: { ...process.env, GH_BROWSER: 'echo' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const capture = (chunk, stream) => {
    stream.write(chunk);
    output = (output + chunk.toString()).slice(-8192);
    const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
    if (code) save({ state: 'pending', code, url: 'https://github.com/login/device' });
  };
  child.stdout.on('data', chunk => capture(chunk, process.stdout));
  child.stderr.on('data', chunk => capture(chunk, process.stderr));
  child.on('error', () => { save({ state: 'error' }); process.exitCode = 1; });
  child.on('close', code => {
    if (code !== 0) { save({ state: 'error' }); process.exitCode = 1; return; }
    try { connected(); }
    catch { save({ state: 'error' }); process.exitCode = 1; }
  });
}
