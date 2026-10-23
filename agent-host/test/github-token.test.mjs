import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validateToken, saveToken } from '../gateway/github-token.js';
const token = 'github_pat_fixture';
const fixture = (login = 'MszBednarski', push = true) => async url => ({ ok: true, json: async () => url.endsWith('/user') ? { login } : { full_name: 'MszBednarski/code_butler', permissions: { push } } });
test('accepts expected account and writable repo, rejects wrong identities and token kinds', async () => {
  await validateToken(token, 'mszbednarski', 'MszBednarski/code_butler', fixture());
  await assert.rejects(validateToken('gho_fixture', 'mszbednarski', 'MszBednarski/code_butler', fixture()), /fine-grained/);
  await assert.rejects(validateToken(token, 'mszbednarski', 'MszBednarski/code_butler', fixture('someone')), /different/);
  await assert.rejects(validateToken(token, 'mszbednarski', 'MszBednarski/code_butler', fixture('MszBednarski', false)), /push access/);
  await assert.rejects(validateToken(token, 'mszbednarski', 'MszBednarski/code_butler', async () => ({ ok: false })), /validation failed/);
});
test('stores and rotates tokens with private file permissions', async () => {
  const dir = await mkdtemp(`${tmpdir()}/butler-pat-`);
  try {
    await saveToken(token, dir);
    await saveToken(`${token}_rotated`, dir);
    assert.equal(await readFile(`${dir}/repo-token`, 'utf8'), `${token}_rotated`);
    assert.equal((await stat(`${dir}/repo-token`)).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launcher ignores inherited credentials and uses only the workspace PAT', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(`${tmpdir()}/butler-launch-`);
  try {
    await saveToken(token, `${dir}/.config/gh`);
    await mkdir(`${dir}/bin`);
    await writeFile(`${dir}/bin/codex`, '#!/bin/bash\nif [ "$1" = login ]; then exit 0; fi\nprintf "%s\\n" "$GH_TOKEN" "$GH_CONFIG_DIR" "${GITHUB_TOKEN-unset}"\n', { mode: 0o700 });
    const { stdout } = await promisify(execFile)('bash', [(await import('node:url')).fileURLToPath(new URL('../run-agent.sh', import.meta.url))], { env: {
      ...process.env, HOME: dir, PATH: `${dir}/bin:${process.env.PATH}`,
      GH_TOKEN: 'broad-fixture', GITHUB_TOKEN: 'other-fixture', GH_CONFIG_DIR: '/nonexistent-shared-fixture'
    } });
    assert.equal(stdout.trim(), `${token}\n${dir}/.config/gh\nunset`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
