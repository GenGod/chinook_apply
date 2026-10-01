'use client';

// S11 — /profile page interactions: document upload (multipart → ingest),
// proposal build (diff with source excerpts) and the one-time PO approve.
// Colors only via tokens (check-colors gate).
import { useRef, useState } from 'react';
import styles from './profile.module.css';

interface DiffEntry {
  op: string;
  line: string;
  excerpts: string[];
}

interface SourceRow {
  id: string;
  fileName: string;
  format: string;
  sha256: string;
  factCount: number;
  createdAt: string;
}

export function ProfileWorkspace({ initialSources, masterVersion }: { initialSources: SourceRow[]; masterVersion: number | null }) {
  const [sources, setSources] = useState(initialSources);
  const [version, setVersion] = useState(masterVersion);
  const [diff, setDiff] = useState<DiffEntry[] | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refreshState() {
    const res = await fetch('/api/profile/state');
    const body = (await res.json().catch(() => null)) as { sources?: SourceRow[]; masterVersion?: number | null } | null;
    if (res.ok && body) {
      setSources(body.sources ?? []);
      setVersion(body.masterVersion ?? null);
    }
  }

  async function upload() {
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/profile/sources', { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as
        | { factsSaved?: number; factsRejected?: number; duplicate?: boolean; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setNotice(
        body?.duplicate
          ? 'Already ingested (identical file) — no changes.'
          : `Ingested: ${body?.factsSaved ?? 0} facts saved, ${body?.factsRejected ?? 0} rejected by the provenance gate.`,
      );
      if (fileInput.current) fileInput.current.value = '';
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  async function buildProposal() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/profile/proposal');
      const body = (await res.json().catch(() => null)) as
        | { diff?: DiffEntry[]; conflicts?: number; error?: string }
        | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setDiff(body?.diff ?? []);
      setConflicts(body?.conflicts ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/profile/approve', { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { applied?: number; version?: number; error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      setVersion(body?.version ?? version);
      await buildProposal(); // clears transient state — set the notice AFTER it
      setNotice(`Applied ${body?.applied ?? 0} additions — master profile v${body?.version}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'network error');
    } finally {
      setBusy(false);
    }
  }

  const applicable = (diff ?? []).filter((d) => d.op.startsWith('add_') || d.op === 'new_category').length;

  return (
    <div>
      <section className={styles.section} data-testid="profile-upload">
        <h3 className={styles.title}>Add a resume document</h3>
        <p className={styles.hint}>DOCX / PDF / TXT · facts are extracted with verbatim provenance; nothing enters the profile without your approve.</p>
        <div className={styles.row}>
          <input ref={fileInput} type="file" accept=".docx,.pdf,.txt" data-testid="profile-file" disabled={busy} />
          <button type="button" className={styles.btn} data-testid="profile-upload-btn" disabled={busy} onClick={upload}>
            Ingest
          </button>
        </div>
      </section>

      <section className={styles.section} data-testid="profile-sources">
        <h3 className={styles.title}>Sources</h3>
        <p className={styles.hint}>Master profile version: {version ?? '—'}</p>
        {sources.length === 0 ? (
          <p className={styles.hint}>No documents ingested yet.</p>
        ) : (
          <ul className={styles.sourceList}>
            {sources.map((s) => (
              <li key={s.id} className={styles.sourceRow}>
                <span className={styles.sourceName}>{s.fileName}</span>
                <span className={styles.sourceMeta}>
                  {s.format} · #{s.sha256} · {s.factCount} facts · {s.createdAt.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={styles.btn} data-testid="profile-build" disabled={busy || sources.length === 0} onClick={buildProposal}>
          Build proposal
        </button>
      </section>

      {error ? (
        <div className={styles.errorBox} role="alert" data-testid="profile-error">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className={styles.noticeBox} data-testid="profile-notice">
          {notice}
        </div>
      ) : null}

      {diff !== null ? (
        <section className={styles.section} data-testid="profile-proposal">
          <h3 className={styles.title}>Proposed changes</h3>
          <p className={styles.hint}>
            {applicable} addition{applicable === 1 ? '' : 's'} · {conflicts} conflict{conflicts === 1 ? '' : 's'} (not applied — decide manually)
          </p>
          {diff.length === 0 ? (
            <p className={styles.hint}>Nothing to add — the superprofile already covers all stored facts.</p>
          ) : (
            <ul className={styles.diffList}>
              {diff.map((d, i) => (
                <li key={i} className={d.op === 'conflict' ? styles.diffConflict : styles.diffRow}>
                  <span className={styles.diffOp}>{d.op}</span>
                  <span className={styles.diffLine}>{d.line}</span>
                  {d.excerpts[0] ? <span className={styles.diffExcerpt}>“{d.excerpts[0].slice(0, 160)}”</span> : null}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className={styles.btnPrimary}
            data-testid="profile-approve"
            disabled={busy || applicable === 0}
            onClick={approve}
          >
            Approve {applicable > 0 ? `(${applicable})` : ''}
          </button>
        </section>
      ) : null}
    </div>
  );
}
