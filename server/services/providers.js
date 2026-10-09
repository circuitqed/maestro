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

/**
 * The Claude config directory an agent should run under, or null for the default.
 *
 * Claude Code keeps BOTH the OAuth credentials and the account identity inside its
 * config home, so pointing CLAUDE_CONFIG_DIR somewhere else is what lets a second
 * Anthropic account run on a host that is already signed in to another one. Set it
 * per agent via `config.claudeConfigDir`.
 *
 * Store a PATH here, never a token: a failing start surfaces the whole command in
 * the error message (agentStart re-throws it and the route returns err.message), and
 * the command line is visible to `ps` on the host. A directory path is inert there.
 *
 * Throws rather than falling back on a bad value. Silently reverting to the default
 * would run the agent as the WRONG ACCOUNT, which is both wrong and invisible --
 * much worse than refusing to start.
 */
export function claudeConfigDir(config) {
  const raw = config && config.claudeConfigDir;
  if (raw === undefined || raw === null || raw === '') return null;
  const dir = String(raw).trim();
  if (!dir.startsWith('/')) {
    throw new Error(
      `claudeConfigDir must be an absolute path (got ${JSON.stringify(raw)}). ` +
        'Claude Code rejects a relative config dir.'
    );
  }
  if (/[\r\n]/.test(dir)) throw new Error('claudeConfigDir must not contain newlines');
  return dir;
}

/**
 * The Codex config home an agent should run under, or null for the default.
 *
 * CODEX_HOME is Codex's equivalent of CLAUDE_CONFIG_DIR: it relocates config.toml,
 * which is where a custom model_provider (e.g. the Stanford AI API Gateway) lives.
 * Set per agent via `config.codexHome`.
 *
 * Throws rather than falling back, as claudeConfigDir does. Quietly reverting to
 * the default home would run the agent against the wrong provider -- and here the
 * wrong BILLING -- which is worse than refusing to start.
 */
export function codexHome(config) {
  const raw = config && config.codexHome;
  if (raw === undefined || raw === null || raw === '') return null;
  const dir = String(raw).trim();
  if (!dir.startsWith('/')) {
    throw new Error(`codexHome must be an absolute path (got ${JSON.stringify(raw)})`);
  }
  if (/[\r\n]/.test(dir)) throw new Error('codexHome must not contain newlines');
  return dir;
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
      // `export`, not a bare VAR=val prefix: the trailing `exec bash` keeps the pane
      // alive after claude exits, and that shell (where a human may well type
      // `claude` again by hand) must inherit the same account rather than silently
      // falling back to the default one.
      const cfgDir = claudeConfigDir(config);
      const envPrefix = cfgDir ? `export CLAUDE_CONFIG_DIR=${quoteForBashLc(cfgDir)}; ` : '';
      return `bash -lc '${envPrefix}${binary} ${nameFlag}${sessionFlag}${flags}; exec bash'`;
    },
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    icon: 'codex',
    // NOT --dangerously-bypass-approvals-and-sandbox any more. From 0.153.4 the
    // enterprise "regulated-workspace" baseline disallows approval_policy=never and
    // sandbox_mode=danger-full-access, so that flag is silently downgraded — the
    // agent prints two warnings at startup and then begins asking for approval on
    // ordinary commands, which is fatal for agents meant to run unattended.
    // workspace-write is the most permissive mode still permitted; the writable
    // roots and network access that make it behave like the old flag are set in
    // each host's ~/.codex/config.toml.
    defaultFlags: '--sandbox workspace-write',
    envVars: ['OPENAI_API_KEY'],
    monitorable: true,
    buildCommand(config, agentName) {
      const binary = config.binaryPath || 'codex';
      const flags = config.flags ?? this.defaultFlags;
      // Resuming the pinned rollout, so a restart keeps the conversation instead of
      // silently starting an empty one — the Codex equivalent of claude --resume.
      // `codex resume <SESSION_ID>` takes the id as a positional BEFORE the options,
      // and the id is a validated UUID (hex + dashes), so it needs no quoting.
      const rid = config.codexResumeId;
      const resume = rid && /^[0-9a-fA-F-]{36}$/.test(rid) ? `resume ${rid} ` : '';
      // A resumed session keeps the model it was created with, which is how an agent
      // silently stays on an old model across restarts. Pin it when configured.
      const model = config.model ? `-m ${quoteForBashLc(config.model)} ` : '';
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
      // A custom provider needs two things in the environment: CODEX_HOME so codex
      // reads the right config.toml, and that provider's env_key. The key is read
      // from a 0600 file by the shell at launch rather than spliced into the command,
      // so the secret never appears in argv or in `ps`.
      const home = codexHome(config);
      let envPrefix = '';
      if (home) {
        const q = quoteForBashLc(home);
        const keyVar = quoteForBashLc(config.codexKeyEnv || 'STANFORD_API_KEY');
        envPrefix = `export CODEX_HOME=${q}; `
          + `if [ -r ${q}/key ]; then export ${keyVar}="$(cat ${q}/key)"; fi; `;
      }
      return `bash -lc '${envPrefix}${binary} ${resume}${model}${idFlag}${flags}; exec bash'`;
    },
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    icon: 'antigravity',
    // Google's terminal agent (binary name `agy`, installed to ~/.local/bin by
    // https://antigravity.google/cli/install.sh). Same shape as the other two:
    // unattended agents cannot answer permission prompts, so approvals are skipped.
    defaultFlags: '--dangerously-skip-permissions',
    envVars: [],
    monitorable: true,
    buildCommand(config, agentName, host) {
      const binary = config.binaryPath || 'agy';
      const flags = config.flags ?? this.defaultFlags;
      // agy resumes with --continue (most recent) or --conversation <id>. The id is
      // not known until a conversation exists, so a restart continues the latest —
      // the closest equivalent to claude --resume without a pinned id to point at.
      const resume = config.agyResume ? '--continue ' : '';
      const model = config.model ? `--model ${quoteForBashLc(config.model)} ` : '';
      const effort = config.effort ? `--effort ${quoteForBashLc(config.effort)} ` : '';
      return `bash -lc '${binary} ${resume}${model}${effort}${flags}; exec bash'`;
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
