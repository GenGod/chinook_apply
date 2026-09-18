import { NextResponse } from 'next/server';
import { getMetrics } from '@chinook/core';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const metrics = await getMetrics(getDb());
  return NextResponse.json(metrics);
}
