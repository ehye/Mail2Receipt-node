import { Buffer } from 'node:buffer';

import { expect, test, type FrameLocator, type Page, type Request } from '@playwright/test';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8pQAAAABJRU5ErkJggg==';
const imageHost = 'images.example.test';
const receiptImage = `https://${imageHost}/receipt.png`;
const replacementImage = `https://${imageHost}/replacement.png`;
const insecureImage = `http://${imageHost}/insecure.png`;
const stylesheetUrl = 'https://styles.example.test/assets/receipt.css';
const fontUrl = 'https://fonts.example.test/receipt.woff2';
const backgroundImage = 'https://images.example.test/background.png';
const stylesheetFontUrl = 'https://fonts.example.test/stylesheet-receipt.woff2';
const relativeStylesheetFontUrl = 'https://styles.example.test/fonts/stylesheet-relative-receipt.woff2';
const stylesheetBackgroundImage = 'https://images.example.test/stylesheet-background.png';
const httpFontUrl = 'http://fonts.example.test/receipt.woff2';
const httpBackgroundImage = 'http://images.example.test/background.png';
const stylesheetWithHttpDependenciesUrl = 'https://styles.example.test/http-dependencies.css';
const httpStylesheetImportUrl = 'http://styles.example.test/insecure-import.css';
const markupStylesheetUrl = 'https://styles.example.test/markup.css';
const attackerPixelUrl = 'https://attacker.example/pixel';
const privateText = 'PRIVATE-PLAINTEXT-FIXTURE-CONTENT';

const mixedEmail = relatedEmail(`
  <p>Mixed receipt fixture</p>
  <img src="cid:logo" alt="Logo">
  <img src="${receiptImage}" alt="Remote receipt">
  <img src="${insecureImage}" alt="Insecure receipt">
`);
const replacementEmail = htmlEmail(`<p>Replacement receipt fixture</p><img src="${replacementImage}" alt="Replacement receipt">`);
const remoteContentEmail = htmlEmail(`
  <link rel="stylesheet" href="${stylesheetUrl}">
  <style>@font-face { font-family: Receipt; src: url(${fontUrl}); } .receipt { background-image: url(${backgroundImage}); }</style>
  <p class="receipt" style="font-family: Receipt">Remote content fixture</p>
  <img src="${receiptImage}" alt="Remote receipt">
`);
const legacyFontEmail = htmlEmail(`
  <table><tbody><tr><td face="Verdana, Droid Sans">Legacy table font</td></tr></tbody></table>
  <p><font face="Verdana, Droid Sans">Legacy font element</font></p>
`);
const bodyFontEmail = htmlEmail('<body style="font-family: Verdana, Droid Sans"><p>Body font</p></body>');
const stylesheetHttpDependenciesEmail = htmlEmail(`
  <link rel="stylesheet" href="${stylesheetWithHttpDependenciesUrl}">
  <p>Stylesheet HTTP dependency fixture</p>
  <img src="${insecureImage}" alt="Insecure receipt">
`);
const stylesheetMarkupEmail = htmlEmail(`
  <link rel="stylesheet" href="${markupStylesheetUrl}">
  <p>Stylesheet markup fixture</p>
`);
const sourceStyleMarkupEmail = htmlEmail(`
  <style>.receipt::before { content: "</style><img src=${attackerPixelUrl}><a href='https://attacker.example/link'>"; }</style>
  <p class="receipt">Source style markup fixture</p>
  <img src="${receiptImage}" alt="Approved receipt">
`);
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

function externalHttpRequests(page: Page): Request[] {
  const requests: Request[] = [];
  const applicationOrigin = new URL(page.url()).origin;

  page.on('request', (request) => {
    const url = new URL(request.url());

    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== applicationOrigin) {
      requests.push(request);
    }
  });

  return requests;
}

async function uploadAndWaitForPreview(page: Page, eml: string, text: string): Promise<FrameLocator> {
  await page.locator('input[type="file"]').setInputFiles(emailFile(eml));

  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText(text);
  await expect(page.getByRole('button', { name: 'Print' })).toBeEnabled();

  return frame;
}

test('uses the preview sheet as the upload overlay', async ({ page }) => {
  await page.goto('/');

  const overlay = page.locator('.preview-upload');
  const input = overlay.locator('input[type="file"]');

  await expect(overlay).toHaveCSS('position', 'absolute');
  await expect(overlay).toHaveCSS('z-index', '1');
  await expect(input).toHaveCSS('position', 'absolute');
  await expect(input).toHaveCSS('width', '1px');
  await expect(input).toHaveCSS('height', '1px');
  await expect(input).toHaveCSS('overflow', 'clip');
});

test('remote content fetches each stylesheet once and keeps all approved requests private', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);
  await expect(page.getByText('Direct and stylesheet-derived requests use no-referrer.')).toBeVisible();
  let dialogMessage: string | undefined;
  page.on('dialog', (dialog) => {
    dialogMessage = dialog.message();
    void dialog.dismiss();
  });

  await page.route(stylesheetUrl, (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/css' },
      body: `@font-face { font-family: Receipt; src: url(${stylesheetFontUrl}); } @font-face { font-family: RelativeReceipt; src: url("../fonts/stylesheet-relative-receipt.woff2"); } body { font-family: RelativeReceipt; background-image: url(${stylesheetBackgroundImage}); }`,
    }),
  );
  await page.route(fontUrl, (route) => route.fulfill({ contentType: 'font/woff2', body: Buffer.from('fixture-font') }));
  await page.route(relativeStylesheetFontUrl, (route) => route.fulfill({ contentType: 'font/woff2', body: Buffer.from('fixture-font') }));
  await page.route(`https://${imageHost}/**`, (route) =>
    route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
  );

  const frame = await uploadAndWaitForPreview(page, remoteContentEmail, 'Remote content fixture');

  await page.waitForTimeout(750);
  expect(requests).toEqual([]);

  const remoteContent = page.getByRole('checkbox', { name: /load remote content/i });
  const previewNavigation = page.waitForEvent(
    'framenavigated',
    (candidate) => candidate.parentFrame() === page.mainFrame(),
  );
  await remoteContent.check();
  await previewNavigation;

  await expect(frame.locator('body')).toContainText('Remote content fixture');
  expect(await frame.locator('style').allTextContents()).toEqual(
    expect.arrayContaining([
        expect.stringContaining('stylesheet-receipt.woff2'),
        expect.stringContaining('stylesheet-relative-receipt.woff2'),
        expect.stringContaining(fontUrl),
      expect.stringContaining(backgroundImage),
    ]),
  );

  await expect
    .poll(
      () => requests.map((request) => request.url()),
      { timeout: 3_000 },
    )
    .toEqual(expect.arrayContaining([stylesheetUrl, fontUrl, backgroundImage, receiptImage, stylesheetFontUrl, relativeStylesheetFontUrl, stylesheetBackgroundImage]));
  await expect(frame.getByAltText('Remote receipt')).toHaveJSProperty('naturalWidth', 1);
  expect(requests.map((request) => request.url())).toEqual(
    expect.arrayContaining([stylesheetUrl, fontUrl, backgroundImage, receiptImage, stylesheetFontUrl, relativeStylesheetFontUrl, stylesheetBackgroundImage]),
  );
  expect(requests.filter((request) => request.url() === stylesheetUrl)).toHaveLength(1);
  for (const url of [stylesheetUrl, fontUrl, backgroundImage, receiptImage, stylesheetFontUrl, relativeStylesheetFontUrl, stylesheetBackgroundImage]) {
    expect(requests.find((request) => request.url() === url)?.headers().referer).toBeUndefined();
  }
  expect(await frame.locator('link').count()).toBe(0);
  expect(dialogMessage).toBeUndefined();

  const replacementRequest = page.waitForRequest(replacementImage);
  await uploadAndWaitForPreview(page, replacementEmail, 'Replacement receipt fixture');

  await replacementRequest;
  await expect(remoteContent).toBeChecked();
  expect(requests.find((request) => request.url() === replacementImage)?.headers().referer).toBeUndefined();
  expect(dialogMessage).toBeUndefined();
});

test('remote content consent blocks HTTP stylesheet font, image, and import dependencies', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);
  const httpRequests: Request[] = [];
  const applicationOrigin = new URL(page.url()).origin;
  page.on('request', (request) => {
    const url = new URL(request.url());

    if (url.protocol === 'http:' && url.origin !== applicationOrigin) {
      httpRequests.push(request);
    }
  });

  await page.route(stylesheetWithHttpDependenciesUrl, (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/css' },
      body: `@import url(${httpStylesheetImportUrl}); @font-face { font-family: Insecure; src: url(${httpFontUrl}); } body { background-image: url(${httpBackgroundImage}); }`,
    }),
  );
  await page.route(`http://${imageHost}/**`, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
  await page.route(httpFontUrl, (route) => route.fulfill({ contentType: 'font/woff2', body: Buffer.from('fixture-font') }));
  await page.route(httpStylesheetImportUrl, (route) => route.fulfill({ contentType: 'text/css', body: '' }));

  await page.locator('input[type="file"]').setInputFiles(emailFile(stylesheetHttpDependenciesEmail));
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('body')).toContainText('Stylesheet HTTP dependency fixture');

  await page.waitForTimeout(750);
  expect(requests).toEqual([]);

  const remoteContent = page.getByRole('checkbox', { name: /load remote content/i });
  await expect(remoteContent).toBeEnabled();
  const noHttpRequest = page.waitForRequest(
    (request) => new URL(request.url()).protocol === 'http:' && new URL(request.url()).origin !== new URL(page.url()).origin,
    { timeout: 750 },
  );

  await remoteContent.check();
  await expect(frame.locator('body')).toContainText('Stylesheet HTTP dependency fixture');
  await expect(remoteContent).toBeChecked();
  await expect(noHttpRequest).rejects.toThrow();
  expect(httpRequests).toEqual([]);
});

test('CORS stylesheet markup cannot create a preview image request', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);

  await page.route(markupStylesheetUrl, (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': 'text/css' },
      body: `.receipt { content: "</style><img src=${attackerPixelUrl}>"; }`,
    }),
  );
  await page.route(attackerPixelUrl, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));

  const frame = await uploadAndWaitForPreview(page, stylesheetMarkupEmail, 'Stylesheet markup fixture');
  const previewNavigation = page.waitForEvent(
    'framenavigated',
    (candidate) => candidate.parentFrame() === page.mainFrame(),
  );
  await page.getByRole('checkbox', { name: /load remote content/i }).check();
  await previewNavigation;

  await expect(frame.locator('img')).toHaveCount(0);
  await page.waitForTimeout(250);
  expect(requests.map((request) => request.url())).toEqual([markupStylesheetUrl]);
});

test('source style markup cannot create preview nodes or attacker requests', async ({ page }) => {
  await page.goto('/');
  const requests = externalHttpRequests(page);

  await page.route(receiptImage, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
  await page.route(attackerPixelUrl, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));

  const frame = await uploadAndWaitForPreview(page, sourceStyleMarkupEmail, 'Source style markup fixture');
  await expect(frame.locator('img')).toHaveCount(0);
  await expect(frame.locator('a')).toHaveCount(0);
  expect(requests).toEqual([]);

  const previewNavigation = page.waitForEvent(
    'framenavigated',
    (candidate) => candidate.parentFrame() === page.mainFrame(),
  );
  await page.getByRole('checkbox', { name: /load remote content/i }).check();
  await previewNavigation;

  await expect(frame.locator('img')).toHaveCount(1);
  await expect(frame.locator('a')).toHaveCount(0);
  await expect(frame.getByAltText('Approved receipt')).toHaveJSProperty('naturalWidth', 1);
  expect(requests.map((request) => request.url())).toEqual([receiptImage]);
});

test('page reload resets remote content consent', async ({ page }) => {
  await page.goto('/');
  await uploadAndWaitForPreview(page, remoteContentEmail, 'Remote content fixture');

  const remoteContent = page.getByRole('checkbox', { name: /load remote content/i });
  await remoteContent.check();
  await expect(remoteContent).toBeChecked();

  await page.reload();

  await expect(page.getByRole('checkbox', { name: /load remote content/i })).not.toBeChecked();
});

test('preserves legacy email font families', async ({ page }) => {
  await page.goto('/');
  const frame = await uploadAndWaitForPreview(page, legacyFontEmail, 'Legacy table font');

  for (const locator of [frame.locator('td'), frame.locator('font')]) {
    await expect(locator).toHaveCSS('font-family', /Verdana.*Droid Sans/);
  }
});

test('preserves a source body font family', async ({ page }) => {
  await page.goto('/');
  const frame = await uploadAndWaitForPreview(page, bodyFontEmail, 'Body font');

  await expect(frame.locator('body')).toHaveCSS('font-family', /Verdana.*Droid Sans/);
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

test('reports text-only input with generic copy that excludes email content', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(emailFile(textOnlyEmail));

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
