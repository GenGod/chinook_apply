import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createDb,
  ensureSchema,
  saveProfileSource,
  findProfileSourceByHash,
  listProfileSources,
  saveProfileFacts,
  listProfileFacts,
  type Database,
} from '@chinook/core';
import type { Kysely } from 'kysely';

/**
 * S11 T1 (red→green): profile_source + profile_fact repositories. Synthetic
 * fixtures only — no real PII (Constitution 3.2).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

describe('profile sources and facts (S11 T1)', () => {
  it('saves a source, is idempotent by sha256, lists with fact counts', async () => {
    const sha = randomUUID(); // unique per run
    const first = await saveProfileSource(db, {
      fileName: 'resume-fixture.docx',
      format: 'docx',
      storagePath: `fixtures/${sha}.docx`,
      sha256: sha,
      textChars: 1234,
    });
    expect(first.id).toBeTruthy();

    // same hash → same row (idempotent re-upload)
    const again = await saveProfileSource(db, {
      fileName: 'resume-fixture (1).docx',
      format: 'docx',
      storagePath: `fixtures/${sha}.docx`,
      sha256: sha,
      textChars: 1234,
    });
    expect(again.id).toBe(first.id);

    const found = await findProfileSourceByHash(db, sha);
    expect(found?.fileName).toBe('resume-fixture.docx'); // first wins

    await expect(
      saveProfileSource(db, {
        fileName: 'x.pdf',
        format: 'epub' as never,
        storagePath: 'x',
        sha256: randomUUID(),
        textChars: 1,
      }),
    ).rejects.toThrow();
  });

  it('saves fact batches and lists them per source', async () => {
    const sha = randomUUID();
    const source = await saveProfileSource(db, {
      fileName: 'second.docx',
      format: 'docx',
      storagePath: `fixtures/${sha}.docx`,
      sha256: sha,
      textChars: 500,
    });
    const saved = await saveProfileFacts(db, source.id, [
      {
        kind: 'skill',
        payload: { category: 'languages', name: 'FixtureLang' },
        excerpt: 'Proficient in FixtureLang and Tooling',
      },
      {
        kind: 'experience',
        payload: { employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: ['Did things.'] },
        excerpt: 'Fixture Corp — Developer (2020-01): Did things.',
      },
    ]);
    expect(saved).toBe(2);

    await expect(
      saveProfileFacts(db, source.id, [
        { kind: 'hobby' as never, payload: {}, excerpt: 'x'.repeat(20) },
      ]),
    ).rejects.toThrow();

    const facts = await listProfileFacts(db, source.id);
    expect(facts.map((f) => f.kind).sort()).toEqual(['experience', 'skill']);
    expect(facts[0]!.excerpt.length).toBeGreaterThan(5);

    const list = await listProfileSources(db);
    const mine = list.find((s) => s.sha256 === sha);
    expect(mine?.fileName).toBe('second.docx');
    expect(typeof mine?.createdAt).toBe('string');

    // cleanup this suite's rows
    await db.deleteFrom('profile_fact').where('source_id', '=', source.id).execute();
    await db.deleteFrom('profile_source').where('id', '=', source.id).execute();
  });
});

beforeAll(async () => {
  await ensureSchema(db);
});

afterAll(async () => {
  await db.destroy();
});
