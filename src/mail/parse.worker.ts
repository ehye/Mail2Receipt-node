import { ParseFailure, parseMessage } from './parse-message';
import type { WorkerRequest, WorkerResponse } from './types';

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const response: WorkerResponse = await parseMessage(data.bytes)
    .then((message) => ({ id: data.id, ok: true as const, message }))
    .catch((error: unknown) => ({
      id: data.id,
      ok: false,
      error: error instanceof ParseFailure ? error.code : 'invalid-email',
    }));
  const transfers = response.ok ? response.message.cidImages.map((image) => image.bytes) : [];

  self.postMessage(response, transfers);
};
