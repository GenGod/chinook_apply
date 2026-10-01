export {
  createLlm,
  DegradeError,
  computeCacheKey,
  computeCostUsd,
  type Llm,
  type LlmCall,
  type LlmResult,
  type LlmUsage,
  type LlmRole,
  type LlmDb,
} from './gateway';
export { createPgLlmDb, type LlmStatsSummary } from './llm-db';
export {
  buildScoringPrompt,
  scoreJob,
  SCORING_PROMPT_VERSION,
  MatchScoreSchema,
  type MatchScore,
  type ScoringJob,
} from './scoring';
export {
  buildResumePrompt,
  buildCoverPrompt,
  RESUME_PROMPT_VERSION,
  COVER_PROMPT_VERSION,
  ResumeDiffSchema,
  CoverSchema,
  type ResumeDiff,
  type CoverLetter,
  type GenerationJob,
} from './generation';
export { extractProfileSummary, type ProfileSummary } from './profile-context';

// S23: generation orchestration + auto-draft (moved from apps/web; core must
// not depend on llm — this package orchestrates the gateway).
export {
  generateDocuments,
  loadMasterProfile,
  loadMasterIdentity,
  GenerationLimitError,
  JobNotEligibleError,
} from './document-generation';
export {
  runAutoDraft,
  selectAutoDraftCandidates,
  autodraftEnabled,
  DEFAULT_AUTODRAFT_SCORE,
  DEFAULT_AUTODRAFT_JOBS_PER_DAY,
  type AutoDraftCandidate,
  type AutoDraftSummary,
} from './autodraft';
export {
  ProfileFactsSchema,
  buildFactExtractionPrompt,
  FACTS_PROMPT_VERSION,
  type ProfileFacts,
  type ExtractedFact,
} from './profile-facts';
