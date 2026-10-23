import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function validateToken(token, login, repo, request = fetch) {
  if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('Use a fine-grained PAT (github_pat_), not a classic token or OAuth login.');
  if (!login || !/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('Missing GitHub identity or repository configuration.');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  async function get(path) {
    const response = await request(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Token validation failed. Check the token, expiration, and repository access.');
    return response.json();
  }
  const user = await get('user');
  if (user.login?.toLowerCase() !== login.toLowerCase()) throw new Error('Token belongs to a different GitHub account.');
  const repository = await get(`repos/${repo}`);
  if (repository.full_name?.toLowerCase() !== repo.toLowerCase() || !repository.permissions?.push) {
    throw new Error('Token must have push access to the configured repository.');
  }
}

export async function saveToken(token, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/repo-token.${process.pid}.tmp`;
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: 'wx' });
    await rename(temporary, `${directory}/repo-token`);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let token = '';
    for await (const chunk of process.stdin) {
      token += chunk;
      if (token.length > 512) throw new Error('Invalid token length.');
    }
    await validateToken(token, process.env.BUTLER_GITHUB_LOGIN, process.env.GITHUB_REPO);
    await saveToken(token, `${process.env.HOME}/.config/gh`);
    console.log('Repository token saved.');
  } catch (error) {
    // Network errors may contain request details; only print our known messages.
    console.error(error.message.startsWith('Token ') || error.message.startsWith('Use a ') || error.message.startsWith('Missing ')
      ? error.message : 'Could not validate or save the repository token.');
    process.exitCode = 1;
  }
}
