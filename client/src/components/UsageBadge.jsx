import React, { useCallback, useEffect, useState } from 'react';
import UsageBar, { elapsedFraction, FIVE_HOURS_MIN, SEVEN_DAYS_MIN } from './UsageBar';

/**
 * How much of its plan this agent's account has left.
 *
 * Sits next to the account badge because the two answer one question together:
 * which account is this, and is that account about to stop working. Hitting a
 * weekly limit mid-task is the failure this exists to pre-empt, and until now the
 * only way to see it was to open the agent's terminal and read its footer.
 *
 * The providers report different things and the badge says which rather than
 * flattening them into one invented number: Claude has a 5-hour and a 7-day
 * window, Codex a single rolling one. The tightest window is shown, because that
 * is the one that will bite first.
 *
 * Renders nothing at all when usage cannot be read. Both sources are undocumented
 * -- Claude's is an internal endpoint, Codex's is a field in a rollout file -- so
 * absence is expected and must be quiet, never an error badge.
 */
function UsageBadge({ agentId, provider = 'claude' }) {
  const [u, setU] = useState(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agentId}/usage`);
      if (res.ok) setU(await res.json());
    } catch {
      /* leave the last reading rather than flapping */
    }
  }, [agentId]);

  useEffect(() => {
    let timer;
    let cancelled = false;
    const tick = async () => {
      await poll();
      // The server caches for 90s; polling faster only costs requests. Usage moves
      // on the scale of minutes.
      if (!cancelled) timer = setTimeout(tick, 60000);
    };
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [poll]);

  if (!u || !u.ok) return null;

  // The window closest to its limit: a 7-day figure of 14% is no comfort when the
  // 5-hour one is at 95%.
  let pct = null;
  let label = '';
  let detail = '';
  let elapsed = null;
  if (u.provider === 'claude') {
    const five = u.fiveHour ? u.fiveHour.utilization : null;
    const seven = u.sevenDay ? u.sevenDay.utilization : null;
    const tight = (five ?? -1) >= (seven ?? -1) ? 'five' : 'seven';
    pct = tight === 'five' ? five : seven;
    label = tight === 'five' ? '5h' : '7d';
    elapsed = tight === 'five'
      ? elapsedFraction(u.fiveHour && u.fiveHour.resetsAt, FIVE_HOURS_MIN)
      : elapsedFraction(u.sevenDay && u.sevenDay.resetsAt, SEVEN_DAYS_MIN);
    const t = (s) => (s ? new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '?');
    detail = `5-hour window: ${five ?? '?'}% (resets ${t(u.fiveHour && u.fiveHour.resetsAt)})\n`
      + `7-day window: ${seven ?? '?'}% (resets ${t(u.sevenDay && u.sevenDay.resetsAt)})`
      + (u.extraEnabled ? '\nExtra usage credits enabled' : '');
  } else {
    pct = u.primary ? u.primary.utilization : null;
    const days = u.primary && u.primary.windowMinutes ? Math.round(u.primary.windowMinutes / 1440) : null;
    label = days ? `${days}d` : 'plan';
    elapsed = u.primary ? elapsedFraction(u.primary.resetsAtEpoch, u.primary.windowMinutes) : null;
    detail = `${pct}% of the ${days || '?'}-day window used`
      + (u.secondary ? `\nsecondary window: ${u.secondary.utilization}%` : '');
  }
  if (pct === null || pct === undefined) return null;

  // Thresholds, not a gradient: the question is "do I need to care", which has
  // three answers. 80 is where a long task starts being at risk of not finishing.
  const tone = pct >= 90
    ? 'bg-red-500/20 text-red-300'
    : pct >= 80
      ? 'bg-amber-500/15 text-amber-300'
      : 'bg-gray-600/40 text-gray-400';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] flex-shrink-0 ${tone}`}
      title={`${detail}${elapsed === null ? '' : `\n${Math.round(elapsed * 100)}% of the ${label} window has passed (white tick)`}\n\nchecked ${u.checkedAt ? new Date(u.checkedAt).toLocaleTimeString() : 'just now'}`}
    >
      <UsageBar pct={pct} elapsed={elapsed} className="w-10 h-1.5" />
      <span>{label} {Math.round(pct)}%</span>
    </span>
  );
}

export default UsageBadge;
