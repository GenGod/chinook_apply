'use client';

// S8 T5 — Email dispatch section (form-card in the Documents idiom).
// The visible form IS the art. 1.3 package review: recipient (editable),
// attachments (latest renders) and the body note; the Send button is the
// one-time approve (art. 1.2). Dry-run mode routes the envelope to a sink —
// the mode chip makes the current safety state explicit.
import { useState } from 'react';
import type { ArtifactView } from '@chinook/core';
import styles from './email-dispatch.module.css';

function attachmentLabel(view: ArtifactView, sourceLabel: string): string {
  const format = view.kind === 'render_docx' ? 'DOCX' : 'PDF';
  return `${sourceLabel} ${format} v${view.version}`;
}

export function EmailDispatchSection({
  jobId,
  renders,
  candidates,
  mode,
}: {
  jobId: string;
  renders: Array<{ view: ArtifactView; sourceLabel: string }>;
  candidates: string[];
  mode: string;
}) {
  const [recipient, setRecipient] = useState(candidates[0] ?? '');
  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(renders.map((r) => [r.view.kind, true])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const kinds = renders.filter((r) => selected[r.view.kind]).map((r) => r.view.kind);

  async function send() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/dispatch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: recipient, kinds }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; dispatch?: { id: number }; mode?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setSuccess(`Sent ✓ (dispatch #${body?.dispatch?.id}, ${body?.mode ?? mode} mode)`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} data-testid="dispatch">
      <h3 className={styles.title}>Email dispatch</h3>
      <p className={styles.subtitle}>
        Send the application package · <span className={mode === 'live' ? styles.modeLive : styles.modeDry}>{mode} mode</span>
      </p>

      <label className={styles.label} htmlFor="dispatch-recipient">To</label>
      <input
        id="dispatch-recipient"
        className={styles.input}
        data-testid="dispatch-recipient"
        type="email"
        placeholder="employer@example.com"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        disabled={busy}
      />

      {renders.length > 0 ? (
        <div className={styles.attach}>
          <span className={styles.label}>Attachments</span>
          {renders.map(({ view, sourceLabel }) => (
            <label key={view.id} className={styles.checkRow}>
              <input
                type="checkbox"
                data-testid={`dispatch-attach-${view.kind}`}
                checked={selected[view.kind] ?? false}
                onChange={(e) => setSelected((prev) => ({ ...prev, [view.kind]: e.target.checked }))}
                disabled={busy}
              />
              <span>{attachmentLabel(view, sourceLabel)}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className={styles.hint} data-testid="dispatch-no-renders">
          Render the documents first — nothing to attach yet.
        </p>
      )}

      <p className={styles.hint}>
        Body: your cover letter text (preview above). Sending is a one-time approval of this package.
      </p>

      {error ? (
        <div className={styles.errorBox} role="alert" data-testid="dispatch-error">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className={styles.successBox} data-testid="dispatch-success">
          {success}
        </div>
      ) : null}

      <button
        type="button"
        className={styles.btn}
        data-testid="dispatch-send"
        disabled={busy || renders.length === 0 || recipient === '' || kinds.length === 0}
        onClick={send}
      >
        Send by email
      </button>
    </section>
  );
}
