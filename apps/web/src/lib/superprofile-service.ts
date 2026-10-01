// S11: superprofile ingest + proposal + approve orchestration.
//
// Constitution 2.1–2.3: the pipeline never invents facts — the LLM only
// extracts, every fact carries a VERBATIM excerpt, the excerpt must be a
// substring of the document text (provenance gate) before storage, and the
// merged profile is applied ONLY through the explicit PO approve.
//
// Source files live under the gitignored data/profile/sources dir; the master
// file path resolves env-first (MASTER_PROFILE_PATH) so e2e/CI can point at
// an isolated fixture. Path math lives in core/profile-paths (validated).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import {
  extractDocxText,
  saveProfileSource,
  findProfileSourceByHash,
  saveProfileFacts,
  listAllProfileFacts,
  listProfileSources,
  masterProfileFilePath,
  profileSourcesDir,
  safeSourceFilePath,
  buildSuperprofileProposal,
  type SuperprofileDiffEntry,
  type Database,
} from '@chinook/core';
import {
  buildFactExtractionPrompt,
  ProfileFactsSchema,
  type ExtractedFact,
  type Llm,
} from '@chinook/llm';
import { extractPdfText } from './pdf-text';

export interface IngestResult {
  sourceId: string;
  factsSaved: number;
  factsRejected: number;
  duplicate: boolean;
}

/** Whitespace-insensitive substring check — the provenance gate (S11 R4). */
export function excerptInText(excerpt: string, text: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  return norm(text).includes(norm(excerpt));
}

async function extractText(format: 'docx' | 'pdf' | 'txt', bytes: Buffer): Promise<string> {
  if (format === 'docx') return extractDocxText(bytes);
  if (format === 'pdf') return extractPdfText(bytes);
  return bytes.toString('utf8');
}

/**
 * Ingests one resume document: store bytes (gitignored sources dir) →
 * sha256-deduped profile_source row → LLM fact extraction (flash) →
 * provenance gate per fact → profile_fact rows.
 */
export async function ingestProfileDocument(
  db: Kysely<Database>,
  llm: Llm,
  input: { fileName: string; format: 'docx' | 'pdf' | 'txt'; bytes: Buffer },
  opts?: { sourcesDir?: string },
): Promise<IngestResult> {
  const text = await extractText(input.format, input.bytes);
  if (text.replace(/\s+/g, '').length < 80) {
    throw new Error(`no extractable text in ${input.fileName} (${input.format})`);
  }

  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const existing = await findProfileSourceByHash(db, sha256);
  if (existing) {
    return { sourceId: existing.id, factsSaved: 0, factsRejected: 0, duplicate: true };
  }

  const dir = profileSourcesDir(opts?.sourcesDir);
  const storageName = `${Date.now()}-${sha256.slice(0, 8)}.${input.format}`;
  const target = safeSourceFilePath(dir, storageName);
  if (!target) throw new Error('storage path rejected');
  await mkdir(dir, { recursive: true });
  await writeFile(target, input.bytes);

  const source = await saveProfileSource(db, {
    fileName: input.fileName,
    format: input.format,
    storagePath: storageName,
    sha256,
    textChars: text.length,
  });

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
  if (accepted.length > 0) {
    await saveProfileFacts(
      db,
      source.id,
      accepted.map((f) => ({ kind: f.kind, payload: f.payload, excerpt: f.excerpt })),
    );
  }
  return { sourceId: source.id, factsSaved: accepted.length, factsRejected: rejected, duplicate: false };
}

export async function readMasterRaw(): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(masterProfileFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

export interface ProposalView {
  diff: SuperprofileDiffEntry[];
  conflicts: number;
  masterVersion: number;
  sources: number;
  facts: number;
}

/** Builds the superprofile proposal from all stored facts + the current master. */
export async function buildProposal(db: Kysely<Database>): Promise<ProposalView> {
  const [masterRaw, facts, sources] = await Promise.all([readMasterRaw(), listAllProfileFacts(db), listProfileSources(db)]);
  const masterObj = (masterRaw ?? {}) as Record<string, unknown>;
  const { diff } = buildSuperprofileProposal(masterObj, facts);
  return {
    diff,
    conflicts: diff.filter((d) => d.op === 'conflict').length,
    masterVersion: typeof masterObj.version === 'number' ? masterObj.version : 1,
    sources: sources.length,
    facts: facts.length,
  };
}

/**
 * Applies every non-conflict add of the current proposal to the master file
 * (backup first). Called ONLY from the PO approve action (Constitution 2.3).
 */
export async function approveProposal(db: Kysely<Database>): Promise<{ applied: number; version: number }> {
  const masterRaw = await readMasterRaw();
  if (!masterRaw) throw new Error('master profile unavailable');
  const masterObj = masterRaw as Record<string, unknown>;
  const facts = await listAllProfileFacts(db);
  const { proposed, diff } = buildSuperprofileProposal(masterObj, facts);
  const applicable = diff.filter((d) => d.op.startsWith('add_') || d.op === 'new_category');
  const currentVersion = typeof masterObj.version === 'number' ? masterObj.version : 1;
  if (applicable.length === 0) {
    return { applied: 0, version: currentVersion };
  }

  const file = masterProfileFilePath();
  const backup = `${file}.${Date.now()}.bak.json`;
  await writeFile(backup, JSON.stringify(masterObj, null, 2));

  await writeFile(file, JSON.stringify(proposed, null, 2));
  return { applied: applicable.length, version: currentVersion + 1 };
}
