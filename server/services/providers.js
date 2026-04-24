/**
 * Provider registry for agent CLI tools.
 * Each provider defines how to build the tmux command for its CLI.
 */

const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    icon: 'claude',
    defaultFlags: '--dangerously-skip-permissions',
    envVars: ['ANTHROPIC_API_KEY'],
    monitorable: true,
    buildCommand(config) {
      const binary = config.binaryPath || '/home/dave/.local/bin/claude';
      const flags = config.flags ?? this.defaultFlags;
      return `bash -lc '${binary} ${flags}; exec bash'`;
    },
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex',
    icon: 'codex',
    defaultFlags: '--dangerously-bypass-approvals-and-sandbox',
    envVars: ['OPENAI_API_KEY'],
    monitorable: true,
    buildCommand(config) {
      const binary = config.binaryPath || 'codex';
      const flags = config.flags ?? this.defaultFlags;
      return `bash -lc '${binary} ${flags}; exec bash'`;
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
