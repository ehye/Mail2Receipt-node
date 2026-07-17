import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedMessage } from './mail/types';
import type { PreparedPreview } from './preview/policy';

const mocks = vi.hoisted(() => ({
  buildPreviewDocument: vi.fn(),
  parseEml: vi.fn(),
  preparePreview: vi.fn(),
}));

vi.mock('./mail/parse', () => ({ parseEml: mocks.parseEml }));
vi.mock('./preview/policy', () => ({ preparePreview: mocks.preparePreview }));
vi.mock('./preview/preview-document', () => ({ buildPreviewDocument: mocks.buildPreviewDocument }));

import { mountApp } from './app';

const message: ParsedMessage = { html: '<p>synthetic</p>', cidImages: [] };

function file(): File {
  const selected = new File(['synthetic email'], 'private-email.eml', { type: 'message/rfc822' });
  Object.defineProperty(selected, 'arrayBuffer', { value: vi.fn().mockResolvedValue(new ArrayBuffer(1)) });
  return selected;
}

function select(root: HTMLDivElement, selected: File): void {
  const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const files = { 0: selected, length: 1, item: (index: number) => (index === 0 ? selected : null) } as unknown as FileList;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new Event('change'));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function dispatchFrameLoad(frame: HTMLIFrameElement, source: string): void {
  const token = /<meta name="mail2receipt-document-token" content="(\d+)">/.exec(source)?.[1];
  const document = window.document.implementation.createHTMLDocument();
  const marker = document.createElement('meta');
  marker.name = 'mail2receipt-document-token';
  marker.content = token ?? '';
  document.head.append(marker);
  Object.defineProperty(frame, 'contentDocument', { configurable: true, value: document });
  frame.dispatchEvent(new Event('load'));
}

describe('mountApp', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    mocks.parseEml.mockReset();
    mocks.preparePreview.mockReset();
    mocks.buildPreviewDocument.mockReset();
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteImageCount: 0 } satisfies PreparedPreview);
    mocks.buildPreviewDocument.mockImplementation((_preview: PreparedPreview, allowRemoteImages: boolean) =>
      allowRemoteImages
        ? '<!doctype html><html><head></head><body><p>remote</p></body></html>'
        : '<!doctype html><html><head></head><body><p>blocked</p></body></html>',
    );
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('creates a private review shell with disabled actions', () => {
    mountApp(root);

    const input = root.querySelector<HTMLInputElement>('input[type="file"]');
    const remote = root.querySelector<HTMLButtonElement>('button[name="load-remote-images"]');
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]');
    const status = root.querySelector<HTMLElement>('[role="status"]');
    expect(input?.getAttribute('accept')).toBe('.eml,message/rfc822');
    expect(remote?.disabled).toBe(true);
    expect(print?.disabled).toBe(true);
    expect(status?.getAttribute('aria-live')).toBe('polite');

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('reads and parses an accepted selection exactly once', async () => {
    const selected = file();
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    select(root, selected);
    await flush();

    expect(selected.arrayBuffer).toHaveBeenCalledOnce();
    expect(mocks.parseEml).toHaveBeenCalledOnce();
    expect(mocks.preparePreview).toHaveBeenCalledWith(message);
    expect(root.querySelector('iframe')!.srcdoc).toContain('<p>blocked</p>');
  });

  it('does not let a stale parse replace a newer selection', async () => {
    let resolveFirst!: (value: ParsedMessage) => void;
    const first = new Promise<ParsedMessage>((resolve) => {
      resolveFirst = resolve;
    });
    mocks.parseEml.mockReturnValueOnce(first).mockResolvedValueOnce(message);
    mountApp(root);

    select(root, file());
    select(root, file());
    await flush();
    resolveFirst(message);
    await flush();

    expect(mocks.preparePreview).toHaveBeenCalledTimes(1);
  });

  it('reports a generic parsing failure without exposing message data', async () => {
    mocks.parseEml.mockRejectedValue(new Error('subject: confidential receipt'));
    mountApp(root);

    select(root, file());
    await flush();

    expect(root.querySelector('[role="status"]')?.textContent).toBe('Unable to prepare this email for preview.');
    expect(root.textContent).not.toContain('confidential receipt');
    expect(root.textContent).not.toContain('private-email.eml');
  });

  it('requires fresh remote consent for each selected file', async () => {
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteImageCount: 1 } satisfies PreparedPreview);
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    select(root, file());
    await flush();
    const remote = root.querySelector<HTMLButtonElement>('button[name="load-remote-images"]')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    expect(remote.disabled).toBe(false);
    expect(print.disabled).toBe(true);

    dispatchFrameLoad(frame, frame.srcdoc);
    expect(print.disabled).toBe(false);
    remote.click();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('IP address'));
    expect(frame.srcdoc).toContain('<p>remote</p>');
    expect(print.disabled).toBe(true);

    select(root, file());
    expect(remote.disabled).toBe(true);
    expect(print.disabled).toBe(true);
    await flush();
    expect(frame.srcdoc).toContain('<p>blocked</p>');
  });

  it('ignores a late blocked-document load after remote replacement', async () => {
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteImageCount: 1 } satisfies PreparedPreview);
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);
    select(root, file());
    await flush();

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    const remote = root.querySelector<HTMLButtonElement>('button[name="load-remote-images"]')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const blockedDocument = frame.srcdoc;
    remote.click();
    const remoteDocument = frame.srcdoc;

    dispatchFrameLoad(frame, blockedDocument);
    expect(print.disabled).toBe(true);
    dispatchFrameLoad(frame, remoteDocument);
    expect(print.disabled).toBe(false);
  });

  it('ignores a stale frame load after switching files', async () => {
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);
    select(root, file());
    await flush();

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const firstDocument = frame.srcdoc;
    select(root, file());
    await flush();
    const secondDocument = frame.srcdoc;

    dispatchFrameLoad(frame, firstDocument);
    expect(print.disabled).toBe(true);
    dispatchFrameLoad(frame, secondDocument);
    expect(print.disabled).toBe(false);
  });

  it('prints only the ready active preview frame', async () => {
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);
    select(root, file());
    await flush();

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    const focus = vi.fn();
    const print = vi.fn();
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: { focus, print } });
    const button = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    button.click();
    expect(print).not.toHaveBeenCalled();

    dispatchFrameLoad(frame, frame.srcdoc);
    button.click();
    expect(focus).toHaveBeenCalledOnce();
    expect(print).toHaveBeenCalledOnce();
  });
});
