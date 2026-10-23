import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../run-agent.sh', import.meta.url));
test('personal login ignores host credentials, persists per user, and stops on failure', async () => {
  const dir = await mkdtemp(`${tmpdir()}/github-login-`);
  try {
    await mkdir(`${dir}/bin`);
    await writeFile(`${dir}/bin/gh`, `#!/bin/bash
set -eu
[ "$GH_CONFIG_DIR" = "$HOME/.config/gh" ]
[ -z "\${GH_TOKEN+x}\${GITHUB_TOKEN+x}\${GH_ENTERPRISE_TOKEN+x}\${GITHUB_ENTERPRISE_TOKEN+x}" ]
case "$*" in
  'auth status --hostname github.com') test -f "$GH_CONFIG_DIR/logged-in" ;;
  auth\\ login*) printf 'First copy your one-time code: ABCD-1234\\n'; echo login >> "$HOME/logins"; [ "\${FAIL_LOGIN:-}" != 1 ]; touch "$GH_CONFIG_DIR/logged-in" ;;
  api\\ user*) printf '%s\\t42\\n' "$TEST_LOGIN" ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
    await writeFile(`${dir}/bin/claude`, '#!/bin/bash\nprintf "%s|%s|%s" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GH_CONFIG_DIR" > "$HOME/agent"\n', { mode: 0o700 });
    const run = (name, extra = {}) => execFileSync('bash', [launcher, 'claude'], { env: {
      ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, HOME: `${dir}/${name}`,
      CODEX_HOME: `${dir}/${name}/.codex`, BUTLER_USER: name, TEST_LOGIN: name,
      GH_CONFIG_DIR: `${dir}/shared`, GH_TOKEN: 'host-fixture', GITHUB_TOKEN: 'host-fixture',
      GH_ENTERPRISE_TOKEN: 'host-fixture', GITHUB_ENTERPRISE_TOKEN: 'host-fixture', ...extra
    } });
    run('alice'); run('bob'); run('alice');
    for (const name of ['alice', 'bob']) {
      assert.equal(await readFile(`${dir}/${name}/logins`, 'utf8'), 'login\n');
      const connection = JSON.parse(await readFile(`${dir}/${name}/.config/gh/connection.json`, 'utf8'));
      assert.equal(connection.state, 'connected');
      assert.equal(connection.code, undefined);
      assert.equal(connection.token, undefined);
      assert.equal(await readFile(`${dir}/${name}/agent`, 'utf8'), `${name}|42+${name}@users.noreply.github.com|${dir}/${name}/.config/gh`);
    }
    assert.throws(() => run('failed', { FAIL_LOGIN: '1' }));
    await assert.rejects(readFile(`${dir}/failed/agent`), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(`${dir}/failed/.config/gh/connection.json`, 'utf8')).state, 'error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('device code is available to the mobile screen only while authorization is pending', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = await mkdtemp(`${tmpdir()}/github-device-`);
  let child;
  try {
    await mkdir(`${dir}/bin`);
    await writeFile(`${dir}/bin/gh`, `#!/bin/bash
case "$*" in
  auth\\ status*) exit 1 ;;
  auth\\ login*) printf 'First copy your one-time code: ABCD-1234\\n' >&2; sleep 0.3 ;;
  api\\ user*) printf 'alice\\n' ;;
esac
`, { mode: 0o700 });
    child = spawn(process.execPath, [fileURLToPath(new URL('../github-login.mjs', import.meta.url))], {
      env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GH_CONFIG_DIR: `${dir}/gh` },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = once(child, 'close');
    await once(child.stderr, 'data');
    let pending;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { pending = JSON.parse(await readFile(`${dir}/gh/connection.json`, 'utf8')); } catch {}
      if (pending?.state === 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(pending.state, 'pending');
    assert.equal(pending.code, 'ABCD-1234');
    assert.equal(pending.url, 'https://github.com/login/device');
    assert.equal((await closed)[0], 0);
    const connected = JSON.parse(await readFile(`${dir}/gh/connection.json`, 'utf8'));
    assert.equal(connected.state, 'connected');
    assert.equal(connected.login, 'alice');
    assert.equal(connected.code, undefined);
  } finally { child?.kill(); await rm(dir, { recursive: true, force: true }); }
});
