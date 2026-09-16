export {
  normalizeTitle,
  normalizeEmployer,
  parseLocation,
  type ParsedLocation,
} from './normalize.js';
export { createHash, normalizeJob, type HashComponents } from './canonical.js';
export { dedupe, diceSimilarity, FUZZY_THRESHOLD, type DedupeResult, type FuzzyPair } from './dedupe.js';
export {
  createDb,
  createDbFromEnv,
  resolveDatabaseUrl,
  DEV_DATABASE_URL,
  ensureSchema,
  upsertJobs,
  countJobs,
  SCHEMA_SQL,
  type Database,
  type JobRow,
  type IngestRunRow,
} from './db.js';
export {
  listJobs,
  markAppliedManually,
  type JobFilters,
  type JobListItem,
  type ApplicationRow,
} from './repository.js';
export const CORE_MARKER = 's1';
