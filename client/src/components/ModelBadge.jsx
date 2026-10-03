import React from 'react';
import ProviderIcon from './ProviderIcon';

/**
 * Which model (and for Codex, which reasoning effort) the open chat is talking to.
 * Sits in the panel/modal title bar so the answer is visible without opening the
 * picker — switching models per agent is routine here, and until now the only way
 * to tell Opus from Fable was to scroll the terminal back to the banner.
 */
function ModelBadge({ info, className = '', onClick, busy = false }) {
  if (!info || !info.model) return null;
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
