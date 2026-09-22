// Lazy enrichment: fetches full description from Job Bank posting page
// when the stored description is too short (search APIs return ~200-500 chars).
import type { Kysely } from 'kysely';
import type { Database } from '@chinook/core';
import { fetchPostingDescription } from '@chinook/adapters/posting-fetcher';

const MIN_DESCRIPTION_LENGTH = 600; // below this, try to enrich

/** Returns the best available description, enriching from the posting page if needed. */
export async function getEnrichedDescription(
  db: Kysely<Database>,
  jobId: string,
): Promise<string | null> {
  const job = await db
    .selectFrom('job')
    .where('job.id', '=', jobId)
    .select(['job.raw', 'job.source', 'job.url'])
    .executeTakeFirst();

  if (!job) return null;

  const raw = (job.raw ?? {}) as Record<string, unknown>;
  
  // already enriched → return cached
  const cached = raw.fullDescription;
  if (typeof cached === 'string' && cached.length >= MIN_DESCRIPTION_LENGTH) {
    return cached;
  }

  // get the feed/API description
  const feed = feedDescription(raw);
  
  // only enrich Job Bank (consistent page format; Adzuna redirects to varying external sites)
  if (job.source !== 'jobbank' || !job.url) {
    return feed;
  }

  // if feed description is already long enough, use it
  if (feed && feed.length >= MIN_DESCRIPTION_LENGTH) {
    return feed;
  }

  // try to fetch the full posting page
  try {
    const full = await fetchPostingDescription(job.url);
    if (full && full.length > (feed?.length ?? 0)) {
      // cache in raw for future views
      const enrichedRaw = { ...raw, fullDescription: full };
      await db
        .updateTable('job')
        .set({ raw: enrichedRaw })
        .where('job.id', '=', jobId)
        .execute();
      return full;
    }
  } catch {
    // network/parsing failure → return what we have
  }

  return feed;
}

function feedDescription(raw: Record<string, unknown>): string | null {
  const s = raw.summary;
  if (s != null && typeof s === 'object') {
    const t = (s as Record<string, unknown>)['#text'];
    if (typeof t === 'string') return t;
  }
  const d = raw.description;
  if (typeof d === 'string') return d;
  return null;
}
