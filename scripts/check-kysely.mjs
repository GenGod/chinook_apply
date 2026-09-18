#!/usr/bin/env node
// Kysely gate (S7 regression): builders without .execute() silently no-op
// (bit us twice: S12 insert, S7 fresh-deletes). Flags awaited builder chains
// missing .execute() in worker/core sources.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['apps/worker/src', 'packages/core/src'];
const offenders = [];

function check(file) {
  const src = readFileSync(file, 'utf8');
  const re = /await\s+db\.(deleteFrom|insertInto|updateTable)\([^;]*?\);/gs;
  for (const m of src.matchAll(re)) {
    if (!m[0].includes('.execute(')) {
      offenders.push(`${path.relative('.', file)}: ${m[1]} without .execute()`);
    }
  }
}

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) check(full);
  }
}

for (const r of roots) walk(path.resolve(r));
if (offenders.length) {
  console.error('Kysely builders missing .execute():');
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('kysely: all awaited builders call .execute()');
