import { parseEml } from './mail/parse';
import { preparePreview, type PreparedPreview } from './preview/policy';
import { buildPreviewDocument } from './preview/preview-document';

type ReviewState = {
  session: number;
  preview?: PreparedPreview;
  remoteAllowed: boolean;
  frameReady: boolean;
  nextDocumentToken: number;
  activeDocumentToken: number;
  activeDocumentSession: number;
};

const parsingError = 'Unable to prepare this email for preview.';
const remoteWarning =
  'Loading remote images lets image hosts receive your IP address and request timing. Load remote images for this email?';
const documentTokenName = 'mail2receipt-document-token';

export function mountApp(root: HTMLDivElement): void {
  const state: ReviewState = {
    session: 0,
    remoteAllowed: false,
    frameReady: false,
    nextDocumentToken: 0,
    activeDocumentToken: 0,
    activeDocumentSession: 0,
  };
  const shell = element('main', 'review-shell');
  const heading = element('h1', 'review-title');
  const picker = document.createElement('label');
  const input = document.createElement('input');
  const dropTarget = element('div', 'drop-target');
  const status = element('p', 'review-status');
  const controls = element('div', 'review-controls');
  const remoteButton = document.createElement('button');
  const printButton = document.createElement('button');
  const sheet = element('div', 'preview-sheet');
  const frame = document.createElement('iframe');

  heading.textContent = 'Email print preview';
  picker.className = 'file-picker';
  input.type = 'file';
  input.accept = '.eml,message/rfc822';
  input.name = 'email-file';
  picker.htmlFor = input.id = 'email-file';
  picker.append('Choose email', input);
  dropTarget.textContent = 'Drop an email file here';
  dropTarget.setAttribute('aria-label', 'Drop email file');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Choose one HTML email to begin.';
  remoteButton.type = 'button';
  remoteButton.name = 'load-remote-images';
  remoteButton.textContent = 'Load remote images';
  remoteButton.disabled = true;
  printButton.type = 'button';
  printButton.name = 'print';
  printButton.textContent = 'Print';
  printButton.disabled = true;
  frame.title = 'Sanitized email preview';
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('referrerpolicy', 'no-referrer');

  controls.append(remoteButton, printButton);
  sheet.append(frame);
  shell.append(heading, picker, dropTarget, status, controls, sheet);
  root.replaceChildren(shell);

  input.addEventListener('change', () => {
    const file = input.files?.item(0);
    input.value = '';

    if (file) {
      selectFile(file);
    }
  });

  for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    dropTarget.addEventListener(eventName, (event) => event.preventDefault());
  }

  dropTarget.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files.item(0);

    if (file) {
      selectFile(file);
    }
  });

  frame.addEventListener('load', () => {
    const loadedToken = frame.contentDocument?.querySelector(`meta[name="${documentTokenName}"]`)?.getAttribute('content');

    if (
      !state.preview ||
      state.activeDocumentSession !== state.session ||
      loadedToken !== String(state.activeDocumentToken)
    ) {
      return;
    }

    state.frameReady = true;
    printButton.disabled = false;
  });

  remoteButton.addEventListener('click', () => {
    const preview = state.preview;
    const session = state.session;

    if (!preview || preview.remoteImageCount === 0 || state.remoteAllowed || !window.confirm(remoteWarning)) {
      return;
    }

    if (state.session !== session) {
      return;
    }

    state.remoteAllowed = true;
    state.frameReady = false;
    remoteButton.disabled = true;
    printButton.disabled = true;
    assignFrameDocument(buildPreviewDocument(preview, true));
  });

  printButton.addEventListener('click', () => {
    if (!state.frameReady) {
      return;
    }

    const target = frame.contentWindow;

    if (target) {
      target.focus();
      target.print();
    }
  });

  function selectFile(file: File): void {
    const session = ++state.session;
    delete state.preview;
    state.remoteAllowed = false;
    state.frameReady = false;
    assignFrameDocument('');
    remoteButton.disabled = true;
    printButton.disabled = true;
    status.textContent = 'Preparing email preview.';

    void prepareFile(file, session);
  }

  async function prepareFile(file: File, session: number): Promise<void> {
    try {
      const message = await parseEml(await file.arrayBuffer());

      if (state.session !== session) {
        return;
      }

      const preview = preparePreview(message);

      if (state.session !== session) {
        return;
      }

      state.preview = preview;
      state.frameReady = false;
      assignFrameDocument(buildPreviewDocument(preview, false));
      remoteButton.disabled = preview.remoteImageCount === 0;
      printButton.disabled = true;
      status.textContent = 'Preview ready.';
    } catch {
      if (state.session !== session) {
        return;
      }

      delete state.preview;
      state.remoteAllowed = false;
      state.frameReady = false;
      assignFrameDocument('');
      remoteButton.disabled = true;
      printButton.disabled = true;
      status.textContent = parsingError;
    }
  }

  function assignFrameDocument(source: string): void {
    const token = ++state.nextDocumentToken;
    state.activeDocumentToken = token;
    state.activeDocumentSession = state.session;
    state.frameReady = false;
    frame.srcdoc = source
      ? source.replace('<head>', `<head><meta name="${documentTokenName}" content="${token}">`)
      : '';
  }
}

function element(tagName: string, className: string): HTMLElement {
  const result = document.createElement(tagName);
  result.className = className;
  return result;
}
