import React from 'react';
import { useApp } from '../context/AppContext';
import { ago, money, swarmLook } from '../lib/swarmFormat';

/**
 * A swarm, as ONE row.
 *
 * Workers are cattle: 20 of them in the agent list would bury the six agents a human
 * actually talks to, and they are not agents anyway -- they have no session you chat
 * with, no name worth remembering, and a lifetime measured in minutes. At 20 workers
 * the question is never "how is each one" but "which one is stuck", and that question
 * is answered one level down, in the panel this row opens.
 *
 * What the row owes you is the decision: is this costing more than it should, and is
 * anything waiting on me.
 */
function SwarmRow({ swarm }) {
  const { openSwarm, activeSwarm } = useApp();
  const look = swarmLook(swarm);
  const l = swarm.ledger || {};
  const c = swarm.counts || {};
  const selected = activeSwarm && activeSwarm.id === swarm.id;
  const needsYou = (c.failures || 0) + (c.stalled || 0);

  // The gate compares spent + reserved against the cap, so these are never summed
  // into one number for display. A swarm that stops admitting at "$1.20 / $4.00"
  // looks broken; the same swarm at "$1.20 + $2.80 reserved / $4.00" is obvious.
  const costTitle = [
    `${money(l.spent)} spent`,
    `${money(l.reserved)} reserved for ${l.live || 0} live worker(s), each charged at its full ${money(swarm.perWorkerUsd)} ceiling`,
    `cap ${money(l.cap)}`,
    '',
    'Spawning stops when spent + reserved reaches the cap, which is before the cap has actually been spent.',
  ].join('\n');

  return (
    <button
      type="button"
      onClick={() => openSwarm(swarm.id)}
      className={`w-full text-left flex items-center gap-3 py-2 px-3 rounded-lg transition-colors ${
        selected ? 'bg-indigo-500/15 ring-1 ring-indigo-500/40' : 'bg-gray-700/50 hover:bg-gray-700'
      }`}
    >
      {/* State indicator */}
      <span
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${look.dot} ${look.pulse && !swarm.paused ? 'animate-pulse' : ''}`}
        title={look.label}
      />

      <div className="flex-1 min-w-0">
        {/* Same rule as AgentRow, learned the same way: truncate cannot live on the
            flex container, and fixed-width badges on the title line eat the name on a
            390px phone — here they ate it entirely. Identity first; the badges that
            do not fit move down to the metadata line, which is allowed to truncate. */}
        <div className="font-medium text-white text-sm flex items-center gap-1.5 min-w-0">
          <span className="truncate">{swarm.name}</span>
          <span className="hidden sm:inline-flex flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
            swarm
          </span>
          <span className={`flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded ${look.chip}`}>{look.label}</span>
          {/* Compact at every width, including the ~500px dashboard beside an open
              panel: the badge's job is to be noticed, and spelling out "3 needs you"
              there cost enough room to truncate the swarm's name to "dep-a…". The
              breakdown is in the tooltip and spelled out on the line below. */}
          {needsYou > 0 && (
            <span
              className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300"
              title={`${needsYou} worker(s) need you — ${c.failures || 0} failed/over-budget, ${c.stalled || 0} stalled`}
            >
              !{needsYou}
            </span>
          )}
        </div>
        <div className="text-xs text-gray-500 truncate">
          {/* Without the badge above, this is what says "not an agent" on a phone. */}
          <span className="sm:hidden text-indigo-300">swarm · </span>
          {/* Ordered by what you would act on, not by what is tidy: this line
              truncates on a phone and the things that end it are the things nobody
              needs to see first. */}
          <span className="text-gray-400">{c.done || 0}/{swarm.maxWorkers} done</span>
          {(c.failures || 0) > 0 && (
            <>
              <span className="text-gray-600"> · </span>
              <span className="text-red-400">{c.failures} failed</span>
            </>
          )}
          {(c.stalled || 0) > 0 && (
            <>
              <span className="text-gray-600"> · </span>
              <span className="text-fuchsia-300">{c.stalled} stalled</span>
            </>
          )}
          {(l.live || 0) > 0 && (
            <>
              <span className="text-gray-600"> · </span>
              <span className="text-blue-300">{l.live} live</span>
            </>
          )}
          {swarm.items && (
            <>
              <span className="text-gray-600"> · </span>
              <span>{swarm.items.done}/{swarm.items.total} items</span>
            </>
          )}
          <span className="text-gray-600"> · </span>
          <span>{swarm.spawner ? swarm.spawner.name : 'unknown'}</span>
          {swarm.finished && swarm.finishedAgoS !== null && (
            <>
              <span className="text-gray-600"> · </span>
              <span>{ago(swarm.finishedAgoS)}</span>
            </>
          )}
        </div>
      </div>

      {/* Money. Three separate numbers, on purpose. */}
      <div className="flex-shrink-0 text-right font-mono text-xs leading-tight" title={costTitle}>
        <div>
          <span className="text-white">{money(l.spent)}</span>
          <span className="text-gray-500"> + </span>
          <span className="text-amber-300">{money(l.reserved)}</span>
        </div>
        <div className="text-gray-500">of {money(l.cap)}</div>
      </div>

      <svg className="w-4 h-4 text-gray-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}

export default SwarmRow;
