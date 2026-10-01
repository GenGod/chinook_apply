import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Isolated fixture master path (see playwright.config MASTER_PROFILE_PATH). */
export const FIXTURE_MASTER = join(process.cwd(), '..', 'data', 'artifacts-e2e', 'master-profile-e2e.json');

/** Pristine v1 fixture master (no tracks, no applied facts). */
const PRISTINE = {
  version: 1,
  identity: { full_name: 'E2E Fixture' },
  search_config: { noc_codes: ['21231'] },
  summary: 'Fixture engineer for e2e.',
  skills: { languages: ['TypeScript'] },
  experience: [
    { id: 'fx:Fixture Corp', employer: 'Fixture Corp', title: 'Developer', start: '2020-01', end: null, bullets: [], technology: [] },
  ],
  education: [],
};

/** Resets the fixture master so every proposal test starts deterministic. */
export async function resetFixtureMaster(): Promise<void> {
  await writeFile(FIXTURE_MASTER, JSON.stringify(PRISTINE, null, 2));
}
