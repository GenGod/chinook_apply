import type { Metadata } from 'next';
import { listJobs, type JobFilters, type JobListItem } from '@chinook/core';
import type { JobSourceId } from '@chinook/contracts';
import { getDb } from '@/lib/db';
import { AppliedToggle } from './applied-toggle';
import styles from './jobs.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chinook — Jobs',
  description: 'Alberta job search automation (Express Entry)',
};

interface SearchParams {
  source?: string;
  days?: string;
  salaryMin?: string;
  sort?: string;
}

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All sources' },
  { value: 'jobbank', label: 'Job Bank' },
  { value: 'adzuna', label: 'Adzuna' },
];

function parseFilters(sp: SearchParams): JobFilters {
  const filters: JobFilters = {};
  if (sp.source === 'jobbank' || sp.source === 'adzuna') filters.source = sp.source as JobSourceId;
  if (sp.days === '7' || sp.days === '30') filters.days = Number(sp.days);
  const salary = Number(sp.salaryMin);
  if (Number.isFinite(salary) && salary > 0) filters.salaryMin = salary;
  if (sp.sort === 'salary') filters.sort = 'salary';
  return filters;
}

function salaryLabel(job: JobListItem): string {
  if (job.salaryMin === null && job.salaryMax === null) return '—';
  const fmt = (v: number) => `$${Math.round(v / 1000)}k`;
  if (job.salaryMin !== null && job.salaryMax !== null) return `${fmt(job.salaryMin)}–${fmt(job.salaryMax)}/yr`;
  return `${fmt(job.salaryMin ?? job.salaryMax!)}/yr`;
}

function postedLabel(job: JobListItem): string {
  return job.postedAt ? job.postedAt.slice(0, 10) : '—';
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const jobs = await listJobs(getDb(), parseFilters(sp));

  return (
    <main style={{ minHeight: '100vh', background: '#0d1b2a', color: '#e0e6ed', padding: '24px 32px' }}>
      <div className={styles.heading}>
        <h1 style={{ margin: 0, width: '140px', height: '56px', lineHeight: '56px', fontSize: '28px' }}>Chinook</h1>
        <span className={styles.muted} style={{ display: 'inline-block', width: '320px', height: '56px', lineHeight: '56px', fontSize: '15px' }}>
          Jobs — Alberta (Express Entry)
        </span>
      </div>

      <form className={styles.bar} method="get" data-testid="filters">
        <div className={styles.field}>
          <label htmlFor="source">Source</label>
          <select id="source" name="source" defaultValue={sp.source ?? ''}>
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="days">Posted</label>
          <select id="days" name="days" defaultValue={sp.days ?? ''}>
            <option value="">Any time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor="salaryMin">Salary from (CAD/yr)</label>
          <input id="salaryMin" name="salaryMin" type="number" min="0" step="1000" placeholder="e.g. 90000" defaultValue={sp.salaryMin ?? ''} />
        </div>
        <div className={styles.field}>
          <label htmlFor="sort">Sort</label>
          <select id="sort" name="sort" defaultValue={sp.sort ?? 'posted'}>
            <option value="posted">Newest</option>
            <option value="salary">Salary</option>
          </select>
        </div>
        <button className={styles.submit} type="submit">
          Apply filters
        </button>
      </form>

      <div style={{ height: 16 }} />

      {jobs.length === 0 ? (
        <div className={`${styles.tableWrap} ${styles.empty}`} data-testid="empty">
          No jobs match — run <code>pnpm --filter @chinook/worker run ingest</code>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="jobs-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Employer</th>
                <th>Location</th>
                <th>Source</th>
                <th>Salary</th>
                <th>Posted</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} data-job-id={job.id}>
                  <td>
                    <a className={styles.titleLink} href={job.url} target="_blank" rel="noopener noreferrer">
                      {job.title}
                    </a>
                  </td>
                  <td>{job.employer}</td>
                  <td className={styles.muted}>
                    {job.location.remote ? 'Remote' : `${job.location.city || '—'}${job.location.province ? `, ${job.location.province}` : ''}`}
                  </td>
                  <td>
                    <span className={styles.source}>{job.source}</span>
                  </td>
                  <td>{salaryLabel(job)}</td>
                  <td className={styles.muted}>{postedLabel(job)}</td>
                  <td>
                    <AppliedToggle jobId={job.id} initiallyApplied={job.appliedManually} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
