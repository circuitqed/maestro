import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isRemote, execOnHost, shellQuote } from './hosts.js';

const execAsync = promisify(exec);

// Markers in AGENTS.md between which per-agent ownership lanes are kept, so we can
// append a lane when an agent is added without disturbing the rest of the file.
export const LANE_START = '<!-- maestro:agents:start -->';
export const LANE_END = '<!-- maestro:agents:end -->';

function agentsTemplate(name, description) {
  const desc = (description && description.trim()) || 'One-line description of what this project is.';
  return `# ${name}

${desc}

## Working conventions

- This is the **canonical project directory** and the single source of truth. Every
  agent on this project shares it — there is intentionally no per-agent copy.
- Put durable project assets here (code, data, docs) and **commit them**; see the
  layout below. Anything not committed is not durable.
- Commit small and often with clear messages so other agents see your work. Pull /
  rebase before starting a large change.
- Throwaway experiments go in \`.agent-scratch/<your-name>/\` (gitignored), never in
  the shared tree.

## Layout

- \`docs/\` — design notes, references, decisions.
- _(add project-specific directories here as they appear)_

## Agents & ownership

Multiple agents share this directory, so each one takes a **lane** — a slice of the
work (by subdirectory or by responsibility) — so two agents don't edit the same
files at once. Define your lane here before you start.

${LANE_START}
${LANE_END}

## Notes

_(Anything an agent should know before working here — build commands, gotchas,
external services, credentials location, etc.)_
`;
}

function claudePointer(name) {
  return `# ${name}

> **Canonical instructions live in [AGENTS.md](AGENTS.md).**
>
> This project uses \`AGENTS.md\` as the single source of truth for agent guidance
> (read by Codex, Claude Code, and other agents). This \`CLAUDE.md\` is only a
> pointer so the two never diverge — edit \`AGENTS.md\`, not this file.
`;
}

const GITIGNORE = `# Maestro scaffold
.agent-scratch/
node_modules/
__pycache__/
*.pyc
.DS_Store
.env
.env.local
`;

// One agent's ownership line in AGENTS.md.
function laneLine(agentName, provider) {
  return `- **${agentName}** (\`${provider}\`) — _lane: define this_`;
}

function filesFor(name, description) {
  return {
    'AGENTS.md': agentsTemplate(name, description),
    'CLAUDE.md': claudePointer(name),
    '.gitignore': GITIGNORE,
    'docs/.gitkeep': '',
  };
}

/**
 * Scaffold a project directory with the Maestro conventions: AGENTS.md (canonical)
 * + CLAUDE.md pointer + .gitignore + docs/, then `git init` and a first commit.
 *
 * Idempotent and non-destructive: existing files are never overwritten, and git is
 * only initialised when the directory is not already a repo. Host-aware (local fs /
 * remote over SSH). Returns { created: [...relPaths], git: 'init'|'skipped' }.
 */
export async function scaffoldProject(host, dir, { name, description } = {}) {
  const files = filesFor(name || path.basename(dir), description);
  return isRemote(host)
    ? scaffoldRemote(host, dir, files)
    : scaffoldLocal(dir, files);
}

async function scaffoldLocal(dir, files) {
  const created = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full)) continue; // never clobber
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    created.push(rel);
  }
  let git = 'skipped';
  if (!fs.existsSync(path.join(dir, '.git'))) {
    const q = shellQuote(dir);
    await execAsync(`git -C ${q} init -q`);
    await execAsync(`git -C ${q} add -A`);
    await execAsync(
      `git -C ${q} -c user.name=Maestro -c user.email=maestro@localhost commit -q -m ${shellQuote('Initial project scaffold (Maestro)')}`
    );
    git = 'init';
  }
  return { created, git };
}

async function scaffoldRemote(host, dir, files) {
  let script = `set -e; cd ${shellQuote(dir)}; `;
  for (const [rel, content] of Object.entries(files)) {
    const b64 = Buffer.from(content).toString('base64');
    const d = path.posix.dirname(rel);
    if (d && d !== '.') script += `mkdir -p ${shellQuote(d)}; `;
    script += `[ -f ${shellQuote(rel)} ] || echo ${shellQuote(b64)} | base64 -d > ${shellQuote(rel)}; `;
  }
  script +=
    `if [ ! -d .git ]; then git init -q && git add -A && ` +
    `git -c user.name=Maestro -c user.email=maestro@localhost commit -q -m ${shellQuote('Initial project scaffold (Maestro)')}; fi`;
  await execOnHost(host, script);
  return { created: Object.keys(files), git: 'maybe' };
}

/**
 * Append an agent's ownership lane to the canonical (local) AGENTS.md, best-effort.
 * No-op if the file is missing, the lane already exists, or on any error — this must
 * never block agent creation.
 */
export function appendAgentLane(projectPath, agentName, provider) {
  try {
    if (!projectPath) return;
    const file = path.join(projectPath, 'AGENTS.md');
    if (!fs.existsSync(file)) return;
    const line = laneLine(agentName, provider || 'claude');
    let md = fs.readFileSync(file, 'utf8');
    if (md.includes(line)) return;
    md = md.includes(LANE_END)
      ? md.replace(LANE_END, `${line}\n${LANE_END}`)
      : `${md}\n${line}\n`;
    fs.writeFileSync(file, md);
  } catch {
    /* best-effort */
  }
}
