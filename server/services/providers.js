/**
 * Provider registry for agent CLI tools.
 * Each provider defines how to build the tmux command for its CLI.
 */

// Quote `s` for splicing into a `bash -lc '...'` template: sh-single-quote,
// then re-escape every ' for the outer SQ context.
function quoteForBashLc(s) {
  const sqQuoted = `'${String(s).replace(/'/g, `'\\''`)}'`;
  return sqQuoted.replace(/'/g, `'\\''`);
}

// Who this Codex agent is, and the warning that matters most for it: siblings share
// its working directory, so repo state is not evidence about its own past work.
function codexIdentity(agentName) {
  const name = String(agentName || '').replace(/[\r\n]/g, ' ').trim();
  if (!name) return '';
  return (
    `You are the agent named "${name}", one of several agents orchestrated by Maestro. ` +
    `Other agents share this working directory and git repository, so uncommitted changes, ` +
    `running jobs and recent commits are often theirs, not yours. Never adopt work you find ` +
    `in the repo as your own: if your conversation has no history of it, say the context is ` +
    `not yours and ask, rather than reconstructing a task from repo state.`
  );
}

const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    icon: 'claude',
    defaultFlags: '--dangerously-skip-permissions',
    envVars: ['ANTHROPIC_API_KEY'],
    monitorable: true,
    buildCommand(config, agentName, host) {
      // Remote hosts rely on the PATH prefix (see hosts.js); local uses the absolute path
      const binary = config.binaryPath || (host && host.ssh_target ? 'claude' : '/home/dave/.local/bin/claude');
      const flags = config.flags ?? this.defaultFlags;
      const nameFlag = agentName ? `--name ${quoteForBashLc(agentName)} ` : '';
      // Pin the transcript session id when the caller supplies one. The id is a
      // validated UUID (hex + dashes only), so it needs no quoting; guard anyway.
      // First start creates the session with --session-id; a restart must --resume
      // the same id instead (Claude rejects a --session-id that already exists).
      const sid = config.claudeSessionId;
      const validSid = sid && /^[0-9a-fA-F-]{36}$/.test(sid);
      const sessionFlag = validSid
        ? (config.claudeResume ? `--resume ${sid} ` : `--session-id ${sid} `)
        : '';
      return `bash -lc '${binary} ${nameFlag}${sessionFlag}${flags}; exec bash'`;
    },
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    icon: 'codex',
    defaultFlags: '--dangerously-bypass-approvals-and-sandbox',
    envVars: ['OPENAI_API_KEY'],
    monitorable: true,
    buildCommand(config, agentName) {
      const binary = config.binaryPath || 'codex';
      const flags = config.flags ?? this.defaultFlags;
      // Codex has no `--name`, so without this a Codex agent has no idea which agent
      // it is. Asked "where were we" with a fresh session, it reconstructs context from
      // the repo — and since the project convention is one SHARED working dir, the
      // uncommitted work it finds is usually a sibling's. (Observed: the
      // qubit-designer-sonnet agent reporting the transducer agent's v37/v39 campaign
      // as its own.) developer_instructions rides in as a developer message, so it
      // costs no turn. JSON.stringify emits a valid TOML basic string; the whole
      // key=value is one shell word so `-c` still gets its own argv.
      const identity = codexIdentity(agentName);
      const idFlag = identity ? `-c ${quoteForBashLc(`developer_instructions=${JSON.stringify(identity)}`)} ` : '';
      return `bash -lc '${binary} ${idFlag}${flags}; exec bash'`;
    },
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    icon: 'gemini',
    defaultFlags: '',
    envVars: ['GOOGLE_API_KEY'],
    monitorable: true,
    buildCommand(config) {
      const binary = config.binaryPath || 'gemini';
      const flags = config.flags ?? this.defaultFlags;
      return `bash -lc '${binary} ${flags}; exec bash'`;
    },
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    icon: 'aider',
    defaultFlags: '',
    envVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    monitorable: true,
    buildCommand(config) {
      const binary = config.binaryPath || 'aider';
      const flags = config.flags ?? this.defaultFlags;
      const model = config.model ? `--model ${config.model}` : '';
      return `bash -lc '${binary} ${model} ${flags}; exec bash'`.replace(/  +/g, ' ');
    },
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    icon: 'custom',
    defaultFlags: '',
    envVars: [],
    monitorable: true,
    buildCommand(config) {
      if (!config.customCommand) throw new Error('Custom command is required');
      return `bash -lc '${config.customCommand}; exec bash'`;
    },
  },
  shell: {
    id: 'shell',
    name: 'Shell',
    icon: 'shell',
    defaultFlags: '',
    envVars: [],
    monitorable: false,
    buildCommand() {
      return null; // shell uses createSession(), not startProviderSession()
    },
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.custom;
}

export function getProviderList() {
  return Object.values(PROVIDERS);
}
