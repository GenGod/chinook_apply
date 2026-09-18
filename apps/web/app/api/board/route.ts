import { NextResponse } from 'next/server';
import { getBoard } from '@chinook/core';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const board = await getMetricsBoard();
  return NextResponse.json(board);
}

async function getMetricsBoard() {
  return getBoard(getDb());
}
