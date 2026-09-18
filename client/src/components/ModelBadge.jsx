import React from 'react';
import ProviderIcon from './ProviderIcon';

/**
 * Which model (and for Codex, which reasoning effort) the open chat is talking to.
 * Sits in the panel/modal title bar so the answer is visible without opening the
 * picker — switching models per agent is routine here, and until now the only way
 * to tell Opus from Fable was to scroll the terminal back to the banner.
 */
function ModelBadge({ info, className = '' }) {
  if (!info || !info.model) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-gray-700/70 px-1.5 py-0.5 text-[11px] text-gray-300 min-w-0 ${className}`}
      title={`${info.provider === 'codex' ? 'OpenAI Codex' : 'Claude Code'} · ${info.model}${info.effort ? ` · ${info.effort} effort` : ''}`}
    >
      <ProviderIcon provider={info.provider} className="w-3 h-3 flex-shrink-0" />
      <span className="truncate max-w-[9rem]">{info.model}</span>
      {info.effort && <span className="text-gray-400 flex-shrink-0">· {info.effort}</span>}
    </span>
  );
}

export default ModelBadge;
