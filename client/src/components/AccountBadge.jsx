import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Which Anthropic account this agent runs as, and a way to change it.
 *
 * An agent's account is otherwise invisible -- it is one key in a JSON config column
 * -- which makes "is this one on my work subscription?" unanswerable without reading
 * the database. It sits beside the model and Sherlock badges because that is where
 * you already look to see what an agent is configured with.
 *
 * Hidden entirely when there is nothing to choose between: one account on the host
 * and the agent on the default. A picker with a single option is just noise.
 *
 * Switching only rewrites config. CLAUDE_CONFIG_DIR is read by claude at launch, so
 * a running agent keeps the identity it started with -- hence the explicit restart
 * offer rather than pretending the change took effect immediately.
 */
function AccountBadge({ agentId, hostId, provider = 'claude', running = false, onChanged }) {
  const [accounts, setAccounts] = useState(null);
  const [current, setCurrent] = useState(undefined); // undefined = unknown, null = default
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false); // changed, not yet restarted
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const qs = hostId ? `?hostId=${encodeURIComponent(hostId)}` : '';
      const [accRes, agRes] = await Promise.all([
        fetch(`/api/agents/accounts${qs}`),
        fetch(`/api/agents/${agentId}`),
      ]);
      if (accRes.ok) setAccounts(await accRes.json());
      if (agRes.ok) {
        const a = await agRes.json();
        setCurrent((a.config && a.config.claudeConfigDir) || null);
      }
    } catch {
      /* leave the last known state rather than flashing an empty picker */
    }
  }, [agentId, hostId]);

  useEffect(() => { load(); }, [load]);

  // Same clipping problem as the Sherlock card: the chat lives in a Panel with
  // overflow:hidden, so an absolutely positioned popover is cut off at the panel
  // edge. Portal to the body and position from the badge's rect.
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setPos({ top: r.bottom + 4, left, width });
  }, []);

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

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const inBadge = wrapRef.current && wrapRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inBadge && !inPop) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const choose = async (dir) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeConfigDir: dir || '' }),
      });
      if (res.ok) {
        setCurrent(dir || null);
        setPending(true);
        setOpen(false);
        if (onChanged) onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setBusy(true);
    try {
      await fetch(`/api/agents/${agentId}/stop`, { method: 'POST' });
      await fetch(`/api/agents/${agentId}/start`, { method: 'POST' });
      setPending(false);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (provider !== 'claude' || !accounts) return null;
  // Nothing to choose between, and nothing surprising to report.
  if (accounts.length < 2 && !current) return null;

  const mine = accounts.find((a) => a.dir === current);
  const label = current ? (mine ? mine.label : 'custom') : 'Default';
  const isAlt = !!current;

  return (
    <div className="relative flex-shrink-0" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          `Anthropic account: ${label}${mine && mine.detail ? ` (${mine.detail})` : ''}` +
          (pending ? ' — restart to apply' : '') + '\nClick to switch'
        }
        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
          pending
            ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25'
            : isAlt
              ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
              : 'bg-gray-600/40 text-gray-300 hover:bg-gray-600/70'
        }`}
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span className="hidden sm:inline">{label}</span>
        {pending && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
      </button>

      {open && pos && createPortal(
        <div ref={popRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 60 }}>
          <div className="rounded-lg border border-gray-700 bg-gray-900 shadow-xl p-1.5">
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-gray-500">Anthropic account</div>
            {accounts.map((a) => {
              const selected = (a.isDefault && !current) || a.dir === current;
              return (
                <button
                  key={a.dir}
                  type="button"
                  disabled={busy || (!a.loggedIn && !selected)}
                  onClick={() => choose(a.isDefault ? '' : a.dir)}
                  className={`w-full text-left rounded px-2 py-1.5 text-sm flex items-start gap-2 ${
                    selected ? 'bg-gray-700/70 text-white' : 'text-gray-300 hover:bg-gray-800'
                  } ${!a.loggedIn && !selected ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className="w-3 flex-shrink-0 text-emerald-400">{selected ? '✓' : ''}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{a.label}</span>
                    <span className="block text-[11px] text-gray-500 truncate">
                      {a.detail || (a.loggedIn ? a.dir : 'not signed in — run the login first')}
                    </span>
                  </span>
                </button>
              );
            })}
            {pending && (
              <div className="mt-1 border-t border-gray-700 pt-1.5 px-2 pb-1">
                <div className="text-[11px] text-amber-300 mb-1.5">
                  Saved. The account is read when the agent starts, so this applies on restart.
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={restart}
                  className="rounded bg-amber-600/80 hover:bg-amber-600 text-white text-xs px-2.5 py-1 disabled:opacity-50"
                >
                  {busy ? 'Restarting…' : running ? 'Restart now' : 'Start now'}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default AccountBadge;
