import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import PostalMime from 'postal-mime';
import type { Email } from 'postal-mime';

import { parseMessage } from './parse-message';
import {
  MAX_CID_IMAGE_BYTES,
  MAX_CID_IMAGE_TOTAL_BYTES,
  MAX_EMAIL_BYTES,
  type ParseErrorCode,
} from './types';

const encoder = new TextEncoder();
const pngSignature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegSignature = new Uint8Array([0xff, 0xd8, 0xff]);
const gifSignature = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

type CIDImageFixture = { contentId: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> };

function toArrayBuffer(value: string): ArrayBuffer {
  return encoder.encode(value).buffer;
}

function expectParseFailure(bytes: ArrayBuffer, code: ParseErrorCode): Promise<void> {
  return expect(parseMessage(bytes)).rejects.toMatchObject({ code });
}

function bytesWithSignature(
  byteLength: number,
  signature: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(byteLength);
  bytes.set(signature);

  return bytes;
}

function pngImages(imageSizes: readonly number[]): CIDImageFixture[] {
  return imageSizes.map((size, index) => ({
    contentId: `image-${index}`,
    mimeType: 'image/png',
    bytes: bytesWithSignature(size, pngSignature),
  }));
}

function cidImageEmail(images: readonly CIDImageFixture[]): ArrayBuffer {
  const boundary = 'cid-boundary';
  const parts = images.map(
    (image) =>
      `--${boundary}\r\nContent-Type: ${image.mimeType}\r\nContent-ID: <${image.contentId}>\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(image.bytes).toString('base64')}\r\n`,
  );

  return toArrayBuffer(
    `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Receipt</p>\r\n${parts.join('')}--${boundary}--\r\n`,
  );
}

function overlyNestedMessage(depth: number): ArrayBuffer {
  const boundaries = Array.from({ length: depth }, (_, index) => `nested-${index}`);
  const headers = boundaries.map(
    (boundary) => `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n`,
  );
  const closings = [...boundaries]
    .reverse()
    .map((boundary) => `\r\n--${boundary}--\r\n`);

  return toArrayBuffer(`MIME-Version: 1.0\r\n${headers.join('')}Content-Type: text/html\r\n\r\n<p>Nested</p>${closings.join('')}`);
}

describe('parseMessage', () => {
  it('selects HTML from a multipart alternative message', async () => {
    const message = await parseMessage(
      toArrayBuffer(
        'MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="alternative"\r\n\r\n--alternative\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain text\r\n--alternative\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p><strong>HTML</strong></p>\r\n--alternative--\r\n',
      ),
    );

    expect(message.cidImages).toEqual([]);
    expect(message.html).toContain('<strong>HTML</strong>');
    expect(message.html).not.toContain('Plain text');
  });

  it('decodes a base64 HTML body', async () => {
    const message = await parseMessage(
      toArrayBuffer(
        'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA+QmFzZTY0PC9wPg==\r\n',
      ),
    );

    expect(message.html).toBe('<p>Base64</p>');
  });

  it('decodes a quoted-printable HTML body', async () => {
    const message = await parseMessage(
      toArrayBuffer(
        'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>Quoted=20printable</p>',
      ),
    );

    expect(message.html).toContain('<p>Quoted printable</p>');
  });

  it('decodes ISO-8859-1 HTML to a JavaScript string', async () => {
    const prefix = encoder.encode(
      'Content-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n<p>caf',
    );
    const suffix = encoder.encode('</p>');
    const bytes = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);

    bytes.set(prefix);
    bytes[prefix.byteLength] = 0xe9;
    bytes.set(suffix, prefix.byteLength + 1);

    const message = await parseMessage(bytes.buffer);

    expect(message.html).toContain('<p>caf\u00e9</p>');
  });

  it('rejects a text-only email', async () => {
    await expectParseFailure(
      toArrayBuffer('Content-Type: text/plain; charset=utf-8\r\n\r\nPlain text only\r\n'),
      'unsupported-email',
    );
  });

  it('rejects malformed nested MIME input generically', async () => {
    await expectParseFailure(overlyNestedMessage(65), 'invalid-email');
  });

  it('rejects email input larger than the limit before parsing', async () => {
    await expectParseFailure(new ArrayBuffer(MAX_EMAIL_BYTES + 1), 'email-too-large');
  });

  it('retains a PNG CID attachment at the per-image limit', async () => {
    const message = await parseMessage(cidImageEmail(pngImages([MAX_CID_IMAGE_BYTES])));

    expect(message.cidImages).toEqual([
      {
        contentId: 'image-0',
        mimeType: 'image/png',
        bytes: expect.any(ArrayBuffer),
      },
    ]);
    expect(message.cidImages[0]?.bytes.byteLength).toBe(MAX_CID_IMAGE_BYTES);
  });

  it('rejects a PNG CID attachment over the per-image limit', async () => {
    await expectParseFailure(
      cidImageEmail(pngImages([MAX_CID_IMAGE_BYTES + 1])),
      'unsupported-email',
    );
  });

  it('retains JPEG and GIF CID attachments with matching signatures', async () => {
    const message = await parseMessage(
      cidImageEmail([
        { contentId: 'jpeg', mimeType: 'image/jpeg', bytes: jpegSignature },
        { contentId: 'gif', mimeType: 'image/gif', bytes: gifSignature },
      ]),
    );

    expect(message.cidImages).toMatchObject([
      { contentId: 'jpeg', mimeType: 'image/jpeg' },
      { contentId: 'gif', mimeType: 'image/gif' },
    ]);
  });

  it('discards a CID image whose bytes do not match its declared MIME type', async () => {
    const message = await parseMessage(
      cidImageEmail([{ contentId: 'mismatch', mimeType: 'image/png', bytes: gifSignature }]),
    );

    expect(message.cidImages).toEqual([]);
  });

  it('discards a CID image with an incomplete signature', async () => {
    const message = await parseMessage(
      cidImageEmail([{ contentId: 'truncated', mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8]) }]),
    );

    expect(message.cidImages).toEqual([]);
  });

  it('rejects PNG CID attachments over the total limit', async () => {
    const attachments = Array.from({ length: 6 }, (_, index) => ({
      filename: null,
      mimeType: 'image/png',
      disposition: 'inline' as const,
      contentId: `<image-${index}>`,
      content:
        index < 5
          ? bytesWithSignature(MAX_CID_IMAGE_BYTES - 2, pngSignature).buffer
          : bytesWithSignature(
                MAX_CID_IMAGE_TOTAL_BYTES - (MAX_CID_IMAGE_BYTES - 2) * 5 + 1,
                pngSignature,
              )
              .buffer,
    }));
    const parse = vi.spyOn(PostalMime, 'parse').mockResolvedValue({
      attachments,
      headers: [],
      headerLines: [],
      html: '<p>Receipt</p>',
    } satisfies Email);

    try {
      await expectParseFailure(toArrayBuffer('synthetic'), 'unsupported-email');
    } finally {
      parse.mockRestore();
    }
  });
});
