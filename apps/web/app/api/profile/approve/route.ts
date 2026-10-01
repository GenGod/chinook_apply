// S11: POST /api/profile/approve — THE PO approve (Constitution 2.3): applies
// every non-conflict addition of the current proposal to the master profile
// (timestamped backup first). No body; the diff is rebuilt deterministically
// from stored facts so what was reviewed is what gets applied.
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { approveProposal } from '@/lib/superprofile-service';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await approveProposal(getDb());
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'approve failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
