'use client';

// S5 T8 — Documents section (superdesign variant A: versioned accordion/inline).
// S6 T8 — adds the render/download flow: valid artifacts get DOCX/PDF buttons
// (POST /api/artifacts/[id]/render, then GET /api/artifacts/[id]/file); render
// rows appear in the version list and download directly. Colors only via
// tokens; resume renders Summary/Skills/Experience/Education — NO identity in
// the preview (G1; the rendered files carry the identity header instead).
import { useState } from 'react';
import type { ArtifactView } from '@chinook/core';
import styles from './documents.module.css';

interface ArtifactDetail {
  kind: string;
  version: number;
  status: string;
  content: unknown;
  violations: string[];
}

type GenerateKind = 'resume' | 'cover_letter';
type RenderFormat = 'docx' | 'pdf';

const KIND_LABEL: Record<string, string> = { resume: 'Resume', cover_letter: 'Cover letter' };
const FORMAT_LABEL: Record<string, string> = { render_docx: 'DOCX', render_pdf: 'PDF' };

/** List-row label: source rows "Resume v2"; render rows "Resume · DOCX v1". */
function rowLabel(a: ArtifactView, artifacts: ArtifactView[]): string {
  const format = FORMAT_LABEL[a.kind];
  if (!format) return `${KIND_LABEL[a.kind] ?? a.kind} v${a.version}`;
  const source = artifacts.find((x) => x.id === a.sourceArtifactId);
  const sourceName = source ? (KIND_LABEL[source.kind] ?? source.kind) : 'Document';
  return `${sourceName} · ${format} v${a.version}`;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asObjectArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => x != null && typeof x === 'object' && !Array.isArray(x))
    : [];
}

/** Education is rendered only for objects with string fields; values joined into a readable line. */
function educationLines(v: unknown): string[] {
  return asObjectArray(v)
    .map((e) => Object.values(e).filter((x): x is string => typeof x === 'string').join(' — '))
    .filter((line) => line !== '');
}

function CoverParagraphs({ content }: { content: unknown }) {
  const letter = asString((content as { letter?: unknown } | null)?.letter);
  const paragraphs = letter.split(/\n+/).map((p) => p.trim()).filter((p) => p !== '');
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={styles.p}>{p}</p>
      ))}
    </>
  );
}

function ResumeBlocks({ content }: { content: unknown }) {
  const resume = (content as { resume?: unknown } | null)?.resume;
  if (resume == null || typeof resume !== 'object') return null;
  const r = resume as Record<string, unknown>;
  const summary = asString(r.summary);
  const skills = asStringArray(r.skills);
  const experience = asObjectArray(r.experience);
  const edu = educationLines(r.education);
  return (
    <>
      {summary ? (
        <div className={styles.block}>
          <h4 className={styles.secTitle}>Summary</h4>
          <p className={styles.p}>{summary}</p>
        </div>
      ) : null}
      {skills.length > 0 ? (
        <div className={styles.block}>
          <h4 className={styles.secTitle}>Skills</h4>
          <ul className={styles.skills}>
            {skills.map((s) => (
              <li key={s} className={styles.skillItem}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {experience.length > 0 ? (
        <div className={styles.block}>
          <h4 className={styles.secTitle}>Experience</h4>
          {experience.map((e, i) => {
            const title = asString(e.title);
            const employer = asString(e.employer);
            const start = asString(e.start);
            const end = asString(e.end);
            const tech = asStringArray(e.technology);
            const bullets = asStringArray(e.bullets);
            return (
              <div key={i} className={styles.exp}>
                <div className={styles.expHead}>
                  <h5 className={styles.expTitle}>{title}</h5>
                  <span className={styles.expDates}>{start && end ? `${start} — ${end}` : start || end}</span>
                </div>
                {employer ? <div className={styles.expEmployer}>{employer}</div> : null}
                {tech.length > 0 ? <div className={styles.expTech}>{tech.join(' · ')}</div> : null}
                {bullets.length > 0 ? (
                  <ul className={styles.bullets}>
                    {bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {edu.length > 0 ? (
        <div className={styles.block}>
          <h4 className={styles.secTitle}>Education</h4>
          {edu.map((line, i) => (
            <p key={i} className={styles.eduLine}>{line}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function DocumentsSection({ jobId, initialArtifacts }: { jobId: string; initialArtifacts: ArtifactView[] }) {
  const [artifacts, setArtifacts] = useState<ArtifactView[]>(initialArtifacts);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = artifacts.find((a) => a.id === openId) ?? null;

  function triggerFileDownload(artifactId: string) {
    const anchor = document.createElement('a');
    anchor.href = `/api/artifacts/${artifactId}/file`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  async function refreshArtifacts() {
    const list = await fetch(`/api/jobs/${jobId}/artifacts`);
    const listBody = (await list.json().catch(() => null)) as { artifacts?: ArtifactView[] } | null;
    if (list.ok && Array.isArray(listBody?.artifacts)) setArtifacts(listBody.artifacts);
  }

  async function toggleRow(a: ArtifactView) {
    setError(null);
    if (a.kind === 'render_docx' || a.kind === 'render_pdf') {
      // Render rows are binary downloads — no preview accordion.
      triggerFileDownload(a.id);
      return;
    }
    if (openId === a.id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(a.id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/artifacts/${a.id}`);
      const body = (await res.json().catch(() => null)) as { artifact?: ArtifactDetail; error?: string } | null;
      if (res.ok && body?.artifact) {
        setDetail(body.artifact);
      } else {
        setError(body?.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setDetailLoading(false);
    }
  }

  /** S6: renders the artifact into both formats, then starts the download. */
  async function renderAndDownload(sourceId: string, format: RenderFormat) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/artifacts/${sourceId}/render`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as { artifacts?: ArtifactView[]; error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      await refreshArtifacts();
      const created = body?.artifacts?.find((a) => a.kind === `render_${format}`);
      if (created) triggerFileDownload(created.id);
    } finally {
      setBusy(false);
    }
  }

  async function generate(kinds: GenerateKind[], closePreview: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kinds }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      // POST returns only the created versions — refetch the full list.
      await refreshArtifacts();
      if (closePreview) {
        setOpenId(null);
        setDetail(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} data-testid="documents">
      <h3 className={styles.title}>Documents</h3>
      <p className={styles.subtitle}>AI-assisted application materials based on job description</p>

      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          data-testid="generate-resume"
          disabled={busy}
          onClick={() => generate(['resume'], false)}
        >
          Generate resume
        </button>
        <button
          type="button"
          className={styles.btn}
          data-testid="generate-cover"
          disabled={busy}
          onClick={() => generate(['cover_letter'], false)}
        >
          Generate cover letter
        </button>
        <button
          type="button"
          className={styles.btn}
          data-testid="generate-both"
          disabled={busy}
          onClick={() => generate(['resume', 'cover_letter'], false)}
        >
          Generate both
        </button>
      </div>

      {error ? (
        <div className={styles.errorBox} role="alert" data-testid="generate-error">
          {error}
        </div>
      ) : null}

      <div className={styles.list}>
        <div className={styles.listHeader} data-testid="versions-label">Available versions</div>
        {artifacts.length === 0 ? (
          <div className={styles.empty}>No documents generated yet.</div>
        ) : (
          artifacts.map((a) => (
            <button
              type="button"
              key={a.id}
              className={openId === a.id ? `${styles.row} ${styles.rowOpen}` : styles.row}
              data-testid="artifact-row"
              aria-expanded={openId === a.id}
              onClick={() => toggleRow(a)}
            >
              <span className={styles.rowLeft}>
                <span
                  className={a.status === 'valid' ? `${styles.dot} ${styles.dotValid}` : `${styles.dot} ${styles.dotInvalid}`}
                  aria-hidden="true"
                />
                <span>
                  <span className={styles.rowTitle}>
                    {rowLabel(a, artifacts)}
                    {a.status !== 'valid' ? <span className={styles.rowFlag}>Validation failed</span> : null}
                  </span>
                  <span className={styles.rowMeta}>
                    {a.kind.startsWith('render_') ? 'Rendered ' : 'Generated '}
                    {a.created.slice(0, 10)}
                    {a.violations.length > 0 ? ` · ${a.violations.length} violation${a.violations.length === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      {open && open.status !== 'valid' ? (
        <div className={styles.violations} data-testid="violations">
          <div>
            <p className={styles.violTitle}>Validation failed</p>
            <ul className={styles.violList}>
              {open.violations.map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className={styles.regen}
            data-testid="regenerate"
            disabled={busy}
            onClick={() => generate([open.kind as GenerateKind], true)}
          >
            Regenerate
          </button>
        </div>
      ) : null}

      {openId !== null ? (
        <div className={styles.preview}>
          <div className={styles.previewLabel}>Document preview</div>
          <div className={styles.panel} data-testid="artifact-content">
            {detailLoading ? (
              <p className={styles.loading}>Loading…</p>
            ) : detail ? (
              detail.kind === 'cover_letter' ? (
                <CoverParagraphs content={detail.content} />
              ) : (
                <ResumeBlocks content={detail.content} />
              )
            ) : null}
          </div>
          {open && open.status === 'valid' && (open.kind === 'resume' || open.kind === 'cover_letter') ? (
            <div className={styles.downloadRow}>
              <span className={styles.downloadLabel}>Download</span>
              <button
                type="button"
                className={styles.btn}
                data-testid="download-docx"
                disabled={busy}
                onClick={() => renderAndDownload(open.id, 'docx')}
              >
                DOCX
              </button>
              <button
                type="button"
                className={styles.btn}
                data-testid="download-pdf"
                disabled={busy}
                onClick={() => renderAndDownload(open.id, 'pdf')}
              >
                PDF
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
