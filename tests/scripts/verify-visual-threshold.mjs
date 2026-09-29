// B-011 (S22): inversion/sensitivity proof for the visual comparator threshold.
//
// S19 review finding: Playwright's default per-pixel `threshold: 0.2` treats any
// perceived-color difference below 20% as EQUAL — dark-navy palette shifts within
// themselves were invisible to the comparator (~279k pixels passed as zero on S19).
//
// Two synthetic 64x64 pairs (palette color vs intra-palette drift) are compared
// with pixelmatch at the old default (0.2) and the candidate locks (0.05 / 0.01):
//   small drift (~1.3% perceptual YIQ) — subtle shade change
//   large drift (~10% YIQ) — clearly visible, far from any other palette color
// Exit code 1 when the verdict does not hold (comparator gate broken).
//
// Run: node tests/scripts/verify-visual-threshold.mjs  (from the repo root)
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const PALETTE = [0x1a, 0x2f, 0x4a]; // Chinook dark navy (tokens mask color)
const SHIFT_SMALL = [0x1a, 0x33, 0x52];
const SHIFT_LARGE = [0x20, 0x3c, 0x5e];
const W = 64;
const H = 64;

function solidPng([r, g, b]) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return png.data; // pixelmatch v7 takes raw RGBA data
}

const baseline = solidPng(PALETTE);

for (const [label, shift] of [['small ~1.3% YIQ', SHIFT_SMALL], ['large ~10% YIQ', SHIFT_LARGE]]) {
  const shifted = solidPng(shift);
  const cells = [label.padEnd(16)];
  for (const threshold of [0.2, 0.05, 0.01]) {
    const diff = pixelmatch(baseline, shifted, null, W, H, { threshold });
    cells.push(`t=${threshold.toFixed(2)}: ${String(diff).padStart(4)}/${W * H}`);
  }
  console.log(cells.join('  '));
}

const largeAt02 = pixelmatch(baseline, solidPng(SHIFT_LARGE), null, W, H, { threshold: 0.2 });
const smallAt01 = pixelmatch(baseline, solidPng(SHIFT_SMALL), null, W, H, { threshold: 0.01 });
const largeAt01 = pixelmatch(baseline, solidPng(SHIFT_LARGE), null, W, H, { threshold: 0.01 });
console.log('');
console.log('verdict:');
console.log(`  old default 0.2: blind even to the large drift — ${largeAt02 === 0 ? 'yes (S19 finding reproduced)' : 'no'}`);
console.log(`  locked 0.01: sees small (${smallAt01 > 0}) and large (${largeAt01 > 0})`);
const holds = largeAt02 === 0 && smallAt01 > 0 && largeAt01 > 0;
console.log(`  => ${holds ? 'GATE HOLDS at 0.01' : 'COMPARATOR GATE BROKEN'}`);
process.exitCode = holds ? 0 : 1;
