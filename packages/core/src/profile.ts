import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ProfileSearch } from './rules';
import { PROVINCES } from './normalize';

const ProfileFileSchema = z.object({
  search_config: z.object({
    target_province: z.string().min(2),
  }),
});

export const DEFAULT_PROFILE_SEARCH: ProfileSearch = { targetProvince: 'AB' };

const DEFAULT_PROFILE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/profile/master_profile.json',
);

/**
 * Loads search config from the (gitignored) master profile on disk; PII never
 * enters code, tests or git (tests pass their own fixture / profile object).
 * Falls back to the Alberta default when the file is absent (e.g. CI).
 */
export function loadProfileSearch(explicitPath?: string): ProfileSearch {
  const file = explicitPath ?? process.env.CHINOOK_PROFILE_PATH ?? DEFAULT_PROFILE_PATH;
  try {
    const parsed = ProfileFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    const raw = parsed.search_config.target_province.trim();
    const code = PROVINCES[raw.toLowerCase()] ?? raw.toUpperCase();
    return { targetProvince: code };
  } catch {
    return DEFAULT_PROFILE_SEARCH;
  }
}
