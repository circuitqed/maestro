import React from 'react';
import ProviderIcon from './ProviderIcon';

/**
 * Which model (and for Codex, which reasoning effort) the open chat is talking to.
 * Sits in the panel/modal title bar so the answer is visible without opening the
 * picker — switching models per agent is routine here, and until now the only way
 * to tell Opus from Fable was to scroll the terminal back to the banner.
 */
const PROVIDER_LABEL = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  aider: 'Aider',
};

function ModelBadge({ info, className = '', onClick, busy = false, provider = null, configuredModel = null }) {
  // A model reported by the transcript is the truth, but only claude and codex have
  // a renderer that can report one. Everything else showed a bare title bar with no
  // hint of what the agent even is -- an Antigravity agent looked identical to a
  // broken one. Fall back to what the agent is CONFIGURED as: the model if the agent
  // row carries one, else the provider's name.
  const model = (info && info.model) || configuredModel || null;
  const prov = (info && info.provider) || provider || null;
  if (!model && !prov) return null;
  // Only the transcript-derived case can be trusted enough to offer the picker --
  // clicking would type /model into a provider that may not have that command.
  const derived = !!(info && info.model);
  if (!derived) onClick = undefined;
  info = { ...(info || {}), model: model || PROVIDER_LABEL[prov] || prov, provider: prov };
  // Clickable when the parent gives it something to do — opening the picker from here
  // saves typing /model into the composer, which is the only way it was reachable.
  // While the agent is working, Claude queues keystrokes rather than running a slash
  // command, so a click would silently stack "/model" in its composer until it got
  // submitted as a message. Show the badge, but don't let it fire.
  const Tag = onClick ? 'button' : 'span';
  const interactive = onClick && !busy
    ? 'hover:bg-gray-600/80 hover:text-white cursor-pointer transition-colors'
    : onClick
      ? 'opacity-60 cursor-not-allowed'
      : '';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      disabled={Tag === 'button' ? busy : undefined}
      className={`inline-flex items-center gap-1 rounded bg-gray-700/70 px-1.5 py-0.5 text-[11px] text-gray-300 min-w-0 ${interactive} ${className}`}
      title={
        `${info.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'} · ${info.model}` +
        `${info.effort ? ` · ${info.effort} effort` : ''}${busy ? ' — busy, finish the turn to change it' : onClick ? ' — click to change' : ''}`
      }
    >
      <ProviderIcon provider={info.provider} className="w-3 h-3 flex-shrink-0" />
      <span className="truncate max-w-[9rem]">{info.model}</span>
      {info.effort && <span className="text-gray-400 flex-shrink-0">· {info.effort}</span>}
    </Tag>
  );
}

export default ModelBadge;
