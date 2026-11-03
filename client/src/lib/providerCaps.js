// Providers whose agents are worth opening the chat view for. A transcript renderer
// exists only for claude and codex, but the chat is also where prompts are answered
// and messages are sent — so a provider without a renderer still belongs here: it
// shows prompts and an empty history rather than a conversation. Kept in one place
// because the gate used to be duplicated in two components, which is how an
// Antigravity agent ended up with no Chat button at all.
export const CHAT_PROVIDERS = ['claude', 'codex', 'antigravity'];
export const hasChatView = (provider) => CHAT_PROVIDERS.includes(provider || 'claude');

// The icon an agent should show. A DeepSeek agent IS a Claude Code agent (same
// binary, transcript, chat and account plumbing; only the model differs), so its
// stored provider stays `claude` and every capability check above keeps working.
// Only the glyph changes, so a row of agents tells you what each one bills as.
export const iconProvider = (config) => {
  const provider = (config && config.provider) || 'claude';
  if (provider === 'claude' && /deepseek/i.test((config && config.model) || '')) return 'deepseek';
  return provider;
};
