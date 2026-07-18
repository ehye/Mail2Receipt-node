import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedMessage } from './mail/types';
import type { PreparedPreview } from './preview/policy';

const mocks = vi.hoisted(() => ({
  buildPreviewDocument: vi.fn(),
  parseEml: vi.fn(),
  preparePreview: vi.fn(),
  prepareRemoteStylesheets: vi.fn(),
}));

vi.mock('./mail/parse', () => ({ parseEml: mocks.parseEml }));
vi.mock('./preview/policy', () => ({
  preparePreview: mocks.preparePreview,
  prepareRemoteStylesheets: mocks.prepareRemoteStylesheets,
}));
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
    vi.stubGlobal('URL', { createObjectURL: undefined, revokeObjectURL: URL.revokeObjectURL });
    root = document.createElement('div');
    document.body.replaceChildren(root);
    mocks.parseEml.mockReset();
    mocks.preparePreview.mockReset();
    mocks.prepareRemoteStylesheets.mockReset().mockResolvedValue(undefined);
    mocks.buildPreviewDocument.mockReset();
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteResourceCount: 0 } satisfies PreparedPreview);
    mocks.buildPreviewDocument.mockImplementation((_preview: PreparedPreview, allowRemoteContent: boolean) =>
      allowRemoteContent
        ? '<!doctype html><html><head></head><body><p>remote</p></body></html>'
        : '<!doctype html><html><head></head><body><p>blocked</p></body></html>',
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('creates a private review shell with disabled actions', () => {
    mountApp(root);

    const input = root.querySelector<HTMLInputElement>('input[type="file"]');
    const uploadOverlay = root.querySelector<HTMLElement>('.preview-upload');
    const remote = root.querySelector<HTMLInputElement>('input[name="load-remote-content"]');
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]');
    const status = root.querySelector<HTMLElement>('[role="status"]');
    expect(input?.getAttribute('accept')).toBe('.eml,message/rfc822');
    expect(uploadOverlay?.getAttribute('aria-label')).toBe('Choose or drop an HTML email');
    expect(input?.closest('.preview-upload')).toBe(uploadOverlay);
    expect(root.querySelector('.drop-target')).toBeNull();
    expect(root.querySelector('.review-shell > .file-picker')).toBeNull();
    expect(remote?.type).toBe('checkbox');
    expect(remote?.checked).toBe(false);
    expect(remote?.disabled).toBe(true);
    expect(root.textContent).toContain(
      'Direct and stylesheet-derived requests use no-referrer.',
    );
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

  it('hides the combined upload overlay after a file is selected', async () => {
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    const overlay = root.querySelector<HTMLElement>('.preview-upload')!;
    expect(overlay.hidden).toBe(false);

    select(root, file());
    expect(overlay.hidden).toBe(true);
    await flush();

    expect(overlay.hidden).toBe(true);
  });

  it('reads a file dropped on the combined upload overlay', async () => {
    const selected = file();
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    const files = { 0: selected, length: 1, item: (index: number) => (index === 0 ? selected : null) } as unknown as FileList;
    const event = new Event('drop', { cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files } });
    root.querySelector<HTMLElement>('.preview-upload')!.dispatchEvent(event);
    await flush();

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.parseEml).toHaveBeenCalledOnce();
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

  it('keeps remote content consent through later selections', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    mocks.preparePreview
      .mockReturnValueOnce({ html: '<p>first</p>', remoteResourceCount: 1 } satisfies PreparedPreview)
      .mockReturnValueOnce({ html: '<p>local</p>', remoteResourceCount: 0 } satisfies PreparedPreview)
      .mockReturnValueOnce({ html: '<p>later</p>', remoteResourceCount: 1 } satisfies PreparedPreview);
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    select(root, file());
    await flush();
    const remote = root.querySelector<HTMLInputElement>('input[name="load-remote-content"]')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    expect(remote.disabled).toBe(false);
    expect(print.disabled).toBe(true);

    dispatchFrameLoad(frame, frame.srcdoc);
    expect(print.disabled).toBe(false);
    remote.checked = true;
    remote.dispatchEvent(new Event('change'));
    await flush();
    expect(frame.srcdoc).toContain('<p>remote</p>');
    expect(print.disabled).toBe(true);

    select(root, file());
    await flush();
    expect(remote.checked).toBe(true);
    expect(remote.disabled).toBe(true);
    expect(mocks.buildPreviewDocument).toHaveBeenLastCalledWith(expect.anything(), true);

    select(root, file());
    await flush();
    expect(remote.checked).toBe(true);
    expect(remote.disabled).toBe(false);
    expect(mocks.buildPreviewDocument).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(frame.srcdoc).toContain('<p>remote</p>');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rebuilds the active preview when remote content is unchecked', async () => {
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteResourceCount: 1 } satisfies PreparedPreview);
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);

    select(root, file());
    await flush();
    const remote = root.querySelector<HTMLInputElement>('input[name="load-remote-content"]')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    remote.checked = true;
    remote.dispatchEvent(new Event('change'));
    await flush();
    expect(frame.srcdoc).toContain('<p>remote</p>');

    remote.checked = false;
    remote.dispatchEvent(new Event('change'));
    await flush();
    expect(frame.srcdoc).toContain('<p>blocked</p>');
    expect(print.disabled).toBe(true);
  });

  it('ignores a late blocked-document load after remote replacement', async () => {
    mocks.preparePreview.mockReturnValue({ html: '<p>prepared</p>', remoteResourceCount: 1 } satisfies PreparedPreview);
    mocks.parseEml.mockResolvedValue(message);
    mountApp(root);
    select(root, file());
    await flush();

    const frame = root.querySelector<HTMLIFrameElement>('iframe')!;
    const remote = root.querySelector<HTMLInputElement>('input[name="load-remote-content"]')!;
    const print = root.querySelector<HTMLButtonElement>('button[name="print"]')!;
    const blockedDocument = frame.srcdoc;
    remote.checked = true;
    remote.dispatchEvent(new Event('change'));
    await flush();
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
