import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { listArtifacts, latestRenderArtifactByKind, extractEmailCandidates } from '@chinook/core';
import type { BoardStatus, Database } from '@chinook/core';
import type { Kysely } from 'kysely';
import { getDb } from '@/lib/db';
import { fetchAdzunaFullDescription } from '@chinook/adapters';
import { StatusControls } from '../../board/status-controls';
import { DocumentsSection } from './documents-section';
import { EmailDispatchSection } from './email-dispatch-section';
import styles from '../../board/board.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chinook — Job details' };

function jb(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === 'string') { try { return JSON.parse(v) as string[]; } catch { return []; } }
  return v as string[];
}

function rawDescription(raw: unknown): string {
  if (raw == null || typeof raw !== 'object') return '';
  const r = raw as Record<string, unknown>;
  const s = r.summary;
  if (s != null && typeof s === 'object') {
    const t = (s as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
  }
  const d = r.description;
  if (typeof d === 'string') return d;
  return '';
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6 }}>
      <span style={{ minWidth: 140, color: 'var(--text-muted)', fontSize: 'var(--text-aux)' }}>{props.label}</span>
      <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>{props.children}</span>
    </div>
  );
}

async function fetchFullJob(db: Kysely<Database>, jobId: string) {
  const j = await db.selectFrom('job').where('job.id', '=', jobId)
    .select(['job.id','job.title','job.employer','job.city','job.province','job.remote',
      'job.url','job.urls','job.source','job.source_job_id','job.rule_status',
      'job.rule_reasons','job.salary_min','job.salary_max','job.noc_code',
      'job.posted_at','job.ingested_at','job.raw'])
    .executeTakeFirst();
  if (!j) return null;
  const a = await db.selectFrom('application').where('application.job_id', '=', jobId)
    .select(['application.status','application.channel']).executeTakeFirst();
  const m = await db.selectFrom('job_match').where('job_match.job_id', '=', jobId)
    .select(['job_match.score','job_match.reasons','job_match.risks','job_match.noc_guess'])
    .orderBy('job_match.id', 'desc').executeTakeFirst();
  return { ...j, app: a ?? null, match: m ?? null };
}

/** Fetches the full description from a Job Bank posting page and caches it. */
async function enrichFromPostingPage(
  db: Kysely<Database>,
  jobId: string,
  postingUrl: string,
  existingRaw: Record<string, unknown>,
): Promise<string | null> {
  // Only fetch from the allowlisted Job Bank host
  const parsed = new URL(postingUrl);
  if (parsed.hostname !== 'www.jobbank.gc.ca' || parsed.protocol !== 'https:') return null;

  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'Chinook/0.1 (job-search automation)', Accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;
  const html = await response.text();

  // Remove script/style blocks entirely
  let cleaned = html;
  let sIdx = cleaned.indexOf('<script');
  while (sIdx >= 0) {
    const eIdx = cleaned.indexOf('</script>', sIdx);
    if (eIdx < 0) break;
    cleaned = cleaned.slice(0, sIdx) + cleaned.slice(eIdx + 9);
    sIdx = cleaned.indexOf('<script');
  }
  sIdx = cleaned.indexOf('<style');
  while (sIdx >= 0) {
    const eIdx = cleaned.indexOf('</style>', sIdx);
    if (eIdx < 0) break;
    cleaned = cleaned.slice(0, sIdx) + cleaned.slice(eIdx + 8);
    sIdx = cleaned.indexOf('<style');
  }

  // Strip HTML tags (character-by-character, no regex)
  let text = '';
  let inTag = false;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '<') { inTag = true; text += ' '; continue; }
    if (c === '>') { inTag = false; continue; }
    if (!inTag) text += c;
  }

  // Decode HTML entities
  const decodePairs: Array<[string, string]> = [
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' '],
  ];
  for (const [ent, ch] of decodePairs) {
    text = text.split(ent).join(ch);
  }

  // Clean up whitespace
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const result = lines.join('\n');

  if (result.length < 200) return null;

  // Cache in database for future views
  const updatedRaw = { ...existingRaw, fullDescription: result };
  await db.updateTable('job').set({ raw: updatedRaw }).where('job.id', '=', jobId).execute();

  return result;
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await fetchFullJob(getDb(), id);
  if (!job) notFound();
  const artifacts = await listArtifacts(getDb(), id);
  const db = getDb();
  const renders = (
    await Promise.all(
      (['render_docx', 'render_pdf'] as const).map(async (kind) => {
        const view = await latestRenderArtifactByKind(db, id, kind);
        if (!view) return null;
        const source = artifacts.find((a) => a.id === view.sourceArtifactId);
        const sourceLabel = source?.kind === 'cover_letter' ? 'Cover letter' : 'Resume';
        return { view, sourceLabel };
      }),
    )
  ).filter((entry): entry is { view: typeof artifacts[number]; sourceLabel: string } => entry !== null);
  const candidates = extractEmailCandidates(job.raw);

  const bs = job.app?.status ?? 'new';
  const bc = job.app?.channel ?? null;
  const from = (bs === 'applied' ? `applied_${bc}` : bs) as BoardStatus;
  const raw = (job.raw ?? {}) as Record<string, unknown>;
  const fullDesc = raw.fullDescription;
  const feedDesc = rawDescription(job.raw);
  let desc = typeof fullDesc === 'string' && fullDesc.length > 100 ? fullDesc : feedDesc;

  // Enrichment: if description is short, fetch the full posting text
  if ((!desc || desc.length < 600) && job.url) {
    try {
      let enriched: string | null = null;
      if (job.source === 'jobbank') {
        enriched = await enrichFromPostingPage(getDb(), id, job.url, raw);
      } else if (job.source === 'adzuna') {
        // Adzuna API caps description at 500 chars; the details page has the
        // full text in a JobPosting JSON-LD block. Cache like jobbank does.
        enriched = await fetchAdzunaFullDescription(job.url);
        if (enriched && enriched.length > 200) {
          await getDb().updateTable('job')
            .set({ raw: { ...raw, fullDescription: enriched } })
            .where('job.id', '=', id)
            .execute();
        }
      }
      if (enriched && enriched.length > (desc?.length ?? 0)) {
        desc = enriched;
      }
    } catch {
      // enrichment failure → show what we have
    }
  }
  const urls = jb(job.urls);
  const allUrls = urls.length > 0 ? urls : [job.url];
  const rr = jb(job.rule_reasons);
  const ms = job.match?.score ?? null;
  const mr = jb(job.match?.reasons);
  const mrisks = jb(job.match?.risks);
  const ng = job.match?.noc_guess ?? null;
  const sMin = job.salary_min !== null ? Number(job.salary_min) : null;
  const sMax = job.salary_max !== null ? Number(job.salary_max) : null;
  const scoreColor = ms !== null ? (ms > 90 ? 'var(--accent)' : ms >= 70 ? 'var(--status-success)' : ms >= 40 ? 'var(--status-warning)' : 'var(--text-muted)') : 'inherit';

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Chinook</h1>
        <span className={styles.subtitle}>Job details</span>
        <nav className={styles.nav}><a className={styles.navLink} href="/board">Board</a><a className={styles.navLink} href="/">Jobs</a></nav>
      </div>
      <div className="horizon" style={{ marginTop: 4, marginBottom: 20 }} />
      <article style={{ maxWidth: 860 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 'var(--text-section)', fontWeight: 600 }}>{job.title}</h2>
        <div style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
          {job.employer} · {job.remote ? 'Remote' : `${job.city}${job.province ? `, ${job.province}` : ''}`} · {job.source} · {job.posted_at ? job.posted_at.toISOString().slice(0, 10) : '—'}
        </div>
        <p><a href={job.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>Open original posting ↗</a></p>

        <section style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0', paddingTop: 16 }}>
          <h3 style={{ fontSize: 'var(--text-emphasis)', margin: '0 0 12px' }}>Details</h3>
          <Field label="Salary">{sMin !== null || sMax !== null ? `$${(sMin ?? sMax ?? 0).toLocaleString()}${sMin !== null && sMax !== null ? ` – $${sMax.toLocaleString()}` : ''} CAD/yr` : '—'}</Field>
          <Field label="Rule status"><span style={{ color: job.rule_status === 'relevant' ? 'var(--status-success)' : job.rule_status === 'review' ? 'var(--status-warning)' : 'var(--text-muted)' }}>{job.rule_status ?? '—'}</span>{rr.length > 0 ? <span style={{ color: 'var(--text-muted)' }}> ({rr.join(', ')})</span> : null}</Field>
          <Field label="Match score">{ms !== null ? <span style={{ fontWeight: 600, color: scoreColor }}>{ms}</span> : '—'}</Field>
          {mr.length > 0 ? <Field label="Why this score">{mr.join('; ')}</Field> : null}
          {mrisks.length > 0 ? <Field label="Risks">{mrisks.join('; ')}</Field> : null}
          <Field label="NOC code">{job.noc_code ?? ng ?? '—'}</Field>
          <Field label="Source ID">{job.source_job_id ?? '—'}</Field>
          <Field label="Remote">{job.remote ? 'Yes' : 'No'}</Field>
          <Field label="Location">{job.remote ? 'Remote' : `${job.city}${job.province ? `, ${job.province}` : ''}`}</Field>
          <Field label="Posted">{job.posted_at ? job.posted_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'}</Field>
          <Field label="Ingested">{job.ingested_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'}</Field>
          {allUrls.length > 1 ? <Field label="All URLs"><div>{allUrls.map((u: string, i: number) => (<div key={i}><a href={u} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--badge-source-text)' }}>{u.slice(0, 60)}{u.length > 60 ? '…' : ''}</a></div>))}</div></Field> : null}
        </section>

        <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0', paddingTop: 16 }}>
          <div style={{ fontSize: 'var(--text-aux)', color: 'var(--text-muted)', marginBottom: 8 }}>Status: {from.replace('_', ' · ')}</div>
          <StatusControls jobId={job.id} from={from} />
        </div>

        <DocumentsSection jobId={job.id} initialArtifacts={artifacts} />

        <EmailDispatchSection
          jobId={job.id}
          renders={renders}
          candidates={candidates}
          mode={process.env.DISPATCH_MODE ?? 'dry-run'}
        />

        {desc ? (
          <section style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 'var(--text-emphasis)', margin: '0 0 8px' }}>Description</h3>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>{desc}</p>
          </section>
        ) : null}
      </article>
    </main>
  );
}
