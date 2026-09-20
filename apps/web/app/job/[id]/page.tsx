import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'kysely';
import type { BoardStatus } from '@chinook/core';
import { getDb } from '@/lib/db';
import { StatusControls } from '../../board/status-controls';
import styles from '../../board/board.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chinook — Job details',
};

interface JobDetail {
  id: string;
  title: string;
  employer: string;
  city: string;
  province: string;
  remote: boolean;
  url: string;
  source: string;
  rule_status: string | null;
  salary_min: string | number | null;
  salary_max: string | number | null;
  posted_at: Date | null;
  raw: unknown;
  board_status: string | null;
  board_channel: string | null;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

/** Provider HTML → plain text: block breaks become newlines, tags stripped, entities decoded. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*(?:br|\/p|\/li|\/h[1-6])\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function descriptionFrom(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const summary = typeof r.summary === 'object' && r.summary !== null ? (r.summary as { '#text'?: string })['#text'] : undefined;
  if (typeof summary === 'string') return htmlToText(summary) || null;
  const desc = (r as { description?: unknown }).description;
  if (typeof desc === 'string') return htmlToText(desc) || null;
  return null;
}

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = (
    await sql<JobDetail>`select j.id, j.title, j.employer, j.city, j.province, j.remote, j.url,
        j.source, j.rule_status, j.salary_min, j.salary_max, j.posted_at, j.raw,
        a.status as board_status, a.channel as board_channel
      from job j left join application a on a.job_id = j.id
      where j.id = ${id} limit 1`.execute(getDb())
  ).rows;
  const job = rows[0];
  if (!job) notFound();

  const from = (
    job.board_status === 'applied'
      ? `applied_${job.board_channel}`
      : (job.board_status ?? 'new')
  ) as BoardStatus;
  const description = descriptionFrom(job.raw);
  const salary =
    job.salary_min !== null || job.salary_max !== null
      ? `$${Math.round(Number(job.salary_min ?? job.salary_max) / 1000)}k${
          job.salary_min !== null && job.salary_max !== null
            ? `–$${Math.round(Number(job.salary_max) / 1000)}k`
            : ''
        }/yr`
      : '—';

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Chinook</h1>
        <span className={styles.subtitle}>Job details</span>
        <nav className={styles.nav}>
          <a className={styles.navLink} href="/board">Board</a>
          <a className={styles.navLink} href="/">Jobs</a>
        </nav>
      </div>
      <div className="horizon" style={{ marginTop: 4, marginBottom: 20 }} />

      <article style={{ maxWidth: 760 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 'var(--text-section)', fontWeight: 600 }}>{job.title}</h2>
        <div style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>
          {job.employer} · {job.remote ? 'Remote' : `${job.city}${job.province ? `, ${job.province}` : ''}`} ·{' '}
          {job.source} · {job.posted_at ? job.posted_at.toISOString().slice(0, 10) : '—'}
        </div>
        <div style={{ color: 'var(--text-secondary)', marginBottom: 12 }}>{salary} · rule: {job.rule_status ?? '—'}</div>
        <p>
          <a href={job.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            Open original posting
          </a>
        </p>
        <div style={{ borderTop: '1px solid var(--border-subtle)', margin: '16px 0', paddingTop: 16 }}>
          <div style={{ fontSize: 'var(--text-aux)', color: 'var(--text-muted)', marginBottom: 8 }}>
            Status: {from.replace('_', ' · ')}
          </div>
          <StatusControls jobId={job.id} from={from} />
        </div>
        {description ? (
          <section style={{ marginTop: 24 }}>
            <h3 style={{ fontSize: 'var(--text-emphasis)', margin: '0 0 8px' }}>Description</h3>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}>{description}</p>
          </section>
        ) : null}
      </article>
    </main>
  );
}
