import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AccountLoginCard from './AccountLoginCard';
import { useApp } from '../context/AppContext';

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
// What "account" means for each harness. Claude relocates just its config dir
// (CLAUDE_CONFIG_DIR); agy has no such knob, so an account is a whole HOME — see
// services/geminiAccounts.js. Keeping the difference in one table lets the rest of
// this component stay provider-agnostic instead of growing a second copy.
const ACCOUNT_SHAPE = {
  claude: { field: 'claudeConfigDir', activeField: 'activeClaudeConfigDir', label: 'Anthropic account' },
  antigravity: { field: 'agyHome', activeField: 'activeAgyHome', label: 'Google account' },
};

function AccountBadge({ agentId, hostId, hostName, provider = 'claude', running = false, onChanged }) {
  const shape = ACCOUNT_SHAPE[provider];
  const [accounts, setAccounts] = useState(null);
  const [current, setCurrent] = useState(undefined); // undefined = unknown, null = default
  const [open, setOpen] = useState(false);
  // Whether the inline "sign in another account" card is showing. Widens the popover,
  // because the card carries a URL and an input and is unusable at menu width.
  const [adding, setAdding] = useState(false);
  // Resolved here rather than threaded through TerminalPanel and TerminalModal, which
  // both render this badge and neither of which currently reads `hosts`. A null hostId
  // means the local host, found by its missing ssh_target rather than a hardcoded id.
  const { hosts } = useApp();
  const resolvedHostName =
    hostName
    || (hostId
      ? (hosts || []).find((h) => h.id === hostId)?.name
      : (hosts || []).find((h) => !h.ssh_target)?.name)
    || 'this host';
  const [pos, setPos] = useState(null);
  const [busy, setBusy] = useState(false);
  // What the RUNNING session was started with. Compared against `current` (what it
  // is configured to use next) to decide whether a restart is outstanding.
  //
  // This used to be a local boolean set when you switched accounts, which meant the
  // marker was lost on any re-render -- restarting one agent re-fetched the agent
  // list, remounted the badge, and every other agent's "restart to apply" silently
  // disappeared while those sessions kept billing the old account.
  const [active, setActive] = useState(undefined);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const load = useCallback(async () => {
    try {
      if (!shape) return;
      const params = new URLSearchParams();
      if (hostId) params.set('hostId', String(hostId));
      params.set('provider', provider);
      const [accRes, agRes] = await Promise.all([
        fetch(`/api/agents/accounts?${params}`),
        fetch(`/api/agents/${agentId}`),
      ]);
      if (accRes.ok) setAccounts(await accRes.json());
      if (agRes.ok) {
        const a = await agRes.json();
        setCurrent((a.config && a.config[shape.field]) || null);
        setActive((a.config && a.config[shape.activeField]) || null);
      }
    } catch {
      /* leave the last known state rather than flashing an empty picker */
    }
  }, [agentId, hostId, provider, shape]);

  useEffect(() => { load(); }, [load]);

  // Same clipping problem as the Sherlock card: the chat lives in a Panel with
  // overflow:hidden, so an absolutely positioned popover is cut off at the panel
  // edge. Portal to the body and position from the badge's rect.
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(adding ? 440 : 340, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    setPos({ top: r.bottom + 4, left, width });
  }, [adding]);

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

  // Closing the picker abandons an unstarted login, so reopening lands on the menu
  // rather than halfway through a form. A login already in progress is unaffected —
  // it lives in a tmux session on the host, and reopening re-attaches to it.
  useEffect(() => { if (!open) setAdding(false); }, [open]);

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
        body: JSON.stringify({ [shape.field]: dir || '' }),
      });
      if (res.ok) {
        // No local "pending" flag: `current !== active` is now what says a restart
        // is outstanding, and it survives re-renders, reloads and other agents
        // being restarted.
        setCurrent(dir || null);
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
      await load();   // the server now knows what it restarted as; believe it
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  // A restart is outstanding when the configured account differs from the one the
  // live session was started with. Only meaningful while it is running: a stopped
  // agent will pick up the new account whenever it next starts.
  // `active === undefined` means the agent predates this tracking -- treat that as
  // "no claim", because inventing a mismatch would nag on every old agent.
  const pending = !!running && active !== undefined && (current || null) !== (active || null);

  if (!shape || !accounts || accounts.length === 0) return null;
  // Deliberately NOT hidden when the host has only one account. Hiding it seemed
  // tidy -- a picker with one option is noise -- but it makes the feature vanish
  // exactly when someone goes looking for it: accounts are per host, so an agent on
  // a machine where the second account has not been signed in yet showed no control
  // at all, and the only available reading was "this is broken". Showing which
  // account it is, plus why there is nothing to switch to, is the useful answer.

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
          `${shape.label}: ${label}${mine && mine.detail ? ` (${mine.detail})` : ''}` +
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
            <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-gray-500">{shape.label}</div>
            {accounts.map((a) => {
              const selected = (a.isDefault && !current) || a.dir === current;
              return (
                <button
                  key={a.dir}
                  type="button"
                  // Gate on `usable`, not `loggedIn`: a credential file can exist and
                  // hold an hours-dead token. An expired token with a refresh token is
                  // still usable (Claude refreshes it on start) and must stay
                  // selectable — pinning an agent to it is how it gets refreshed.
                  disabled={busy || (!a.usable && !selected)}
                  onClick={() => choose(a.isDefault ? '' : a.dir)}
                  className={`w-full text-left rounded px-2 py-1.5 text-sm flex items-start gap-2 ${
                    selected ? 'bg-gray-700/70 text-white' : 'text-gray-300 hover:bg-gray-800'
                  } ${!a.usable && !selected ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className="w-3 flex-shrink-0 text-emerald-400">{selected ? '✓' : ''}</span>
                  <span className="min-w-0">
                    <span className="block truncate">
                      {a.label}
                      {a.tokenExpired && (
                        <span className="ml-1.5 text-[10px] text-amber-400">stale</span>
                      )}
                    </span>
                    <span className={`block text-[11px] truncate ${a.tokenExpired ? 'text-amber-500/80' : 'text-gray-500'}`}>
                      {a.detail || (a.loggedIn ? a.dir : 'not signed in — run the login first')}
                    </span>
                  </span>
                </button>
              );
            })}
            {/*
              Adding an account used to be a sentence telling you to go and do it
              somewhere else, which is the one place it should not be done: at a
              terminal, `claude /login` writes to whatever CLAUDE_CONFIG_DIR the
              shell has, so adding a second account overwrites the first. The card
              has the dir set for it, so the safe route is now the easy one.
            */}
            {!pending && !adding && (
              <div className="mt-1 border-t border-gray-700 pt-1.5 px-1 pb-0.5">
                {accounts.length < 2 && (
                  <div className="px-1 pb-1 text-[11px] text-gray-500">
                    Only this account is signed in here. A plan is shared across machines,
                    but its credential is per machine.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="w-full text-left rounded px-2 py-1.5 text-xs text-sky-300 hover:bg-gray-800"
                >
                  + Sign in another account…
                </button>
              </div>
            )}
            {adding && (
              <div className="mt-1 border-t border-gray-700 pt-1.5 px-1 pb-1">
                <AccountLoginCard
                  hostId={hostId}
                  hostName={resolvedHostName}
                  takenNames={accounts.filter((a) => !a.isDefault).map((a) => a.label)}
                  onCancel={() => setAdding(false)}
                  onDone={() => { load(); }}
                />
              </div>
            )}
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
