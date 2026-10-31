import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Sign an additional Anthropic account in on a host, from here.
 *
 * Accounts are per machine: a plan is one subscription with one shared window no
 * matter how many hosts use it, but the CREDENTIAL lives in a config dir on each
 * host, so reaching a plan from a new machine means a login there. Doing that at a
 * terminal is where the damage happens — `claude /login` writes to whatever
 * CLAUDE_CONFIG_DIR the shell has, so adding a second account from a plain pane
 * overwrites the first. The server bakes the dir into the session command, so this
 * path cannot do that (services/accountLogin.js).
 *
 * The flow is Claude's own: pick a login method, open a URL, paste the code back.
 * All of it is pane text, so it is rendered here rather than in a terminal — with the
 * two things a terminal does badly made explicit: the authorize URL becomes a real
 * link, and the numbered menu becomes buttons.
 */

// The authorize URL is ~465 chars of query string. Matching on the scheme and
// stopping at whitespace is enough, and is why the server runs the login pane at
// 1000 columns — narrower and the TUI breaks the URL across lines, producing a link
// that looks complete and is missing `state=`.
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

function extractUrl(text) {
  const all = String(text || '').match(URL_RE) || [];
  // Prefer the OAuth URL over the docs links Claude also prints in its banner.
  return all.find((u) => /oauth|authorize|login/i.test(u)) || null;
}

/** Numbered options Claude is offering, e.g. "1. Claude account with subscription". */
function extractOptions(lines) {
  const out = [];
  for (const l of lines.slice(-18)) {
    const m = /^\s*[❯>]?\s*(\d)[.)]\s+(.{3,70})/.exec(l);
    if (m && !out.some((o) => o.n === m[1])) {
      out.push({ n: m[1], label: m[2].replace(/\s+·.*$/, '').trim() });
    }
  }
  return out.slice(0, 5);
}

// The gateway most of this fleet uses. Prefilled because typing it is the only hard
// part of the token flow, and getting it subtly wrong fails as "rejected token".
const DEFAULT_BASE_URL = 'https://aiapi-prod.stanford.edu';

function AccountLoginCard({ hostId = null, hostName = 'this host', onDone, onCancel, takenNames = [], resumeName = null }) {
  // `resumeName` means a login is already running on the host for that account: pick
  // it up where it was left rather than offering to start a new one.
  const [name, setName] = useState(resumeName || 'work');
  const [kind, setKind] = useState('oauth'); // oauth | token
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [token, setToken] = useState('');
  const [models, setModels] = useState(null);
  const [phase, setPhase] = useState(resumeName ? 'running' : 'name'); // name | running | done
  const [pane, setPane] = useState('');
  const [status, setStatus] = useState(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const api = useCallback(async (path, options) => {
    const sep = path.includes('?') ? '&' : '?';
    const q = `${sep}name=${encodeURIComponent(name)}${hostId ? `&hostId=${encodeURIComponent(hostId)}` : ''}`;
    const res = await fetch(`/api/accounts${path}${q}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }, [name, hostId]);

  // Poll the pane and the credential state while a login is in progress. Stops as
  // soon as a credential lands — there is nothing left to watch after that.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    let timer;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api('/login/status');
        if (cancelled) return;
        setStatus(s);
        if (s.signedIn) {
          setPhase('done');
          // Close the TUI; the credential is written and the process has no further job.
          api('/login/finish', { method: 'POST' }).catch(() => {});
          if (onDone) onDone(s);
          return;
        }
        const p = await api('/login/pane').catch(() => ({ text: null }));
        if (!cancelled) setPane(p.text || '');
      } catch {
        /* transient; next tick retries */
      }
      if (!cancelled) timer = setTimeout(tick, 2500);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [phase, api, onDone]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const start = () => act(async () => {
    await api('/login', { method: 'POST' });
    setPane('');
    setPhase('running');
  });

  // The token path has nothing interactive about it: one request that validates the
  // key against the endpoint and only stores it if the gateway accepts it. The token
  // is cleared from state the moment it is sent, and no response carries it back.
  const saveToken = () => {
    const value = token;
    setToken('');
    return act(async () => {
      const r = await api('/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: baseUrl.replace(/\/+$/, ''), key: value }),
      });
      setModels(r.models || []);
      setStatus({ email: r.detail || baseUrl, signedIn: true });
      setPhase('done');
      if (onDone) onDone(r);
    });
  };

  const send = () => {
    const value = answer;
    setAnswer('');
    return act(() => api('/login/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value }),
    }));
  };

  const press = (keys) => act(() => api('/login/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }));

  const cancel = (discard) => act(async () => {
    await api('/login/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discard }),
    });
    if (onCancel) onCancel();
  });

  const nameTaken = takenNames.includes(name.trim());
  const nameValid = /^[a-z0-9][a-z0-9._-]{0,30}$/.test(name.trim());

  if (phase === 'name') {
    return (
      <div className="rounded border border-gray-700 bg-gray-900/60 p-2.5">
        <div className="text-xs text-gray-300 mb-1.5">
          Sign another Anthropic account in on <span className="text-white">{hostName}</span>.
        </div>
        <div className="text-[11px] text-gray-500 mb-2">
          A plan is shared across machines, but its credential is per machine — so reaching
          a plan from here needs a login here. The config dir is set for you, so this cannot
          overwrite the account already signed in.
        </div>
        <label className="block text-[11px] text-gray-400 mb-1">Name for this account</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="work"
          className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-sm text-gray-100 font-mono"
        />
        <div className="text-[11px] text-gray-600 mt-1">
          Becomes <span className="font-mono">~/.claude-accts/{name || '<name>'}</span>
        </div>

        <div className="mt-2 flex gap-1">
          {[
            { id: 'oauth', label: 'Subscription' },
            { id: 'token', label: 'API token' },
          ].map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => setKind(k.id)}
              className={`flex-1 rounded px-2 py-1 text-[11px] border ${
                kind === k.id
                  ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                  : 'border-gray-700 text-gray-400 hover:bg-gray-800'
              }`}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-gray-600 mt-1">
          {kind === 'oauth'
            ? 'Pro, Max, Team or Enterprise — opens a browser to authorize.'
            : 'A gateway endpoint and bearer token, e.g. the Stanford AI API Gateway.'}
        </div>

        {kind === 'token' && (
          <div className="mt-2 space-y-1.5">
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Base URL</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://gateway.example.edu"
                className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-xs text-gray-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-[11px] text-gray-400 mb-1">Token</label>
              {/* Write-only: sent and cleared, never read back, never echoed. */}
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="sk-…"
                className="w-full rounded bg-gray-900 border border-gray-700 px-2 py-1 text-xs text-gray-100 font-mono"
              />
            </div>
            <div className="text-[11px] text-gray-600">
              Checked against the endpoint before it is stored, from {hostName} — so a
              token the gateway refuses is never written. It is kept out of every command
              line, log and the database; the only copies are the two 600 files it lives in.
            </div>
          </div>
        )}
        {!nameValid && name && (
          <div className="text-[11px] text-amber-400 mt-1">
            Lowercase letters, numbers, dot, dash or underscore.
          </div>
        )}
        {nameTaken && (
          <div className="text-[11px] text-amber-400 mt-1">
            That name already exists on this host — pick another.
          </div>
        )}
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            disabled={busy || !nameValid || nameTaken || (kind === 'token' && (!token || !/^https:\/\//.test(baseUrl)))}
            onClick={kind === 'token' ? saveToken : start}
            className="rounded bg-sky-600/80 hover:bg-sky-600 text-white text-xs px-2.5 py-1 disabled:opacity-50"
          >
            {busy
              ? (kind === 'token' ? 'Checking…' : 'Starting…')
              : (kind === 'token' ? 'Check & save' : 'Start login')}
          </button>
          <button type="button" onClick={onCancel} className="text-xs text-gray-400 hover:text-gray-200 px-1">
            Cancel
          </button>
        </div>
        {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="rounded border border-emerald-500/50 bg-emerald-950/20 p-2.5">
        <div className="text-xs text-emerald-200">
          {models ? 'Token accepted' : 'Signed in'} as{' '}
          <span className="text-white">{status?.email || name}</span> on {hostName}.
        </div>
        <div className="text-[11px] text-emerald-300/70 mt-1">
          Available as <span className="font-mono">{name}</span> in this picker. Pin an agent to it,
          then restart that agent for it to take effect.
        </div>
        {/* The model list is the useful part of a gateway key: this one refuses haiku,
            and finding that out from a 403 mid-task is worse than reading it here. */}
        {models && models.length > 0 && (
          <div className="text-[11px] text-emerald-300/60 mt-1.5">
            <div className="text-emerald-300/80">Models this token may use:</div>
            <div className="font-mono break-words">{models.join(', ')}</div>
          </div>
        )}
      </div>
    );
  }

  const lines = pane.split('\n').filter((l) => l.trim());
  const url = extractUrl(pane);
  const options = extractOptions(lines);
  const lastLines = lines.slice(-6).join('\n');
  const wantsCode = /paste code|authorization code|enter the code/i.test(pane);

  return (
    <div className="rounded border border-sky-500/50 bg-sky-950/20 p-2.5">
      <div className="text-xs text-sky-100 mb-2">
        Signing in <span className="font-mono text-white">{name}</span> on {hostName}
        {status && !status.running && <span className="text-sky-300/70"> · starting…</span>}
      </div>

      {url && (
        <div className="mb-2">
          <div className="text-[11px] text-sky-200/80 mb-1">Open this to authorize, then paste the code back:</div>
          <div className="flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex-1 min-w-0 truncate rounded bg-gray-900 border border-sky-700/60 px-2 py-1 text-[11px] text-sky-300 hover:text-sky-200 font-mono"
            >
              {url}
            </a>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(url)}
              title="Copy the authorize URL"
              className="rounded border border-gray-600 text-gray-300 text-[11px] px-2 py-1 hover:bg-gray-700"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {options.length > 0 && !wantsCode && (
        <div className="mb-2">
          <div className="text-[11px] text-sky-200/80 mb-1">Choose a login method:</div>
          <div className="flex flex-col gap-1">
            {options.map((o) => (
              <button
                key={o.n}
                type="button"
                disabled={busy}
                onClick={() => press([o.n])}
                className="text-left rounded border border-sky-600/50 text-sky-100 text-xs px-2 py-1 hover:bg-sky-900/40 disabled:opacity-50"
              >
                {o.n}. {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The raw pane stays visible: this drives a real TUI, and when it asks
          something unanticipated, seeing it is the difference between a stuck card
          and an obvious next step. */}
      {lastLines && (
        <pre className="text-[10px] font-mono text-gray-400 bg-gray-900/70 border border-gray-700 rounded p-1.5 overflow-x-auto whitespace-pre-wrap max-h-28">
          {lastLines}
        </pre>
      )}

      <form className="flex gap-2 mt-2" onSubmit={(e) => { e.preventDefault(); if (answer) send(); }}>
        <input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={wantsCode ? 'Paste the code from the browser' : 'Type an answer'}
          autoComplete="off"
          className="flex-1 min-w-0 rounded bg-gray-900 border border-gray-700 px-2 py-1 text-xs text-gray-100 font-mono"
        />
        <button
          type="submit"
          disabled={busy || !answer}
          className="rounded bg-sky-600/80 hover:bg-sky-600 text-white text-xs px-2.5 py-1 disabled:opacity-50"
        >
          Send
        </button>
      </form>

      <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
        <button type="button" onClick={() => press(['Enter'])} className="hover:text-gray-200">Enter</button>
        <button type="button" onClick={() => cancel(true)} className="hover:text-gray-200">Cancel &amp; discard</button>
        <span className="text-gray-600">waiting on Claude…</span>
      </div>

      {error && <div className="mt-2 text-[11px] text-red-400">{error}</div>}
    </div>
  );
}

export default AccountLoginCard;
