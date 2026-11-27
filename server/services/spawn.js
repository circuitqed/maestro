/**
 * Ideas to agents: one sentence in, a running agent out.
 *
 * Making an agent was 5-10 manual steps -- pick a host, name, directory, account;
 * start it; answer the trust prompt; turn the claude.ai connectors off and restart;
 * issue a yap token; get the card posted -- and that friction, not the work, was what
 * made ideas wait. Here:
 *
 *   draft(idea)  asks a model for a proposed card (name, host, project, first prompt),
 *                using the fleet as it is right now and the `spawn_rules` setting;
 *                the person edits whatever is wrong and taps Go.
 *   spawn(card)  does every step, in order, with nothing left for a person:
 *                dir + scaffold (AGENTS.md, git) -> .claude/settings.json with the
 *                connectors off -> directory pre-trusted for that account -> agent row
 *                -> GitHub repo + per-repo deploy key (github.js) -> yap token straight
 *                to the host -> start -> the idea delivered as its first message
 *                once its composer is up.
 *   githubForAgent(id, repo)  the GitHub step alone, for an agent that already exists.
 *
 * Pre-trusting is done here, and only here, because the person just asked for this
 * directory to be created and run: the Go tap IS the trust decision. Maestro still
 * never answers a trust prompt in someone else's pane.
 *
 * Accounts default to whatever most live Claude agents on that host already run as,
 * learned from the fleet rather than configured, so moving the fleet to a new account
 * moves new agents with it.
 */
import fs from 'fs';
import path from 'path';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import {
  getHosts, getHost, getProjects, getProject, getAgents, getAgent, createProject, createAgent,
  setProjectHostPath, getSetting,
} from './db.js';
import { execOnHost, isRemote, shellQuote, isValidSessionName } from './hosts.js';
import { scaffoldProject, appendAgentLane } from './scaffold.js';
import { sanitizeSessionName, uniqueSessionName } from './sessions.js';
import { getTmuxSessions, capturePane, sendText } from './tmux.js';
import { startAgentSession } from './agentStart.js';
import { looksLikePrompt } from './inject.js';
import { setupGithub, validRepo, repoExists } from './github.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const runLocal = (cmd) => execAsync(cmd, { shell: '/bin/bash', timeout: 15000 });

const GATEWAY_SETTINGS = '/home/dave/.claude-accts/stanford-api/settings.json';
const MODEL = 'claude-opus-5-5';
const YAP_ISSUE = '/home/projects/yap/bin/yap-issue';

// What each machine is for. Editable as the `spawn_rules` setting; this is the default.
export const DEFAULT_RULES = `- zlmc (Linux Threadripper in the lab): anything touching lab instruments, fridges, qubit measurement, QICK/RFSoC, Vivado/FPGA firmware, EM simulation (HFSS, Sonnet, em-sim), lab data. Reaches the lab subnet.
- oracle (cloud VM, runs Maestro/yap): web apps and sites, Maestro/yap/fleet tooling, personal projects, games, writing, anything public on lazybrains.com or circuitqed.com. Low CPU (4 cores) and nearly full disk: no heavy compute.
- mac-mini (Apple M4): macOS/iOS apps, Xcode, Apple-only tools, on-device ML that wants Metal.
- whistler (lab Windows/WSL box): only FleetMonitor-style fridge monitoring and Windows lab software.
- lithium: JTAG/FPGA board programming on the bench.
- garage-wsl: AXIEM and other Windows EM tools; often offline, so avoid unless the idea needs it.
Prefer an EXISTING project when the idea is clearly part of one; otherwise a new project.`;

function gatewayKey() {
  const s = JSON.parse(fs.readFileSync(GATEWAY_SETTINGS, 'utf8'));
  const env = s.env || {};
  if (!env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL) throw new Error('gateway account is not configured');
  return { key: env.ANTHROPIC_AUTH_TOKEN, base: env.ANTHROPIC_BASE_URL.replace(/\/$/, '') };
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** The account most live Claude agents on this host use (null = the host's default ~/.claude). */
export function defaultAccountFor(hostId) {
  const counts = new Map();
  const localId = (getHosts().find((h) => !isRemote(h)) || {}).id;
  const want = hostId ?? localId;
  for (const a of getAgents()) {
    if ((a.host_id ?? localId) !== want) continue;
    if (a.status === 'stopped') continue;
    const cfg = typeof a.config === 'string' ? JSON.parse(a.config || '{}') : (a.config || {});
    if ((cfg.provider || 'claude') !== 'claude') continue;
    const dir = cfg.claudeConfigDir || '';
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = '', n = -1;
  for (const [dir, c] of counts) if (c > n) { best = dir; n = c; }
  return best || null;
}

function hostRoot(host) {
  if (!isRemote(host)) return '/home/projects';
  return host.default_root || null;
}

function fleetSummary() {
  const hosts = getHosts();
  const agents = getAgents();
  const projects = getProjects();
  const byHost = hosts.map((h) => {
    const names = agents.filter((a) => (a.host_id ?? (isRemote(h) ? -1 : h.id)) === h.id && a.status !== 'stopped').map((a) => a.name);
    return `${h.name} (${h.status || 'unknown'}): ${names.slice(0, 25).join(', ') || 'no live agents'}`;
  });
  const proj = projects.map((p) => {
    const n = agents.filter((a) => a.project_id === p.id).length;
    return `${p.name}${p.description ? ` -- ${String(p.description).slice(0, 80)}` : ''} (${n} agents)`;
  });
  return { hostsText: byHost.join('\n'), projectsText: proj.join('\n'), hosts, projects };
}

// ---- Public URL: Cloudflare tunnel route + Access, set up at start ----------------
const ZONES = ['circuitqed.com', 'lazybrains.com'];
export const ACCESS = ['lab', 'dave', 'anyone', 'public'];
const CF_TUNNEL_ADD = '/home/dave/.local/bin/cf-tunnel-add';
const CF_ACCESS_ADD = '/home/dave/.local/bin/cf-access-add';
const CF_TOKEN = '/home/dave/.config/cloudflare/token';
const CF_ACCOUNT = '5113ba1b3173ca9c34309c04b953b9d3';
const CF_TUNNEL = '001ee67a-79fa-4913-8eeb-f78f7f6b7381'; // the shared oracle tunnel
const PORT_MIN = 7800, PORT_MAX = 7999;

export function validHostname(h) {
  const s = String(h || '').toLowerCase().trim();
  if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?\.[a-z0-9.-]+$/.test(s)) return false;
  return ZONES.some((z) => s === z || s.endsWith(`.${z}`)) && s.split('.').length === 3;
}

async function tunnelIngress() {
  const tok = fs.readFileSync(CF_TOKEN, 'utf8').trim();
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/cfd_tunnel/${CF_TUNNEL}/configurations`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (!d.success) throw new Error('could not read the tunnel config');
  return (d.result && d.result.config && d.result.config.ingress) || [];
}

// A port nobody uses: not in any tunnel route, not reserved by another agent, not
// listening on the host. The fleet convention is 78xx, counting up.
async function freePort(host, ingress) {
  const used = new Set();
  for (const i of ingress) { const m = String(i.service || '').match(/:(\d+)\/?$/); if (m) used.add(Number(m[1])); }
  for (const a of getAgents()) {
    const c = typeof a.config === 'string' ? (() => { try { return JSON.parse(a.config || '{}'); } catch { return {}; } })() : (a.config || {});
    if (c.port) used.add(Number(c.port));
  }
  try {
    const { stdout } = await execOnHost(host, "ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'");
    for (const p of stdout.split(/\s+/)) if (p) used.add(Number(p));
  } catch { /* best effort */ }
  const top = Math.max(PORT_MIN, ...[...used].filter((p) => p >= PORT_MIN && p <= PORT_MAX));
  for (let p = top + 1; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  throw new Error('no free port in 7800-7999');
}

/**
 * Route https://<hostname> to the agent's port and put it behind Google sign-in.
 * Refuses a hostname that already routes somewhere: cf-tunnel-add would silently
 * re-point it, taking over another app's address.
 */
export async function setupUrl(host, hostname, access, { port = null } = {}) {
  if (!validHostname(hostname)) throw new Error(`${hostname} is not a hostname on ${ZONES.join(' or ')}.`);
  const ingress = await tunnelIngress();
  const taken = ingress.find((i) => i.hostname === hostname);
  if (port == null) port = await freePort(host, ingress);
  let target;
  if (!isRemote(host)) target = String(port);
  else {
    const { stdout } = await execOnHost(host, 'tailscale ip -4 2>/dev/null | head -1');
    const ip = stdout.trim();
    if (!/^100\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`${host.name} has no tailnet address for the tunnel to reach.`);
    target = `http://${ip}:${port}`;
  }
  const want = /^\d+$/.test(target) ? `http://localhost:${target}` : target;
  if (taken && taken.service !== want) throw new Error(`${hostname} already routes to ${taken.service}; choose another name.`);
  await execFileAsync(CF_TUNNEL_ADD, [hostname, target], { timeout: 60000 });
  if (access !== 'public') {
    const args = [hostname];
    if (access === 'lab') args.push('--allow-domain', 'stanford.edu', '--allow', 'david.schuster@gmail.com');
    if (access === 'anyone') args.push('--anyone');
    await execFileAsync(CF_ACCESS_ADD, args, { timeout: 60000 });
  }
  return { url: `https://${hostname}`, port, bind: isRemote(host) ? `0.0.0.0:${port} (reached over the tailnet)` : `127.0.0.1:${port}`, access };
}

const ACCESS_TEXT = {
  lab: 'behind Google sign-in for Stanford accounts and Dave',
  dave: 'behind Google sign-in, Dave only',
  anyone: 'behind Google sign-in, any Google account',
  public: 'public, with no login',
};

/** A proposed card for an idea. Never creates anything. */
export async function draft(idea) {
  const text = String(idea || '').trim();
  if (!text) throw new Error('Say what the agent should do.');
  const { hostsText, projectsText, hosts, projects } = fleetSummary();
  const rules = getSetting('spawn_rules') || DEFAULT_RULES;
  const system = `You set up new AI coding agents for Dave, a physics professor who runs a fleet of Claude Code agents across several machines. Given his one-line idea, propose where and how the agent should run. Answer with ONE JSON object and nothing else:
{"name": short kebab-case agent name, 2-4 words, specific (e.g. "bfg1-warmup-log", not "monitor-agent"),
 "host": one of the host names below,
 "project": the name of an EXISTING project from the list, or null for a new project,
 "projectName": if project is null, a short kebab-case name for the new project (often the same as name),
 "description": one sentence saying what this agent does, for its card,
 "why": a few words on the host choice,
 "url": if the idea is something people open in a browser (a web app, site, dashboard, form, API others call), a public hostname for it, else null. Lab and research things go on circuitqed.com, Dave's personal projects on lazybrains.com; a short memorable subdomain (e.g. "inventory.circuitqed.com"). Use a hostname Dave named if he gave one,
 "github": the GitHub repo for its code as "owner/name", or null. Almost every agent that writes code wants one: lab and research work goes under "SchusterLab", Dave's personal projects under "circuitqed"; the name is usually the agent's name. null only for an agent that writes no code (a monitor, a one-off question),
 "access": who may open the url: "lab" (Stanford Google accounts and Dave; the default for lab tools), "dave" (only Dave), "anyone" (any Google account), or "public" (no login, only for things meant to be public),
 "firstPrompt": the first message the agent will receive: Dave's idea restated as a clear task, keeping every specific he gave (names, numbers, machines), adding nothing he didn't ask for. Written to the agent in second person. Plain text.}

Rules for choosing a machine:
${rules}

Machines and their live agents now:
${hostsText}

Existing projects:
${projectsText}`;
  const { key, base } = gatewayKey();
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`drafting failed: ${body?.error?.message || `HTTP ${res.status}`}`);
  const out = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('drafting returned no card');
  let card;
  try { card = JSON.parse(m[0]); } catch { throw new Error('drafting returned an unreadable card'); }

  // Normalise against what actually exists; never trust a name the model made up.
  const host = hosts.find((h) => h.name === card.host) || hosts.find((h) => !isRemote(h));
  const project = card.project ? projects.find((p) => p.name === card.project) : null;
  const name = slug(card.name) || slug(text.split(/\s+/).slice(0, 3).join('-')) || 'new-agent';
  return {
    idea: text,
    name,
    hostId: host.id,
    projectId: project ? project.id : null,
    // Name for a NEW project, even when an existing one was picked: the picker's
    // "New project" choice must not duplicate the existing project under its own name.
    projectName: project ? name : (slug(card.projectName) || name),
    existingProjectName: project ? project.name : null,
    description: String(card.description || '').slice(0, 300),
    why: String(card.why || '').slice(0, 200),
    firstPrompt: String(card.firstPrompt || text),
    claudeConfigDir: defaultAccountFor(host.id),
    url: validHostname(card.url) ? String(card.url).toLowerCase() : '',
    access: ACCESS.includes(card.access) ? card.access : 'lab',
    github: validRepo(card.github) ? String(card.github) : '',
  };
}

// Mark a directory trusted for the account the agent will run as, so its first start
// doesn't stop on "Do you trust the files in this folder?". Atomic replace; a missing
// config file is created.
const TRUST_PY = `
import json, os, sys, tempfile
cfg, d = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(cfg))
except FileNotFoundError:
    data = {}
p = data.setdefault('projects', {}).setdefault(d, {})
p['hasTrustDialogAccepted'] = True
p.setdefault('allowedTools', [])
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg) or '.', prefix='.claude.json.')
with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2)
if os.path.exists(cfg):
    os.chmod(tmp, os.stat(cfg).st_mode & 0o777)
os.replace(tmp, cfg)
`;

async function pretrust(host, dir, configDir) {
  const cfg = configDir ? `${configDir.replace(/\/$/, '')}/.claude.json` : '$HOME/.claude.json';
  const b64 = Buffer.from(TRUST_PY).toString('base64');
  const cmd = `f=$(mktemp) && echo ${shellQuote(b64)} | base64 -d > "$f" && python3 "$f" ${configDir ? shellQuote(cfg) : `"${cfg}"`} ${shellQuote(dir)}; r=$?; rm -f "$f"; exit $r`;
  if (isRemote(host)) await execOnHost(host, cmd);
  else await runLocal(cmd);
}

// The project's own settings: connectors off before the first start, so an agent that
// gets a yap token never also had Gmail/Drive (and no restart is needed to drop them).
async function writeProjectSettings(host, dir) {
  const py = `
import json, os, sys
p = os.path.join(sys.argv[1], '.claude', 'settings.json')
os.makedirs(os.path.dirname(p), exist_ok=True)
try:
    d = json.load(open(p))
except Exception:
    d = {}
d['disableClaudeAiConnectors'] = True
json.dump(d, open(p, 'w'), indent=2)
`;
  const b64 = Buffer.from(py).toString('base64');
  const cmd = `f=$(mktemp) && echo ${shellQuote(b64)} | base64 -d > "$f" && python3 "$f" ${shellQuote(dir)}; r=$?; rm -f "$f"; exit $r`;
  if (isRemote(host)) await execOnHost(host, cmd);
  else await runLocal(cmd);
}

async function dirExists(host, dir) {
  try { await execOnHost(host, `test -e ${shellQuote(dir)}`); return true; } catch (err) {
    if (err.code === 1) return false;
    throw err;
  }
}

function firstMessage(card, agent, host, dir, yapOk, web = null, github = null) {
  const lines = [
    `[from Maestro, for Dave] ${card.firstPrompt.trim()}`,
    '',
    card.workingDir
      ? `Setup (done by Maestro): you are "${agent.name}" on ${host.name}, working in the existing repo ${dir}; read its CLAUDE.md/AGENTS.md first and keep it current. claude.ai connectors are off for this project (.claude/settings.json).`
      : `Setup (done by Maestro): you are "${agent.name}" on ${host.name}, working in ${dir} (git initialised; AGENTS.md is the project's instructions file, keep it current). claude.ai connectors are off for this project.`,
  ];
  if (web) {
    lines.push(`Your public address is ${web.url}, ${ACCESS_TEXT[web.access]} (Cloudflare tunnel and Access are already set up). Serve on ${web.bind}; in docker-compose that is \`ports: ["${web.bind.startsWith('127') ? '127.0.0.1:' : ''}${web.port}:<container port>"]\`. Don't use another port. ${web.access === 'public' ? '' : 'Cloudflare checks the login before a request reaches you; read the signed-in person from the Cf-Access-Authenticated-User-Email header (details: /home/projects/docs/google-login.md).'}`);
  }
  if (github && !github.error) {
    lines.push(`GitHub: ${github.url} (${github.created ? 'new, private' : 'existing'}) is your repo; remote origin = ${github.remote}, which uses a deploy key on this machine that can push to that repo only.${github.pushed ? ' The initial commit is already pushed.' : ''}${github.note ? ` ${github.note}` : ''} Commit and push your work there.`);
  } else if (github && github.error) {
    lines.push(`GitHub setup for ${github.repo} failed (${github.error}); tell Dave if you need it.`);
  }
  if (yapOk) {
    lines.push(`You're on yap as dave/${agent.screen_session}, the lab's agent message board. Before starting: run \`yap help\`, post your card (what you do, in a sentence or two: "${card.description}"), then \`yap new\`.`);
  }
  lines.push('If you need something set up (GitHub access, a public URL, a credential), say exactly what and why, and Dave will arrange it. Credentials come as one-time claim links (`secret-claim URL`), never pasted.');
  return lines.join('\n');
}

// Deliver the first message once the composer is up. A trust prompt or any other
// widget means a person has to act: wait for them rather than type into it.
async function deliverFirst(agentId, host, text) {
  const until = Date.now() + 15 * 60 * 1000;
  let sawComposer = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    const agent = getAgent(agentId);
    if (!agent) return;
    let pane = '';
    try { pane = await capturePane(agent.screen_session, host); } catch { continue; }
    if (looksLikePrompt(pane)) { sawComposer = 0; continue; }
    // The composer is a ❯ line between two rules; wait for two looks in a row so a
    // half-drawn start screen doesn't get the paste.
    // (Claude follows the ❯ with a no-break space, which \s covers and ' ' does not.)
    if (/^\s*❯(\s|$)/m.test(pane)) sawComposer++;
    else sawComposer = 0;
    if (sawComposer >= 2) {
      try { await sendText(agent.screen_session, text, host); } catch (err) { console.error('spawn: first message failed', err.message); }
      return;
    }
  }
  console.error(`spawn: gave up delivering the first message to agent ${agentId}`);
}

/** Create and start the agent described by an (edited) card. */
export async function spawn(card, { userId = null, registerAgent } = {}) {
  const name = slug(card.name);
  if (!name) throw new Error('The agent needs a name.');
  const host = getHost(card.hostId);
  if (!host) throw new Error('Unknown host.');
  const root = hostRoot(host);
  if (!root) throw new Error(`${host.name} has no default directory; set one in Manage Hosts.`);

  // Directory: <root>/<name>, suffixed if taken, so a new agent never lands in (and
  // takes over) someone else's tree.
  // An existing directory (an agent for a repo that already exists) is used as is
  // and not scaffolded: the repo has its own instructions file and layout.
  const existingDir = typeof card.workingDir === 'string' && card.workingDir.trim() ? card.workingDir.trim() : null;
  let dir;
  if (existingDir) {
    if (!existingDir.startsWith('/')) throw new Error('The working directory must be an absolute path.');
    if (!(await dirExists(host, existingDir))) throw new Error(`${existingDir} does not exist on ${host.name}.`);
    dir = existingDir;
  } else {
    dir = path.posix.join(root, name);
    for (let i = 2; await dirExists(host, dir); i++) {
      dir = path.posix.join(root, `${name}-${i}`);
      if (i > 20) throw new Error(`Could not find a free directory under ${root}.`);
    }
  }

  // GitHub: refuse a taken name now, before anything is created. A drafted name that
  // matches a real repo must not hand this agent write access to it; an agent run in
  // an existing working dir may of course use that repo's own GitHub repo.
  const githubRepo = String(card.github || '').trim();
  if (githubRepo) {
    if (!validRepo(githubRepo)) throw new Error(`"${githubRepo}" is not an owner/repo name.`);
    if (!existingDir && await repoExists(githubRepo)) throw new Error(`github.com/${githubRepo} already exists; pick another name, or leave the GitHub field blank.`);
  }

  // Project: existing, or a new one named for the idea.
  let project = card.projectId ? getProject(card.projectId) : null;
  if (card.projectId && !project) throw new Error('That project no longer exists.');
  const description = String(card.description || '').trim();
  if (!project) {
    const pname = slug(card.projectName) || name;
    const existing = getProjects().find((p) => slug(p.name) === pname);
    project = existing || createProject(pname, isRemote(host) ? null : dir, description, null, userId);
  }

  if (!existingDir) {
    await execOnHost(host, `mkdir -p ${shellQuote(dir)}`);
    await scaffoldProject(isRemote(host) ? host : null, dir, { name, description });
  }
  await writeProjectSettings(host, dir);
  if (isRemote(host) && !project.path) setProjectHostPath(project.id, host.id, dir);

  let github = null;
  if (githubRepo) {
    try {
      github = await setupGithub(host, dir, githubRepo, { allowExisting: !!existingDir, description, agentName: name });
    } catch (err) {
      console.error('spawn: github failed', err.message);
      github = { repo: githubRepo, error: err.message };
    }
  }

  // URL before the agent exists, so a name clash fails the start instead of leaving
  // an agent told about an address it doesn't have.
  let web = null;
  if (card.url && String(card.url).trim()) {
    web = await setupUrl(host, String(card.url).trim().toLowerCase(), ACCESS.includes(card.access) ? card.access : 'lab');
  }

  const configDir = card.claudeConfigDir === undefined ? defaultAccountFor(host.id) : (card.claudeConfigDir || null);
  try { await pretrust(host, dir, configDir); } catch (err) { console.error('spawn: pretrust failed', err.message); }

  let hostSessions = [];
  try { hostSessions = (await getTmuxSessions(host)).map((s) => s.name); } catch { hostSessions = []; }
  const session = uniqueSessionName(host.id, sanitizeSessionName(name), hostSessions);
  if (!isValidSessionName(session)) throw new Error('Could not make a valid session name.');
  const config = {
    provider: 'claude', ...(configDir ? { claudeConfigDir: configDir } : {}), spawnedFrom: String(card.idea || '').slice(0, 1000),
    ...(web ? { url: web.url, port: web.port, access: web.access } : {}),
  };
  const agent = createAgent(project.id, name, session, 'stopped', config, host.id, dir);
  if (project.path && !isRemote(host)) appendAgentLane(project.path, name, 'claude');

  // yap: the token goes straight into a file on the host; it never passes through here
  // as text we keep, log, or show.
  let yapOk = false;
  try {
    await execFileAsync(YAP_ISSUE, [`dave/${session}`, '--host', isRemote(host) ? host.ssh_target : 'local', '--session', session], { timeout: 30000 });
    yapOk = true;
  } catch (err) {
    console.error('spawn: yap-issue failed', (err.stderr || err.message || '').toString().slice(0, 200));
  }

  const fresh = getAgent(agent.id);
  await startAgentSession(fresh, host, { registerAgent });
  deliverFirst(agent.id, host, firstMessage({ ...card, description }, fresh, host, dir, yapOk, web, github))
    .catch((err) => console.error('spawn: deliver', err.message));

  return { agent: getAgent(agent.id), dir, project: getProject(project.id), yap: yapOk, web, github };
}

/**
 * GitHub for an agent that already exists (the agent menu's "GitHub repo…"). An
 * existing repo is allowed: Dave typed this name for this agent. The agent is told
 * once its composer is free, the same way as a first message.
 */
export async function githubForAgent(agentId, repo) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Unknown agent.');
  const host = agent.host_id ? getHost(agent.host_id) : getHosts().find((h) => !isRemote(h));
  const dir = agent.working_dir || (agent.project_id && getProject(agent.project_id)?.path);
  if (!host || !dir) throw new Error('This agent has no working directory to attach a repo to.');
  try { await execOnHost(host, `git -C ${shellQuote(dir)} rev-parse --git-dir >/dev/null`); } catch {
    throw new Error(`${dir} on ${host.name} is not a git repository.`);
  }
  const out = await setupGithub(host, dir, String(repo || '').trim(), { allowExisting: true, agentName: agent.name });
  const msg = `[from Maestro, for Dave] GitHub is set up: ${out.url} (${out.created ? 'new, private' : 'existing'}). Remote origin = ${out.remote}, using a deploy key on this machine that can push to that repo only.${out.pushed ? ' Your current branch is pushed.' : ''}${out.note ? ` ${out.note}` : ''}`;
  deliverFirst(agent.id, host, msg).catch((err) => console.error('github: notify', err.message));
  return { ...out, dir, host: host.name };
}
