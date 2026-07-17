import type { ParsedMessage, WorkerResponse } from './types';

let nextRequestId = 0;

export function parseEml(bytes: ArrayBuffer): Promise<ParsedMessage> {
  const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  const id = nextRequestId++;

  return new Promise((resolve, reject) => {
    const fail = (): void => {
      worker.terminate();
      reject(new Error('invalid-email'));
    };

    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if (data.id !== id) {
        return;
      }

      worker.terminate();

      if (data.ok) {
        resolve(data.message);
      } else {
        reject(new Error(data.error));
      }
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;

    try {
      worker.postMessage({ id, bytes }, [bytes]);
    } catch {
      fail();
    }
  });
}
