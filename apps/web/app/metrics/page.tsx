import type { Metadata } from 'next';
import { getMetrics } from '@chinook/core';
import { getDb } from '@/lib/db';
import styles from './metrics.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Chinook — Metrics',
  description: 'Job flow funnel and source health',
};

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export default async function MetricsPage() {
  const m = await getMetrics(getDb());
  const f = m.funnel;

  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title} style={{ fontFamily: 'var(--font-display)' }}>Chinook</h1>
        <span className={styles.subtitle}>Metrics — flow health</span>
        <a className={styles.navLink} href="/">
          Jobs
        </a>
        <a className={styles.navLink} href="/board">
          Board
        </a>
      </div>

      <div className="horizon" style={{ marginTop: 4, marginBottom: 20 }} />

      <div className={styles.sectionTitle}>Funnel</div>
      <div className={styles.cards}>
        <div className={styles.card} data-testid="card-total">
          <div className={styles.cardLabel}>Total jobs</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.total}</div>
          <div className={styles.barTrack}>
            <div className={styles.barFill} style={{ width: '100%' }} />
          </div>
        </div>
        <div className={styles.card} data-testid="card-relevant">
          <div className={styles.cardLabel}>Relevant</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.relevant}</div>
          <div className={styles.barTrack}>
            <div className={styles.barFill} style={{ width: `${pct(f.relevant, f.total)}%` }} />
          </div>
        </div>
        <div className={styles.card} data-testid="card-review">
          <div className={styles.cardLabel}>Review</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.review}</div>
          <div className={styles.barTrack}>
            <div className={`${styles.barFill} ${styles.barFillReview}`} style={{ width: `${pct(f.review, f.total)}%` }} />
          </div>
        </div>
        <div className={styles.card} data-testid="card-excluded">
          <div className={styles.cardLabel}>Excluded</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.excluded}</div>
          <div className={styles.barTrack}>
            <div className={`${styles.barFill} ${styles.barFillExcluded}`} style={{ width: `${pct(f.excluded, f.total)}%` }} />
          </div>
        </div>
        <div className={styles.card} data-testid="card-applied">
          <div className={styles.cardLabel}>Applied manually</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.appliedManual}</div>
          <div className={styles.barTrack}>
            <div className={`${styles.barFill} ${styles.barFillApplied}`} style={{ width: `${pct(f.appliedManual, f.total)}%` }} />
          </div>
        </div>
      </div>

      <div className={styles.sectionTitle}>Sources</div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <colgroup>
            <col style={{ width: 120 }} />
            <col style={{ width: 180 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 120 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Source</th>
              <th>Last run</th>
              <th>Interval</th>
              <th>Avg fetched</th>
              <th>Avg unique</th>
              <th>Dedup ratio</th>
              <th>Failures</th>
            </tr>
          </thead>
          <tbody>
            {m.sources.map((s) => (
              <tr key={s.source}>
                <td>
                  {s.source}
                  {s.stale ? (
                    <span style={{ marginLeft: 8, color: 'var(--status-danger)', fontSize: 'var(--text-aux)', fontWeight: 700 }} data-testid="source-stale">
                      STALE
                    </span>
                  ) : null}
                </td>
                <td>{s.lastRunAt ? `${new Date(s.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')}Z` : 'never'}</td>
                <td>{s.intervalMin}m</td>
                <td>{s.avgFetched}</td>
                <td>{s.avgUnique}</td>
                <td>{s.dedupRatio === null ? '—' : `${Math.round(s.dedupRatio * 100)}%`}</td>
                <td className={s.failuresInRow >= 3 ? styles.degraded : undefined}>
                  {s.failuresInRow}
                  {s.failuresInRow >= 3 ? ' ⚠' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>


      <div className={styles.sectionTitle}>LLM cost</div>
      <div className={styles.cards} data-testid="llm-cards">
        <div className={styles.card}>
          <div className={styles.cardLabel}>Calls</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.llm.calls}</div>
          <div className={styles.cardMeta}>cache hits {m.llm.cacheHits}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Cost, $</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.llm.costUsd.toFixed(4)}</div>
          <div className={styles.cardMeta}>tokens {m.llm.promptTokens + m.llm.completionTokens}</div>
        </div>
        {m.llm.byStage.map((st) => (
          <div className={styles.card} key={st.stage} data-testid={`llm-stage-${st.stage}`}>
            <div className={styles.cardLabel}>{st.stage}</div>
            <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>${st.costUsd.toFixed(4)}</div>
            <div className={styles.cardMeta}>{st.calls} calls · {st.avgLatencyMs} ms avg</div>
          </div>
        ))}
      </div>

      <div className={styles.sectionTitle}>Dispatch</div>
      <div className={styles.cards} data-testid="dispatch-cards">
        <div className={styles.card}>
          <div className={styles.cardLabel}>Sent</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.dispatch.sent}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Failed</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.dispatch.failed}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Skipped (captcha)</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.quality.captchaStops}</div>
        </div>
        {m.dispatch.byChannel.map((c) => (
          <div className={styles.card} key={c.channel} data-testid={`dispatch-channel-${c.channel}`}>
            <div className={styles.cardLabel}>{c.channel}</div>
            <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{c.sent}</div>
            <div className={styles.cardMeta}>sent · {c.failed} failed · {c.skipped} skipped</div>
          </div>
        ))}
      </div>

      <div className={styles.sectionTitle}>Quality</div>
      <div className={styles.cards} data-testid="quality-cards">
        <div className={styles.card}>
          <div className={styles.cardLabel}>Artifacts</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{m.quality.artifactsTotal}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Invalid share</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>
            {m.quality.invalidShare === null ? '—' : `${(m.quality.invalidShare * 100).toFixed(1)}%`}
          </div>
          <div className={styles.cardMeta}>{m.quality.artifactsInvalid} invalid</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Scored → drafted</div>
          <div className={styles.cardValue} style={{ fontFamily: 'var(--font-display)' }}>{f.scored} → {f.drafted}</div>
        </div>
      </div>

      <div className={styles.sectionTitle}>Ingest history</div>
      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="history-table">
          <colgroup>
            <col style={{ width: 180 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 200 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Started</th>
              <th>Source</th>
              <th>Fetched</th>
              <th>Unique</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {m.history.map((h) => (
              <tr key={h.id}>
                <td>{h.startedAt.slice(0, 16).replace('T', ' ')}Z</td>
                <td>{h.source}</td>
                <td>{h.fetched}</td>
                <td>{h.uniqueJobs}</td>
                <td className={h.error ? styles.errorText : undefined}>{h.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
