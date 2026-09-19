import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './db.js';
import type { ApplicationRow } from './repository.js';
import type { ProvinceCode } from './normalize.js';

/** Board columns in canonical order (DB stores applied + channel, board splits it). */
export const BOARD_STATUSES = [
  'new',
  'applying',
  'applied_manual',
  'applied_auto',
  'interview',
  'rejected',
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

/** Stored application statuses (new is virtual — no row until first action). */
export type StoredStatus = 'applying' | 'applied' | 'interview' | 'rejected';

/** Transition graph; `new` is the virtual start (no row yet). */
export const TRANSITIONS: Record<string, string[]> = {
  new: ['applying', 'applied'],
  applying: ['new', 'applied'],
  applied: ['interview', 'rejected', 'applying'],
  interview: ['rejected', 'applied'],
  rejected: ['applying'],
};

export function canTransition(from: string, to: string): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Only `applied` carries the manual/auto channel (G1 answer #2). */
export function requiredChannel(status: string): boolean {
  return status === 'applied';
}

export interface BoardCard {
  id: string;
  title: string;
  employer: string;
  location: string;
  remote: boolean;
  url: string;
  source: string;
  ruleStatus: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  postedAt: string | null;
}

export interface BoardColumn {
  status: BoardStatus;
  cards: BoardCard[];
  total: number; // may exceed cards.length (New is capped)
}

export interface BoardData {
  columns: BoardColumn[];
}

const NEW_COLUMN_LIMIT = 30;

type Row = {
  id: string;
  title: string;
  employer: string;
  city: string;
  province: string;
  remote: boolean;
  url: string;
  source: string;
  rule_status: string | null;
  salary_min: string | number | null;
  salary_max: string | number | null;
  posted_at: Date | null;
};

function toCard(r: Row): BoardCard {
  return {
    id: r.id,
    title: r.title,
    employer: r.employer,
    location: `${r.city}${r.province ? `, ${r.province}` : ''}`,
    remote: r.remote,
    url: r.url,
    source: r.source,
    ruleStatus: r.rule_status,
    salaryMin: r.salary_min === null ? null : Number(r.salary_min),
    salaryMax: r.salary_max === null ? null : Number(r.salary_max),
    postedAt: r.posted_at ? r.posted_at.toISOString() : null,
  };
}

export interface BoardFilters {
  province?: ProvinceCode;
  remoteOnly?: boolean;
}

/** Six-column board: New = relevant jobs without an application row (capped). */
export async function getBoard(db: Kysely<Database>, filters: BoardFilters = {}): Promise<BoardData> {
  const { province, remoteOnly } = filters;

  let newQuery = db
    .selectFrom('job')
    .where('job.rule_status', '=', 'relevant')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('application')
            .select('application.job_id')
            .whereRef('application.job_id', '=', 'job.id'),
        ),
      ),
    )
    .select([
      'job.id as id',
      'job.title as title',
      'job.employer as employer',
      'job.city as city',
      'job.province as province',
      'job.remote as remote',
      'job.url as url',
      'job.source as source',
      'job.rule_status as rule_status',
      'job.salary_min as salary_min',
      'job.salary_max as salary_max',
      'job.posted_at as posted_at',
      sql<number>`count(*) over ()::int`.as('total'),
    ]);
  if (province) {
    newQuery = newQuery.where('job.province', '=', province);
  }
  if (remoteOnly) {
    newQuery = newQuery.where('job.remote', '=', true);
  }
  const newRows = (await newQuery
    .orderBy(sql`job.posted_at desc nulls last`)
    .limit(NEW_COLUMN_LIMIT)
    .execute()) as Array<Row & { total: number }>;

  let appQuery = db
    .selectFrom('application')
    .innerJoin('job', (join) => join.onRef('job.id', '=', 'application.job_id'))
    .select([
      'job.id as id',
      'job.title as title',
      'job.employer as employer',
      'job.city as city',
      'job.province as province',
      'job.remote as remote',
      'job.url as url',
      'job.source as source',
      'job.rule_status as rule_status',
      'job.salary_min as salary_min',
      'job.salary_max as salary_max',
      'job.posted_at as posted_at',
      'application.status as status',
      'application.channel as channel',
    ]);
  if (province) {
    appQuery = appQuery.where('job.province', '=', province);
  }
  if (remoteOnly) {
    appQuery = appQuery.where('job.remote', '=', true);
  }
  const appRows = await appQuery.orderBy('application.created_at', 'desc').execute();

  const byColumn: Record<BoardStatus, BoardCard[]> = {
    new: newRows.map(toCard),
    applying: [],
    applied_manual: [],
    applied_auto: [],
    interview: [],
    rejected: [],
  };
  for (const r of appRows) {
    const key: BoardStatus = r.status === 'applied' ? `applied_${r.channel}` as BoardStatus : (r.status as BoardStatus);
    if (byColumn[key]) byColumn[key].push(toCard(r));
  }

  return {
    columns: BOARD_STATUSES.map((status) => ({
      status,
      cards: byColumn[status],
      total: status === 'new' ? (newRows[0]?.total ?? 0) : byColumn[status].length,
    })),
  };
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Idempotent status move with transition-graph validation (S7 AC2). */
export async function setApplicationStatus(
  db: Kysely<Database>,
  jobId: string,
  target: { status: string; channel?: string },
): Promise<ApplicationRow> {
  const { status, channel } = target;
  const current0 = (
    await sql<{ status: string; channel: string }>`select status, channel from application
      where job_id = ${jobId} limit 1`.execute(db)
  ).rows[0];
  const from = current0
    ? current0.status === 'applied'
      ? 'applied'
      : current0.status
    : 'new';

  if (status === 'new') {
    // virtual column: going back from applying deletes the application row
    if (from !== 'applying') throw new TransitionError('only applying can go back to new');
    await sql`delete from application where job_id = ${jobId}`.execute(db);
    return { id: 0, jobId, status: 'new', channel: 'none', createdAt: new Date().toISOString() };
  }
  if (requiredChannel(status) && channel !== 'manual' && channel !== 'auto') {
    throw new TransitionError(`status "${status}" requires channel manual|auto`);
  }
  if (!requiredChannel(status) && channel) {
    throw new TransitionError(`status "${status}" must not carry a channel`);
  }

  const current = current0;
  if (from === status && (!requiredChannel(status) || current?.channel === channel)) {
    // idempotent: already there
    const row = await sql<ApplicationRow>`select * from application where job_id = ${jobId} limit 1`.execute(db);
    return normalize(row.rows[0]!);
  }
  if (!canTransition(from, status)) {
    throw new TransitionError(`transition ${from} → ${status} is not allowed (${TRANSITIONS[from]?.join(', ') ?? 'none'})`);
  }

  if (current) {
    const updated = (
      await sql`update application set status = ${status}, channel = ${channel ?? 'none'}, created_at = now()
        where job_id = ${jobId} returning *`.execute(db)
    ).rows[0];
    return normalize(updated);
  }
  const inserted = (
    await sql`insert into application (job_id, status, channel)
      values (${jobId}, ${status}, ${channel ?? 'none'}) returning *`.execute(db)
  ).rows[0];
  return normalize(inserted);
}

function normalize(row: unknown): ApplicationRow {
  const r = row as { id: number; job_id: string; status: string; channel: string; created_at: Date };
  return {
    id: Number(r.id),
    jobId: r.job_id,
    status: r.status,
    channel: r.channel,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
