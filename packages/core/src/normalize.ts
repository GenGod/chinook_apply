/** Shared text/location normalization used by hashing and dedup. */

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'lp', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'sarl', 'sa', 'bv', 'pty', 'plc', 'group',
]);

export const PROVINCES: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB',
  'newfoundland and labrador': 'NL', 'nova scotia': 'NS', ontario: 'ON',
  'prince edward island': 'PE', quebec: 'QC', saskatchewan: 'SK',
  'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
};

/** Lowercase, diacritics-folded, punctuation-free, single-spaced. */
export function normalizeTitle(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** normalizeTitle plus repeated legal-suffix stripping ("Acme Corp. Inc." → "acme"). */
export function normalizeEmployer(input: string): string {
  let tokens = normalizeTitle(input).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
}

export interface ParsedLocation {
  city: string;
  province: string;
  remote: boolean;
}

/** Parses "Calgary (AB)", "Calgary, Alberta, Canada", "Remote", "X (ON) (remote)". */
export function parseLocation(input: string): ParsedLocation {
  const raw = input.trim();
  const remote = /\bremote\b/i.test(raw);
  const cleaned = raw.replace(/\(\s*remote\s*\)/gi, '').trim();

  const codeMatch = /^(.*?)\s*\(([A-Z]{2})\)$/i.exec(cleaned);
  if (codeMatch) {
    return {
      city: normalizeTitle(codeMatch[1] ?? ''),
      province: (codeMatch[2] ?? '').toUpperCase(),
      remote,
    };
  }

  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const mapped = PROVINCES[normalizeTitle(parts[i]!)];
    if (mapped) {
      const city = parts.slice(0, i).map(normalizeTitle).filter(Boolean).join(' ');
      return { city, province: mapped, remote };
    }
  }

  if (/^remote$/i.test(cleaned) || parts.length === 0) {
    return { city: '', province: '', remote: true };
  }
  return { city: normalizeTitle(parts[0] ?? cleaned), province: '', remote };
}
