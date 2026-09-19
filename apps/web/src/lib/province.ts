import { PROVINCES, PROVINCE_CODES, type ProvinceCode } from '@chinook/core';

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** S19 filter-bar options: All, Remote sentinel, provinces alphabetical by full name (PO 2026-09-19). */
export const PROVINCE_SELECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All provinces' },
  { value: 'REMOTE', label: 'Remote' },
  ...Object.entries(PROVINCES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, code]) => ({ value: code, label: `${titleCase(name)} (${code})` })),
];

/** URL param → repository fields; unknown values silently ignored (source/rule semantics). */
export function parseProvinceParam(
  raw: string | null | undefined,
): { province?: ProvinceCode; remoteOnly?: boolean } {
  if (raw === 'REMOTE') return { remoteOnly: true };
  if (raw && (PROVINCE_CODES as readonly string[]).includes(raw)) {
    return { province: raw as ProvinceCode };
  }
  return {};
}
