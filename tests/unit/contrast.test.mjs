import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * S16 AC3: WCAG-AA contrast gate for declared token pairs.
 * The design is protected by a machine gate, not taste.
 */
const tokensFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/web/app/styles/tokens.css',
);
const css = readFileSync(tokensFile, 'utf8');
const tokens = Object.fromEntries(
  [...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
);

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg, bg) {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const AA_NORMAL = 4.5;
const AA_LARGE = 3.0; // big metric numbers / 28px headings

// [foreground token, background token, minimum ratio]
const PAIRS = [
  ['text-primary', 'bg-base', AA_NORMAL],
  ['text-primary', 'bg-raised', AA_NORMAL],
  ['text-secondary', 'bg-base', AA_NORMAL],
  ['text-secondary', 'bg-raised', AA_NORMAL],
  ['text-muted', 'bg-base', AA_NORMAL],
  ['accent', 'bg-base', AA_LARGE],
  ['status-success', 'status-success-bg', AA_NORMAL],
  ['status-warning', 'status-warning-bg', AA_NORMAL],
  ['status-danger', 'bg-raised', AA_NORMAL],
  ['status-neutral', 'status-neutral-bg', AA_NORMAL],
  ['badge-source-text', 'badge-source-bg', AA_NORMAL],
  ['accent-text', 'accent', AA_LARGE],
];

describe('DS contrast gate (S16 AC3)', () => {
  it('all declared pairs pass their minimum', () => {
    const failures = [];
    for (const [fg, bg, min] of PAIRS) {
      const r = ratio(tokens[fg], tokens[bg]);
      if (r < min) failures.push(`${fg} on ${bg}: ${r.toFixed(2)} < ${min}`);
    }
    expect(failures, failures.join('; ')).toEqual([]);
  });
});
