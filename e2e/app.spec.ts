import { Buffer } from 'node:buffer';

import { expect, test, type FrameLocator, type Page } from '@playwright/test';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8pQAAAABJRU5ErkJggg==';
const imageHost = 'images.example.test';
const receiptImage = `https://${imageHost}/receipt.png`;
const replacementImage = `https://${imageHost}/replacement.png`;
const insecureImage = `http://${imageHost}/insecure.png`;
const privateText = 'PRIVATE-PLAINTEXT-FIXTURE-CONTENT';

const mixedEmail = relatedEmail(`
  <p>Mixed receipt fixture</p>
  <img src="cid:logo" alt="Logo">
  <img src="${receiptImage}" alt="Remote receipt">
  <img src="${insecureImage}" alt="Insecure receipt">
`);
const replacementEmail = htmlEmail(`<p>Replacement receipt fixture</p><img src="${replacementImage}" alt="Replacement receipt">`);
const httpOnlyEmail = htmlEmail(`<p>HTTP-only fixture</p><img src="${insecureImage}" alt="Insecure receipt">`);
const textOnlyEmail = ['Content-Type: text/plain; charset=utf-8', '', privateText, ''].join('\n');
const hostileEmail = htmlEmail(`
  <p>Hostile fixture</p>
  <script>top.location = 'https://navigate.example.test/script'</script>
  <img src="cid:missing" onerror="top.location='https://navigate.example.test/onerror'" srcset="${receiptImage} 2x">
  <iframe src="https://navigate.example.test/frame"></iframe>
  <form action="https://navigate.example.test/form"><input></form>
  <link rel="stylesheet" href="https://navigate.example.test/styles.css">
  <a href="https://navigate.example.test/link">Navigate away</a>
`);

function htmlEmail(html: string): string {
  return ['MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\n');
}

function relatedEmail(html: string): string {
  const boundary = 'synthetic-related-boundary';

  return [
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    `--${boundary}`,
    'Content-Type: image/png',
    'Content-ID: <logo>',
    'Content-Disposition: inline',
    'Content-Transfer-Encoding: base64',
    '',
    png,
    `--${boundary}--`,
    '',
  ].join('\n');
}

function emailFile(eml: string) {
  return { name: 'fixture.eml', mimeType: 'message/rfc822', buffer: Buffer.from(eml) };
}

function externalHttpRequests(page: Page): string[] {
  const requests: string[] = [];
  const applicationOrigin = new URL(page.url()).origin;

  page.on('request', (request) => {
    const url = new URL(request.url());

    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== applicationOrigin) {
      requests.push(request.url());
    }
  });

  return requests;
}

async function uploadAndWaitForPreview(page: Page, eml: string, text: string): Promise<FrameLocator> {
  await page.getByLabel('Choose email').setInputFiles(emailFile(eml));

  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText(text);
  await expect(page.getByRole('button', { name: 'Print' })).toBeEnabled();

  return frame;
}

test('blocks HTTP(S) receipt images until explicit remote-image consent', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);

  await uploadAndWaitForPreview(page, mixedEmail, 'Mixed receipt fixture');

  expect(requests).toEqual([]);

  await page.route(`https://${imageHost}/**`, (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
  );
  const httpsRequest = page.waitForRequest(receiptImage);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Load remote images' }).click();

  await httpsRequest;
  expect(requests).toEqual([receiptImage]);
});

test('keeps HTTP-only images unavailable for remote loading', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);

  await uploadAndWaitForPreview(page, httpOnlyEmail, 'HTTP-only fixture');

  await expect(page.getByRole('button', { name: 'Load remote images' })).toBeDisabled();
  expect(requests).toEqual([]);
});

test('renders hostile HTML in a sandboxed iframe without active or navigational content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Print' })).toBeDisabled();

  const frame = await uploadAndWaitForPreview(page, hostileEmail, 'Hostile fixture');
  const documentHtml = await frame.locator('html').evaluate((element) => element.outerHTML);

  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-same-origin allow-modals');
  await expect(page.locator('iframe')).not.toHaveAttribute('sandbox', /allow-scripts|allow-top-navigation/);
  await expect(page.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(documentHtml).not.toMatch(/<script|<form|<iframe|<link/i);
  expect(documentHtml).not.toMatch(/onerror=|srcset=|\shref=|\saction=/i);
  expect(documentHtml).not.toContain('https://navigate.example.test');
  await expect(page).toHaveURL(/\/$/);
});

test('resets remote-image consent when a new file is selected', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);

  await uploadAndWaitForPreview(page, mixedEmail, 'Mixed receipt fixture');
  await page.route(`https://${imageHost}/**`, (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Load remote images' }).click();
  await expect.poll(() => requests).toContain(receiptImage);

  await uploadAndWaitForPreview(page, replacementEmail, 'Replacement receipt fixture');

  await expect(page.getByRole('button', { name: 'Load remote images' })).toBeEnabled();
  expect(requests).toEqual([receiptImage]);
});

test('reports text-only input with generic copy that excludes email content', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Choose email').setInputFiles(emailFile(textOnlyEmail));

  await expect(page.getByRole('status')).toHaveText('Unable to prepare this email for preview.');
  await expect(page.locator('body')).not.toContainText(privateText);
  await expect(page.getByRole('button', { name: 'Print' })).toBeDisabled();
});

test('prints the active preview iframe after it has loaded', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Print' })).toBeDisabled();

  const frame = await uploadAndWaitForPreview(page, mixedEmail, 'Mixed receipt fixture');
  await frame.locator('body').evaluate(() => {
    let calls = 0;
    window.print = () => {
      calls += 1;
    };
    Object.defineProperty(window, '__printCalls', { get: () => calls });
  });

  await page.getByRole('button', { name: 'Print' }).click();

  await expect
    .poll(() => frame.locator('body').evaluate(() => (window as Window & { __printCalls?: number }).__printCalls))
    .toBe(1);
});
