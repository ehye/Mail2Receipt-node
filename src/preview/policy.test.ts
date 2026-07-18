import { afterEach, describe, expect, it, vi } from 'vitest';

import { preparePreview, prepareRemoteStylesheets } from './policy';
import { buildPreviewDocument } from './preview-document';
import type { ParsedMessage } from '../mail/types';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
const jpeg = new Uint8Array([0xff, 0xd8, 0xff]).buffer;
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]).buffer;

function message(html: string): ParsedMessage {
  return {
    html,
    cidImages: [
      { contentId: 'logo-png', mimeType: 'image/png', bytes: png },
      { contentId: 'logo-jpeg', mimeType: 'image/jpeg', bytes: jpeg },
      { contentId: 'logo-gif', mimeType: 'image/gif', bytes: gif },
    ],
  };
}

function stylesheetResponse(css: string): Response {
  return new Response(css, { headers: { 'content-type': 'text/css' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('preparePreview', () => {
  it('removes active, navigational, source metadata, and network CSS content', () => {
    const prepared = preparePreview(
      message(`
        <script>alert(1)</script><iframe src="https://evil.example.test"></iframe>
        <form action="https://evil.example.test"><input></form><base href="https://evil.example.test">
        <meta http-equiv="refresh" content="0"><link rel="stylesheet" href="https://evil.example.test/a.css">
        <a href="https://evil.example.test" onclick="alert(1)" data-source="keep">Receipt</a>
        <p style="color: green; background: url(https://evil.example.test/a.png); width: image-set(url(x) 1x); font: var(--font); animation: expression(alert(1)); behavior: url(x); binding: -moz-binding(url(x)); @import 'x';">Safe</p>
      `),
    );

    expect(prepared.html).not.toMatch(/<script|onerror=|<iframe|<form|<base|<meta/i);
    expect(prepared.html).not.toMatch(/srcset=|http:\/\//i);
    expect(prepared.html).not.toContain('data-source');
    expect(prepared.html).not.toMatch(/url\(|image-set\(|var\(|@import|expression\(|behavior|-moz-binding/i);
    expect(prepared.html).toContain('style="color: green"');
  });

  it('embeds exact validated CID images and removes unknown, invalid, and HTTP image sources', () => {
    const prepared = preparePreview(
      message(`
        <img src="CID:logo-png"><img src="cid:logo-jpeg"><img src="cid:logo-gif">
        <img src="cid:missing"><img src="data:image/png;base64,AAAA"><img src="http://images.example.test/logo.png">
      `),
    );

    expect(prepared.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(prepared.html).toContain('src="data:image/jpeg;base64,/9j/"');
    expect(prepared.html).toContain('src="data:image/gif;base64,R0lGODlh"');
    expect(prepared.html).not.toContain('cid:');
    expect(prepared.html).not.toContain('http://');
    expect(prepared.html.match(/<img\b/g)).toHaveLength(3);
  });

  it('renders validated CID CSS data images locally without requiring consent', () => {
    const preview = preparePreview(
      message(`
        <style>.receipt { background-image: url(cid:logo-png); }</style>
        <p class="receipt" style="border-image-source: url(cid:logo-gif)">Receipt</p>
      `),
    );
    const blocked = buildPreviewDocument(preview, false);

    expect(preview.remoteResourceCount).toBe(0);
    expect(blocked).toContain('url("data:image/png;base64,iVBORw0KGgo=")');
    expect(blocked).toContain('url(&quot;data:image/gif;base64,R0lGODlh&quot;)');
    expect(blocked).not.toContain('data-pending-');
  });

  it('preserves passive legacy font-family markup', () => {
    const preview = preparePreview(
      message('<table><tbody><tr><td face="Verdana, Droid Sans">Cell</td></tr></tbody></table><p><font face="Verdana, Droid Sans">Receipt</font></p>'),
    );
    const document = new DOMParser().parseFromString(buildPreviewDocument(preview, false), 'text/html');

    expect(document.querySelector('td')?.getAttribute('face')).toBe('Verdana, Droid Sans');
    expect(document.querySelector('font')?.getAttribute('face')).toBe('Verdana, Droid Sans');
  });

  it('preserves a source body font family on the generated preview body', () => {
    const preview = preparePreview(message('<body style="font-family: Verdana, Droid Sans"><p>Receipt</p></body>'));
    const document = new DOMParser().parseFromString(buildPreviewDocument(preview, false), 'text/html');

    expect(document.body.style.fontFamily).toBe('Verdana, "Droid Sans"');
  });

  it('defers a source body CSS resource until remote content is allowed', () => {
    const backgroundUrl = 'https://images.example.test/background.png';
    const preview = preparePreview(message(`<body style="background-image: url(${backgroundUrl})"><p>Receipt</p></body>`));

    expect(preview.remoteResourceCount).toBe(1);
    expect(buildPreviewDocument(preview, false)).not.toContain(backgroundUrl);
    expect(buildPreviewDocument(preview, true)).toContain(backgroundUrl);
  });

  it('defers only absolute HTTPS images as policy-owned metadata', () => {
    const prepared = preparePreview(
      message(`
        <img src="https://images.example.test/logo.png" data-pending-img-src="https://forged.example.test/x.png" srcset="https://images.example.test/2x.png 2x">
        <img src="HTTPS://images.example.test/banner.png"><img src="//images.example.test/protocol-relative.png">
      `),
    );

    expect(prepared.remoteResourceCount).toBe(2);
    expect(prepared.html).toContain('data-pending-img-src="https://images.example.test/logo.png"');
    expect(prepared.html).toContain('data-pending-img-src="https://images.example.test/banner.png"');
    expect(prepared.html).not.toContain('forged.example.test');
    expect(prepared.html).not.toContain('srcset=');
    expect(prepared.html).not.toContain('protocol-relative');
    expect(prepared.html).not.toMatch(/<img\b[^>]*\ssrc=/i);
  });

  it('removes CSS resource keywords hidden by escapes or comments', () => {
    const prepared = preparePreview(
      message('<p style="background: u\\72l(https://images.example.test/a.png); color: red; background-image: u/**/rl(https://images.example.test/b.png)">Receipt</p>'),
    );

    expect(prepared.html).not.toContain('background:');
    expect(prepared.html).toContain('style="color: red"');
  });

  it('keeps source style markup payloads inert in blocked and consented documents', () => {
    const pixelUrl = 'https://attacker.example/pixel';
    const linkUrl = 'https://attacker.example/link';
    const preview = preparePreview(
      message(`<style>.receipt::before { content: "</style><img src=${pixelUrl}><a href='${linkUrl}'>"; }</style><p class="receipt">Receipt</p>`),
    );

    for (const source of [buildPreviewDocument(preview, false), buildPreviewDocument(preview, true)]) {
      const document = new DOMParser().parseFromString(source, 'text/html');

      expect(document.images).toHaveLength(0);
      expect(document.querySelectorAll('a')).toHaveLength(0);
      expect(document.documentElement.outerHTML).not.toContain('attacker.example');
    }
  });

  it('restores registry-owned HTTPS image and CSS resource URLs only after consent', () => {
    const preview = preparePreview(
      message(`
        <link rel="stylesheet" href="https://fonts.example.test/receipt.css">
        <style>@font-face { font-family: Receipt; src: url(https://fonts.example.test/receipt.woff2); }</style>
        <p style="font-family: Receipt; background-image: url(https://images.example.test/background.png)">Receipt</p>
      `),
    );
    const blocked = buildPreviewDocument(preview, false);
    const remote = buildPreviewDocument(preview, true);

    expect(preview.remoteResourceCount).toBeGreaterThan(0);
    expect(blocked).not.toContain('fonts.example.test');
    expect(blocked).not.toContain('images.example.test');
    expect(remote).not.toContain('<link');
    expect(remote).not.toContain('https://fonts.example.test/receipt.css');
    expect(remote).not.toContain('https://fonts.example.test/receipt.woff2');
    expect(remote).toContain('https://images.example.test/background.png');
    expect(blocked).toContain("style-src 'unsafe-inline'");
    expect(blocked).toContain("font-src 'none'");
    expect(remote).toContain("style-src 'unsafe-inline'");
    expect(remote).toContain("font-src https:");
    expect(remote).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('discards a style block with an insecure import instead of restoring its HTTPS resources', () => {
    const preview = preparePreview(
      message(`
        <style>
          @import url("https://styles.example.test/imported.css");
          @import url("http://styles.example.test/insecure.css");
          .receipt { color: green; }
        </style>
      `),
    );
    const blocked = buildPreviewDocument(preview, false);
    const remote = buildPreviewDocument(preview, true);

    expect(preview.remoteResourceCount).toBe(0);
    expect(blocked).not.toContain('imported.css');
    expect(remote).not.toContain('imported.css');
    expect(remote).not.toContain('insecure.css');
    expect(remote).not.toContain('color: green');
  });

  it('fetches each approved stylesheet once and inlines only sanitized response CSS', async () => {
    const stylesheetUrl = 'https://styles.example.test/receipt.css';
    const fetch = vi.fn().mockResolvedValue(stylesheetResponse('/* response comment */ .receipt { color: green; }'));
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}"><link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);
    const remote = buildPreviewDocument(preview, true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(stylesheetUrl, {
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    expect(remote).not.toContain('<link');
    expect(remote).not.toContain(stylesheetUrl);
    expect(remote).toContain('.receipt { color: green; }');
    expect(remote).not.toContain('response comment');
  });

  it('resolves a stylesheet-relative HTTPS font URL before inlining CSS', async () => {
    const stylesheetUrl = 'https://styles.example.test/assets/receipt.css';
    const fontUrl = 'https://styles.example.test/fonts/receipt.woff2';
    const fetch = vi.fn().mockResolvedValue(stylesheetResponse('@font-face { font-family: Receipt; src: url("../fonts/receipt.woff2"); }'));
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);

    expect(buildPreviewDocument(preview, true)).toContain(`url("${fontUrl}")`);
  });

  it('recursively fetches absolute HTTPS stylesheet imports before inlining them', async () => {
    const stylesheetUrl = 'https://styles.example.test/receipt.css';
    const importedUrl = 'https://styles.example.test/imported.css';
    const fetch = vi.fn().mockImplementation(async (source: string) =>
      stylesheetResponse(
        source === stylesheetUrl
          ? `@import url("${importedUrl}"); .receipt { color: green; }`
          : '.imported { color: blue; }',
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);
    const remote = buildPreviewDocument(preview, true);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([source]) => source)).toEqual([stylesheetUrl, importedUrl]);
    expect(remote).toContain('.receipt { color: green; }');
    expect(remote).toContain('.imported { color: blue; }');
    expect(remote).not.toContain('@import');
  });

  it('rejects fetched CSS markup delimiters before constructing the preview document', async () => {
    const stylesheetUrl = 'https://styles.example.test/markup.css';
    const pixelUrl = 'https://attacker.example/pixel';
    const fetch = vi.fn().mockResolvedValue(stylesheetResponse(`.receipt { content: "</style><img src=${pixelUrl}>"; }`));
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}"><p class="receipt">Receipt</p>`));

    await prepareRemoteStylesheets(preview);
    const document = new DOMParser().parseFromString(buildPreviewDocument(preview, true), 'text/html');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(stylesheetUrl, {
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    expect(document.images).toHaveLength(0);
    expect(document.documentElement.outerHTML).not.toContain(pixelUrl);
  });

  it('rejects oversized fetched stylesheet responses', async () => {
    const stylesheetUrl = 'https://styles.example.test/oversized.css';
    const fetch = vi.fn().mockResolvedValue(stylesheetResponse('.receipt { color: green; }'.repeat(11_000)));
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);

    expect(buildPreviewDocument(preview, true)).not.toContain('color: green');
  });

  it('enforces the stylesheet response byte budget across all roots', async () => {
    const firstUrl = 'https://styles.example.test/first.css';
    const secondUrl = 'https://styles.example.test/second.css';
    const firstCss = `.first { color: green; }${' '.repeat(150 * 1024)}`;
    const secondCss = `.second { color: blue; }${' '.repeat(150 * 1024)}`;
    const fetch = vi.fn().mockImplementation(async (source: string) =>
      stylesheetResponse(source === firstUrl ? firstCss : secondCss),
    );
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${firstUrl}"><link rel="stylesheet" href="${secondUrl}">`));

    await prepareRemoteStylesheets(preview);
    const remote = buildPreviewDocument(preview, true);

    expect(fetch.mock.calls.map(([source]) => source)).toEqual([firstUrl, secondUrl]);
    expect(remote).toContain('.first { color: green; }');
    expect(remote).not.toContain('.second { color: blue; }');
  });

  it('rejects stylesheet trees that exceed the import count limit', async () => {
    const stylesheetUrl = 'https://styles.example.test/root.css';
    const imports = Array.from({ length: 17 }, (_value, index) => `https://styles.example.test/import-${index}.css`);
    const fetch = vi.fn().mockImplementation(async (source: string) =>
      stylesheetResponse(
        source === stylesheetUrl
          ? imports.map((url) => `@import url("${url}");`).join('')
          : '.receipt { color: green; }',
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);

    expect(fetch).toHaveBeenCalledTimes(17);
    expect(buildPreviewDocument(preview, true)).not.toContain('color: green');
  });

  it('rejects stylesheet trees that exceed the import-depth limit', async () => {
    const stylesheetUrl = 'https://styles.example.test/depth-0.css';
    const sources = Array.from({ length: 6 }, (_value, index) => `https://styles.example.test/depth-${index}.css`);
    const fetch = vi.fn().mockImplementation(async (source: string) => {
      const index = sources.indexOf(source);

      return stylesheetResponse(
          index === sources.length - 1
            ? '.receipt { color: green; }'
            : `@import url("${sources[index + 1]}");`,
      );
    });
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(message(`<link rel="stylesheet" href="${stylesheetUrl}">`));

    await prepareRemoteStylesheets(preview);

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(buildPreviewDocument(preview, true)).not.toContain('color: green');
  });

  it('resolves inline HTTPS imports before rendering and rejects unsafe imported CSS', async () => {
    const importedUrl = 'https://styles.example.test/imported.css';
    const insecureImport = 'http://styles.example.test/insecure.css';
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/css' }),
      text: async () => `@import url("${insecureImport}"); .imported { color: blue; }`,
    });
    vi.stubGlobal('fetch', fetch);
    const preview = preparePreview(
      message(`<style>@import url("${importedUrl}"); .receipt { color: green; }</style>`),
    );

    await prepareRemoteStylesheets(preview);
    const remote = buildPreviewDocument(preview, true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(importedUrl, {
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    expect(fetch).not.toHaveBeenCalledWith(insecureImport, expect.anything());
    expect(remote).not.toContain('@import');
    expect(remote).not.toContain(importedUrl);
    expect(remote).not.toContain('insecure.css');
    expect(remote).not.toContain('.receipt { color: green; }');
    expect(remote).not.toContain('.imported { color: blue; }');
  });
});

describe('buildPreviewDocument', () => {
  it('keeps deferred remote sources inert in the blocked document', () => {
    const preview = preparePreview(message('<img src="https://images.example.test/logo.png"><img src="cid:logo-png">'));
    const blocked = buildPreviewDocument(preview, false);

    expect(blocked).toContain("img-src data:");
    expect(blocked).not.toContain('img-src data: https:');
    expect(blocked).not.toContain('https://images.example.test/logo.png');
    expect(blocked).not.toContain('data-pending-img-src');
  });

  it('restores policy-owned HTTPS metadata only in the remote document', () => {
    const preview = preparePreview(
      message('<img src="https://images.example.test/logo.png"><img src="https://images.example.test/banner.png"><img src="http://images.example.test/no.png">'),
    );
    const remote = buildPreviewDocument(preview, true);

    expect(remote).toContain("img-src data: https:");
    expect(remote).toContain('src="https://images.example.test/logo.png"');
    expect(remote).toContain('src="https://images.example.test/banner.png"');
    expect(remote).not.toContain('data-pending-img-src');
    expect(remote).not.toContain('http://images.example.test/no.png');
    expect(remote.match(/referrerpolicy="no-referrer"/g)).toHaveLength(2);
    expect(remote).toContain("style-src 'unsafe-inline'; font-src https:; object-src 'none'; base-uri 'none'; form-action 'none'");
  });

  it('enforces the policy for forged previews in both document modes', () => {
    const forged = {
      html: `
        <script>alert(1)</script><iframe src="https://evil.example.test/frame"></iframe>
        <form action="https://evil.example.test/submit"><input></form><a href="https://evil.example.test">Go</a>
        <link rel="stylesheet" href="https://fonts.example.test/receipt.css" data-pending-stylesheet-id="stylesheet-0">
        <style data-pending-style-id="style-0">@font-face { src: url(https://fonts.example.test/receipt.woff2); }</style>
        <p data-forged="true" data-pending-inline-style-id="inline-style-0" style="background: url(https://evil.example.test/background.png)">Receipt</p>
        <img src="https://evil.example.test/direct.png" onerror="alert(1)">
        <img data-pending-img-src="https://evil.example.test/pending.png" data-pending-stylesheet-id="stylesheet-1" onload="alert(1)">
      `,
      remoteResourceCount: 2,
    };
    const blocked = buildPreviewDocument(forged, false);
    const remote = buildPreviewDocument(forged, true);

    for (const document of [blocked, remote]) {
      expect(document).not.toMatch(/<script|onerror=|onload=|<iframe|<form|<link|<style>@font-face/i);
      expect(document).not.toContain('evil.example.test');
      expect(document).not.toContain('fonts.example.test');
      expect(document).not.toContain('data-forged');
      expect(document).not.toMatch(/\shref=|\saction=|\ssrc="https:/i);
    }
    expect(blocked).not.toContain('data-pending-img-src');
    expect(remote).not.toContain('data-pending-img-src');
    expect(blocked).not.toMatch(/data-pending-(?:stylesheet|style|inline-style)-id/);
    expect(remote).not.toMatch(/data-pending-(?:stylesheet|style|inline-style)-id/);
  });
});
