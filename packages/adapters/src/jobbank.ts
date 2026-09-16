import { XMLParser } from 'fast-xml-parser';
import type { RawJob } from '@chinook/contracts';

export const JOBBANK_FEED_URL = 'https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed';

export const JOBBANK_UA =
  'Chinook/0.1 (personal job-search automation; contact: gengodoriginal@gmail.com)';

export const jobbankAdapter = {
  id: 'jobbank' as const,

  feedUrl(query: string): string {
    return `${JOBBANK_FEED_URL}?searchstring=${encodeURIComponent(query)}`;
  },

  async fetch(query = 'software developer'): Promise<string> {
    const response = await fetch(this.feedUrl(query), {
      headers: { 'User-Agent': JOBBANK_UA, Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`jobbank feed HTTP ${response.status}`);
    }
    return response.text();
  },

  /** Parses an Atom feed; fields (employer/location/salary) live inside entry summary HTML. */
  parse(xml: string): RawJob[] {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
    });
    const doc = parser.parse(xml) as JobBankFeed;
    const entries = (Array.isArray(doc.feed?.entry) ? doc.feed.entry : [doc.feed?.entry]).filter(
      (e): e is JobBankEntry => e != null,
    );
    return entries.map((entry) => {
      const summary = textOf(entry.summary) ?? '';
      return {
        title: textOf(entry.title)?.trim() ?? '',
        employer: field(summary, 'Employer') ?? 'Unknown employer',
        locationRaw: field(summary, 'Location') ?? '',
        url: hrefOf(entry.link),
        postedAt: textOf(entry.updated) ?? null,
        ...parseSalary(field(summary, 'Salary')),
        sourceJobId: /Job number:\s*(\d+)/.exec(summary)?.[1] ?? null,
        raw: entry,
      };
    });
  },
};

interface JobBankFeed {
  feed?: {
    entry?: JobBankEntry[] | JobBankEntry;
  };
}

interface JobBankEntry {
  title?: string | { '#text'?: string };
  updated?: string;
  summary?: string | { '#text'?: string };
  link?: Array<{ '@_href'?: string }> | { '@_href'?: string };
}

function textOf(value: string | { '#text'?: string } | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : (value['#text'] ?? null);
}

function hrefOf(link: JobBankEntry['link']): string {
  if (Array.isArray(link)) return link[0]?.['@_href'] ?? '';
  return link?.['@_href'] ?? '';
}

function field(summaryHtml: string, name: string): string | null {
  const stripped = summaryHtml.replace(/<[^>]+>/g, '\n');
  const match = new RegExp(`${name}:\\s*([^\\n]+)`).exec(stripped);
  return match?.[1]?.trim() ?? null;
}

function parseSalary(
  raw: string | null,
): Pick<RawJob, 'salaryMin' | 'salaryMax' | 'salaryPeriod'> {
  if (!raw || /not available/i.test(raw)) {
    return { salaryMin: null, salaryMax: null, salaryPeriod: null };
  }
  const period = /hour/i.test(raw) ? 'hourly' : /annually/i.test(raw) ? 'annual' : null;
  const numbers = [...raw.matchAll(/\$?([\d,]+(?:\.\d+)?)/g)].map((m) =>
    Number((m[1] ?? '').replace(/,/g, '')),
  );
  if (numbers.length === 0) return { salaryMin: null, salaryMax: null, salaryPeriod: null };
  return {
    salaryMin: numbers[0] ?? null,
    salaryMax: numbers.length > 1 ? numbers[numbers.length - 1]! : numbers[0]!,
    salaryPeriod: period,
  };
}
