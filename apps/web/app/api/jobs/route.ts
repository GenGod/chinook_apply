import { NextResponse, type NextRequest } from 'next/server';
import { listJobs } from '@chinook/core';
import type { JobSourceId } from '@chinook/contracts';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const RULES = new Set(['relevant', 'review', 'excluded']);
const SOURCES = new Set(['jobbank', 'adzuna', 'indeed', 'alis', 'rss', 'telegram', 'email']);

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const sourceParam = params.get('source');
  const source = sourceParam && SOURCES.has(sourceParam) ? (sourceParam as JobSourceId) : undefined;
  const days = num(params.get('days'));
  const salaryMin = num(params.get('salaryMin'));
  const ruleParam = params.get('rule');
  const rule = ruleParam && RULES.has(ruleParam) ? (ruleParam as 'relevant') : undefined;
  const sortParam = params.get('sort');
  const sort = sortParam === 'salary' ? ('salary' as const) : ('posted' as const);
  const limit = num(params.get('limit')) ?? 50;

  const jobs = await listJobs(getDb(), { source, days, salaryMin, sort, rule, limit });
  return NextResponse.json({ jobs, total: jobs.length });
}
