// S11 — /profile: superprofile workspace (upload → facts → proposal → approve).
// Server component fetches source metadata only; the master file body and
// document contents never render here (PII discipline, Constitution 3.2).
import type { Metadata } from 'next';
import { ensureSchema, listProfileSources, type Database, type Kysely } from '@chinook/core';
import { getDb } from '@/lib/db';
import { readMasterRaw } from '@/lib/superprofile-service';
import { ProfileWorkspace } from './profile-workspace';
import styles from '../board/board.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Chinook — Profile' };

export default async function ProfilePage() {
  const db: Kysely<Database> = getDb();
  await ensureSchema(db);
  const [sources, master] = await Promise.all([listProfileSources(db), readMasterRaw()]);
  const version = (master as { version?: unknown } | null)?.version;

  return (
    <main className={styles.page}>
      <h1 className={styles.title} style={{ fontFamily: 'var(--font-display)' }}>
        Profile
      </h1>
      <p className={styles.subtitle}>Multi-resume superprofile · every fact traces to a source document · applied only by your approve</p>
      <div className="horizon" style={{ marginTop: 4, marginBottom: 20 }} />

      <ProfileWorkspace
        initialSources={sources.map((s) => ({
          id: s.id,
          fileName: s.fileName,
          format: s.format,
          sha256: s.sha256.slice(0, 8),
          factCount: s.factCount,
          createdAt: s.createdAt,
        }))}
        masterVersion={typeof version === 'number' ? version : null}
      />
    </main>
  );
}
