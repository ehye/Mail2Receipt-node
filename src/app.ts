import { parseEml } from './mail/parse';
import { preparePreview, prepareRemoteStylesheets, type PreparedPreview } from './preview/policy';
import { buildPreviewDocument } from './preview/preview-document';

type ReviewState = {
  session: number;
  preview?: PreparedPreview;
  remoteContentAllowed: boolean;
  frameReady: boolean;
  nextDocumentToken: number;
  activeDocumentToken: number;
  activeDocumentSession: number;
  activeDocumentUrl?: string;
};

const parsingError = 'Unable to prepare this email for preview.';
const documentTokenName = 'mail2receipt-document-token';

export function mountApp(root: HTMLDivElement): void {
  const state: ReviewState = {
    session: 0,
    remoteContentAllowed: false,
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
  const remoteContent = document.createElement('input');
  const remoteContentLabel = document.createElement('label');
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
  remoteContent.type = 'checkbox';
  remoteContent.name = 'load-remote-content';
  remoteContent.disabled = true;
  remoteContentLabel.className = 'remote-content-toggle';
  remoteContentLabel.append(
    remoteContent,
    ' Load remote content (remote hosts can receive your IP address and request timing. Direct and stylesheet-derived requests use no-referrer.)',
  );
  printButton.type = 'button';
  printButton.name = 'print';
  printButton.textContent = 'Print';
  printButton.disabled = true;
  frame.title = 'Sanitized email preview';
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('referrerpolicy', 'no-referrer');

  controls.append(remoteContentLabel, printButton);
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

  remoteContent.addEventListener('change', () => {
    state.remoteContentAllowed = remoteContent.checked;
    const preview = state.preview;

    if (preview) {
      printButton.disabled = true;
      void renderPreview(preview, state.session);
    }
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
    state.frameReady = false;
    assignFrameDocument('');
    remoteContent.disabled = true;
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
      await renderPreview(preview, session);
      if (state.session !== session || state.preview !== preview) {
        return;
      }
      remoteContent.disabled = preview.remoteResourceCount === 0;
      printButton.disabled = true;
      status.textContent = 'Preview ready.';
    } catch {
      if (state.session !== session) {
        return;
      }

      delete state.preview;
      state.frameReady = false;
      assignFrameDocument('');
      remoteContent.disabled = true;
      printButton.disabled = true;
      status.textContent = parsingError;
    }
  }

  async function renderPreview(preview: PreparedPreview, session: number): Promise<void> {
    if (state.remoteContentAllowed) {
      await prepareRemoteStylesheets(preview);
    }

    if (state.session === session && state.preview === preview) {
      assignFrameDocument(buildPreviewDocument(preview, state.remoteContentAllowed));
    }
  }

  function assignFrameDocument(source: string): void {
    const token = ++state.nextDocumentToken;
    state.activeDocumentToken = token;
    state.activeDocumentSession = state.session;
    state.frameReady = false;
    const document = source ? source.replace('<head>', `<head><meta name="${documentTokenName}" content="${token}">`) : '';

    if (state.activeDocumentUrl) {
      URL.revokeObjectURL(state.activeDocumentUrl);
      delete state.activeDocumentUrl;
    }

    if (document && typeof URL.createObjectURL === 'function') {
      state.activeDocumentUrl = URL.createObjectURL(new Blob([document], { type: 'text/html' }));
      frame.removeAttribute('srcdoc');
      frame.src = state.activeDocumentUrl;
      return;
    }

    frame.srcdoc = document;
  }
}

function element(tagName: string, className: string): HTMLElement {
  const result = document.createElement(tagName);
  result.className = className;
  return result;
}
