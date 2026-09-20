export {
  normalizeTitle,
  normalizeEmployer,
  parseLocation,
  PROVINCES,
  PROVINCE_CODES,
  type ParsedLocation,
  type ProvinceCode,
} from './normalize';
export { createHash, normalizeJob, type HashComponents } from './canonical';
export { dedupe, diceSimilarity, FUZZY_THRESHOLD, type DedupeResult, type FuzzyPair } from './dedupe';
export {
  createDb,
  createDbFromEnv,
  resolveDatabaseUrl,
  assertSafeDatabaseUrl,
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
export { seedE2eExtras } from './seed';
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
export {
  BOARD_STATUSES, TRANSITIONS, canTransition, requiredChannel,
  getBoard, setApplicationStatus, TransitionError,
  type BoardStatus, type StoredStatus, type BoardCard, type BoardColumn, type BoardData, type BoardFilters,
} from './board';
export { planSources, nextDue, type SourceSchedule } from './schedule';
export { getMetrics, DEFAULT_INTERVALS, type MetricsSummary, type SourceHealth, type HistoryRow } from './metrics';
export const CORE_MARKER = 's1';
