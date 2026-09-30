'use client';

// S9 T3 — Web form dispatch block. Rendered ONLY for jobs whose raw payload
// carries a formConfig (v1: fixtures/per-site adapters); the visible summary
// (form url + fields) is the art. 1.3 package, the Send button is the
// one-time approve. Captcha stops surface as an error with manual fallback.
import { useState } from 'react';
import styles from './email-dispatch.module.css';

export function WebFormDispatchSection({ jobId, formUrl }: { jobId: string; formUrl: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/dispatch-form`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as
        | { error?: string; outcome?: string; dispatch?: { id: number } }
        | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setSuccess(
        body?.outcome === 'skipped'
          ? 'Stopped: captcha detected — apply manually (screenshots saved)'
          : `Sent via web form ✓ (dispatch #${body?.dispatch?.id})`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.section} data-testid="web-form">
      <h3 className={styles.title}>Web form dispatch</h3>
      <p className={styles.hint}>
        Form: <span data-testid="web-form-url">{formUrl}</span> — fields: name, email, message, resume (PDF)
      </p>
      {error ? (
        <div className={styles.errorBox} role="alert" data-testid="web-form-error">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className={styles.successBox} data-testid="web-form-success">
          {success}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.btn}
        data-testid="web-form-send"
        disabled={busy}
        onClick={send}
      >
        Send via web form
      </button>
    </div>
  );
}
