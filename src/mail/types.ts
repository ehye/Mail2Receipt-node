export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const MAX_CID_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CID_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

export type CIDImage = {
  contentId: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
  bytes: ArrayBuffer;
};

export type ParsedMessage = { html: string; cidImages: CIDImage[] };
export type ParseErrorCode = 'invalid-email' | 'unsupported-email' | 'email-too-large';
export type WorkerRequest = { id: number; bytes: ArrayBuffer };
export type WorkerResponse =
  | { id: number; ok: true; message: ParsedMessage }
  | { id: number; ok: false; error: ParseErrorCode };
