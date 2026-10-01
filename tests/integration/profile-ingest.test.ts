import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, ensureSchema, listProfileFacts, type Database } from '@chinook/core';
import type { Llm } from '@chinook/llm';
import { ingestProfileDocument } from '../../apps/web/src/lib/superprofile-service';

/**
 * S11 T4: document ingest with the provenance gate. Mock LLM returns a fact
 * batch; facts whose excerpt is NOT a substring of the document text are
 * rejected before storage. Synthetic content only (no PII).
 */
const db: Kysely<Database> = createDb(
  process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook_test',
);

const DOC_TEXT = [
  'Fixture Corp — Senior Developer, 2020-01 to present.',
  'Built platforms serving 40k users. Cut latency by 35%.',
  'Skills: FixtureLang, WidgetTool.',
  'B.Sc. from Fixture University, 2016.',
].join('\n');

function mockLlm(facts: unknown) {
  return {
    async call() {
      return { data: facts, runId: 1, usage: { costUsd: 0.001 } };
    },
    breakerState: () => ({ open: false, consecutiveFailures: 0 }),
  } as unknown as Llm;
}

let sourcesDir = '';
let sourceId = '';

beforeAll(async () => {
  await ensureSchema(db);
  sourcesDir = await mkdtemp(join(tmpdir(), 'chinook-profile-'));
});

afterAll(async () => {
  if (sourceId) {
    await db.deleteFrom('profile_fact').where('source_id', '=', sourceId).execute();
    await db.deleteFrom('profile_source').where('id', '=', sourceId).execute();
  }
  // sweep any leftovers from earlier iterations of this suite
  await db.deleteFrom('profile_source').where('file_name', 'in', ['roundtrip.docx', 'dbg.docx', 'fixture.txt', 'fixture-copy.txt']).execute();
  if (sourcesDir) await rm(sourcesDir, { recursive: true, force: true });
  await db.destroy();
});

describe('ingestProfileDocument (S11 T4)', () => {
  it('stores verbatim-excerpt facts and rejects fabricated ones', async () => {
    const result = await ingestProfileDocument(
      db,
      mockLlm({
        facts: [
          {
            kind: 'skill',
            payload: { category: 'languages', name: 'FixtureLang' },
            excerpt: 'Skills: FixtureLang, WidgetTool.',
          },
          {
            kind: 'experience',
            payload: { employer: 'Fixture Corp', title: 'Senior Developer', start: '2020-01', end: null, bullets: ['Built platforms serving 40k users.'] },
            excerpt: 'Fixture Corp — Senior Developer, 2020-01 to present.',
          },
          {
            kind: 'skill',
            payload: { category: 'languages', name: 'InventedSkill' },
            excerpt: 'Totally invented line that is not in the document.',
          },
        ],
      }),
      { fileName: 'fixture.txt', format: 'txt', bytes: Buffer.from(DOC_TEXT, 'utf8') },
      { sourcesDir },
    );
    sourceId = result.sourceId;
    expect(result.factsSaved).toBe(2);
    expect(result.factsRejected).toBe(1);

    const facts = await listProfileFacts(db, sourceId);
    expect(facts.map((f) => f.kind).sort()).toEqual(['experience', 'skill']);
    const skill = facts.find((f) => f.kind === 'skill')!;
    expect((skill.payload as { name: string }).name).toBe('FixtureLang');
  });

  it('idempotent: re-upload of identical bytes adds no rows', async () => {
    const before = await listProfileFacts(db, sourceId);
    const again = await ingestProfileDocument(
      db,
      mockLlm({ facts: [{ kind: 'skill', payload: { category: 'x', name: 'y' }, excerpt: 'Skills: FixtureLang, WidgetTool.' }] }),
      { fileName: 'fixture-copy.txt', format: 'txt', bytes: Buffer.from(DOC_TEXT, 'utf8') },
      { sourcesDir },
    );
    expect(again.sourceId).toBe(sourceId);
    expect(again.factsSaved).toBe(0); // duplicate source → no extraction run
    const after = await listProfileFacts(db, sourceId);
    expect(after.length).toBe(before.length);
  });

  it('empty-text documents are refused', async () => {
    await expect(
      ingestProfileDocument(
        db,
        mockLlm({ facts: [] }),
        { fileName: 'empty.txt', format: 'txt', bytes: Buffer.from('   ') },
        { sourcesDir },
      ),
    ).rejects.toThrow(/no extractable text/i);
  });

  it('docx bytes go through the docx extractor (round-trip with our encoder)', async () => {
    const { Document, Packer, Paragraph, TextRun } = await import('docx');
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ children: [new TextRun({ text: `Fixture Round-Trip Resume for extraction testing purposes. Run ${Date.now()}.` })] }),
            new Paragraph({ children: [new TextRun({ text: 'Skills: RoundTripLang and supporting tooling across platforms.' })] }),
            new Paragraph({ children: [new TextRun({ text: 'Experience building systems with measurable outcomes over years.' })] }),
          ],
        },
      ],
    });
    const bytes = await Packer.toBuffer(doc);
    const result = await ingestProfileDocument(
      db,
      mockLlm({
        facts: [{ kind: 'skill', payload: { category: 'languages', name: 'RoundTripLang' }, excerpt: 'Skills: RoundTripLang and supporting tooling' }],
      }),
      { fileName: 'roundtrip.docx', format: 'docx', bytes: Buffer.from(bytes) },
      { sourcesDir },
    );
    expect(result.factsSaved).toBe(1);
    const facts = await listProfileFacts(db, result.sourceId);
    expect(facts[0]!.payload).toEqual({ category: 'languages', name: 'RoundTripLang' });
    await db.deleteFrom('profile_fact').where('source_id', '=', result.sourceId).execute();
    await db.deleteFrom('profile_source').where('id', '=', result.sourceId).execute();
  });
});
