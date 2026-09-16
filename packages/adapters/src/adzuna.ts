import type { RawJob } from '@chinook/contracts';

export const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs/ca/search';

export const adzunaAdapter = {
  id: 'adzuna' as const,

  searchUrl(params: {
    appId: string;
    appKey: string;
    page?: number;
    what?: string;
    where?: string;
    resultsPerPage?: number;
  }): string {
    const url = new URL(`${ADZUNA_BASE}/${params.page ?? 1}`);
    url.searchParams.set('app_id', params.appId);
    url.searchParams.set('app_key', params.appKey);
    url.searchParams.set('what', params.what ?? 'software developer');
    url.searchParams.set('where', params.where ?? 'Alberta');
    url.searchParams.set('results_per_page', String(params.resultsPerPage ?? 50));
    url.searchParams.set('content-type', 'application/json');
    return url.toString();
  },

  async fetch(credentials: { appId: string; appKey: string }, what = 'software developer'): Promise<unknown> {
    const response = await fetch(
      this.searchUrl({ ...credentials, what }),
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
      throw new Error(`adzuna HTTP ${response.status}`);
    }
    return response.json();
  },

  parse(payload: unknown, regionHint = 'Alberta'): RawJob[] {
    const results = (payload as AdzunaResponse)?.results ?? [];
    return results.map((r) => ({
      title: r.title?.trim() ?? 'Untitled',
      employer: r.company?.display_name?.trim() || 'Unknown employer',
      locationRaw: withRegionHint(r.location?.display_name ?? '', regionHint),
      url: r.redirect_url ?? '',
      postedAt: r.created ?? null,
      salaryMin: typeof r.salary_min === 'number' ? r.salary_min : null,
      salaryMax: typeof r.salary_max === 'number' ? r.salary_max : null,
      salaryPeriod: typeof r.salary_min === 'number' ? 'annual' : null,
      sourceJobId: r.id != null ? String(r.id) : null,
      raw: r,
    }));
  },
};

/** Adzuna often returns "Calgary, Canada" without the province; the search context (where=) is the honest hint. */
function withRegionHint(location: string, hint: string): string {
  if (!location || !hint) return location;
  const hasProvince =
    /,\s*(Alberta|Ontario|Quebec|British Columbia|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|Prince Edward|Yukon|Nunavut|Northwest)/i.test(location) ||
    /\([A-Z]{2}\)/.test(location);
  return hasProvince ? location : `${location}, ${hint}`;
}

interface AdzunaResponse {
  results?: Array<{
    id?: number | string;
    title?: string;
    company?: { display_name?: string };
    location?: { display_name?: string };
    redirect_url?: string;
    created?: string;
    salary_min?: number;
    salary_max?: number;
  }>;
}
