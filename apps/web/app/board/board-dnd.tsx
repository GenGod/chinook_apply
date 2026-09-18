'use client';

import { useState, type ReactNode, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Native HTML5 DnD layer over the board grid (S18). Drop semantics follow the
 * transition graph: the API rejects illegal moves and the card stays put.
 * Buttons inside cards remain the canonical a11y path.
 */
export function BoardDnd({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const columnOf = (e: DragEvent): string | null =>
    (e.target as HTMLElement).closest?.('[data-column]')?.getAttribute('data-column') ?? null;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const column = columnOf(e);
    setDropTarget(null);
    const jobId = e.dataTransfer.getData('text/jobid');
    if (!column || !jobId) return;

    const channel = column === 'applied_manual' ? 'manual' : column === 'applied_auto' ? 'auto' : undefined;
    const status = column === 'applied_manual' || column === 'applied_auto' ? 'applied' : column;

    setError(null);
    const response = await fetch(`/api/jobs/${jobId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, ...(channel ? { channel } : {}) }),
    });
    if (response.ok) {
      router.refresh();
    } else {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `HTTP ${response.status}`);
    }
  };

  return (
    <div
      data-testid="board"
      style={{ display: 'grid', gridTemplateColumns: '300px 180px 180px 140px 180px 140px', gap: 12, marginTop: 20, alignItems: 'start' }}
      onDragOver={(e) => {
        e.preventDefault();
        const c = columnOf(e);
        if (c && c !== dropTarget) setDropTarget(c);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
      }}
      onDrop={onDrop}
    >
      {error ? (
        <div role="alert" data-testid="dnd-error" style={{ gridColumn: '1 / -1', color: 'var(--status-danger)', fontSize: 13, padding: '6px 4px' }}>
          {error}
        </div>
      ) : null}
      {children}
      {dropTarget ? <HighlightInjector target={dropTarget} /> : null}
    </div>
  );
}

/** Applies the dropTarget class imperatively — server-rendered children can't take props. */
function HighlightInjector({ target }: { target: string }) {
  if (typeof document !== 'undefined') {
    document.querySelectorAll('[data-column].dropTarget').forEach((el) => el.classList.remove('dropTarget'));
    document.querySelector(`[data-column="${target}"]`)?.classList.add('dropTarget');
  }
  return null;
}

/** Makes a server-rendered card draggable; carries the job id in dataTransfer. */
export function DraggableCard({ jobId, children }: { jobId: string; children: ReactNode }) {
  return (
    <article
      draggable
      data-card-id={jobId}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/jobid', jobId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      style={{ border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-raised)', padding: '10px 12px', marginBottom: 8 }}
    >
      {children}
    </article>
  );
}
