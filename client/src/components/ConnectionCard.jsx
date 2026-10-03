import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drive an interactive SSH login (Sherlock) from the chat.
 *
 * Sherlock wants a password AND a Duo factor, and an agent cannot answer either —
 * Claude's Bash tool is not interactive, so the agent just gets "Permission denied".
 * One human login opens a ControlMaster socket that every later ssh rides for 12h,
 * including the agents'. All this card does is make that login answerable here
 * instead of in a terminal: the prompts are text in a tmux pane, so they can be shown
 * and typed into like anything else.
 *
 * The password field is write-only — it is sent and cleared, never kept in state
 * beyond the keystroke, and ssh does not echo it, so it appears nowhere in the pane.
 */
function ConnectionCard({ id, label, hint, onConnected }) {
  const [status, setStatus] = useState(null); // { connected }
  const [pane, setPane] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const api = useCallback(async (path, options) => {
    const res = await fetch(`/api/connections/${id}${path}`, options);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }, [id]);

  // Poll status, and the login pane while one is in progress. Stops as soon as the
  // master is up — there is nothing left to watch after that.
  useEffect(() => {
    let timer;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api('/status');
        if (cancelled) return;
        setStatus(s);
        if (s.connected) {
          setPane('');
          if (onConnected) onConnected();
        } else {
          const p = await api('/pane').catch(() => ({ text: null }));
          if (!cancelled) setPane(p.text || '');
        }
      } catch {
        /* transient; next tick retries */
      }
      if (!cancelled) timer = setTimeout(tick, 3000);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, onConnected]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err.message); } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const connect = () => act(() => api('/connect', { method: 'POST' }));
  const sendSecret = () => {
    const value = secret;
    setSecret('');           // clear first: it must not linger if the request is slow
    return act(() => api('/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value }),
    }));
  };
  const press = (keys) => act(() => api('/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }));

  if (!status) return null;

  if (status.connected) {
    return (
      <div className="flex justify-start">
        <div className="min-w-0 max-w-[92%] w-full my-1 rounded-lg border border-emerald-500/50 bg-emerald-950/20 px-3 py-2">
          <div className="text-sm text-emerald-200">
            {label} is connected — agents can use it for the next 12 hours without signing in again.
          </div>
        </div>
      </div>
    );
  }

  const paneTail = pane.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
  const loginRunning = !!paneTail;
  // What ssh is asking for right now, so the card shows the relevant control.
  const wantsPassword = /password:/i.test(paneTail);
  const wantsDuo = /duo|passcode|push|phone call|enter a passcode/i.test(paneTail);

  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] w-full my-1 rounded-lg border border-amber-500/50 bg-amber-950/20 px-3 py-2">
        <div className="text-sm text-amber-100 mb-1">
          {label} isn’t connected. An agent can’t sign in itself — it needs one login from you,
          then it rides that connection for 12 hours.
        </div>
        {hint && <div className="text-xs text-amber-200/70 mb-2">{hint}</div>}

        {!loginRunning && (
          <button
            type="button"
            disabled={busy}
            onClick={connect}
            className="rounded bg-amber-600/80 hover:bg-amber-600 text-white text-sm px-3 py-1 disabled:opacity-50"
          >
            {busy ? 'Starting…' : `Connect to ${label}`}
          </button>
        )}

        {loginRunning && (
          <>
            <pre className="text-[11px] font-mono text-gray-300 bg-gray-900/70 border border-gray-700 rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {paneTail}
            </pre>
            {wantsPassword && (
              <form
                className="flex gap-2 mt-2"
                onSubmit={(e) => { e.preventDefault(); if (secret) sendSecret(); }}
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Password (not stored, not echoed)"
                  className="flex-1 min-w-0 rounded bg-gray-900 border border-gray-700 px-2 py-1 text-sm text-gray-100"
                />
                <button
                  type="submit"
                  disabled={busy || !secret}
                  className="rounded bg-amber-600/80 hover:bg-amber-600 text-white text-sm px-3 py-1 disabled:opacity-50"
                >
                  Send
                </button>
              </form>
            )}
            {wantsDuo && !wantsPassword && (
              <div className="flex flex-wrap gap-2 mt-2">
                {['1', '2', '3'].map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={busy}
                    onClick={() => press([n, 'Enter'])}
                    className="rounded border border-amber-500/60 text-amber-100 text-sm px-2.5 py-1 hover:bg-amber-900/40 disabled:opacity-50"
                  >
                    Option {n}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => press(['Enter'])}
                  className="rounded border border-gray-600 text-gray-200 text-sm px-2.5 py-1 hover:bg-gray-700 disabled:opacity-50"
                >
                  Enter
                </button>
              </div>
            )}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
              <button
                type="button"
                onClick={() => act(() => api('/disconnect', { method: 'POST' }))}
                className="hover:text-gray-200"
              >
                Cancel
              </button>
              <span>Waiting on {label}…</span>
            </div>
          </>
        )}

        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
      </div>
    </div>
  );
}

export default ConnectionCard;
