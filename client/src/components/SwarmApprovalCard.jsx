import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { money } from '../lib/swarmFormat';

/**
 * The one moment a human decides to spend money on a swarm.
 *
 * FLOOR and CEILING are shown as separate numbers because they answer different
 * questions and only one of them is intuitive. The ceiling is what you'd guess
 * (workers x per-worker cap). The floor is the part that surprises people: a worker
 * costs ~$0.15 cold and ~$0.05 warm before it has read a single line, because Claude
 * Code writes a ~31k-token system prompt and this gateway bills cache writes at the
 * output rate. That number is what makes one-worker-per-item visibly uneconomic
 * BEFORE anyone approves it -- which is the whole point of showing it here.
 *
 * The grant's limits sit next to them because approving is not the only brake: the
 * agent was already clamped to these, and seeing them is how you tell "it asked for
 * a sensible batch" from "it asked for 50 and got 4".
 */
function SwarmApprovalCard({ swarm }) {
  const { approveSwarm, cancelSwarm, swarmGlobal } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fewer, setFewer] = useState(null);     // null = picker closed
  const [confirmDeny, setConfirmDeny] = useState(false);

  const est = swarm.estimate || {};
  const grant = swarm.grant;
  const atGrantCeiling = grant && swarm.maxWorkers >= grant.maxWorkers;
  const capacity = swarm.maxWorkers * swarm.itemsPerWorker;

  // Recomputed locally from the same two measured constants the server used, so the
  // numbers under the stepper can never disagree with the ones above it.
  const floorFor = (n) => (n > 0 ? (est.coldStartUsd || 0) + (n - 1) * (est.spawnFloorEach || 0) : 0);
  const ceilingFor = (n) => n * swarm.perWorkerUsd;

  const act = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const Num = ({ label, value, hint, tone = 'text-white' }) => (
    <div title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`font-mono text-sm ${tone}`}>{value}</div>
    </div>
  );

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
            <span className="text-white font-medium truncate">{swarm.name}</span>
            <span className="flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
              swarm
            </span>
          </div>
          <div className="text-xs text-gray-400 mt-0.5 truncate">
            {swarm.spawner ? swarm.spawner.name : 'unknown agent'} wants{' '}
            {swarm.maxWorkers} worker{swarm.maxWorkers === 1 ? '' : 's'}
            {' · '}{swarm.itemsPerWorker} item{swarm.itemsPerWorker === 1 ? '' : 's'} each (up to {capacity})
            {' · '}{swarm.model || 'default model'}
            {' · '}{swarm.perWorkerSeconds}s each
          </div>
        </div>
        <span className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
          needs approval
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
        <Num
          label="Floor"
          value={money(est.floorUsd)}
          tone="text-amber-200"
          hint={`What this costs before any worker reads anything: one ${money(est.coldStartUsd)} cold start plus ${money(est.spawnFloorEach)} for each further worker (measured on this gateway, not estimated).`}
        />
        <Num
          label="Ceiling"
          value={money(est.ceilingUsd)}
          hint={`${swarm.maxWorkers} workers x ${money(swarm.perWorkerUsd)} per-worker cap. Each worker is killed at its own cap.`}
        />
        <Num
          label="Hard cap"
          value={money(swarm.maxSpendUsd)}
          hint="Spawning stops when spent + reserved reaches this, whichever happens first."
        />
        <Num
          label="Grant allows"
          value={grant ? `${grant.maxWorkers}w / ${money(grant.maxSpendUsd)}` : 'no grant'}
          tone={grant ? 'text-gray-300' : 'text-red-400'}
          hint={
            grant
              ? `This agent may ask for at most ${grant.maxWorkers} workers and ${money(grant.maxSpendUsd)}; the request was clamped to that before you saw it.${atGrantCeiling ? ' This request is AT the ceiling.' : ''}`
              : 'The grant was revoked after this swarm was created. Admission will refuse every worker.'
          }
        />
      </div>

      {swarmGlobal && !swarmGlobal.enabled && (
        <p className="text-xs text-red-300 mb-3">
          Swarms are switched off system-wide (the kill switch tripped, or they were never
          enabled). Approving this will not start anything until that is turned back on.
        </p>
      )}
      {!grant && (
        <p className="text-xs text-red-300 mb-3">
          This agent has no swarm grant any more. Approving is harmless but no worker will
          be admitted.
        </p>
      )}

      {fewer !== null && (
        <div className="flex flex-wrap items-center gap-3 mb-3 rounded bg-gray-800/60 p-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFewer((n) => Math.max(1, n - 1))}
              disabled={busy || fewer <= 1}
              className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-40"
            >
              −
            </button>
            <span className="font-mono text-white w-16 text-center">{fewer}w</span>
            <button
              type="button"
              onClick={() => setFewer((n) => Math.min(swarm.maxWorkers - 1, n + 1))}
              disabled={busy || fewer >= swarm.maxWorkers - 1}
              className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-40"
            >
              +
            </button>
          </div>
          <div className="text-xs text-gray-400 font-mono">
            floor {money(floorFor(fewer))} · ceiling {money(ceilingFor(fewer))} ·
            covers up to {fewer * swarm.itemsPerWorker} items
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => act(() => approveSwarm(swarm.id, { maxWorkers: fewer }))}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors disabled:opacity-50"
          >
            Approve {fewer}
          </button>
          <button
            type="button"
            onClick={() => setFewer(null)}
            className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
          >
            Back
          </button>
        </div>
      )}

      {error && <p className="text-red-400 text-sm mb-2">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => act(() => approveSwarm(swarm.id))}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors disabled:opacity-50"
        >
          {busy ? '...' : `Approve ${swarm.maxWorkers}`}
        </button>
        {swarm.maxWorkers > 1 && fewer === null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setFewer(Math.max(1, swarm.maxWorkers - 1))}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors disabled:opacity-50"
          >
            Approve with fewer
          </button>
        )}
        {confirmDeny ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => cancelSwarm(swarm.id))}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors disabled:opacity-50"
            >
              Confirm deny
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeny(false)}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded transition-colors"
            >
              Keep waiting
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDeny(true)}
            className="px-4 py-2 bg-red-600/20 text-red-400 hover:bg-red-600/30 text-sm rounded transition-colors disabled:opacity-50"
          >
            Deny
          </button>
        )}
      </div>
    </div>
  );
}

export default SwarmApprovalCard;
