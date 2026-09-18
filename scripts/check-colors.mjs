#!/usr/bin/env node
// DS gate (S16 AC1): no hardcoded colors in screen CSS outside tokens.css.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'apps/web/app');
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!full.endsWith('.css') || full.endsWith('tokens.css')) continue;
    const content = readFileSync(full, 'utf8');
    const hex = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    if (hex.length) offenders.push(`${path.relative(root, full)}: ${hex.join(', ')}`);
  }
}

walk(root);
if (offenders.length) {
  console.error('Hardcoded colors outside tokens.css:');
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('ds: no hardcoded colors outside tokens.css');
