// Providers whose agents are worth opening the chat view for. All three have a
// transcript: claude and codex natively, antigravity translated server-side into
// Claude's record shapes (server/services/agyTranscript.js). A provider without one
// would still belong here, since the chat is also where prompts are answered and
// messages sent; it would show prompts and an empty history. Kept in one place
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
