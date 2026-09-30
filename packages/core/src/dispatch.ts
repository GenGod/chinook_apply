// S8: email dispatch building blocks — pure functions, no I/O.
// extractEmailCandidates scans the job's raw payload for apply-contact
// candidates (best effort — the UI lets the user confirm/edit; Constitution
// 1.3: the recipient is part of the approved package).
// buildDispatchEmail deterministically composes subject/body from the job and
// the cover letter already generated (no facts are invented here).

export interface DispatchJobLike {
  title: string;
  employer: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;
// Raw payload fields that may carry apply contacts (jobbank summary is an
// object with '#text' HTML; adzuna description is a plain string).
const RAW_TEXT_FIELDS = ['fullDescription', 'description', 'summary'] as const;

function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value != null && typeof value === 'object') {
    const text = (value as { '#text'?: unknown })['#text'];
    if (typeof text === 'string') return text;
  }
  return '';
}

/** Best-effort apply-contact candidates from the raw job payload, deduped in order. */
export function extractEmailCandidates(raw: unknown): string[] {
  if (raw == null || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;

  const out: string[] = [];
  const push = (candidate: string) => {
    const lower = candidate.toLowerCase();
    if (!out.some((existing) => existing.toLowerCase() === lower)) out.push(candidate);
  };

  for (const field of RAW_TEXT_FIELDS) {
    const text = rawText(record[field]);
    if (text === '') continue;
    for (const match of text.matchAll(MAILTO_RE)) {
      const address = match[1]?.trim();
      if (address && EMAIL_RE.test(address)) push(address);
      EMAIL_RE.lastIndex = 0;
    }
    for (const match of text.matchAll(EMAIL_RE)) push(match[0]);
    EMAIL_RE.lastIndex = 0;
  }
  return out;
}

export interface DispatchEmail {
  subject: string;
  text: string;
}

/**
 * Deterministically composes the application email. With a cover letter the
 * body is its paragraphs verbatim; without one — a short factual note (no
 * invented facts: only the job title/employer and the candidate name).
 */
export function buildDispatchEmail(
  job: DispatchJobLike,
  identity: { fullName: string },
  coverText: string | null,
): DispatchEmail {
  const fullName = identity.fullName.trim();
  if (fullName === '') throw new Error('dispatch email requires a candidate name');

  const subject = `Application for ${job.title} — ${fullName}`;
  const text =
    coverText && coverText.trim() !== ''
      ? coverText
          .split(/\n+/)
          .map((p) => p.trim())
          .filter((p) => p !== '')
          .join('\n\n')
      : [
          'Dear Hiring Manager,',
          `I am applying for the ${job.title} role at ${job.employer}. My resume is attached for your consideration.`,
          'Thank you for your time.',
          'Best regards,',
          fullName,
        ].join('\n\n');

  return { subject, text };
}
