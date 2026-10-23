import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const validName = name => typeof name === 'string' && /^[a-z0-9-]{1,20}$/.test(name);
const validLogin = login => typeof login === 'string' && /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login);
const hash = token => createHash('sha256').update(token).digest('hex');

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export function createInviteStore(file = '/data/invites.json') {
  async function list() {
    const members = await readJson(file, []);
    if (!Array.isArray(members) || members.some(member => !validName(member.name) || !validLogin(member.login) ||
      !/^[a-f0-9]{32}$/.test(member.version) || !/^[a-f0-9]{64}$/.test(member.tokenHash)) ||
      new Set(members.map(member => member.name)).size !== members.length) throw new Error('Invalid invite database');
    return members;
  }
  return {
    list,
    async get(name) { return (await list()).find(member => member.name === name); },
    async findToken(token) {
      if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return null;
      const candidate = Buffer.from(hash(token), 'hex');
      return (await list()).find(member => timingSafeEqual(candidate, Buffer.from(member.tokenHash, 'hex'))) || null;
    },
    async add(name, login = name) {
      if (!validName(name)) throw new Error('Short name must use [a-z0-9-], 1–20 characters');
      if (!validLogin(login)) throw new Error('Invalid GitHub login');
      const members = await list();
      const token = randomBytes(32).toString('base64url');
      const member = { name, login, tokenHash: hash(token), version: randomBytes(16).toString('hex') };
      await saveJson(file, [...members.filter(item => item.name !== name), member]);
      return { member, token };
    },
    async revoke(name) { await saveJson(file, (await list()).filter(member => member.name !== name)); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const store = createInviteStore(process.env.INVITES_FILE);
    const linksFile = '/data/invite-links.json';
    const [action, name, login] = process.argv.slice(2);
    const links = await readJson(linksFile, {});
    async function add(shortName, githubLogin) {
      const { token } = await store.add(shortName, githubLogin);
      if (!process.env.PUBLIC_URL) throw new Error('PUBLIC_URL is required');
      links[shortName] = `${process.env.PUBLIC_URL}/login#invite=${token}`;
      await saveJson(linksFile, links);
      return links[shortName];
    }
    if (action === 'bootstrap') {
      if (await readJson(process.env.INVITES_FILE || '/data/invites.json', null) === null) {
        for (const [shortName, githubLogin] of [[process.env.BUTLER_TEAM_LEAD || 'msz', process.env.OWNER_LOGIN || 'MszBednarski'],
          ['teammate1', 'teammate1'], ['teammate2', 'teammate2'], ['teammate3', 'teammate3'], ['teammate4', 'teammate4']]) {
          await add(shortName, githubLogin);
        }
      }
      console.log('Team invite slots are ready. Read /data/invite-links.json privately to get the links.');
    } else if (action === 'add') {
      console.log(await add(name, login));
    } else if (action === 'revoke') {
      await store.revoke(name);
      delete links[name];
      await saveJson(linksFile, links);
      console.log(`Revoked ${name}`);
    } else if (action === 'list') {
      console.log(JSON.stringify((await store.list()).map(({ name, login }) => ({ name, login })), null, 2));
    } else {
      throw new Error('Usage: node invites.js bootstrap | add <name> [github-login] | revoke <name> | list');
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}
