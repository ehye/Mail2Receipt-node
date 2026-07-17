import DOMPurify from 'dompurify';

import type { CIDImage, ParsedMessage } from '../mail/types';

export type PreparedPreview = { html: string; remoteImageCount: number };

const allowedTags = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const allowedTagNames = new Set(allowedTags);
const allowedAttributes = new Set([
  'align',
  'alt',
  'border',
  'cellpadding',
  'cellspacing',
  'class',
  'colspan',
  'height',
  'id',
  'lang',
  'role',
  'rowspan',
  'style',
  'title',
  'valign',
  'width',
]);

const unsafeStyleValue = /url\(|image-set\(|var\(|@import|expression\(|behavior|-moz-binding/i;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8, 0xff];
const gif87aSignature = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const gif89aSignature = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const remoteSourcesByPreview = new WeakMap<PreparedPreview, Map<string, number>>();

export function preparePreview(message: ParsedMessage): PreparedPreview {
  const document = sanitizedDocument(message.html, false);
  const cidImages = new Map(message.cidImages.map((image) => [normalizeContentId(image.contentId), image]));
  const remoteSources = new Map<string, number>();
  let remoteImageCount = 0;

  for (const element of document.body.querySelectorAll('*')) {
    if (!allowedTagNames.has(element.localName)) {
      element.remove();
      continue;
    }

    const source = element.localName === 'img' ? element.getAttribute('src') : null;
    filterAttributes(element);

    if (element.localName !== 'img') {
      continue;
    }

    const cidImage = source ? cidImages.get(normalizeCidReference(source)) : undefined;

    if (cidImage) {
      element.setAttribute('src', cidImageDataUrl(cidImage));
      continue;
    }

    const remoteUrl = source ? absoluteHttpsUrl(source) : null;

    if (remoteUrl) {
      element.setAttribute('data-pending-img-src', remoteUrl.href);
      remoteSources.set(remoteUrl.href, (remoteSources.get(remoteUrl.href) ?? 0) + 1);
      remoteImageCount += 1;
      continue;
    }

    element.remove();
  }

  const preview = { html: document.body.innerHTML, remoteImageCount };
  remoteSourcesByPreview.set(preview, remoteSources);

  return preview;
}

export function renderPreviewHtml(preview: PreparedPreview, allowRemoteImages: boolean): string {
  const document = sanitizedDocument(preview.html, true);
  const remoteSources = remoteSourcesByPreview.get(preview);
  const restoredRemoteSources = new Map<string, number>();

  for (const element of document.body.querySelectorAll('*')) {
    if (!allowedTagNames.has(element.localName)) {
      element.remove();
      continue;
    }

    const source = element.localName === 'img' ? element.getAttribute('src') : null;
    const pendingSource = element.localName === 'img' ? element.getAttribute('data-pending-img-src') : null;
    filterAttributes(element);

    if (element.localName !== 'img') {
      continue;
    }

    const dataImage = source ? validatedDataImageUrl(source) : null;

    if (dataImage) {
      element.setAttribute('src', dataImage);
      continue;
    }

    const remoteUrl =
      allowRemoteImages && pendingSource
        ? trustedRemoteUrl(pendingSource, remoteSources, restoredRemoteSources)
        : null;

    if (!remoteUrl) {
      element.remove();
      continue;
    }

    element.setAttribute('src', remoteUrl.href);
    element.setAttribute('referrerpolicy', 'no-referrer');
  }

  return document.body.innerHTML;
}

function filterAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (attribute.name === 'style') {
      const style = safeStyle(attribute.value);

      if (style) {
        element.setAttribute('style', style);
      } else {
        element.removeAttribute('style');
      }

      continue;
    }

    if (!allowedAttributes.has(attribute.name)) {
      element.removeAttribute(attribute.name);
    }
  }
}

function safeStyle(style: string): string {
  return style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && !unsafeStyleValue.test(normalizeCss(declaration)))
    .join('; ');
}

function normalizeCss(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(
      /\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi,
      (_match, hexadecimal: string | undefined, escaped: string | undefined) => {
        if (!hexadecimal) {
          return escaped ?? '';
        }

        const codePoint = Number.parseInt(hexadecimal, 16);

        return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
      },
    );
}

function sanitizedDocument(html: string, allowPendingImageMetadata: boolean): Document {
  // `src` is retained only between sanitization and the detached policy pass.
  const sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: [
      ...allowedAttributes,
      'src',
      ...(allowPendingImageMetadata ? ['data-pending-img-src'] : []),
    ],
    // The builder's detached pass removes every source data attribute after
    // comparing pending image URLs against its private preview registry.
    ALLOW_DATA_ATTR: allowPendingImageMetadata,
  });

  return new DOMParser().parseFromString(sanitized, 'text/html');
}

function normalizeContentId(value: string): string {
  const contentId = value.trim();
  const withoutBrackets =
    contentId.startsWith('<') && contentId.endsWith('>') ? contentId.slice(1, -1).trim() : contentId;

  return withoutBrackets.toLowerCase();
}

function normalizeCidReference(source: string): string {
  return /^cid:/i.test(source) ? normalizeContentId(source.slice(4)) : '';
}

function absoluteHttpsUrl(source: string): URL | null {
  if (!/^https:\/\//i.test(source)) {
    return null;
  }

  try {
    const url = new URL(source);

    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function trustedRemoteUrl(
  source: string,
  remoteSources: ReadonlyMap<string, number> | undefined,
  restoredRemoteSources: Map<string, number>,
): URL | null {
  const url = absoluteHttpsUrl(source);

  if (!url) {
    return null;
  }

  const allowedCount = remoteSources?.get(url.href) ?? 0;
  const restoredCount = restoredRemoteSources.get(url.href) ?? 0;

  if (restoredCount >= allowedCount) {
    return null;
  }

  restoredRemoteSources.set(url.href, restoredCount + 1);

  return url;
}

function validatedDataImageUrl(source: string): string | null {
  const match = /^data:(image\/(?:png|jpeg|gif));base64,([a-z0-9+/]+={0,2})$/i.exec(source);
  const mimeType = match?.[1]?.toLowerCase() as CIDImage['mimeType'] | undefined;
  const encoded = match?.[2];

  if (!mimeType || !encoded) {
    return null;
  }

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    return hasImageSignature(mimeType, bytes) ? `data:${mimeType};base64,${encoded}` : null;
  } catch {
    return null;
  }
}

function hasImageSignature(mimeType: CIDImage['mimeType'], bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/png':
      return startsWith(bytes, pngSignature);
    case 'image/jpeg':
      return startsWith(bytes, jpegSignature);
    case 'image/gif':
      return startsWith(bytes, gif87aSignature) || startsWith(bytes, gif89aSignature);
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.byteLength >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

function cidImageDataUrl(image: CIDImage): string {
  const bytes = new Uint8Array(image.bytes);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:${image.mimeType};base64,${btoa(binary)}`;
}
