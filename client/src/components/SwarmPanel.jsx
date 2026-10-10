import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { ago, attentionLook, money, remaining, secs, swarmLook, workerLook } from '../lib/swarmFormat';

const POLL_MS = 2000;
// Two missed polls. Below that the label would flicker between fresh and stale on
// ordinary jitter; above it, a frozen panel gets to look live for too long.
const STALE_S = 6;

function Band({ title, count, children, tone = 'text-gray-400' }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-[11px] font-semibold uppercase tracking-wider ${tone}`}>{title}</span>
        {count !== undefined && <span className="text-[11px] text-gray-600">({count})</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Which brake is on, said in words.
 *
 * A swarm that is approved, has spent nothing and is spawning nothing looks identical
 * to a swarm that is broken -- and in every comparable product that confusion is the
 * most-reported defect. Every one of these states is the system working correctly, so
 * each gets its own sentence rather than an empty screen.
 */
function Brakes({ swarm, events, global: g }) {
  const notes = [];
  if (swarm.state === 'halted') {
    notes.push(['red', `Halted: ${swarm.haltReason || 'no reason recorded'}`]);
  } else if (swarm.state === 'cancelled') {
    notes.push(['gray', swarm.haltReason || 'Cancelled.']);
  } else if (swarm.paused) {
    notes.push(['amber', 'Paused. Workers already running finish; no new ones start.']);
  }
  if (g && !g.enabled) {
    notes.push(['red', 'Swarms are off system-wide — the kill switch is tripped. Nothing will spawn until it is turned back on.']);
  } else if (g && g.spentToday >= g.dailyCap) {
    notes.push(['amber', `Today's cap is spent (${money(g.spentToday)} of ${money(g.dailyCap)}). Nothing spawns until it rolls over.`]);
  } else if (g && g.liveWorkers >= g.maxLiveWorkers) {
    notes.push(['amber', `${g.liveWorkers}/${g.maxLiveWorkers} workers live across all swarms — this one is queued behind them.`]);
  }
  // The runner records one `waiting_*` event per episode, which is the only place a
  // per-swarm refusal (its own spend cap, its own concurrency) is ever written down.
  const waiting = (events || []).find((e) => e.kind.startsWith('waiting_'));
  if (waiting && swarm.state === 'running' && !swarm.paused) {
    notes.push(['gray', `Waiting: ${waiting.note || waiting.kind.replace('waiting_', '')} (${ago(waiting.agoS)})`]);
  }
  if (!notes.length) return null;

  const tones = {
    red: 'border-red-500/40 bg-red-500/5 text-red-300',
    amber: 'border-amber-500/40 bg-amber-500/5 text-amber-200',
    gray: 'border-gray-600 bg-gray-800/60 text-gray-300',
  };
  return (
    <div className="space-y-2 mb-4">
      {notes.map(([tone, text], i) => (
        <p key={i} className={`text-xs rounded border px-2.5 py-2 ${tones[tone]}`}>{text}</p>
      ))}
    </div>
  );
}

function WorkerChip({ state }) {
  const look = workerLook(state);
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-[11px] px-1.5 py-0.5 rounded ${look.chip}`}
      title={look.hint}
    >
      <span className="font-mono">{look.icon}</span>
      {look.label}
    </span>
  );
}

/**
 * The panel a swarm opens into.
 *
 * The primary band is NEEDS YOU, not the worker list, because the list stops being
 * readable at about six rows and a swarm is twenty. The full table is kept below it
 * for the times you really do want to scan everything (a grid view is deferred).
 *
 * Liveness here is a 2s poll, not a socket, so the header says how old the data is.
 * A panel that silently stops updating is worse than one that admits it: the numbers
 * on screen are money and a human will act on them.
 */
function SwarmPanel({ swarmId, onClose }) {
  const { fetchSwarm, pauseSwarm, cancelSwarm, setSwarmConcurrency, openTerminal } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [fetchedAt, setFetchedAt] = useState(null);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [open, setOpen] = useState({});     // workerId -> result expanded
  const [allEvents, setAllEvents] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async (signal) => {
    if (inFlight.current) return; // a slow poll must not stack another on top of it
    inFlight.current = true;
    try {
      const next = await fetchSwarm(swarmId, signal);
      setData(next);
      setFetchedAt(Date.now());
      setError('');
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      inFlight.current = false;
    }
  }, [fetchSwarm, swarmId]);

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setFetchedAt(null);
    refresh(ctrl.signal);
    const id = setInterval(() => refresh(ctrl.signal), POLL_MS);
    return () => { clearInterval(id); ctrl.abort(); };
  }, [refresh]);

  // Re-render once a second so "as of 4s ago" counts up even when the poll is dead --
  // which is exactly when that number matters.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const act = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const staleS = fetchedAt === null ? null : Math.round((Date.now() - fetchedAt) / 1000);
  const stale = error || (staleS !== null && staleS > STALE_S);

  const header = (
    <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 bg-gray-800 border-b border-gray-700">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-white font-medium text-sm truncate min-w-0">
          {data ? data.name : 'swarm'}
        </span>
        {data && (
          <span className={`flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded ${swarmLook(data).chip}`}>
            {swarmLook(data).label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span
          className={`text-[11px] ${stale ? 'text-amber-300' : 'text-gray-500'}`}
          title={error ? `Last poll failed: ${error}` : `Polled every ${POLL_MS / 1000}s`}
        >
          {fetchedAt === null ? 'loading…' : `as of ${ago(staleS)}`}{error ? ' · retrying' : ''}
        </span>
        <button
          onClick={onClose}
          className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors flex-shrink-0"
          title="Close"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0 w-full bg-gray-900 border-l border-gray-700">
        {header}
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500 p-4 text-center">
          {error || 'Loading swarm…'}
        </div>
      </div>
    );
  }

  const l = data.ledger || {};
  const c = data.counts || {};
  const workers = data.workers || [];
  const attention = workers.filter((w) => w.attention);
  const withResults = workers.filter((w) => w.resultChars > 0);
  const events = data.events || [];
  const finished = data.finished;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 w-full bg-gray-900 border-l border-gray-700">
      {header}

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {/* ------------------------------------------------------------ summary */}
        <div className="rounded-lg bg-gray-800/60 p-3 mb-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3 text-sm">
            <span className="text-white font-mono">{c.done || 0}/{data.maxWorkers} done</span>
            {data.items && (
              <span className="text-gray-400 font-mono">{data.items.done}/{data.items.total} items</span>
            )}
            <span className="text-blue-300 font-mono">{l.live || 0} live</span>
            {(c.failures || 0) > 0 && <span className="text-red-400 font-mono">{c.failures} failed</span>}
            {(c.stalled || 0) > 0 && <span className="text-fuchsia-300 font-mono">{c.stalled} stalled</span>}
            {(c.cancelled || 0) > 0 && <span className="text-gray-500 font-mono">{c.cancelled} cancelled</span>}
          </div>

          {/* Spent and reserved stay separate everywhere, for the same reason as the
              row: the gate adds them, so a swarm stops spawning with money that
              looks unspent. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs mb-3">
            <span title="Reported by workers that have finished.">
              <span className="text-gray-500">spent </span>
              <span className="text-white">{money(l.spent)}</span>
            </span>
            <span title={`${l.live || 0} live worker(s), each charged at its full ${money(data.perWorkerUsd)} ceiling until it reports.`}>
              <span className="text-gray-500">reserved </span>
              <span className="text-amber-300">{money(l.reserved)}</span>
            </span>
            <span title="Spawning stops when spent + reserved reaches this.">
              <span className="text-gray-500">cap </span>
              <span className="text-gray-300">{money(l.cap)}</span>
            </span>
            <span className="text-gray-500">
              {money(data.perWorkerUsd)} / {data.perWorkerSeconds}s each
              {data.model ? ` · ${data.model}` : ''}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Concurrency: the cheapest brake there is, and the only one worth
                reaching for mid-flight -- it slows spend without losing work. */}
            <div className="flex items-center gap-1" title="How many of this swarm's workers may run at once.">
              <span className="text-xs text-gray-500 mr-1">concurrency</span>
              <button
                type="button"
                disabled={busy || finished || data.maxConcurrent <= 1}
                onClick={() => act(() => setSwarmConcurrency(data.id, data.maxConcurrent - 1))}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-40"
              >
                −
              </button>
              <span className="font-mono text-sm text-white w-10 text-center">{data.maxConcurrent}</span>
              <button
                type="button"
                disabled={busy || finished || data.maxConcurrent >= data.maxWorkers}
                onClick={() => act(() => setSwarmConcurrency(data.id, data.maxConcurrent + 1))}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-40"
              >
                +
              </button>
            </div>

            {!finished && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => pauseSwarm(data.id, !data.paused))}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50 ${
                  data.paused
                    ? 'bg-green-600/20 text-green-400 hover:bg-green-600/30'
                    : 'bg-amber-600/20 text-amber-300 hover:bg-amber-600/30'
                }`}
              >
                {data.paused ? 'Resume' : 'Pause'}
              </button>
            )}

            {!finished && (confirmCancel ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(() => cancelSwarm(data.id))}
                  className="px-3 py-1 text-xs font-medium rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                >
                  Confirm cancel
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCancel(false)}
                  className="px-3 py-1 text-xs font-medium rounded bg-gray-600 hover:bg-gray-700 text-white"
                >
                  Keep running
                </button>
                <span className="text-[11px] text-gray-500">
                  live workers finish on their own — the runner kills their sessions
                </span>
              </>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmCancel(true)}
                className="px-3 py-1 text-xs font-medium rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50"
              >
                Cancel all
              </button>
            ))}

            <span className="text-[11px] text-gray-600 ml-auto">
              {data.spawner ? data.spawner.name : 'unknown'} · started {ago(data.createdAgoS)}
            </span>
          </div>
        </div>

        <Brakes swarm={data} events={events} global={data.global} />

        {/* ----------------------------------------------------------- needs you */}
        <Band title="Needs you" count={attention.length} tone={attention.length ? 'text-fuchsia-300' : 'text-gray-500'}>
          {attention.length === 0 ? (
            <p className="text-xs text-gray-500">
              Nothing needs you — {l.live || 0} running, {c.done || 0} done
              {(c.cancelled || 0) > 0 ? `, ${c.cancelled} cancelled` : ''}.
            </p>
          ) : (
            <div className="space-y-2">
              {attention.map((w) => {
                const look = attentionLook(w.attention) || workerLook(w.state);
                return (
                  <div key={w.id} className="rounded-lg bg-gray-800 border border-gray-700 p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded ${look.chip}`} title={look.hint}>
                        <span className="font-mono">{look.icon}</span>
                        {look.label}
                      </span>
                      <span className="font-mono text-sm text-white">#{w.idx}</span>
                      {w.attention === 'stalled' && <WorkerChip state={w.state} />}
                      <span className="text-xs text-gray-500">
                        {w.attention === 'stalled'
                          ? `${secs(w.ageS)} old${w.remainingS !== null ? ` · ${remaining(w.remainingS)}` : ''}`
                          : `${w.costUsd !== null ? money(w.costUsd) : 'no cost reported'} · ${ago(w.finishedAgoS)}`}
                      </span>
                      <div className="ml-auto flex items-center gap-1.5">
                        {w.session && (
                          <button
                            type="button"
                            onClick={() => openTerminal(w.session, null)}
                            className="px-2 py-1 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-white"
                            title={`Attach to ${w.session}. Read-only in practice — the worker is headless.`}
                          >
                            Open session
                          </button>
                        )}
                        {(w.resultChars > 0 || w.errorSignature) && (
                          <button
                            type="button"
                            onClick={() => setOpen((o) => ({ ...o, [w.id]: !o[w.id] }))}
                            className="px-2 py-1 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-white"
                          >
                            {open[w.id] ? 'Hide' : 'Details'}
                          </button>
                        )}
                      </div>
                    </div>
                    {(w.terminalReason || w.errorSignature) && (
                      <div className="mt-1.5 text-xs text-gray-400 font-mono truncate" title={w.terminalReason || ''}>
                        {w.errorSignature || w.terminalReason}
                      </div>
                    )}
                    {open[w.id] && (
                      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-gray-300 bg-gray-900 rounded p-2">
                        {w.result || w.promptPreview || '(nothing reported)'}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Band>

        {/* ------------------------------------------------------------- workers */}
        <Band title="All workers" count={workers.length}>
          {workers.length === 0 ? (
            <p className="text-xs text-gray-500">
              No workers yet. {data.state === 'pending_approval' ? 'This swarm has not been approved.' : 'The runner admits them a few at a time.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-gray-700">
              <table className="w-full text-xs">
                <thead className="bg-gray-800 text-gray-400">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5">#</th>
                    <th className="text-left font-medium px-2 py-1.5">state</th>
                    <th className="text-right font-medium px-2 py-1.5">cost</th>
                    <th className="text-left font-medium px-2 py-1.5">time</th>
                    <th className="text-left font-medium px-2 py-1.5">note</th>
                    <th className="text-left font-medium px-2 py-1.5">session</th>
                  </tr>
                </thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.id} className="border-t border-gray-700/70">
                      <td className="px-2 py-1.5 font-mono text-gray-300">{w.idx}</td>
                      <td className="px-2 py-1.5"><WorkerChip state={w.state} /></td>
                      <td className="px-2 py-1.5 text-right font-mono text-gray-300">
                        {w.costUsd === null ? '—' : money(w.costUsd)}
                      </td>
                      {/* Live workers are counting down to a kill; finished ones are
                          counting up since they stopped. One column, because they are
                          never both, but never the same number. */}
                      <td className="px-2 py-1.5 font-mono text-gray-500 whitespace-nowrap">
                        {w.remainingS !== null
                          ? remaining(w.remainingS)
                          : (w.finishedAgoS !== null ? ago(w.finishedAgoS) : secs(w.ageS))}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 max-w-[12rem] truncate" title={w.terminalReason || ''}>
                        {w.errorSignature || w.terminalReason || (w.resultChars ? `${w.resultChars} chars` : '')}
                      </td>
                      <td className="px-2 py-1.5">
                        {w.session ? (
                          <button
                            type="button"
                            onClick={() => openTerminal(w.session, null)}
                            className="font-mono text-gray-400 hover:text-white truncate max-w-[12rem]"
                            title={`Attach to ${w.session}`}
                          >
                            {w.session}
                          </button>
                        ) : <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Band>

        {/* ------------------------------------------------------------- results */}
        <Band title="Results" count={withResults.length}>
          {withResults.length === 0 ? (
            <p className="text-xs text-gray-500">
              Nothing reported yet. Workers report once, when they finish.
            </p>
          ) : (
            <div className="space-y-2">
              {withResults.map((w) => (
                <div key={w.id} className="rounded-lg bg-gray-800 border border-gray-700">
                  <button
                    type="button"
                    onClick={() => setOpen((o) => ({ ...o, [w.id]: !o[w.id] }))}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
                  >
                    <span className="font-mono text-sm text-white">#{w.idx}</span>
                    <WorkerChip state={w.state} />
                    <span className="text-xs text-gray-500">{w.resultChars} chars</span>
                    {w.costUsd !== null && <span className="text-xs text-gray-500 font-mono">{money(w.costUsd)}</span>}
                    <span className="ml-auto text-gray-500 text-xs">{open[w.id] ? '▾' : '▸'}</span>
                  </button>
                  {open[w.id] && (
                    <div className="px-2.5 pb-2.5">
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] text-gray-300 bg-gray-900 rounded p-2">
                        {w.result}
                      </pre>
                      {w.resultTruncated && (
                        <p className="mt-1 text-[11px] text-gray-500">
                          Truncated at {w.result.length} of {w.resultChars} chars — the spawning agent
                          collects the full text from the results API.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Band>

        {/* ------------------------------------------------------------ activity */}
        {events.length > 0 && (
          <Band title="Activity" count={events.length}>
            <div className="space-y-1">
              {(allEvents ? events : events.slice(0, 8)).map((e) => (
                <div key={e.id} className="flex items-start gap-2 text-[11px]">
                  <span className="text-gray-500 font-mono w-24 flex-shrink-0 text-right whitespace-nowrap">{ago(e.agoS)}</span>
                  <span className="text-gray-400 font-mono w-32 flex-shrink-0 truncate">{e.kind}</span>
                  <span className="text-gray-500 min-w-0 break-words">{e.note}</span>
                </div>
              ))}
            </div>
            {events.length > 8 && (
              <button
                type="button"
                onClick={() => setAllEvents((v) => !v)}
                className="mt-1.5 text-[11px] text-gray-400 hover:text-white"
              >
                {allEvents ? 'Show less' : `Show all ${events.length}`}
              </button>
            )}
          </Band>
        )}
      </div>
    </div>
  );
}

export default SwarmPanel;
