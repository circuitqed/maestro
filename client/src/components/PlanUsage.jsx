import React, { useEffect, useState } from 'react';
import useEscape from '../hooks/useEscape';
import UsageBar, { elapsedFraction, FIVE_HOURS_MIN, SEVEN_DAYS_MIN } from './UsageBar';

/**
 * Every plan in the fleet, and what is drawing on it.
 *
 * The per-agent badge answers "is THIS agent near its limit". This answers the
 * question you actually have when work has stalled: which plan ran out, and who
 * is on it. Same data as `/usage` inside an agent, and as `maestro-usage plans`.
 *
 * One row per login identity, not per host: a subscription signed in on four hosts
 * is one plan with one five-hour window, and the agents across all four draw it
 * down together.
 */

function resetsIn(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  const secs = (t - Date.now()) / 1000;
  if (secs <= 0) return 'reset due';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `resets in ${h}h ${String(m).padStart(2, '0')}m` : `resets in ${m}m`;
}

function Window({ label, w, minutes }) {
  const pct = w && typeof w.utilization === 'number' ? w.utilization : null;
  const reset = w ? resetsIn(w.resetsAt) : null;
  const elapsed = w ? elapsedFraction(w.resetsAt, minutes) : null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 flex-shrink-0 text-gray-400">{label}</span>
      <UsageBar
        pct={pct}
        elapsed={elapsed}
        className="flex-1 h-2"
        title={elapsed === null ? undefined : `${Math.round(elapsed * 100)}% of the window has passed (white tick)`}
      />
      <span className="w-12 flex-shrink-0 text-right tabular-nums text-gray-300">
        {pct === null ? '—' : `${pct.toFixed(1)}%`}
      </span>
      <span className="w-32 flex-shrink-0 text-gray-500">{reset || ''}</span>
    </div>
  );
}

const money = (v) =>
  v === null || v === undefined
    ? '—'
    : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

/**
 * A gateway account has no plan window but it does have a cap, so the same question
 * gets answered in dollars.
 *
 * The reset day is not something the gateway reports — the endpoint that would carry
 * it is barred for this key — so it is learned by watching spend fall, and says so
 * until it has been seen. A guessed "1st of the month" would be indistinguishable
 * from a known one at the moment it matters.
 */
// Where we are in a monthly budget cycle, from the learned reset day. Unknown until a
// reset has been observed: a guessed cycle would put the tick in a confident wrong place.
function budgetElapsed(b) {
  const day = b.resetDayOfMonth;
  if (!day) return null;
  const now = new Date();
  const at = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  let start = at(now.getFullYear(), now.getMonth());
  if (start > now) start = at(now.getFullYear(), now.getMonth() - 1);
  const end = at(start.getFullYear(), start.getMonth() + 1);
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

function Budget({ b }) {
  const pct = typeof b.utilization === 'number' ? b.utilization : null;
  const elapsed = budgetElapsed(b);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-12 flex-shrink-0 text-gray-400">budget</span>
        <UsageBar
          pct={pct}
          elapsed={elapsed}
          className="flex-1 h-2"
          title={elapsed === null ? undefined : `${Math.round(elapsed * 100)}% of the month has passed (white tick)`}
        />
        <span className="w-12 flex-shrink-0 text-right tabular-nums text-gray-300">
          {pct === null ? '—' : `${pct.toFixed(1)}%`}
        </span>
        <span className="w-32 flex-shrink-0 text-gray-500 tabular-nums">
          {money(b.spend)} / {money(b.cap)}
        </span>
      </div>
      <div className="text-xs text-gray-400 pl-14">
        {b.overBudget
          ? <span className="text-red-300">Over cap — requests are being refused</span>
          : <>{money(b.remaining)} remaining</>}
        {' · '}
        {b.resetDayOfMonth
          ? `resets on day ${b.resetDayOfMonth} of the month`
          : b.resetsObserved
            ? `last reset ${String(b.lastResetAt).slice(0, 10)}`
            : 'reset day not yet observed'}
      </div>
    </div>
  );
}

const STATUS_TONE = {
  running: 'text-blue-300',
  busy: 'text-blue-300',
  idle: 'text-green-300',
  stopped: 'text-gray-500',
};

export default function PlanUsage({ onClose }) {
  useEscape(onClose);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/usage/plans');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <div>
              <h3 className="text-lg font-semibold text-white">Plan usage</h3>
              <p className="text-xs text-gray-400">
                One row per account. A subscription signed in on several hosts shares one limit.
                The white tick is how far through the window we are: fill past it is ahead of an even pace.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={load}
                disabled={loading}
                className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 disabled:opacity-50"
              >
                {loading ? 'Checking…' : 'Refresh'}
              </button>
              <button type="button" onClick={onClose} aria-label="Close" title="Close" className="flex items-center justify-center w-10 h-10 -my-2 -mr-2 md:w-auto md:h-auto md:my-0 md:mr-0 rounded text-gray-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {error && (
            <div className="mx-4 mt-3 bg-red-900/50 border border-red-500 text-red-200 px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {loading && !data && <div className="text-sm text-gray-400">Probing each account…</div>}

            {data?.plans?.map((p) => {
              const hosts = [...new Set((p.signedInOn || []).map((h) => h.host))].sort();
              return (
                <div key={p.identity} className="border border-gray-700 rounded p-3 bg-gray-900/40">
                  {/* The name truncates on its own block-level span (truncate on an inline
                      span does nothing), so it can no longer run under the badge. On a
                      phone the host list drops to its own line instead of squeezing both. */}
                  <div className="flex flex-col gap-0.5 md:flex-row md:items-baseline md:justify-between md:gap-2 mb-2">
                    <div className="min-w-0 flex items-baseline gap-2">
                      <span className="block min-w-0 truncate text-sm text-white">{p.name || p.email || p.identity}</span>
                      <span className="flex-shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-700 text-gray-300">
                        {p.kind}
                      </span>
                    </div>
                    <span className="text-xs text-gray-500 md:flex-shrink-0 break-words">{hosts.join(', ')}</span>
                  </div>

                  {p.ok && p.budget ? (
                    <Budget b={p.budget} />
                  ) : p.ok ? (
                    <div className="space-y-1">
                      <Window label="5-hour" w={p.fiveHour} minutes={FIVE_HOURS_MIN} />
                      <Window label="7-day" w={p.sevenDay} minutes={SEVEN_DAYS_MIN} />
                      {p.extraEnabled && (
                        <div className="text-xs text-amber-300">Extra usage credits enabled</div>
                      )}
                      {p.disagreement && (
                        <div className="text-xs text-amber-300">
                          Hosts disagreed on utilization — showing the freshest reading
                        </div>
                      )}
                    </div>
                  ) : (
                    // Not an error state: an API or Bedrock account has no plan window
                    // to show, which is different from a probe that failed.
                    <div className="text-xs text-gray-400">{p.reason || 'no plan window'}</div>
                  )}

                  <div className="mt-2 text-xs text-gray-400">
                    {p.agents?.length
                      ? (
                        <>
                          <span className="text-gray-500">{p.agents.length} agent{p.agents.length === 1 ? '' : 's'}: </span>
                          {p.agents.slice(0, 12).map((a, i) => (
                            <span key={a.id}>
                              {i > 0 && ', '}
                              <span className={STATUS_TONE[a.status] || 'text-gray-400'}>{a.name}</span>
                            </span>
                          ))}
                          {p.agents.length > 12 && <span className="text-gray-500"> +{p.agents.length - 12} more</span>}
                        </>
                      )
                      : <span className="text-gray-500">No agents pinned to this account</span>}
                  </div>
                </div>
              );
            })}

            {data?.hostsUnreachable?.length > 0 && (
              <div className="text-xs text-amber-300">
                Unreachable, so their accounts are missing: {data.hostsUnreachable.join(', ')}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-gray-700 text-xs text-gray-500">
            Same source as <code className="text-gray-400">/usage</code>. Agents can read it with{' '}
            <code className="text-gray-400">maestro-usage plans</code>.
            {data?.checkedAt && <span className="ml-1">Checked {new Date(data.checkedAt).toLocaleTimeString()}.</span>}
          </div>
        </div>
      </div>
    </>
  );
}
