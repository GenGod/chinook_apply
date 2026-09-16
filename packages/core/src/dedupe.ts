import type { Job } from '@chinook/contracts';
import { normalizeEmployer, normalizeTitle } from './normalize';

export interface FuzzyPair {
  kept: Job;
  dropped: Job;
  score: number;
}

export interface DedupeResult {
  unique: Job[];
  merged: number;
  fuzzyPairs: FuzzyPair[];
}

export const FUZZY_THRESHOLD = 0.92;

/** Sørensen–Dice coefficient over character bigrams (no dependencies). */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  let total = 0;
  for (const count of ga.values()) total += count;
  for (const count of gb.values()) total += count;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / total;
}

function earlier(a: Job, b: Job): Job {
  const ta = a.postedAt ?? '9999';
  const tb = b.postedAt ?? '9999';
  if (ta !== tb) return ta < tb ? a : b;
  return a.url <= b.url ? a : b;
}

function mergeInto(kept: Job, dropped: Job): Job {
  return {
    ...kept,
    urls: [...new Set([...kept.urls, ...dropped.urls])].sort(),
    salaryMin: kept.salaryMin ?? dropped.salaryMin,
    salaryMax: kept.salaryMax ?? dropped.salaryMax,
    nocCode: kept.nocCode ?? dropped.nocCode,
  };
}

/**
 * Two-level deduplication:
 * 1. exact — identical canonicalHash;
 * 2. fuzzy — dice ≥ FUZZY_THRESHOLD on normalized title within the same
 *    (city, province, remote, normalized employer) bucket.
 * Representative keeps the earliest postedAt; urls are merged.
 */
export function dedupe(jobs: Job[]): DedupeResult {
  // Level 1: exact by canonical hash.
  const byHash = new Map<string, Job>();
  let merged = 0;
  for (const job of jobs) {
    const existing = byHash.get(job.canonicalHash);
    if (!existing) {
      byHash.set(job.canonicalHash, job);
    } else {
      byHash.set(job.canonicalHash, mergeInto(earlier(existing, job), existing === earlier(existing, job) ? job : existing));
      merged += 1;
    }
  }
  const survivors = [...byHash.values()];

  // Level 2: fuzzy within location+employer buckets (union-find over indices).
  const buckets = new Map<string, number[]>();
  survivors.forEach((job, i) => {
    const key = [
      job.location.city,
      job.location.province,
      job.location.remote,
      normalizeEmployer(job.employer),
    ].join('¦');
    const list = buckets.get(key) ?? [];
    list.push(i);
    buckets.set(key, list);
  });

  const parent = survivors.map((_, i) => i);
  const find = (i: number): number => {
    const p = parent[i];
    if (p === undefined || p === i) return i;
    const root = find(p);
    parent[i] = root;
    return root;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const fuzzyPairs: FuzzyPair[] = [];

  for (const indices of buckets.values()) {
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const a = survivors[indices[i]!]!;
        const b = survivors[indices[j]!]!;
        const score = diceSimilarity(normalizeTitle(a.title), normalizeTitle(b.title));
        if (score >= FUZZY_THRESHOLD && find(indices[i]!) !== find(indices[j]!)) {
          union(indices[i]!, indices[j]!);
          fuzzyPairs.push({ kept: earlier(a, b), dropped: earlier(a, b) === a ? b : a, score });
          merged += 1;
        }
      }
    }
  }

  const groups = new Map<number, Job[]>();
  survivors.forEach((job, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), job]);
  });

  const unique: Job[] = [];
  for (const members of groups.values()) {
    const [first] = members;
    if (!first) continue;
    unique.push(members.reduce((acc, cur) => mergeInto(earlier(acc, cur), earlier(acc, cur) === acc ? cur : acc)));
  }
  unique.sort((a, b) => (a.canonicalHash < b.canonicalHash ? -1 : 1));
  return { unique, merged, fuzzyPairs };
}
