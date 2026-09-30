// S9 T2: mock application form fixtures. Clearly labeled FIXTURE pages — the
// integration suite serves them from a local http server; the web app exposes
// the same HTML at /mock-form for the e2e flow.

export const MOCK_FORM_HTML = `<!doctype html>
<!-- FIXTURE: local mock application form for S9 tests — not a real page. -->
<html lang="en">
<head><meta charset="utf-8"><title>Mock application form</title></head>
<body>
  <h1>Mock application form</h1>
  <form id="apply" method="post" action="/submit">
    <input data-form="name" name="name" type="text" />
    <input data-form="email" name="email" type="email" />
    <textarea data-form="message" name="message"></textarea>
    <input data-form="file" name="resume" type="file" />
    <button data-form="submit" type="submit">Apply</button>
  </form>
  <div id="mock-success" style="display:none">Thank you for your application!</div>
  <script>
    document.getElementById('apply').addEventListener('submit', function (e) {
      e.preventDefault();
      fetch('/submit', { method: 'POST' }).then(function () {
        document.querySelector('[data-form="submit"]').style.display = 'none';
        document.getElementById('mock-success').style.display = 'block';
      });
    });
  </script>
</body>
</html>`;

export const CAPTCHA_FORM_HTML = `<!doctype html>
<!-- FIXTURE: captcha-protected variant — the S9 flow must STOP before filling. -->
<html lang="en">
<head><meta charset="utf-8"><title>Protected form</title></head>
<body>
  <div class="g-recaptcha" data-sitekey="fixture-key"></div>
  <form id="apply" method="post" action="/submit-captcha">
    <input data-form="name" name="name" type="text" />
    <button data-form="submit" type="submit">Apply</button>
  </form>
</body>
</html>`;
