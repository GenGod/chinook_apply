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
export {
  validateFormConfig,
  detectCaptcha,
  buildFormValues,
  type FormConfig,
  type FormValues,
} from './form-dispatch';
export {
  extractEmailCandidates,
  buildDispatchEmail,
  type DispatchJobLike,
  type DispatchEmail,
} from './dispatch';
export { seedE2eExtras, seedArtifactsOnJob, type ArtifactFixture } from './seed';
export {
  listJobs,
  markAppliedManually,
  listUnscoredJobs,
  upsertMatch,
  type JobFilters,
  type JobListItem,
  type ApplicationRow,
  type UnscoredJob,
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
  saveProfileSource,
  findProfileSourceByHash,
  listProfileSources,
  saveProfileFacts,
  listProfileFacts,
  listAllProfileFacts,
  type ProfileSourceView,
  type ProfileFactRow,
  type ProfileFactKind,
  type NewProfileFact,
} from './profile-store';
export {
  BOARD_STATUSES, TRANSITIONS, canTransition, requiredChannel,
  getBoard, setApplicationStatus, TransitionError,
  type BoardStatus, type StoredStatus, type BoardCard, type BoardColumn, type BoardData, type BoardFilters,
} from './board';
export { planSources, nextDue, type SourceSchedule } from './schedule';
export { getMetrics, DEFAULT_INTERVALS, type MetricsSummary, type SourceHealth, type HistoryRow } from './metrics';
export {
  saveArtifact,
  listArtifacts,
  getArtifactContent,
  saveRenderArtifact,
  findRenderArtifact,
  nextRenderVersion,
  saveDispatchLog,
  countSentToday,
  latestRenderArtifactByKind,
  type ArtifactView,
  type ArtifactContent,
  type RenderFormat,
  type DispatchAttachment,
} from './artifacts';
export {
  extractEntities,
  validateResumeDiff,
  assembleResume,
  validateCoverLetter,
  UnknownReferenceError,
  type Violation,
  type ViolationKind,
  type ValidationReport,
  type MasterProfileLike,
  type ResumeDiffLike,
  type TailoredResume,
} from './generation-validators';
export {
  buildResumeRenderModel,
  buildCoverRenderModel,
  groupSkills,
  renderIdentityFromMaster,
  renderIdentityFromContent,
  normalizeTailoredResume,
  normalizeLetter,
  type RenderIdentity,
  type RenderResumeModel,
  type RenderCoverModel,
} from './render-model';
export { encodeResumeDocx, encodeCoverDocx } from './render-docx';
export { encodeResumePdf, encodeCoverPdf } from './render-pdf';
export const CORE_MARKER = 's1';
