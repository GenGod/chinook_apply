// Crawler User-Agent shared by all outbound feed/posting fetches. The contact
// address comes from CRAWLER_CONTACT_EMAIL (politeness etiquette for
// jobbank/adzuna) — never hardcoded: the repo must not carry PII in source.
export function crawlerUserAgent(): string {
  const contact = process.env.CRAWLER_CONTACT_EMAIL;
  return contact
    ? `Chinook/0.1 (personal job-search automation; contact: ${contact})`
    : 'Chinook/0.1 (personal job-search automation)';
}
