// S11 golden run: LIVE flash extraction on the real master_resume_source.docx.
// Metrics only on stdout — fact content and excerpts stay in the database
// (Constitution 3.2); the proposal is NOT applied (PO reviews in /profile).
// Run from apps/web:  pnpm --filter @chinook/web golden:profile
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, ensureSchema, extractDocxText, saveProfileSource, saveProfileFacts, listAllProfileFacts } from '@chinook/core';
import { createLlm, createPgLlmDb, buildFactExtractionPrompt, ProfileFactsSchema, type ExtractedFact } from '@chinook/llm';
import { buildSuperprofileProposal } from '@chinook/core';
import { excerptInText } from '../lib/superprofile-service';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCX = path.join(MODULE_DIR, '..', '..', '..', '..', 'data', 'profile', 'master_resume_source.docx');

async function main(): Promise<void> {
  const bytes = await readFile(DOCX);
  const text = extractDocxText(bytes);
  console.log(`golden-profile: docx text ${text.length} chars`);

  const db = createDb(process.env.DATABASE_URL ?? 'postgres://chinook:chinook_dev@localhost:5433/chinook');
  await ensureSchema(db);
  const llm = createLlm({ db: createPgLlmDb(db) });

  const prompt = buildFactExtractionPrompt(text);
  const result = await llm.call({
    role: 'flash',
    stage: 'extract_profile_facts',
    system: prompt.system,
    user: prompt.user,
    schema: ProfileFactsSchema,
    temperature: 0,
  });
  const facts = (result.data as { facts: ExtractedFact[] }).facts;
  const accepted = facts.filter((f) => excerptInText(f.excerpt, text));
  const rejected = facts.length - accepted.length;
  console.log(`facts: ${facts.length} extracted, ${accepted.length} passed the provenance gate, ${rejected} rejected`);
  const byKind = new Map<string, number>();
  for (const f of accepted) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  console.log('by kind:', JSON.stringify(Object.fromEntries(byKind)));
  console.log(`usage: ${result.usage.promptTokens}+${result.usage.completionTokens} tok, $${result.usage.costUsd.toFixed(6)}, ${result.usage.latencyMs} ms`);

  // Persist to the LIVE database for PO review in /profile (no apply here).
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const source = await saveProfileSource(db, {
    fileName: 'master_resume_source.docx',
    format: 'docx',
    storagePath: `golden-${sha.slice(0, 8)}.docx`,
    sha256: sha,
    textChars: text.length,
  });
  if (accepted.length > 0) {
    await saveProfileFacts(db, source.id, accepted.map((f) => ({ kind: f.kind, payload: f.payload, excerpt: f.excerpt })));
  }
  console.log(`stored: source ${source.id.slice(0, 8)} (+${accepted.length} facts) — review in /profile`);

  const all = await listAllProfileFacts(db);
  const masterRaw = JSON.parse(await readFile(path.join(MODULE_DIR, '..', '..', '..', '..', 'data', 'profile', 'master_profile.json'), 'utf8'));
  const { diff } = buildSuperprofileProposal(masterRaw, all);
  const ops = diff.map((d) => d.op);
  const count = (op: string) => ops.filter((o) => o === op).length;
  console.log(`proposal (NOT applied): ${diff.length} entries — add_skill ${count('add_skill')}, add_experience ${count('add_experience')}, add_education ${count('add_education')}, add_certification ${count('add_certification')}, new_category ${count('new_category')}, conflict ${count('conflict')}`);
  await db.destroy();
}

main().catch((error: unknown) => {
  console.error(`FATAL: ${String(error).slice(0, 300)}`);
  process.exitCode = 1;
});
