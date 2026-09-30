// S9: web-form dispatch building blocks — pure functions, no I/O.
// validateFormConfig guards the browser automation target (the config comes
// from job.raw.formConfig, never from a client request); detectCaptcha
// implements the art. 11.3 stop rule; buildFormValues maps the approved
// package onto form fields without inventing facts.

export interface FormConfig {
  url: string;
  selectors: { name?: string; email?: string; message?: string; file?: string; submit?: string };
  successText?: string;
}

const SAFE_SELECTOR_RE = /^[A-Za-z0-9\s\[\]="'.:_#*(),>+~^-]{1,200}$/;

/** Validates a form config from the job payload; null when anything is off. */
export function validateFormConfig(raw: unknown): FormConfig | null {
  if (raw == null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const urlRaw = typeof record.url === 'string' ? record.url : '';
  let parsed: URL;
  try {
    parsed = new URL(urlRaw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const selectorsRaw = record.selectors;
  const selectors: FormConfig['selectors'] = {};
  if (selectorsRaw != null && typeof selectorsRaw === 'object') {
    for (const [key, value] of Object.entries(selectorsRaw as Record<string, unknown>)) {
      if (!(key in { name: 1, email: 1, message: 1, file: 1, submit: 1 })) return null;
      if (typeof value !== 'string' || value === '' || value.length > 200) return null;
      if (!SAFE_SELECTOR_RE.test(value) || /<|javascript:/i.test(value)) return null;
      selectors[key as keyof FormConfig['selectors']] = value;
    }
  }
  const successText = typeof record.successText === 'string' ? record.successText : undefined;
  return {
    url: urlRaw,
    selectors,
    ...(successText !== undefined ? { successText } : {}),
  };
}

const CAPTCHA_MARKERS: Array<{ re: RegExp; label: string }> = [
  { re: /recaptcha/i, label: 'recaptcha' },
  { re: /hcaptcha/i, label: 'hcaptcha' },
  { re: /challenges\.cloudflare\.com\/turnstile/i, label: 'turnstile' },
  { re: /cf-challenge/i, label: 'cf-challenge' },
  { re: /data-captcha/i, label: 'data-captcha' },
];

/** Art. 11.3: any captcha marker on the page stops the attempt immediately. */
export function detectCaptcha(html: string): string | null {
  for (const { re, label } of CAPTCHA_MARKERS) {
    if (re.test(html)) return label;
  }
  return null;
}

export interface FormValues {
  name: string;
  email: string;
  message: string;
}

/** Maps the approved package onto form fields (no invented facts). */
export function buildFormValues(
  identity: { fullName: string; email?: string },
  coverText: string | null,
  job: { title: string; employer: string },
): FormValues {
  const fullName = identity.fullName.trim();
  if (fullName === '') throw new Error('form dispatch requires a candidate name');
  const message =
    coverText && coverText.trim() !== ''
      ? coverText
      : [
          'Dear Hiring Manager,',
          `I am applying for the ${job.title} role at ${job.employer}. My resume is attached for your consideration.`,
          'Thank you for your time.',
          'Best regards,',
          fullName,
        ].join('\n\n');
  return {
    name: fullName,
    email: identity.email ?? '',
    message,
  };
}
