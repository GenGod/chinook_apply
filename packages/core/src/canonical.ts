import { createHash as nodeCreateHash } from 'node:crypto';
import { normalizeEmployer, normalizeTitle, parseLocation } from './normalize';
import type { Job, JobSourceId, RawJob } from '@chinook/contracts';
import { RawJobSchema, JobSchema } from '@chinook/contracts';

export interface HashComponents {
  title: string;
  employer: string;
  city: string;
  province: string;
}

/**
 * Versioned canonical hash over normalized identity components.
 * No sourceId inside: cross-source duplicates collapse into one Job (S1 R5).
 */
export function createHash(components: HashComponents): string {
  const material = [
    normalizeTitle(components.title),
    normalizeEmployer(components.employer),
    normalizeTitle(components.city),
    components.province.toUpperCase(),
  ].join('|');
  return `canonical_v1:${nodeCreateHash('sha256').update(material).digest('hex')}`;
}

const HOURS_PER_YEAR = 2080; // 40h × 52w — annualization basis for hourly wages

/** Normalizes an untrusted RawJob into a contract-valid Job. */
export function normalizeJob(raw: RawJob, source: JobSourceId, now = new Date()): Job {
  const validated = RawJobSchema.parse(raw);
  const location = parseLocation(validated.locationRaw);
  const annualize = (v: number | null): number | null =>
    validated.salaryPeriod === 'hourly' && v !== null ? v * HOURS_PER_YEAR : v;
  const job: Job = {
    id: crypto.randomUUID(),
    canonicalHash: createHash({
      title: validated.title,
      employer: validated.employer,
      city: location.city,
      province: location.province,
    }),
    title: validated.title.trim(),
    employer: validated.employer.trim(),
    location,
    url: validated.url,
    urls: [validated.url],
    source,
    sourceJobId: validated.sourceJobId,
    postedAt: validated.postedAt,
    salaryMin: annualize(validated.salaryMin),
    salaryMax: annualize(validated.salaryMax),
    salaryCurrency: 'CAD',
    nocCode: null,
    raw: validated.raw,
    ingestedAt: now.toISOString(),
  };
  return JobSchema.parse(job);
}
