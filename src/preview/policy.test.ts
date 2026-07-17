import { describe, expect, it } from 'vitest';

import { preparePreview } from './policy';
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

    expect(prepared.html).not.toMatch(/<script|onerror=|<iframe|<form|<base|<meta|<link/i);
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

  it('defers only absolute HTTPS images as policy-owned metadata', () => {
    const prepared = preparePreview(
      message(`
        <img src="https://images.example.test/logo.png" data-pending-img-src="https://forged.example.test/x.png" srcset="https://images.example.test/2x.png 2x">
        <img src="HTTPS://images.example.test/banner.png"><img src="//images.example.test/protocol-relative.png">
      `),
    );

    expect(prepared.remoteImageCount).toBe(2);
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

  it('removes external font resources before either document is built', () => {
    const preview = preparePreview(
      message(`
        <link rel="stylesheet" href="https://fonts.example.test/receipt.css">
        <style>@font-face { font-family: Receipt; src: url(https://fonts.example.test/receipt.woff2); }</style>
        <p style="font-family: Receipt; src: url(https://fonts.example.test/inline.woff2)">Receipt</p>
      `),
    );
    const blocked = buildPreviewDocument(preview, false);
    const remote = buildPreviewDocument(preview, true);

    expect(preview.html).not.toContain('fonts.example.test');
    expect(blocked).not.toContain('fonts.example.test');
    expect(remote).not.toContain('fonts.example.test');
    expect(blocked).toContain("font-src 'none'");
    expect(remote).toContain("font-src 'none'");
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
    expect(remote).toContain("style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
  });

  it('enforces the policy for forged previews in both document modes', () => {
    const forged = {
      html: `
        <script>alert(1)</script><iframe src="https://evil.example.test/frame"></iframe>
        <form action="https://evil.example.test/submit"><input></form><a href="https://evil.example.test">Go</a>
        <link rel="stylesheet" href="https://fonts.example.test/receipt.css">
        <style>@font-face { src: url(https://fonts.example.test/receipt.woff2); }</style>
        <p data-forged="true" style="background: url(https://evil.example.test/background.png)">Receipt</p>
        <img src="https://evil.example.test/direct.png" onerror="alert(1)">
        <img data-pending-img-src="https://evil.example.test/pending.png" onload="alert(1)">
      `,
      remoteImageCount: 2,
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
  });
});
