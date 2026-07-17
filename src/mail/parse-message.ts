import PostalMime from 'postal-mime';
import type { Attachment } from 'postal-mime';

import {
  MAX_CID_IMAGE_BYTES,
  MAX_CID_IMAGE_TOTAL_BYTES,
  MAX_EMAIL_BYTES,
  type CIDImage,
  type ParsedMessage,
  type ParseErrorCode,
} from './types';

const imageTypes = new Set<CIDImage['mimeType']>(['image/png', 'image/jpeg', 'image/gif']);
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8, 0xff];
const gif87aSignature = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const gif89aSignature = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

export class ParseFailure extends Error {
  constructor(readonly code: ParseErrorCode) {
    super(code);
  }
}

export async function parseMessage(bytes: ArrayBuffer): Promise<ParsedMessage> {
  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    throw new ParseFailure('email-too-large');
  }

  try {
    const email = await PostalMime.parse(bytes, {
      attachmentEncoding: 'arraybuffer',
      maxHeadersSize: 256 * 1024,
      maxNestingDepth: 64,
    });

    if (!email.html) {
      throw new ParseFailure('unsupported-email');
    }

    return { html: email.html, cidImages: collectCidImages(email.attachments) };
  } catch (error) {
    if (error instanceof ParseFailure) {
      throw error;
    }

    throw new ParseFailure('invalid-email');
  }
}

function normalizeContentId(value: string | undefined): string {
  const contentId = value?.trim() ?? '';

  return contentId.startsWith('<') && contentId.endsWith('>')
    ? contentId.slice(1, -1).trim()
    : contentId;
}

function collectCidImages(attachments: Attachment[]): CIDImage[] {
  let total = 0;

  return attachments.flatMap((attachment) => {
    const contentId = normalizeContentId(attachment.contentId);
    const mimeType = attachment.mimeType as CIDImage['mimeType'];

    if (!contentId || !imageTypes.has(mimeType) || !(attachment.content instanceof ArrayBuffer)) {
      return [];
    }

    const bytes = attachment.content;

    if (!hasImageSignature(mimeType, bytes)) {
      return [];
    }

    total += bytes.byteLength;

    if (bytes.byteLength > MAX_CID_IMAGE_BYTES || total > MAX_CID_IMAGE_TOTAL_BYTES) {
      throw new ParseFailure('unsupported-email');
    }

    return [{ contentId, mimeType, bytes }];
  });
}

function hasImageSignature(mimeType: CIDImage['mimeType'], bytes: ArrayBuffer): boolean {
  const content = new Uint8Array(bytes);

  switch (mimeType) {
    case 'image/png':
      return startsWith(content, pngSignature);
    case 'image/jpeg':
      return startsWith(content, jpegSignature);
    case 'image/gif':
      return startsWith(content, gif87aSignature) || startsWith(content, gif89aSignature);
  }
}

function startsWith(content: Uint8Array, signature: readonly number[]): boolean {
  return content.byteLength >= signature.length && signature.every((byte, index) => content[index] === byte);
}
