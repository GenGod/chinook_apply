/** Canonical identifier of an ingestion source (S1 will extend this contract). */
export type JobSourceId =
  | 'jobbank'
  | 'adzuna'
  | 'indeed'
  | 'alis'
  | 'rss'
  | 'telegram'
  | 'email';

/** Shared package contract marker — used by arch-lint tests. */
export const CONTRACTS_VERSION = '0' as const;
