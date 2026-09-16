'use client';

import { useState } from 'react';
import styles from './jobs.module.css';

/** Per-row client island: marks a manual application and reflects it persistently. */
export function AppliedToggle({ jobId, initiallyApplied }: { jobId: string; initiallyApplied: boolean }) {
  const [applied, setApplied] = useState(initiallyApplied);
  const [busy, setBusy] = useState(false);

  if (applied) {
    return (
      <button type="button" className={styles.applied} disabled data-applied="true">
        ✓ Applied
      </button>
    );
  }

  return (
    <button
      type="button"
      className={styles.apply}
      disabled={busy}
      title="Mark this job as applied manually (external link)"
      onClick={async () => {
        setBusy(true);
        try {
          const response = await fetch(`/api/jobs/${jobId}/applied-manually`, { method: 'PATCH' });
          if (response.ok) setApplied(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? '…' : 'Mark applied'}
    </button>
  );
}
