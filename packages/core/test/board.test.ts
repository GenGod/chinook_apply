import { describe, it, expect } from 'vitest';
import { BOARD_STATUSES, canTransition, requiredChannel, TRANSITIONS } from '../src/board.js';

describe('transition graph (S7 AC2)', () => {
  it('new → applying and applied are allowed', () => {
    expect(canTransition('new', 'applying')).toBe(true);
    expect(canTransition('new', 'applied')).toBe(true);
    expect(canTransition('new', 'interview')).toBe(false);
  });

  it('applying ↔ new/applied', () => {
    expect(canTransition('applying', 'applied')).toBe(true);
    expect(canTransition('applying', 'new')).toBe(true);
    expect(canTransition('applying', 'interview')).toBe(false);
  });

  it('applied → interview/rejected/applying', () => {
    expect(canTransition('applied', 'interview')).toBe(true);
    expect(canTransition('applied', 'rejected')).toBe(true);
    expect(canTransition('applied', 'applying')).toBe(true);
  });

  it('interview → rejected/applied; rejected → applying (reactivation)', () => {
    expect(canTransition('interview', 'rejected')).toBe(true);
    expect(canTransition('interview', 'applied')).toBe(true);
    expect(canTransition('rejected', 'applying')).toBe(true);
    expect(canTransition('rejected', 'interview')).toBe(false);
  });

  it('every stored status appears in the graph', () => {
    for (const s of ['applying', 'applied', 'interview', 'rejected']) {
      expect(TRANSITIONS[s] !== undefined, s).toBe(true);
    }
  });
});

describe('channel requirement (G1: manual/auto split)', () => {
  it('applied requires manual|auto; others forbid it', () => {
    expect(requiredChannel('applied')).toBe(true);
    expect(requiredChannel('applying')).toBe(false);
    expect(requiredChannel('interview')).toBe(false);
    expect(requiredChannel('rejected')).toBe(false);
  });

  it('board exposes six columns in canonical order', () => {
    expect(BOARD_STATUSES).toEqual([
      'new',
      'applying',
      'applied_manual',
      'applied_auto',
      'interview',
      'rejected',
    ]);
  });
});
