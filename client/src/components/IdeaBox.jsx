import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import VoiceButton from './VoiceButton';
import useMediaQuery from '../hooks/useMediaQuery';

/**
 * One sentence in, a running agent out (server/services/spawn.js).
 *
 * Type or dictate the idea, then "Draft". The card shows what Maestro proposes:
 * name, machine, project, account and the first message. Every field can be changed.
 * "Start" does all the setup: directory, git, connectors off, trust, yap. Then it
 * opens the new agent's chat.
 */

async function post(path, body) {
  const res = await fetch(`/api/spawn${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const field = 'w-full rounded bg-gray-900 border border-gray-600 px-2.5 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500';
const label = 'block text-[11px] uppercase tracking-wide text-gray-400 mb-1';

export default function IdeaBox() {
  const { projects, loadProjects, loadAgents, openAgentView } = useApp();
  const [idea, setIdea] = useState('');
  const [card, setCard] = useState(null);
  const [hosts, setHosts] = useState([]);
  const [accounts, setAccounts] = useState(null); // for card.hostId
  const [phase, setPhase] = useState('idle'); // idle | drafting | starting
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const inputRef = useRef(null);
  // A shorter placeholder on phones, where the long one wrapped to two lines at 16px.
  const isMobile = useMediaQuery('(max-width: 767px)');

  useEffect(() => {
    fetch('/api/hosts', { credentials: 'include' }).then((r) => r.json()).then((h) => setHosts(Array.isArray(h) ? h : [])).catch(() => {});
  }, []);

  // Accounts signed in on the chosen machine, for the account picker.
  useEffect(() => {
    if (!card) return undefined;
    let live = true; // a slower reply for the previous machine must not win
    setAccounts(null);
    fetch(`/api/agents/accounts?hostId=${encodeURIComponent(card.hostId)}`, { credentials: 'include' })
      .then((r) => r.json()).then((a) => { if (live) setAccounts(Array.isArray(a) ? a : []); })
      .catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, [card && card.hostId]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, and the box is border-box: setting height to
    // scrollHeight alone came up 2px short, so the field scrolled and clipped its top line.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, 128)}px`;
  }, [idea]);

  const makeDraft = async () => {
    if (!idea.trim() || phase !== 'idle') return;
    setPhase('drafting'); setError(''); setDone(null);
    try { setCard(await post('/draft', { idea })); }
    catch (e) { setError(e.message); }
    finally { setPhase('idle'); }
  };

  const start = async () => {
    setPhase('starting'); setError('');
    try {
      const out = await post('/go', card);
      setDone(out);
      setCard(null);
      setIdea('');
      await Promise.all([loadProjects(), loadAgents()]);
      if (out.agent) openAgentView(out.agent, 'chat');
    } catch (e) {
      setError(e.message);
    } finally {
      setPhase('idle');
    }
  };

  const set = (k) => (e) => setCard((c) => ({ ...c, [k]: e.target.value }));
  const host = card && hosts.find((h) => h.id === Number(card.hostId));

  return (
    <div className="bg-gray-800 rounded-lg p-3 mb-4 border border-gray-700">
      {/* Phones: the field takes the whole first row, mic and Draft go underneath. On
          md+ it is one row: mic, field, Draft. */}
      <div className="flex flex-wrap md:flex-nowrap items-end gap-2">
        <VoiceButton value={idea} onChange={setIdea} inputRef={inputRef} disabled={phase !== 'idle'} />
        <textarea
          ref={inputRef}
          rows={1}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); makeDraft(); } }}
          placeholder={isMobile ? 'New agent: what should it do?' : 'New agent: describe what it should do…'}
          className="order-first basis-full md:order-none md:basis-auto flex-1 min-w-0 min-h-[38px] max-h-32 resize-none rounded bg-gray-900 border border-gray-600 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          type="button"
          onClick={makeDraft}
          disabled={!idea.trim() || phase !== 'idle'}
          className="ml-auto md:ml-0 flex-shrink-0 px-4 md:px-3 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {phase === 'drafting' ? 'Drafting…' : 'Draft'}
        </button>
      </div>

      {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
      {done && (
        <p className="mt-2 text-sm text-emerald-300">
          Started {done.agent && done.agent.name} in {done.dir}{done.yap ? ', on yap' : ' (yap token failed; issue it by hand)'}{done.web ? `, at ${done.web.url} (port ${done.web.port})` : ''}.
        </p>
      )}

      {card && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className={label}>Name</span>
            <input className={field} value={card.name} onChange={set('name')} />
          </div>
          <div>
            <span className={label}>Machine{card.why ? ` · ${card.why}` : ''}</span>
            <select className={field} value={card.hostId} onChange={(e) => setCard((c) => ({ ...c, hostId: Number(e.target.value), claudeConfigDir: undefined }))}>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>{h.name}{h.status === 'offline' ? ' (offline)' : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <span className={label}>Project</span>
            <select
              className={field}
              value={card.projectId ?? ''}
              onChange={(e) => setCard((c) => ({ ...c, projectId: e.target.value ? Number(e.target.value) : null }))}
            >
              <option value="">New project: {card.projectName}</option>
              {/* The drafted project, even before the project list has loaded. */}
              {card.projectId && !projects.some((p) => p.id === card.projectId) && (
                <option value={card.projectId}>{card.existingProjectName || `project ${card.projectId}`}</option>
              )}
              {[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <span className={label}>Account</span>
            <select
              className={field}
              value={card.claudeConfigDir === undefined ? '__auto' : (card.claudeConfigDir || '')}
              onChange={(e) => setCard((c) => ({ ...c, claudeConfigDir: e.target.value === '__auto' ? undefined : e.target.value }))}
            >
              {card.claudeConfigDir === undefined && <option value="__auto">What most agents on {host ? host.name : 'it'} use</option>}
              {(accounts || []).filter((a) => a.usable !== false).map((a) => (
                <option key={a.dir || 'default'} value={a.isDefault ? '' : a.dir}>{a.label || a.dir}{a.isDefault && !/default/i.test(a.label || '') ? ' (default)' : ''}</option>
              ))}
              {accounts === null && <option disabled>Loading…</option>}
            </select>
          </div>
          <div>
            <span className={label}>Web address (blank = none)</span>
            <input
              className={field}
              value={card.url || ''}
              onChange={set('url')}
              placeholder="name.circuitqed.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div>
            <span className={label}>Who can open it</span>
            <select className={field} value={card.access || 'lab'} onChange={set('access')} disabled={!(card.url || '').trim()}>
              <option value="lab">Lab: Stanford Google accounts + you</option>
              <option value="dave">Only you</option>
              <option value="anyone">Anyone with a Google account</option>
              <option value="public">Public, no login</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <span className={label}>First message</span>
            <textarea className={`${field} min-h-[80px]`} value={card.firstPrompt} onChange={set('firstPrompt')} />
          </div>
          <div className="sm:col-span-2">
            <span className={label}>Yap card</span>
            <input className={field} value={card.description} onChange={set('description')} />
          </div>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={start}
              disabled={phase !== 'idle' || !card.name.trim()}
              className="px-4 py-2 text-sm font-medium rounded bg-green-600 text-white hover:bg-green-500 disabled:opacity-40"
            >
              {phase === 'starting' ? 'Starting…' : 'Start agent'}
            </button>
            <button type="button" onClick={() => setCard(null)} disabled={phase === 'starting'} className="px-3 py-2 text-sm rounded bg-gray-700 text-gray-200 hover:bg-gray-600">
              Discard
            </button>
            <span className="text-xs text-gray-500">
              Sets up its folder and git, turns the claude.ai connectors off, trusts the folder and puts it on yap{(card.url || '').trim() ? `, and routes https://${card.url.trim()} to a port it is given` : ''}.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
