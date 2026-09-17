import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planSources, nextDue, type SourceSchedule } from '../src/schedule.js';

const jb: SourceSchedule = { source: 'jobbank', intervalMin: 30, jitterRatio: 0.2 };
const az: SourceSchedule = { source: 'adzuna', intervalMin: 120, jitterRatio: 0.2 };

describe('planSources (S12 AC1)', () => {
  const now = new Date('2026-09-17T12:00:00Z');

  it('no history → due (first run)', () => {
    expect(planSources(now, [jb, az], {})).toEqual([jb, az]);
  });

  it('elapsed >= interval → due; less → not due', () => {
    const due = planSources(now, [jb], { jobbank: '2026-09-17T11:29:00Z' });
    expect(due).toEqual([jb]);
    const notDue = planSources(now, [jb], { jobbank: '2026-09-17T11:31:00Z' });
    expect(notDue).toEqual([]);
  });

  it('plans only overdue sources', () => {
    const plan = planSources(now, [jb, az], { jobbank: '2026-09-17T12:00:00Z', adzuna: '2026-09-17T09:00:00Z' });
    expect(plan).toEqual([az]);
  });

  it('accepts Date objects as history values', () => {
    expect(planSources(now, [jb], { jobbank: new Date('2026-09-17T11:00:00Z') })).toEqual([jb]);
  });
});

describe('nextDue (post-run cooldown, S12 AC1 jitter bounds)', () => {
  it('jitter stays within ±20% of the interval', () => {
    const base = new Date('2026-09-17T12:00:00Z');
    const delta = nextDue(base, jb).getTime() - base.getTime();
    const nominal = 30 * 60_000;
    expect(delta).toBeGreaterThanOrEqual(nominal * 0.8);
    expect(delta).toBeLessThanOrEqual(nominal * 1.2);
  });

  it('deterministic with stubbed rand', () => {
    const base = new Date('2026-09-17T12:00:00Z');
    const at = (r: number) => nextDue(base, jb, () => r);
    expect(at(0).getTime() - base.getTime()).toBe(Math.round(30 * 60_000 * 0.8));
    expect(at(1).getTime() - base.getTime()).toBe(Math.round(30 * 60_000 * 1.2));
    expect(at(0.5).getTime() - base.getTime()).toBe(30 * 60_000);
  });

  it('property: always inside bounds and monotonic base', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1440 }), fc.double({ min: 0, max: 1, noNaN: true }), (mins, r) => {
        const s: SourceSchedule = { source: 'jobbank', intervalMin: mins, jitterRatio: 0.2 };
        const base = new Date('2026-09-17T00:00:00Z');
        const due = nextDue(base, s, () => r);
        const deltaMin = (due.getTime() - base.getTime()) / 60_000;
        return deltaMin >= mins * 0.8 - 1e-6 && deltaMin <= mins * 1.2 + 1e-6;
      }),
      { numRuns: 200 },
    );
  });
});
