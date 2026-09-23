/**
 * Egress guard (B-010): adapters may only fetch https URLs on explicitly
 * allowlisted hosts — no other outbound target may be constructed from data.
 */
export const EGRESS_JOBBANK_HOSTS = ['www.jobbank.gc.ca'] as const;
export const EGRESS_ADZUNA_HOSTS = ['api.adzuna.com', 'www.adzuna.ca'] as const;

export function assertSafeExternalUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('egress blocked: invalid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error(`egress blocked: non-https protocol ${url.protocol}`);
  }
  if (!allowedHosts.includes(url.host)) {
    throw new Error(`egress blocked: host ${url.host} not in egress allowlist`);
  }
  return url;
}
