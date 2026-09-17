export {
  normalizeTitle,
  normalizeEmployer,
  parseLocation,
  type ParsedLocation,
} from './normalize';
export { createHash, normalizeJob, type HashComponents } from './canonical';
export { dedupe, diceSimilarity, FUZZY_THRESHOLD, type DedupeResult, type FuzzyPair } from './dedupe';
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
  type ApplicationTable,
  type Kysely,
} from './db';
export {
  listJobs,
  markAppliedManually,
  type JobFilters,
  type JobListItem,
  type ApplicationRow,
} from './repository';
export {
  applyRules,
  NOC_TITLE_FAMILIES,
  JUNIOR_MARKERS,
  type RuleStatus,
  type RuleResult,
  type ProfileSearch,
} from './rules';
export { loadProfileSearch, DEFAULT_PROFILE_SEARCH } from './profile';
export { planSources, nextDue, type SourceSchedule } from './schedule';
export const CORE_MARKER = 's1';
