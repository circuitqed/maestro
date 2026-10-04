import React, { useCallback, useEffect, useRef, useState } from 'react';
import ConnectionCard from './ConnectionCard';

/**
 * Whether this agent's host has a live Sherlock connection, in the title bar.
 *
 * Worth a permanent indicator rather than only a card-when-it-breaks: the master is
 * per-host and lapses after 12h, so "can my agent reach Sherlock right now?" is a
 * question with a changing answer, and the alternative is finding out when an agent
 * fails mid-task. Hidden entirely on hosts with no Sherlock in their ssh config, and
 * while the host itself is unreachable — neither is a Sherlock problem to report.
 *
 * Clicking opens the login inline, so the connection can be established from here
 * without waiting for an agent to trip over it first.
 */
function ConnectionBadge({ hostId, id = 'sherlock', label = 'Sherlock' }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const qs = hostId ? `?host=${encodeURIComponent(hostId)}` : '';

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/connections/${id}/status${qs}`);
      if (res.ok) setStatus(await res.json());
    } catch {
      /* leave the last known state rather than flapping the indicator */
    }
  }, [id, qs]);

  useEffect(() => {
    let timer;
    let cancelled = false;
    const tick = async () => {
      await poll();
      // 12h connection: once a minute is plenty, and the card polls faster while a
      // login is actually in progress.
      if (!cancelled) timer = setTimeout(tick, 60000);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [poll]);

  // Close when clicking elsewhere, so it behaves like the menus around it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!status || !status.available) return null;

  const connected = !!status.connected;

  return (
    <div className="relative flex-shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          connected
            ? `${label} connected on ${status.host} — agents can use it`
            : `${label} not connected on ${status.host} — click to sign in`
        }
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
          connected
            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
            : 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
        }`}
      >
        {/* A tower/cluster glyph — it is a remote machine, not a generic status dot */}
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="3" width="16" height="7" rx="1" />
          <rect x="4" y="14" width="16" height="7" rx="1" />
          <path d="M8 6.5h.01M8 17.5h.01" />
        </svg>
        <span className="hidden sm:inline">{label}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-[26rem] max-w-[85vw]">
          <div className="rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-2">
            <ConnectionCard
              id={id}
              hostId={hostId}
              label={label}
              hint="Stanford password, then approve the Duo push on your phone."
              onConnected={poll}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default ConnectionBadge;
