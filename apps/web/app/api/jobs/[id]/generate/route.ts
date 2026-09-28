// S5 T7: POST /api/jobs/[id]/generate — tailored resume / cover letter
// generation for one job (S5 spec). The LLM gateway instance is created once
// per request; the master profile is loaded from disk (gitignored PII, dev
// path) — without it generation cannot run, so a clear 500 is returned.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLlm, createPgLlmDb } from '@chinook/llm';
import {
  generateDocuments,
  GenerationLimitError,
  JobNotEligibleError,
  loadMasterProfile,
} from '@/lib/generation-service';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  kinds: z.array(z.enum(['resume', 'cover_letter'])).min(1),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const uuid = z.uuid().safeParse(id);
  if (!uuid.success) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });

  let master: ReturnType<typeof loadMasterProfile>;
  try {
    master = loadMasterProfile();
  } catch {
    master = null;
  }
  if (!master) {
    return NextResponse.json({ error: 'master profile not available' }, { status: 500 });
  }

  const db = getDb();
  const llm = createLlm({ db: createPgLlmDb(db) });

  try {
    const { artifacts } = await generateDocuments(db, llm, uuid.data, parsed.data.kinds, { master });
    return NextResponse.json({ artifacts });
  } catch (error) {
    if (error instanceof GenerationLimitError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    if (error instanceof JobNotEligibleError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // Server-side log only; the profile itself never reaches logs (G1).
    console.error(
      '[generate] failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return NextResponse.json({ error: 'generation failed' }, { status: 500 });
  }
}
