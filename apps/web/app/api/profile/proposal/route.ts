// S11: GET /api/profile/proposal — the current superprofile proposal: diff
// entries with source excerpts, conflict count, master version. Read-only.
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildProposal } from '@/lib/superprofile-service';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const proposal = await buildProposal(getDb());
    return NextResponse.json(proposal);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'proposal failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
