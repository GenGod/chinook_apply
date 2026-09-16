import { z } from 'zod';

/** Canonical identifier of an ingestion source. */
export const JobSourceIdSchema = z.enum([
  'jobbank',
  'adzuna',
  'indeed',
  'alis',
  'rss',
  'telegram',
  'email',
]);
export type JobSourceId = z.infer<typeof JobSourceIdSchema>;

/**
 * Source-agnostic shape produced by every adapter: source-specific parsing
 * (XML summaries, JSON payloads) is done in adapters; generic normalization,
 * hashing and deduplication happen in @chinook/core.
 */
export const RawJobSchema = z.object({
  title: z.string().min(1),
  employer: z.string().min(1),
  locationRaw: z.string(),
  url: z.url(),
  postedAt: z.iso.datetime().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryPeriod: z.enum(['hourly', 'annual']).nullable(),
  sourceJobId: z.string().nullable(),
  raw: z.unknown(),
});
export type RawJob = z.infer<typeof RawJobSchema>;

/** Normalized, deduplicated vacancy stored in Postgres. */
export const JobSchema = z.object({
  id: z.uuid(),
  canonicalHash: z.string().refine((s) => s.startsWith('canonical_v1:'), {
    message: 'must be versioned as canonical_v1',
  }),
  title: z.string().min(1),
  employer: z.string().min(1),
  location: z.object({
    city: z.string(),
    province: z.string(),
    remote: z.boolean(),
  }),
  url: z.url(),
  urls: z.array(z.url()),
  source: JobSourceIdSchema,
  sourceJobId: z.string().nullable(),
  postedAt: z.iso.datetime().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.literal('CAD'),
  nocCode: z.string().nullable(),
  raw: z.unknown(),
  ingestedAt: z.iso.datetime(),
});
export type Job = z.infer<typeof JobSchema>;

export interface Adapter {
  readonly id: JobSourceId;
  /** Live fetch (respecting robots.txt / rate limits of the source). */
  fetch(since?: string): Promise<RawJob[]>;
}

export const CONTRACTS_VERSION = '1' as const;
