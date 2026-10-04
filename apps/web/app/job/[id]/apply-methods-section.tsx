'use client';

// S25 T4 — Apply methods (Job Bank): on-demand раскрытие панели подачи
// (read-only — ничего не отправляется), кэш методов на вакансии.
// Кнопка Reveal — действие PO; троттлинг → подсказка ручного пути (ст. 11).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApplyMethods } from '@chinook/adapters/jobbank-apply';

export function ApplyMethodsSection({
  jobId,
  initial,
}: {
  jobId: string;
  initial: { methods: ApplyMethods; revealedAt: string } | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [methods, setMethods] = useState<ApplyMethods | null>(initial?.methods ?? null);

  async function reveal() {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/reveal-apply`, { method: 'POST' });
      const data = (await res.json()) as {
        status?: string;
        methods?: ApplyMethods | null;
        error?: string;
      };
      if (!res.ok) {
        setStatus(data.error ?? 'reveal failed');
      } else if ((data.status === 'revealed' || data.status === 'cached') && data.methods) {
        setMethods(data.methods);
        setStatus(data.status === 'cached' ? 'Showing saved methods.' : null);
        router.refresh(); // префилл email в dispatch-секциях
      } else if (data.status === 'throttled') {
        setStatus(
          'Job Bank did not reveal the panel right now (rate limit). Open the posting and copy the details manually.',
        );
      } else if (data.status === 'partner') {
        setStatus('Partner posting — application happens on the linked external site.');
      } else {
        setStatus('Apply methods are not available for this posting.');
      }
    } catch {
      setStatus('reveal failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="apply-methods"
      style={{ borderTop: '1px solid var(--border-subtle)', margin: '20px 0', paddingTop: 16 }}
    >
      <h3 style={{ fontSize: 'var(--text-emphasis)', margin: '0 0 12px' }}>Apply methods (Job Bank)</h3>
      {methods ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
          {methods.email ? (
            <p style={{ margin: '0 0 6px' }}>
              Email: <strong style={{ color: 'var(--text-primary)' }}>{methods.email}</strong>
            </p>
          ) : null}
          {methods.webUrl ? (
            <p style={{ margin: '0 0 6px' }}>
              Apply online:{' '}
              <a
                href={methods.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                {methods.webUrl.slice(0, 60)}
                {methods.webUrl.length > 60 ? '…' : ''}
              </a>
            </p>
          ) : null}
          {methods.directApply ? (
            <p style={{ margin: '0 0 6px' }}>
              Direct Apply available on Job Bank (account sign-in required — apply manually; automation
              planned separately).
            </p>
          ) : null}
          {methods.screeningQuestions.length > 0 ? (
            <div style={{ margin: '8px 0 6px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-aux)' }}>
                Screening questions (answer them yourself in the application — never auto-answered):
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {methods.screeningQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {methods.notes.length > 0 ? (
            <div style={{ margin: '8px 0 6px' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-aux)' }}>
                Required later in hiring:
              </div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {methods.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {methods.otherText ? (
            <p style={{ margin: '6px 0 0', color: 'var(--text-muted)' }}>{methods.otherText}</p>
          ) : null}
          <button
            onClick={reveal}
            disabled={busy}
            data-testid="apply-methods-refresh"
            style={{
              marginTop: 10,
              background: 'none',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
              cursor: busy ? 'wait' : 'pointer',
              padding: '4px 10px',
            }}
          >
            {busy ? 'Checking…' : 'Re-check methods'}
          </button>
        </div>
      ) : (
        <div>
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)', margin: '0 0 8px' }}>
            The «How to apply» panel is hidden on direct Job Bank postings. Reveal it to get the email /
            link (read-only, nothing is sent).
          </p>
          <button
            onClick={reveal}
            disabled={busy}
            data-testid="apply-methods-reveal"
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: 'var(--accent-text)',
              fontWeight: 600,
              cursor: busy ? 'wait' : 'pointer',
              padding: '6px 14px',
            }}
          >
            {busy ? 'Revealing…' : 'Reveal apply methods'}
          </button>
        </div>
      )}
      {status ? (
        <p
          data-testid="apply-methods-status"
          style={{ marginTop: 8, color: 'var(--status-warning)', fontSize: 'var(--text-aux)' }}
        >
          {status}
        </p>
      ) : null}
    </section>
  );
}
