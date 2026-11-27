/**
 * A GitHub repo an agent can push to, set up for it.
 *
 * Every new agent that wanted to push hit the same wall: it made itself a key, wrote
 * the ssh alias, then waited (sometimes for hours) for Dave to create the repo and add
 * the key. kiutra-measurement sat blocked on exactly that. The fleet convention it
 * followed is kept, so this is the same thing done by hand, minus the wait:
 *
 *   - one DEPLOY key per repo, on the agent's host: ~/.ssh/deploy/<repo>, never a
 *     personal key, so an agent can push to its own repo and nothing else;
 *   - an ssh alias `github-<repo>` in ~/.ssh/config picking that key, and the remote
 *     `git@github-<repo>:<owner>/<repo>.git`;
 *   - the repo private by default.
 *
 * The API token is gh's own (~/.config/gh/hosts.yml, Dave's login), read here and
 * never logged or passed to a host. The host only ever sees its own public key go out.
 *
 * An EXISTING repo is refused unless the caller says it may be used (the agent menu
 * does; the idea box only when it runs in an existing working dir): a drafted name
 * that happens to match a real repo must not quietly hand a new agent write access.
 */
import fs from 'fs';
import { execOnHost, isRemote, shellQuote } from './hosts.js';

const GH_HOSTS = '/home/dave/.config/gh/hosts.yml';
const API = 'https://api.github.com';

export function validRepo(full) {
  return typeof full === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(full) && !/\/\.+$/.test(full);
}

function token() {
  const text = fs.readFileSync(GH_HOSTS, 'utf8');
  const block = text.split(/^(?=\S)/m).find((b) => b.startsWith('github.com:'));
  const m = block && block.match(/^\s+oauth_token:\s*(\S+)/m);
  if (!m) throw new Error('No GitHub login found (gh auth login on oracle).');
  return m[1];
}

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'maestro',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function ghError(what, r) {
  const detail = (r.data.errors || []).map((e) => e.message || e.code).filter(Boolean).join('; ');
  return new Error(`${what}: ${r.data.message || `HTTP ${r.status}`}${detail ? ` (${detail})` : ''}`);
}

export async function repoExists(full) {
  const r = await gh('GET', `/repos/${full}`);
  if (r.status === 200) return true;
  if (r.status === 404) return false;
  throw ghError(`Checking ${full}`, r);
}

async function createRepo(full, description) {
  const [owner, name] = full.split('/');
  const me = await gh('GET', '/user');
  const path = me.data.login && me.data.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
  const r = await gh('POST', path, { name, private: true, description: String(description || '').slice(0, 300) || undefined });
  if (r.status !== 201) throw ghError(`Creating ${full}`, r);
}

// Runs on the agent's host. bash 3.2 safe (mac mini): no heredoc in $(...).
function hostScript(repo, hostLabel) {
  const key = `$HOME/.ssh/deploy/${repo}`;
  const block = `\\nHost github-${repo}\\n    HostName github.com\\n    User git\\n    IdentityFile ~/.ssh/deploy/${repo}\\n    IdentitiesOnly yes\\n`;
  return [
    'set -e',
    'mkdir -p "$HOME/.ssh/deploy" && chmod 700 "$HOME/.ssh" "$HOME/.ssh/deploy"',
    `[ -f "${key}" ] || ssh-keygen -q -t ed25519 -N '' -C ${shellQuote(`${repo} deploy key (${hostLabel})`)} -f "${key}"`,
    'touch "$HOME/.ssh/config" && chmod 600 "$HOME/.ssh/config"',
    `grep -q '^Host github-${repo}$' "$HOME/.ssh/config" || printf '${block}' >> "$HOME/.ssh/config"`,
    // github.com's host key, or the first push stops on "authenticity can't be established".
    'touch "$HOME/.ssh/known_hosts"; grep -q "^github.com " "$HOME/.ssh/known_hosts" || ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$HOME/.ssh/known_hosts"',
    `cat "${key}.pub"`,
  ].join('\n');
}

/**
 * Give the git repo at `dir` on `host` a GitHub remote it can push to.
 * Returns { repo, url, remote, created, pushed, note }.
 */
export async function setupGithub(host, dir, full, { allowExisting = false, description = '', agentName = '' } = {}) {
  if (!validRepo(full)) throw new Error(`"${full}" is not an owner/repo name.`);
  const repo = full.split('/')[1];
  const exists = await repoExists(full);
  if (exists && !allowExisting) throw new Error(`github.com/${full} already exists; pick another name, or leave the GitHub field blank.`);
  if (!exists) await createRepo(full, description);

  const { stdout } = await execOnHost(host, `bash -c ${shellQuote(hostScript(repo, host.name))}`, { timeout: 30000 });
  const pub = String(stdout).trim().split('\n').pop().split(' ').slice(0, 2).join(' ');
  if (!/^ssh-ed25519 \S+$/.test(pub)) throw new Error('Could not read the deploy key from the host.');

  const keys = await gh('GET', `/repos/${full}/keys`);
  const already = Array.isArray(keys.data) && keys.data.find((k) => String(k.key).trim() === pub);
  if (already && already.read_only) throw new Error(`The deploy key is on ${full} read-only; remove it in the repo's settings and run this again.`);
  if (!already) {
    const r = await gh('POST', `/repos/${full}/keys`, { title: `${host.name} ${agentName || repo} agent`, key: pub, read_only: false });
    // GitHub allows a deploy key on one repo only.
    if (r.status !== 201) throw ghError(`Adding the deploy key to ${full}`, r);
  }

  // Remote: set origin only if the repo has none; an existing origin is the repo's
  // own business and is reported, not replaced.
  const remote = `git@github-${repo}:${full}.git`;
  const q = shellQuote(dir);
  let note = '';
  let pushed = false;
  const { stdout: cur } = await execOnHost(host, `git -C ${q} remote get-url origin 2>/dev/null || true`);
  const origin = String(cur).trim();
  if (!origin) {
    await execOnHost(host, `git -C ${q} remote add origin ${shellQuote(remote)}`);
  } else if (origin !== remote) {
    note = `origin already points at ${origin}; left as is. Push to ${remote} with a second remote if wanted.`;
  }
  if (!exists && (!origin || origin === remote)) {
    try {
      await execOnHost(host, `cd ${q} && git rev-parse -q --verify HEAD >/dev/null && git push -q -u origin HEAD`, { timeout: 60000 });
      pushed = true;
    } catch (err) {
      note = `Pushing the first commit failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`;
    }
  }
  return { repo: full, url: `https://github.com/${full}`, remote, created: !exists, pushed, note, remote_host: isRemote(host) ? host.name : 'local' };
}
