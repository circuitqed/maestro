import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  // The card is rendered into document.body rather than next to the badge. It has
  // to be: the chat sits in a resizable Panel with overflow:hidden, so an absolutely
  // positioned child is CLIPPED at the panel's left edge, and a 26rem card hanging
  // off a badge near that edge loses most of itself behind the agent list. No
  // z-index fixes that -- clipping by an ancestor ignores stacking order entirely.
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(416, window.innerWidth - 16); // 26rem, or the viewport
    // Right-aligned to the badge like the old popover, then clamped so neither edge
    // leaves the window on a narrow screen or a dragged-narrow panel.
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setPos({ top: r.bottom + 4, left, width });
  }, []);

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

  // Keep it under the badge while the layout moves: dragging the panel divider,
  // resizing the window, or scrolling an ancestor all shift the anchor, and a fixed
  // element does not follow on its own. Capture phase so nested scrollers count.
  useEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  // Close when clicking elsewhere, so it behaves like the menus around it. The card
  // is portalled out of this subtree, so it needs its own containment check --
  // otherwise clicking the password field counts as "outside" and closes it.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const inBadge = wrapRef.current && wrapRef.current.contains(e.target);
      const inCard = popRef.current && popRef.current.contains(e.target);
      if (!inBadge && !inCard) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!status || !status.available) return null;

  const connected = !!status.connected;

  return (
    <div className="relative flex-shrink-0" ref={wrapRef}>
      <button
        ref={btnRef}
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

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 60 }}
        >
          <div className="rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-2">
            <ConnectionCard
              id={id}
              hostId={hostId}
              label={label}
              hint="Stanford password, then approve the Duo push on your phone."
              onConnected={poll}
            />
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default ConnectionBadge;
