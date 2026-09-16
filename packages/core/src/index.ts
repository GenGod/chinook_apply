export {
  normalizeTitle,
  normalizeEmployer,
  parseLocation,
  type ParsedLocation,
} from './normalize.js';
export { createHash, normalizeJob, type HashComponents } from './canonical.js';
export { dedupe, diceSimilarity, FUZZY_THRESHOLD, type DedupeResult, type FuzzyPair } from './dedupe.js';
export const CORE_MARKER = 's1';
