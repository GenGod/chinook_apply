import type { Job } from '@chinook/contracts';
import { normalizeTitle } from './normalize.js';

/** NOC 21231/21234 title families — data, not logic; calibrated per S2 report. */
export const NOC_TITLE_FAMILIES: string[] = [
  'developer',
  'software',
  'web',
  'fullstack',
  'full stack',
  'frontend',
  'front end',
  'backend',
  'back end',
  'programmer',
  'typescript',
  'javascript',
  'react',
  'node',
  'nodejs',
  'node js',
  'angular',
  'vue',
  'nextjs',
  'next js',
  'python developer',
  'developpeur',
];

/** Titles with these markers are review (not excluded) — G1 answer #1. */
export const JUNIOR_MARKERS: string[] = [
  'intern',
  'internship',
  'junior',
  'co op',
  'coop',
  'student',
  'trainee',
  'entry level',
];

export type RuleStatus = 'relevant' | 'review' | 'excluded';

export interface RuleResult {
  status: RuleStatus;
  reasons: string[];
}

export interface ProfileSearch {
  targetProvince: string;
}

/**
 * Deterministic profile-based filter (S2; LLM scoring is S4):
 * - excluded: outside target province and not remote;
 * - review: right location but no dev-keyword match, or junior-marked title;
 * - relevant: right location and a keyword-family match.
 */
export function applyRules(job: Job, search: ProfileSearch): RuleResult {
  const title = normalizeTitle(job.title);

  const locationOk =
    job.location.remote || job.location.province.toUpperCase() === search.targetProvince.toUpperCase();
  if (!locationOk) {
    return { status: 'excluded', reasons: [`province:not-${search.targetProvince.toUpperCase()}`] };
  }

  const reasons: string[] = [];
  if (job.location.remote && job.location.province.toUpperCase() !== search.targetProvince.toUpperCase()) {
    reasons.push('location:remote');
  }

  const junior = JUNIOR_MARKERS.find((m) => title.includes(m));
  if (junior) {
    reasons.push(`seniority:junior-marker:${junior}`);
    return { status: 'review', reasons };
  }

  const keyword = NOC_TITLE_FAMILIES.find((f) => title.includes(f));
  if (keyword) {
    reasons.push(`keyword:match:${keyword}`);
    return { status: 'relevant', reasons };
  }

  reasons.push('keyword:no-match');
  return { status: 'review', reasons };
}
