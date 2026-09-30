// S9 T2: local mock application form (FIXTURE page for form-dispatch tests
// and e2e — never linked from production UI).
import { MOCK_FORM_HTML, CAPTCHA_FORM_HTML } from '@/lib/mock-form';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const captcha = new URL(request.url).searchParams.get('captcha') === '1';
  return new Response(captcha ? CAPTCHA_FORM_HTML : MOCK_FORM_HTML, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
