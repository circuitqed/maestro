import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { money } from '../lib/swarmFormat';

/**
 * An agent asking for a standing spend envelope.
 *
 * This is a different decision from approving a swarm, and it is the one that
 * removes the per-swarm friction: approving an envelope lets the agent spawn freely
 * up to an amount, for a duration, without coming back each time. So the two
 * numbers are editable here rather than being a yes/no on what was requested --
 * "yes, but $2 not $5" is the common answer, and an approve button that can only
 * ratify the agent's own figure quietly makes the agent set the budget.
 *
 * The REASON is shown in full and never truncated. It is the agent's argument for
 * the money, and it is also the only place a request that does not match what the
 * agent is actually doing would become visible.
 */
function AuthorizationRequestCard({ auth }) {
  const { decideAuthorization, agents } = useApp();
  const [usd, setUsd] = useState(String(auth.requested_usd));
  const [hours, setHours] = useState(() => {
    // The request carries an absolute expiry; show it back as a duration, which is
    // what a person reasons about when deciding.
    const ms = new Date(auth.expires_at.replace(' ', 'T') + 'Z') - new Date(auth.created_at.replace(' ', 'T') + 'Z');
    const h = Math.round(ms / 3600000);
    return String(h > 0 ? h : 8);
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const agent = (agents || []).find((a) => a.id === auth.agent_id);
  const asked = Number(auth.requested_usd);
  const changed = Number(usd) !== asked;

  const decide = async (approved) => {
    setBusy(approved ? 'approve' : 'deny');
    setError('');
    try {
      await decideAuthorization(auth.id, approved, {
        usd: Number(usd),
        hours: Number(hours),
      });
    } catch (err) {
      setError(err.message || 'failed');
      setBusy('');
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-amber-200">
            {agent ? agent.name : `agent ${auth.agent_id}`} is asking for a spend envelope
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            Approving lets it spawn swarms without asking again, until the time runs out
            or the money does.
          </div>
        </div>
        <span className="flex-shrink-0 rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-300">
          awaiting you
        </span>
      </div>

      {auth.reason && (
        <div className="mb-3 rounded bg-black/30 p-2 text-xs text-gray-300 whitespace-pre-wrap break-words">
          {auth.reason}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-400">
          <span className="block mb-1">Amount (USD)</span>
          <input
            type="number" min="0" step="0.50" value={usd}
            onChange={(e) => setUsd(e.target.value)}
            className="w-24 rounded bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100
                       tabular-nums focus:border-amber-500/60 focus:outline-none"
          />
        </label>
        <label className="text-xs text-gray-400">
          <span className="block mb-1">For how long (hours)</span>
          <input
            type="number" min="1" step="1" value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="w-24 rounded bg-gray-800 border border-gray-700 px-2 py-1 text-sm text-gray-100
                       tabular-nums focus:border-amber-500/60 focus:outline-none"
          />
        </label>

        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => decide(false)}
            disabled={!!busy}
            className="rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700/60 disabled:opacity-50"
          >
            {busy === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button
            onClick={() => decide(true)}
            disabled={!!busy || !(Number(usd) > 0) || !(Number(hours) > 0)}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white
                       hover:bg-amber-500 disabled:opacity-50"
          >
            {busy === 'approve' ? 'Approving…' : `Approve ${money(Number(usd))}`}
          </button>
        </div>
      </div>

      {/* Only shown once the figure differs, so the default case stays quiet. */}
      {changed && (
        <div className="mt-2 text-xs text-gray-500">
          It asked for {money(asked)} — you are approving {money(Number(usd))}.
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}

export default AuthorizationRequestCard;
