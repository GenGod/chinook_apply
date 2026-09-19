import { NextResponse, type NextRequest } from 'next/server';
import { getBoard } from '@chinook/core';
import { getDb } from '@/lib/db';
import { parseProvinceParam } from '@/lib/province';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { province, remoteOnly } = parseProvinceParam(request.nextUrl.searchParams.get('province'));
  const board = await getBoard(getDb(), { province, remoteOnly });
  return NextResponse.json(board);
}
