import React from 'react';

// Per-provider display name (tooltip) and a distinct color so agent types are
// recognizable at a glance rather than a row of identical gray marks.
const PROVIDER_META = {
  claude: { label: 'Claude Code', color: 'text-orange-400' },
  codex: { label: 'OpenAI Codex', color: 'text-emerald-400' },
  gemini: { label: 'Gemini CLI', color: 'text-sky-400' },
  aider: { label: 'Aider', color: 'text-amber-400' },
  custom: { label: 'Custom', color: 'text-fuchsia-400' },
  shell: { label: 'Shell', color: 'text-gray-400' },
};

function Glyph({ provider, className }) {
  switch (provider) {
    case 'claude': {
      // Anthropic/Claude — stylized radial sunburst (spark)
      const spokes = [];
      for (let i = 0; i < 12; i++) {
        const a = (i * 30 * Math.PI) / 180;
        spokes.push(
          <line
            key={i}
            x1={12 + 2.6 * Math.cos(a)}
            y1={12 + 2.6 * Math.sin(a)}
            x2={12 + 9 * Math.cos(a)}
            y2={12 + 9 * Math.sin(a)}
          />
        );
      }
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          {spokes}
        </svg>
      );
    }
    case 'codex':
      // OpenAI — stylized blossom: three interlocking loops
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <ellipse cx="12" cy="12" rx="4" ry="8.5" />
          <ellipse cx="12" cy="12" rx="4" ry="8.5" transform="rotate(60 12 12)" />
          <ellipse cx="12" cy="12" rx="4" ry="8.5" transform="rotate(120 12 12)" />
        </svg>
      );
    case 'gemini':
      // Google Gemini — four-point spark star with concave sides
      return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10 5.3-.6 9.4-4.7 10-10z" />
        </svg>
      );
    case 'aider':
      // Wrench/tool icon
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case 'custom':
      // Gear icon
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
        </svg>
      );
    case 'shell':
      // Terminal icon
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    default:
      // Generic bot icon
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v4" />
          <line x1="8" y1="16" x2="8" y2="16" />
          <line x1="16" y1="16" x2="16" y2="16" />
        </svg>
      );
  }
}

// `colored` (default true) applies the per-provider color + a tooltip; pass
// colored={false} to inherit the surrounding text color instead.
function ProviderIcon({ provider, className = 'w-4 h-4', colored = true }) {
  const meta = PROVIDER_META[provider] || { label: provider || 'agent', color: 'text-gray-400' };
  return (
    <span
      className={`inline-flex flex-shrink-0 ${colored ? meta.color : ''}`}
      title={meta.label}
      aria-label={meta.label}
    >
      <Glyph provider={provider} className={className} />
    </span>
  );
}

export default ProviderIcon;
