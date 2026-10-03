// S25: Job Bank apply-адаптер — классификация постинга и извлечение методов
// подачи из панели «How to apply», которую прямые постинги прячут за JSF
// постбэком (кнопка «Show how to apply» → POST формы seekeractivity к URL
// самого постинга). Маркеры сняты с живых страниц 2026-10-03; фикстуры —
// синтетические, без PII. Раскрытие read-only: submit отклика — только S26.
import { assertSafeExternalUrl, EGRESS_JOBBANK_HOSTS } from './egress';
import { crawlerUserAgent } from './user-agent';
import { stripHtml } from './posting-fetcher';

export type PostingKind = 'partner' | 'direct' | 'unknown';

export interface ApplyMethods {
  email: string | null;
  webUrl: string | null;
  directApply: boolean;
  screeningQuestions: string[];
  notes: string[];
  otherText: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Тип постинга по маркерам apply-блока (живая разметка 2026-10-03). */
export function classifyPosting(html: string): PostingKind {
  if (/id="externalJobLink"/.test(html)) return 'partner';
  if (/id="applynowbutton"/.test(html)) return 'direct';
  return 'unknown';
}

/** Тело POST-формы seekeractivity (JSF stateless) — раскрытие панели. */
export function buildRevealPostBody(jobId: string): string {
  const id = encodeURIComponent(jobId);
  return `seekeractivity%3Ajobid=${id}&seekeractivity_SUBMIT=1&jakarta.faces.ViewState=stateless`;
}

/** Панель целиком (или null): от id="howtoapply" до job-posting-detail-common. */
function panelOf(pageHtml: string): string | null {
  const start = pageHtml.indexOf('id="howtoapply"');
  if (start < 0) return null;
  const end = pageHtml.indexOf('job-posting-detail-common', start);
  return pageHtml.slice(start, end > start ? end : undefined);
}

/** Первый email секции: mailto-ссылка приоритетна, иначе первый адрес в тексте. */
function emailOf(sectionHtml: string): string | null {
  const mailto = sectionHtml.match(/href="mailto:([^"'?]+)/i);
  if (mailto?.[1] && EMAIL_RE.test(mailto[1])) return mailto[1];
  const plain = sectionHtml.match(EMAIL_RE);
  return plain?.[0] ?? null;
}

/** Первая внешняя http(s)-ссылка секции (ссылки jobbank.gc.ca пропускаются). */
function webUrlOf(sectionHtml: string): string | null {
  const re = /href="(https?:\/\/[^"]+)"/gi;
  for (const m of sectionHtml.matchAll(re)) {
    const url = m[1]!;
    if (!/jobbank\.gc\.ca/i.test(url)) return url;
  }
  return null;
}

/** li-тексты блока. Job Bank вкладывает списки: <li>боилерплейт<ul><li>пункт</li></ul></li> —
 * обёртка снимается (остаётся вложенный список), берутся тексты всех li по порядку. */
function listItems(sectionHtml: string): string[] {
  const normalized = sectionHtml.replace(/<li[^>]*>([^<]*)(<ul[\s>])/gi, '$2');
  const items: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  for (const m of normalized.matchAll(re)) {
    const text = stripHtml(m[1]!).trim();
    if (text !== '') items.push(text);
  }
  return items;
}

/** Секция h4-заголовка: от </h4> до следующего <h4 или конца панели. */
function sectionUnderHeading(panel: string, headingTest: (h: string) => boolean): string | null {
  const headings = [...panel.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)];
  for (let i = 0; i < headings.length; i++) {
    const h = stripHtml(headings[i]![1]!).toLowerCase().trim();
    if (headingTest(h)) {
      const from = (headings[i]!.index ?? 0) + headings[i]![0].length;
      const to = i + 1 < headings.length ? headings[i + 1]!.index : panel.length;
      return panel.slice(from, to);
    }
  }
  return null;
}

const OTHER_HEADINGS = /^(in person|by phone|by mail|by fax|apply in person)/;

/** Извлекает ApplyMethods из страницы с раскрытой панелью; без панели → null. */
export function extractApplyMethods(pageHtml: string): ApplyMethods | null {
  const panel = panelOf(pageHtml);
  if (!panel) return null;
  const emailSection = sectionUnderHeading(panel, (h) => h.startsWith('by email'));
  const webSection = sectionUnderHeading(panel, (h) => /apply online|by web|online at/.test(h));
  const mustInclude = sectionUnderHeading(panel, (h) => h.includes('must include'));
  const later = sectionUnderHeading(
    panel,
    (h) => h.includes('might be required') || h.includes('required by the employer later'),
  );

  const others: string[] = [];
  for (const h of panel.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)) {
    const text = stripHtml(h[1]!).trim();
    if (OTHER_HEADINGS.test(text.toLowerCase())) {
      const from = (h.index ?? 0) + h[0].length;
      const to = panel.indexOf('<h4', from);
      const body = stripHtml(panel.slice(from, to > from ? to : panel.length)).trim();
      others.push(body !== '' ? `${text}: ${body}` : text);
    }
  }

  return {
    email: emailSection ? emailOf(emailSection) : null,
    webUrl: webSection ? webUrlOf(webSection) : null,
    directApply: /id="direct-apply-popup"|class="[^"]*openDA/.test(panel),
    screeningQuestions: mustInclude ? listItems(mustInclude) : [],
    notes: later ? listItems(later) : [],
    otherText: others.length > 0 ? others.join('; ') : null,
  };
}

export interface RevealResponse {
  status: number;
  body: string;
}

export interface RevealFetch {
  get(url: string): Promise<RevealResponse>;
  post(url: string, body: string): Promise<RevealResponse>;
}

export type RevealOutcome =
  | { kind: 'revealed'; methods: ApplyMethods }
  | { kind: 'throttled' | 'partner' | 'unavailable' };

const UA_HEADERS = { 'User-Agent': crawlerUserAgent(), Accept: 'text/html' };
const TIMEOUT_MS = 30_000;

/**
 * Транспорт раскрытия с cookie-jar (JSESSIONID из GET обязателен для
 * POST-постбэка). URL фиксируется при создании; без egress-guard — обёртка
 * httpRevealFetch. Отдельно выделен для интеграционных тестов против
 * локального http-сервера (политика URL — у вызывающей стороны).
 */
export function cookieJarRevealFetch(base: string): RevealFetch {
  let cookie = '';
  const request = async (method: 'GET' | 'POST', body?: string): Promise<RevealResponse> => {
    const headers: Record<string, string> = { ...UA_HEADERS };
    if (cookie) headers.cookie = cookie;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(base, {
      method,
      headers,
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    return { status: response.status, body: await response.text() };
  };
  return { get: () => request('GET'), post: (_url, body) => request('POST', body) };
}

/** Прод-транспорт: egress-guard B-010 (https + allowlist-хосты) + cookie-jar. */
export function httpRevealFetch(
  postingUrl: string,
  allowedHosts: readonly string[] = EGRESS_JOBBANK_HOSTS,
): RevealFetch {
  return cookieJarRevealFetch(assertSafeExternalUrl(postingUrl, allowedHosts).toString());
}

/**
 * Раскрытие панели: GET (cookie) → POST постбэка → парсинг. Партнёрский
 * постинг не постбэчится (там внешняя ссылка); POST без панели = троттлинг.
 */
export async function revealApplyMethods(
  fetcher: RevealFetch,
  postingUrl: string,
  jobId: string,
): Promise<RevealOutcome> {
  let page: RevealResponse;
  try {
    page = await fetcher.get(postingUrl);
  } catch {
    return { kind: 'unavailable' };
  }
  if (page.status < 200 || page.status >= 300) return { kind: 'unavailable' };
  const kind = classifyPosting(page.body);
  if (kind === 'partner') return { kind: 'partner' };
  if (kind !== 'direct') return { kind: 'unavailable' };

  let posted: RevealResponse;
  try {
    posted = await fetcher.post(postingUrl, buildRevealPostBody(jobId));
  } catch {
    return { kind: 'unavailable' };
  }
  if (posted.status < 200 || posted.status >= 300) return { kind: 'unavailable' };
  const methods = extractApplyMethods(posted.body);
  return methods ? { kind: 'revealed', methods } : { kind: 'throttled' };
}
