import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createDb, ensureSchema, saveProfileSource, saveProfileFacts, type Database } from '@chinook/core';
import { buildProposal, approveProposal, masterProfilePath } from '../../apps/web/src/lib/superprofile-service';

/**
 * S11 T6: proposal + approve against an ISOLATED fixture master file
 * (MASTER_PROFILE_PATH), never the real PII profile.
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

const FIXTURE_MASTER = {
  version: 1,
  identity: { full_name: 'Fixture Only' },
  search_config: { noc_codes: ['21231'] },
  summary: 'Engineer.',
  skills: { languages: ['TypeScript'] },
  experience: [{ id: 'fx:Fixture Corp', employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: [], technology: [] }],
  education: [],
};

let workDir = '';
let prevEnv: string | undefined;
let sourceId = '';

beforeAll(async () => {
  await ensureSchema(db);
  workDir = await mkdtemp(join(tmpdir(), 'chinook-master-'));
  prevEnv = process.env.MASTER_PROFILE_PATH;
  process.env.MASTER_PROFILE_PATH = join(workDir, 'master_profile.json');
  await writeFile(masterProfilePath(), JSON.stringify(FIXTURE_MASTER, null, 2));

  const src = await saveProfileSource(db, {
    fileName: 'fixture-resume.txt', format: 'txt', storagePath: 'f.txt',
    sha256: randomUUID(), textChars: 400,
  });
  sourceId = src.id;
  await saveProfileFacts(db, sourceId, [
    { kind: 'skill', payload: { category: 'languages', name: 'Go' }, excerpt: 'Skills: Go' },
    { kind: 'experience', payload: { employer: 'Fixture Corp', title: 'Senior Developer', start: '2020-01', end: null, bullets: [] }, excerpt: 'Fixture Corp Senior' }, // conflict
    { kind: 'education', payload: { degree: 'M.Sc.', institution: 'Other University', year: 2020 }, excerpt: 'M.Sc. Other University 2020' },
  ]);
});

afterAll(async () => {
  if (prevEnv === undefined) delete process.env.MASTER_PROFILE_PATH;
  else process.env.MASTER_PROFILE_PATH = prevEnv;
  await db.deleteFrom('profile_fact').where('source_id', '=', sourceId).execute();
  await db.deleteFrom('profile_source').where('id', '=', sourceId).execute();
  await db.destroy();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe('proposal + approve (S11 T6)', () => {
  it('builds a diff with adds and a conflict, without touching the file', async () => {
    const before = await readFile(masterProfilePath(), 'utf8');
    const proposal = await buildProposal(db);
    expect(proposal.conflicts).toBe(1);
    const ops = proposal.diff.map((d) => d.op);
    expect(ops).toContain('add_skill');
    expect(ops).toContain('add_education');
    expect(ops).toContain('conflict');
    expect(await readFile(masterProfilePath(), 'utf8')).toBe(before); // read-only until approve
  });

  it('approve applies non-conflict adds, bumps version, writes a backup; second approve is a no-op', async () => {
    const result = await approveProposal(db);
    expect(result.applied).toBeGreaterThanOrEqual(2); // skill + education
    expect(result.version).toBe(2);

    const applied = JSON.parse(await readFile(masterProfilePath(), 'utf8')) as typeof FIXTURE_MASTER;
    expect(applied.version).toBe(2);
    expect(applied.skills.languages).toContain('Go');
    expect(applied.experience.length).toBe(1); // conflict NOT applied
    expect(applied.experience[0]!.title).toBe('Developer');

    const files = await readdir(workDir);
    expect(files.some((f) => f.includes('.bak.json'))).toBe(true);

    const again = await approveProposal(db);
    expect(again.applied).toBe(0); // idempotent — diff empty after apply
  });
});
