import type { JobSourceId } from '@chinook/contracts';

/** Per-source polling plan; jitter applies to the post-run cooldown (nextDue). */
export interface SourceSchedule {
  source: JobSourceId;
  intervalMin: number;
  jitterRatio: number;
}

/**
 * Cooldown after a completed run: interval ± jitterRatio (rand injectable for
 * deterministic tests). Keeps the scheduler off a metronomic request pattern.
 */
export function nextDue(base: Date, s: SourceSchedule, rand: () => number = Math.random): Date {
  const factor = 1 + (rand() * 2 - 1) * s.jitterRatio;
  return new Date(base.getTime() + Math.round(s.intervalMin * 60_000 * factor));
}

/**
 * Sources whose last attempt is older than their interval (or that never ran).
 * The last attempt counts success or failure alike — failures surface through
 * the degraded counter, not through faster re-polling.
 */
export function planSources(
  now: Date,
  schedules: SourceSchedule[],
  lastRunPerSource: Record<string, Date | string>,
): SourceSchedule[] {
  return schedules.filter((s) => {
    const last = lastRunPerSource[s.source];
    if (!last) return true;
    const lastMs = (last instanceof Date ? last : new Date(last)).getTime();
    return now.getTime() - lastMs >= s.intervalMin * 60_000;
  });
}
