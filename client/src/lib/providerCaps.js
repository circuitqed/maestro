// Providers whose agents are worth opening the chat view for. A transcript renderer
// exists only for claude and codex, but the chat is also where prompts are answered
// and messages are sent — so a provider without a renderer still belongs here: it
// shows prompts and an empty history rather than a conversation. Kept in one place
// because the gate used to be duplicated in two components, which is how an
// Antigravity agent ended up with no Chat button at all.
export const CHAT_PROVIDERS = ['claude', 'codex', 'antigravity'];
export const hasChatView = (provider) => CHAT_PROVIDERS.includes(provider || 'claude');
