'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './board.module.css';
import type { BoardStatus } from '@chinook/core';

/** Allowed next moves per board position (UI projection of the transition graph). */
const MOVES: Record<string, Array<{ label: string; status: string; channel?: 'manual' | 'auto'; primary?: boolean }>> = {
  new: [
    { label: 'Start applying', status: 'applying' },
    { label: 'Applied manual', status: 'applied', channel: 'manual', primary: true },
  ],
  applying: [
    { label: 'Back', status: 'new' },
    { label: 'Applied manual', status: 'applied', channel: 'manual', primary: true },
  ],
  applied_manual: [
    { label: 'Back', status: 'applying' },
    { label: 'Interview', status: 'interview', primary: true },
    { label: 'Rejected', status: 'rejected' },
  ],
  applied_auto: [
    { label: 'Back', status: 'applying' },
    { label: 'Interview', status: 'interview', primary: true },
    { label: 'Rejected', status: 'rejected' },
  ],
  interview: [
    { label: 'Back', status: 'applied', channel: 'manual' },
    { label: 'Rejected', status: 'rejected' },
  ],
  rejected: [{ label: 'Reactivate', status: 'applying' }],
};

export function StatusControls({ jobId, from }: { jobId: string; from: BoardStatus }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moves = MOVES[from] ?? [];

  if (moves.length === 0) return null;

  return (
    <div className={styles.actionsWrap}>
      <div className={styles.actionsRow}>
        {moves.map((m) => (
          <button
            key={m.label}
            type="button"
            className={m.primary ? `${styles.act} ${styles.actPrimary}` : styles.act}
            disabled={busy}
            data-move={m.label}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const response = await fetch(`/api/jobs/${jobId}/status`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ status: m.status, channel: m.channel }),
                });
                if (!response.ok) {
                  const body = (await response.json().catch(() => null)) as { error?: string } | null;
                  setError(body?.error ?? `HTTP ${response.status}`);
                  return;
                }
                router.refresh();
              } finally {
                setBusy(false);
              }
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {error ? <div className={styles.moveError} role="alert">{error}</div> : null}
    </div>
  );
}
