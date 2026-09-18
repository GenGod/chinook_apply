import type { Metadata } from 'next';
import styles from './design.module.css';

export const metadata: Metadata = {
  title: 'Chinook — Design System',
  description: 'DS v1 tokens and components',
};

const SWATCHES: Array<{ token: string; css: string }> = [
  { token: 'bg-base', css: 'var(--bg-base)' },
  { token: 'bg-raised', css: 'var(--bg-raised)' },
  { token: 'bg-inset', css: 'var(--bg-inset)' },
  { token: 'border-subtle', css: 'var(--border-subtle)' },
  { token: 'border-strong', css: 'var(--border-strong)' },
  { token: 'accent', css: 'var(--accent)' },
  { token: 'status-success', css: 'var(--status-success)' },
  { token: 'status-warning', css: 'var(--status-warning)' },
  { token: 'status-danger', css: 'var(--status-danger)' },
  { token: 'status-neutral', css: 'var(--status-neutral)' },
  { token: 'text-primary', css: 'var(--text-primary)' },
  { token: 'text-secondary', css: 'var(--text-secondary)' },
  { token: 'text-muted', css: 'var(--text-muted)' },
  { token: 'mask-test', css: 'var(--mask-test)' },
];

const TYPE: Array<{ spec: string; style: React.CSSProperties; sample: string }> = [
  { spec: 'h1 · 28/600', style: { fontSize: 'var(--text-h1)', fontWeight: 600 }, sample: 'Chinook' },
  { spec: 'section · 20/600', style: { fontSize: 'var(--text-section)', fontWeight: 600 }, sample: 'Funnel' },
  { spec: 'emphasis · 16/600', style: { fontSize: 'var(--text-emphasis)', fontWeight: 600 }, sample: 'Applied manually' },
  { spec: 'body · 14/400', style: { fontSize: 'var(--text-body)' }, sample: 'Senior Full-Stack Developer' },
  { spec: 'aux · 12/400', style: { fontSize: 'var(--text-aux)', color: 'var(--text-secondary)' }, sample: '2 hours ago' },
  { spec: 'label · 11-caps/400', style: { fontSize: 'var(--text-label)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }, sample: 'Source' },
];

export default function DesignPage() {
  return (
    <main className={styles.page}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Chinook</h1>
        <span className={styles.subtitle}>Design System v1</span>
      </div>

      <div className={styles.section}>Palette</div>
      <div className={styles.grid}>
        {SWATCHES.map((s) => (
          <div className={styles.swatch} key={s.token}>
            <div className={styles.swatchColor} style={{ background: s.css }} />
            <div className={styles.swatchLabel}>--{s.token}</div>
          </div>
        ))}
      </div>

      <div className={styles.section}>Typography</div>
      {TYPE.map((t) => (
        <div className={styles.typeRow} key={t.spec}>
          <span className={styles.typeSpec}>{t.spec}</span>
          <span style={t.style}>{t.sample}</span>
        </div>
      ))}

      <div className={styles.section}>Components</div>
      <div className={styles.grid} style={{ marginBottom: 16 }}>
        <button type="button" className={styles.btn} data-ds="button-primary">
          Apply filters
        </button>
        <button type="button" className={styles.btnGhost} data-ds="button-ghost">
          Mark applied
        </button>
        <span>
          <span className={styles.badge} data-ds="badge-relevant" style={{ background: 'var(--status-success-bg)', color: 'var(--status-success)', borderColor: 'var(--status-success-border)' }}>
            relevant
          </span>{' '}
          <span className={styles.badge} data-ds="badge-review" style={{ background: 'var(--status-warning-bg)', color: 'var(--status-warning)', borderColor: 'var(--status-warning-border)' }}>
            review
          </span>{' '}
          <span className={styles.badge} data-ds="badge-excluded" style={{ background: 'var(--status-neutral-bg)', color: 'var(--status-neutral)', borderColor: 'var(--status-neutral-border)' }}>
            excluded
          </span>{' '}
          <span className={styles.badge} data-ds="badge-source" style={{ background: 'var(--badge-source-bg)', color: 'var(--badge-source-text)' }}>
            jobbank
          </span>
        </span>
      </div>
      <div className={styles.grid} style={{ marginBottom: 16 }}>
        <div className={styles.fieldDemo}>
          <label htmlFor="ds-select">Source</label>
          <select id="ds-select" data-ds="field">
            <option>All sources</option>
          </select>
        </div>
        <div className={styles.barDemo} data-ds="bar">
          <div className={styles.barDemoFill} style={{ width: '62%' }} />
        </div>
        <div className={styles.cardDemo} data-ds="card">
          <div className={styles.cardLabel}>Relevant</div>
          <div className={styles.cardValue}>40</div>
        </div>
      </div>
    </main>
  );
}
