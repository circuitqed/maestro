import React, { useMemo, useState } from 'react';
import { useApp } from '../context/AppContext';
import AgentRow from './AgentRow';
import ProviderIcon from './ProviderIcon';

/**
 * The fleet by machine, rather than by project or by agent.
 *
 * This is the axis the other two views cannot show. When something is wrong it is
 * usually wrong per HOST — a box that stopped answering, a disk filling, a plan
 * pinned to one machine — and answering "what is on garage-wsl right now?" meant
 * reading the host column of a long agent list.
 *
 * It also owns host shells, because that is what you actually want during setup and
 * recovery: a terminal on a specific machine, now, without inventing a project to
 * hang it from. Host shells are deliberately created with NO project — they are
 * utilities, not work, and forcing them into a project misfiles them in every other
 * view.
 */

const STATUS = {
  online: { dot: 'bg-emerald-500', text: 'text-emerald-300', label: 'online' },
  offline: { dot: 'bg-red-500', text: 'text-red-300', label: 'offline' },
  unknown: { dot: 'bg-gray-500', text: 'text-gray-400', label: 'unknown' },
};

function HostCard({ host, agents, onAddShell, onTest, busy }) {
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState(null);

  // The local host has no ssh_target and is reachable by definition — the server is
  // running on it — so it never carries a meaningful status.
  const isLocal = !host.ssh_target;
  const st = STATUS[isLocal ? 'online' : (host.status || 'unknown')] || STATUS.unknown;

  const shells = agents.filter((a) => (a.config?.provider || '') === 'shell');
  const others = agents.filter((a) => (a.config?.provider || '') !== 'shell');
  const live = others.filter((a) => ['running', 'busy', 'idle'].includes(a.status)).length;

  const add = async () => {
    setAdding(true);
    setErr(null);
    try {
      await onAddShell(host);
    } catch (e) {
      setErr(e.message || 'Could not add shell');
    } finally {
      setAdding(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setErr(null);
    try {
      await onTest(host.id);
    } catch (e) {
      setErr(e.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${st.dot}`} title={st.label} />
            <h3 className="text-white font-medium truncate">{host.name}</h3>
            <span className={`text-xs ${st.text}`}>{isLocal ? 'local' : st.label}</span>
          </div>
          <div className="text-xs text-gray-500 mt-0.5 truncate">
            {isLocal ? 'this machine — Maestro runs here' : host.ssh_target}
            {host.default_root && <span className="text-gray-600"> · {host.default_root}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!isLocal && (
            <button
              type="button"
              onClick={test}
              disabled={testing || busy}
              className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
          )}
          <button
            type="button"
            onClick={add}
            disabled={adding || busy}
            title={`Open a new shell on ${host.name}`}
            className="text-xs px-2 py-1 rounded bg-sky-600/80 text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {adding ? 'Starting…' : '+ Shell'}
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-2 text-xs text-red-300 bg-red-500/10 border border-red-500/40 rounded px-2 py-1">
          {err}
        </div>
      )}

      <div className="flex items-center gap-3 text-xs text-gray-400 mb-2">
        <span>{agents.length} agent{agents.length === 1 ? '' : 's'}</span>
        {live > 0 && <span className="text-green-300">{live} up</span>}
        {shells.length > 0 && <span className="text-sky-300">{shells.length} shell{shells.length === 1 ? '' : 's'}</span>}
      </div>

      {shells.length > 0 && (
        <div className="space-y-1">
          {shells.map((a) => <AgentRow key={a.id} agent={a} />)}
        </div>
      )}

      {others.length > 0 && (
        <details className="mt-2 group">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300 select-none">
            {others.length} other agent{others.length === 1 ? '' : 's'} on this host
          </summary>
          <div className="mt-1.5 space-y-1">
            {others.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs text-gray-400 px-2 py-1">
                <ProviderIcon provider={a.config?.provider || 'claude'} className="w-3 h-3 flex-shrink-0" />
                <span className="truncate">{a.name}</span>
                <span className="text-gray-600">{a.status}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function HostsView() {
  const { hosts, agents, createAgent, startAgent, openAgentView, testHost, loadAgents } = useApp();
  const [busy, setBusy] = useState(false);

  const byHost = useMemo(() => {
    const m = new Map();
    for (const h of hosts) m.set(h.id, []);
    for (const a of agents) {
      // host_id null => the local host. Find it by its missing ssh_target rather
      // than by a hardcoded id, which would break on a renamed or reseeded row.
      const localId = (hosts.find((h) => !h.ssh_target) || {}).id;
      const key = a.host_id ?? localId;
      if (m.has(key)) m.get(key).push(a);
    }
    return m;
  }, [hosts, agents]);

  /**
   * Create a shell on this host and open it.
   *
   * No projectId: a host shell is a tool, not project work. The name is suffixed
   * so a second shell on the same host doesn't collide — the server also de-dupes
   * session names against sessions already on the host, so this can't adopt a
   * stranger's tmux session.
   */
  const addShell = async (host) => {
    setBusy(true);
    try {
      const existing = agents.filter(
        (a) => (a.config?.provider || '') === 'shell' && (a.host_id ?? null) === (host.ssh_target ? host.id : null)
      ).length;
      const name = existing === 0 ? `${host.name}-shell` : `${host.name}-shell-${existing + 1}`;
      const created = await createAgent({
        name,
        hostId: host.ssh_target ? host.id : null,
        config: { provider: 'shell' },
        // Start where the host says agents belong; the server creates it if absent.
        workingDir: host.default_root || undefined,
      });
      if (created && created.id) {
        await startAgent(created.id);
        await loadAgents();
        openAgentView({ ...created, screen_session: created.screen_session }, 'terminal');
      }
      return created;
    } finally {
      setBusy(false);
    }
  };

  if (!hosts.length) {
    return <div className="text-sm text-gray-400">No hosts configured yet.</div>;
  }

  // Local first, then alphabetical — the same ordering as the account pickers.
  const ordered = [...hosts].sort((a, b) =>
    !a.ssh_target === !b.ssh_target ? a.name.localeCompare(b.name) : a.ssh_target ? 1 : -1
  );

  return (
    // Single column, matching the Projects view's `space-y-4` stack. Two columns
    // halved the width available to the inline shell rows, which carry a session
    // name, a host label and action buttons and so truncate badly.
    <div className="space-y-4">
      {ordered.map((h) => (
        <HostCard
          key={h.id}
          host={h}
          agents={byHost.get(h.id) || []}
          onAddShell={addShell}
          onTest={testHost}
          busy={busy}
        />
      ))}
    </div>
  );
}
