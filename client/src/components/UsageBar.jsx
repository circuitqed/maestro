import React from 'react';

/**
 * A usage window as a fill bar, with a tick for how far through the window we are.
 *
 * The fill is how much of the limit is used; the tick is how much of the TIME is
 * used. Fill past the tick means burning faster than an even pace (60% used, 30%
 * of the week gone, will run out early); fill short of it means there is room.
 * The percentage alone could not say that: 60% is alarming on Monday and
 * comfortable on Saturday.
 */

export const FIVE_HOURS_MIN = 300;
export const SEVEN_DAYS_MIN = 7 * 1440;

// Fraction of the window elapsed (0..1), or null when the reset time is unknown.
export function elapsedFraction(resetsAt, windowMinutes) {
  if (!resetsAt || !windowMinutes) return null;
  const t = typeof resetsAt === 'number'
    ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) // epoch seconds (Codex) or ms
    : new Date(resetsAt).getTime();
  if (Number.isNaN(t)) return null;
  const left = (t - Date.now()) / 60000;
  return Math.min(1, Math.max(0, 1 - left / windowMinutes));
}

// Thresholds, not a gradient: "do I need to care" has three answers.
export function fillTone(pct) {
  if (pct === null || pct === undefined) return 'bg-gray-600';
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export default function UsageBar({ pct, elapsed, className = 'h-2', title }) {
  const fill = pct === null || pct === undefined ? null : Math.min(100, Math.max(0, pct));
  return (
    <div className={`relative rounded bg-gray-700 overflow-hidden ${className}`} title={title}>
      {fill !== null && (
        <div className={`absolute inset-y-0 left-0 ${fillTone(pct)}`} style={{ width: `${fill}%` }} />
      )}
      {elapsed !== null && elapsed !== undefined && (
        <div
          className="absolute inset-y-0 w-0.5 -ml-px bg-white shadow-[0_0_0_1px_rgba(17,24,39,0.8)]"
          style={{ left: `${elapsed * 100}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
