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
  auth\\ login*) echo login >> "$HOME/logins"; [ "\${FAIL_LOGIN:-}" != 1 ]; touch "$GH_CONFIG_DIR/logged-in" ;;
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
      assert.equal(await readFile(`${dir}/${name}/agent`, 'utf8'), `${name}|42+${name}@users.noreply.github.com|${dir}/${name}/.config/gh`);
    }
    assert.throws(() => run('failed', { FAIL_LOGIN: '1' }));
    await assert.rejects(readFile(`${dir}/failed/agent`), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
