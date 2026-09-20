import type { Metadata } from 'next';
import { getBoard, type BoardColumn } from '@chinook/core';
import { getDb } from '@/lib/db';
import { PROVINCE_SELECT_OPTIONS, parseProvinceParam } from '@/lib/province';
import { StatusControls } from './status-controls';
import { BoardDnd, DraggableCard } from './board-dnd';
import styles from './board.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chinook — Applications board',
  description: 'Kanban board of the job-search pipeline',
};

const COLUMN_TITLES: Record<string, string> = {
  new: 'New',
  applying: 'Applying',
  applied_manual: 'Applied · manual',
  applied_auto: 'Applied · auto',
  interview: 'Interview',
  rejected: 'Rejected',
};

function salaryLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return '';
  const fmt = (v: number) => `$${Math.round(v / 1000)}k`;
  if (min !== null && max !== null) return `${fmt(min)}–${fmt(max)}/yr`;
  return `${fmt((min ?? max)!)}${(min ?? max)! % 1000 === 0 ? '' : ''}/yr`;
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ province?: string }>;
}) {
  const sp = await searchParams;
  const board = await getBoard(getDb(), parseProvinceParam(sp.province));
  const active =
    board.columns.find((c) => c.status === 'applying')!.total +
    board.columns.find((c) => c.status === 'applied_manual')!.total +
    board.columns.find((c) => c.status === 'applied_auto')!.total +
    board.columns.find((c) => c.status === 'interview')!.total;

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Chinook</h1>
        <span className={styles.subtitle}>Applications board</span>
        <span className={styles.activeCount} data-testid="active-count" title="Active applications">
          {active}
        </span>
        <nav className={styles.nav}>
          <a className={styles.navLink} href="/">Jobs</a>
          <a className={styles.navLink} href="/metrics">Metrics</a>
        </nav>
      </div>
      <div className="horizon" style={{ marginTop: 4, marginBottom: 4 }} />

      <form className={styles.bar} method="get" action="/board" data-testid="board-filters">
        <div className={styles.field}>
          <label htmlFor="province">Province</label>
          <select id="province" name="province" defaultValue={sp.province ?? ''}>
            {PROVINCE_SELECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button className={styles.submit} type="submit">
          Apply filters
        </button>
      </form>

      <BoardDnd>
        {board.columns.map((col: BoardColumn) => (
          <section
            key={col.status}
            className={`${styles.column}${col.status === 'applied_auto' ? ` ${styles.columnAuto}` : ''}`}
            data-column={col.status}
          >
            <header className={styles.columnHeader}>
              <span className={styles.columnTitle}>{COLUMN_TITLES[col.status]}</span>
              <span className={styles.columnCount}>
                {col.total}
                {col.status === 'new' && col.total > col.cards.length ? '+' : ''}
              </span>
            </header>
            {col.cards.length === 0 ? (
              <div className={styles.emptyColumn}>Empty</div>
            ) : (
              col.cards.map((card) => (
                <DraggableCard key={card.id} jobId={card.id}>
                  <a className={styles.cardTitle} draggable={false} href={`/job/${card.id}`}>
                    {card.title}
                  </a>
                  <div className={styles.cardMeta}>
                    {card.employer}
                    {card.remote ? ' · remote' : card.location ? ` · ${card.location}` : ''}
                    {salaryLabel(card.salaryMin, card.salaryMax) ? ` · ${salaryLabel(card.salaryMin, card.salaryMax)}` : ''}
                  </div>
                  <div className={styles.cardBadges}>
                    <span className={`${styles.badge} ${styles.badgeSource}`}>{card.source}</span>
                    {card.ruleStatus ? (
                      <span className={`${styles.badge} ${styles.badgeRule}`} data-rule={card.ruleStatus}>
                        {card.ruleStatus}
                      </span>
                    ) : null}
                  </div>
                  <StatusControls jobId={card.id} from={col.status} />
                </DraggableCard>
              ))
            )}
          </section>
        ))}
      </BoardDnd>
    </main>
  );
}
