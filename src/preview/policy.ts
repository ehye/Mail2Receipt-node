import DOMPurify from 'dompurify';

import type { CIDImage, ParsedMessage } from '../mail/types';

export type PreparedPreview = { html: string; remoteResourceCount: number };

type RemotePreviewResources = {
  bodyStyle?: SanitizedInlineStyle;
  images: Map<string, number>;
  stylesheets: Map<string, number>;
  styles: Map<string, string>;
  inlineStyles: Map<string, string>;
  preparedStylesheets: Map<string, string>;
  preparedStyles: Map<string, string>;
  stylesheetPreparation?: Promise<void>;
};

type SanitizedCss = {
  css: string;
  hasResource: boolean;
  rejected: boolean;
};

type SanitizedInlineStyle = {
  local: string;
  full: string;
  hasResource: boolean;
};

type RemoteStylesheetBudget = {
  bytes: number;
  imports: number;
  depth: number;
};

const allowedTags = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'div',
  'em',
  'font',
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
  'link',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'style',
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
  'face',
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

const unsafeStyleValue = /image-set\(|var\(|expression\(|behavior|-moz-binding/i;
const cssUrl = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
const cssImport = /^@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')\s*;$/i;
const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jpegSignature = [0xff, 0xd8, 0xff];
const gif87aSignature = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const gif89aSignature = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const maxRemoteStylesheetBytes = 256 * 1024;
const maxRemoteStylesheetImports = 16;
const maxRemoteStylesheetImportDepth = 4;
const remoteResourcesByPreview = new WeakMap<PreparedPreview, RemotePreviewResources>();

export function preparePreview(message: ParsedMessage): PreparedPreview {
  const sourceBody = sourceBodyPresentation(message.html);
  const document = sanitizedDocument(message.html, false);
  const cidImages = new Map(message.cidImages.map((image) => [normalizeContentId(image.contentId), image]));
  const resources: RemotePreviewResources = {
    images: new Map(),
    stylesheets: new Map(),
    styles: new Map(),
    inlineStyles: new Map(),
    preparedStylesheets: new Map(),
    preparedStyles: new Map(),
  };
  let remoteResourceCount = 0;
  const bodyStyle = withLegacyFontFamily(
    sanitizeInlineStyle(sourceBody.style, cidImages, false, true),
    sourceBody.face,
  );

  if (bodyStyle.local || bodyStyle.full) {
    resources.bodyStyle = bodyStyle;
  }

  if (bodyStyle.hasResource) {
    remoteResourceCount += 1;
  }

  for (const element of document.body.querySelectorAll('*')) {
    if (!allowedTagNames.has(element.localName)) {
      element.remove();
      continue;
    }

    const source = element.localName === 'img' ? element.getAttribute('src') : null;
    const href = element.localName === 'link' ? element.getAttribute('href') : null;
    const relation = element.localName === 'link' ? element.getAttribute('rel') : null;
    const styleText = element.localName === 'style' ? element.textContent ?? '' : null;
    const inlineStyle = element.getAttribute('style');
    const face = element.getAttribute('face');
    filterAttributes(element);

    if (element.localName === 'img') {
      const cidImage = source ? cidImages.get(normalizeCidReference(source)) : undefined;
      const cidDataUrl = cidImage ? cidImageDataUrl(cidImage) : null;

      if (cidDataUrl) {
        element.setAttribute('src', cidDataUrl);
        continue;
      }

      const remoteUrl = source ? absoluteHttpsUrl(source) : null;

      if (remoteUrl) {
        element.setAttribute('data-pending-img-src', remoteUrl.href);
        registerRemoteUrl(resources.images, remoteUrl.href);
        remoteResourceCount += 1;
        continue;
      }

      element.remove();
      continue;
    }

    if (element.localName === 'link') {
      const stylesheetUrl = href && relation?.trim().toLowerCase() === 'stylesheet' ? absoluteHttpsUrl(href) : null;

      if (!stylesheetUrl) {
        element.remove();
        continue;
      }

      const pendingId = `stylesheet-${registeredUrlCount(resources.stylesheets)}`;
      registerRemoteUrl(resources.stylesheets, stylesheetUrl.href);
      element.setAttribute('rel', 'stylesheet');
      element.setAttribute('href', '#');
      element.setAttribute('data-pending-stylesheet-id', pendingId);
      remoteResourceCount += 1;
      continue;
    }

    if (element.localName === 'style') {
      const sanitized = sanitizeStylesheet(styleText ?? '', cidImages, false, true);

      if (!sanitized.css || sanitized.rejected) {
        element.remove();
        continue;
      }

      if (sanitized.hasResource) {
        const pendingId = `style-${resources.styles.size}`;
        resources.styles.set(pendingId, sanitized.css);
        element.textContent = ':root{}';
        element.setAttribute('data-pending-style-id', pendingId);
        remoteResourceCount += 1;
      } else {
        element.textContent = sanitized.css;
      }

      continue;
    }

    const sanitizedInlineStyle = withLegacyFontFamily(
      sanitizeInlineStyle(inlineStyle ?? '', cidImages, false, true),
      face,
    );

    if (sanitizedInlineStyle.local) {
      element.setAttribute('style', sanitizedInlineStyle.local);
    } else {
      element.removeAttribute('style');
    }

    if (sanitizedInlineStyle.hasResource) {
      const pendingId = `inline-style-${resources.inlineStyles.size}`;
      resources.inlineStyles.set(pendingId, sanitizedInlineStyle.full);
      element.setAttribute('data-pending-inline-style-id', pendingId);
      remoteResourceCount += 1;
    }
  }

  const preview = { html: document.body.innerHTML, remoteResourceCount };
  remoteResourcesByPreview.set(preview, resources);

  return preview;
}

export function renderPreviewHtml(preview: PreparedPreview, allowRemoteContent: boolean): string {
  const document = sanitizedDocument(preview.html, true);
  const resources = remoteResourcesByPreview.get(preview);
  const restoredImages = new Map<string, number>();
  const restoredStylesheets = new Map<string, number>();

  for (const element of document.body.querySelectorAll('*')) {
    if (!allowedTagNames.has(element.localName)) {
      element.remove();
      continue;
    }

    const source = element.localName === 'img' ? element.getAttribute('src') : null;
    const pendingImage = element.localName === 'img' ? element.getAttribute('data-pending-img-src') : null;
    const pendingStylesheet = element.localName === 'link' ? element.getAttribute('data-pending-stylesheet-id') : null;
    const pendingStyle = element.localName === 'style' ? element.getAttribute('data-pending-style-id') : null;
    const pendingInlineStyle = element.getAttribute('data-pending-inline-style-id');
    const inlineStyle = element.getAttribute('style');
    const styleText = element.localName === 'style' ? element.textContent ?? '' : null;
    filterAttributes(element);

    if (element.localName === 'img') {
      const dataImage = source ? validatedDataImageUrl(source) : null;

      if (dataImage) {
        element.setAttribute('src', dataImage);
        continue;
      }

      const remoteUrl =
        allowRemoteContent && pendingImage
          ? trustedRemoteUrl(pendingImage, resources?.images, restoredImages)
          : null;

      if (!remoteUrl) {
        element.remove();
        continue;
      }

      element.setAttribute('src', remoteUrl.href);
      element.setAttribute('referrerpolicy', 'no-referrer');
      continue;
    }

    if (element.localName === 'link') {
      const stylesheetUrl =
        allowRemoteContent && pendingStylesheet
          ? registeredUrlById(pendingStylesheet, 'stylesheet', resources?.stylesheets, restoredStylesheets)
          : null;
      const stylesheet = stylesheetUrl ? resources?.preparedStylesheets.get(stylesheetUrl.href) : undefined;

      if (!stylesheet) {
        element.remove();
        continue;
      }

      const style = document.createElement('style');
      style.textContent = stylesheet;
      element.replaceWith(style);
      continue;
    }

    if (element.localName === 'style') {
      const preparedStyle = allowRemoteContent && pendingStyle ? resources?.preparedStyles.get(pendingStyle) : undefined;
      const sanitized = preparedStyle
        ? sanitizeStylesheet(preparedStyle, undefined, true, true)
        : pendingStyle
          ? null
          : sanitizeStylesheet(styleText ?? '', undefined, true, false);

      if (sanitized?.css) {
        element.textContent = sanitized.css;
      } else {
        element.remove();
      }

      continue;
    }

    const localStyle = sanitizeInlineStyle(inlineStyle ?? '', undefined, true, false);
    const registeredInlineStyle =
      allowRemoteContent && pendingInlineStyle ? resources?.inlineStyles.get(pendingInlineStyle) : undefined;
    const restoredStyle = registeredInlineStyle
      ? sanitizeInlineStyle(registeredInlineStyle, undefined, true, true)
      : null;
    const style = restoredStyle?.full || localStyle.local;

    if (style) {
      element.setAttribute('style', style);
    } else {
      element.removeAttribute('style');
    }
  }

  return document.body.innerHTML;
}

export function renderPreviewBodyStyle(preview: PreparedPreview, allowRemoteContent: boolean): string {
  const bodyStyle = remoteResourcesByPreview.get(preview)?.bodyStyle;

  if (!bodyStyle) {
    return '';
  }

  const sanitized = sanitizeInlineStyle(
    allowRemoteContent ? bodyStyle.full : bodyStyle.local,
    undefined,
    true,
    allowRemoteContent,
  );

  return allowRemoteContent ? sanitized.full : sanitized.local;
}

export async function prepareRemoteStylesheets(preview: PreparedPreview): Promise<void> {
  const resources = remoteResourcesByPreview.get(preview);

  if (!resources) {
    return;
  }

  if (!resources.stylesheetPreparation) {
    resources.stylesheetPreparation = prepareStylesheets(resources);
  }

  await resources.stylesheetPreparation;
}

async function prepareStylesheets(resources: RemotePreviewResources): Promise<void> {
  const resolvedStylesheets = new Map<string, string | null>();
  const budget: RemoteStylesheetBudget = {
    bytes: maxRemoteStylesheetBytes,
    imports: maxRemoteStylesheetImports,
    depth: maxRemoteStylesheetImportDepth,
  };

  for (const source of resources.stylesheets.keys()) {
    const stylesheet = await resolveFetchedStylesheet(source, new Set(), resolvedStylesheets, 0, budget);

    if (stylesheet) {
      resources.preparedStylesheets.set(source, stylesheet);
    }
  }

  for (const [id, stylesheet] of resources.styles) {
    const resolved = await resolveStylesheetContents(stylesheet, new Set(), resolvedStylesheets, 0, budget);

    if (resolved) {
      resources.preparedStyles.set(id, resolved);
    }
  }
}

async function resolveFetchedStylesheet(
  source: string,
  ancestors: ReadonlySet<string>,
  resolvedStylesheets: Map<string, string | null>,
  depth: number,
  budget: RemoteStylesheetBudget,
): Promise<string | null> {
  if (ancestors.has(source)) {
    return null;
  }

  if (resolvedStylesheets.has(source)) {
    return resolvedStylesheets.get(source) ?? null;
  }

  try {
    const response = await fetch(source, {
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();

    if (!response.ok || contentType !== 'text/css') {
      resolvedStylesheets.set(source, null);
      return null;
    }

    const responseText = await boundedResponseText(response, budget);

    if (responseText === null) {
      resolvedStylesheets.set(source, null);
      return null;
    }

    const stylesheet = await resolveStylesheetContents(
      responseText,
      new Set([...ancestors, source]),
      resolvedStylesheets,
      depth,
      budget,
      source,
    );
    resolvedStylesheets.set(source, stylesheet);
    return stylesheet;
  } catch {
    resolvedStylesheets.set(source, null);
    return null;
  }
}

async function resolveStylesheetContents(
  stylesheet: string,
  ancestors: ReadonlySet<string>,
  resolvedStylesheets: Map<string, string | null>,
  depth: number,
  budget: RemoteStylesheetBudget,
  resourceBaseUrl?: string,
): Promise<string | null> {
  const rules = splitCssRules(normalizeCss(stylesheet));

  if (!rules) {
    return null;
  }

  const imports: string[] = [];
  const localRules: string[] = [];

  for (const rule of rules) {
    const importUrl = importedStylesheetUrl(rule);

    if (importUrl) {
      if (depth >= budget.depth || budget.imports === 0) {
        return null;
      }

      budget.imports -= 1;
      const imported = await resolveFetchedStylesheet(importUrl.href, ancestors, resolvedStylesheets, depth + 1, budget);

      if (!imported) {
        return null;
      }

      imports.push(imported);
      continue;
    }

    if (/@import/i.test(rule)) {
      return null;
    }

    localRules.push(rule);
  }

  const sanitized = sanitizeStylesheet(localRules.join(''), undefined, true, true, resourceBaseUrl);

  return sanitized.rejected ? null : `${imports.join('')}${sanitized.css}`;
}

async function boundedResponseText(response: Response, budget: RemoteStylesheetBudget): Promise<string | null> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);

  if (Number.isSafeInteger(declaredLength) && declaredLength > budget.bytes) {
    return null;
  }

  const body = response.body;

  if (!body) {
    return null;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        return `${text}${decoder.decode()}`;
      }

      if (value.byteLength > budget.bytes) {
        await reader.cancel();
        return null;
      }

      budget.bytes -= value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}

function filterAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    if (!allowedAttributes.has(attribute.name)) {
      element.removeAttribute(attribute.name);
    }
  }
}

function sanitizeInlineStyle(
  style: string,
  cidImages: ReadonlyMap<string, CIDImage> | undefined,
  allowDataImages: boolean,
  allowRemoteUrls: boolean,
): SanitizedInlineStyle {
  const declarations = splitCssDeclarations(style);
  const local: string[] = [];
  const full: string[] = [];
  let hasResource = false;

  for (const declaration of declarations) {
    const sanitized = sanitizeCssFragment(declaration, cidImages, allowDataImages, allowRemoteUrls);

    if (!sanitized?.css) {
      continue;
    }

    full.push(sanitized.css);

    if (sanitized.hasResource) {
      hasResource = true;
    } else {
      local.push(sanitized.css);
    }
  }

  return { local: local.join('; '), full: full.join('; '), hasResource };
}

function withLegacyFontFamily(style: SanitizedInlineStyle, face: string | null): SanitizedInlineStyle {
  if (!face) {
    return style;
  }

  const legacyFont = document.createElement('span');
  legacyFont.style.fontFamily = face;
  const fontFamily = legacyFont.style.fontFamily;

  if (!fontFamily) {
    return style;
  }

  return {
    ...style,
    local: addFontFamily(style.local, fontFamily),
    full: addFontFamily(style.full, fontFamily),
  };
}

function addFontFamily(style: string, fontFamily: string): string {
  const element = document.createElement('span');
  element.style.cssText = style;

  if (!element.style.fontFamily) {
    element.style.fontFamily = fontFamily;
  }

  return element.style.cssText;
}

function sanitizeStylesheet(
  stylesheet: string,
  cidImages: ReadonlyMap<string, CIDImage> | undefined,
  allowDataImages: boolean,
  allowRemoteUrls: boolean,
  resourceBaseUrl?: string,
): SanitizedCss {
  const rules: string[] = [];
  let hasResource = false;

  const sourceRules = splitCssRules(normalizeCss(stylesheet));

  if (!sourceRules) {
    return { css: '', hasResource: false, rejected: true };
  }

  for (const rule of sourceRules) {
    const sanitized = sanitizeCssFragment(rule, cidImages, allowDataImages, allowRemoteUrls, resourceBaseUrl);

    if (!sanitized?.css) {
      return { css: '', hasResource: false, rejected: true };
    }

    rules.push(sanitized.css);
    hasResource ||= sanitized.hasResource;
  }

  return { css: rules.join(''), hasResource, rejected: false };
}

function sanitizeCssFragment(
  fragment: string,
  cidImages: ReadonlyMap<string, CIDImage> | undefined,
  allowDataImages: boolean,
  allowRemoteUrls: boolean,
  resourceBaseUrl?: string,
): SanitizedCss | null {
  const normalized = normalizeCss(fragment).trim();

  if (!normalized || /[<>]/.test(normalized) || unsafeStyleValue.test(normalized)) {
    return null;
  }

  const importRule = sanitizeCssImport(normalized, allowRemoteUrls);

  if (importRule) {
    return importRule;
  }

  if (/@import/i.test(normalized)) {
    return null;
  }

  let hasResource = false;
  let valid = true;
  const css = normalized.replace(cssUrl, (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
    const source = (doubleQuoted ?? singleQuoted ?? bare ?? '').trim();
    const remoteUrl = stylesheetResourceUrl(source, resourceBaseUrl);

    if (remoteUrl) {
      if (!allowRemoteUrls) {
        valid = false;
        return '';
      }

      hasResource = true;
      return `url("${remoteUrl.href}")`;
    }

    const cidImage = cidImages?.get(normalizeCidReference(source));
    const cidDataUrl = cidImage ? cidImageDataUrl(cidImage) : null;

    if (cidDataUrl) {
      return `url("${cidDataUrl}")`;
    }

    const dataImage = allowDataImages ? validatedDataImageUrl(source) : null;

    if (dataImage) {
      return `url("${dataImage}")`;
    }

    valid = false;
    return '';
  });

  return valid ? { css, hasResource, rejected: false } : null;
}

function splitCssDeclarations(style: string): string[] {
  return splitCss(style, ';');
}

function splitCssRules(stylesheet: string): string[] | null {
  const rules: string[] = [];
  let start = 0;
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let quote = '';

  for (let index = 0; index < stylesheet.length; index += 1) {
    const character = stylesheet[index];

    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;

      if (braceDepth < 0) {
        return null;
      }

      if (braceDepth === 0) {
        rules.push(stylesheet.slice(start, index + 1));
        start = index + 1;
      }
    } else if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth -= 1;

      if (parenthesisDepth < 0) {
        return null;
      }
    } else if (character === ';' && braceDepth === 0 && stylesheet.slice(start, index).trimStart().startsWith('@')) {
      rules.push(stylesheet.slice(start, index + 1));
      start = index + 1;
    }
  }

  if (quote || braceDepth !== 0 || parenthesisDepth !== 0) {
    return null;
  }

  const trailing = stylesheet.slice(start).trim();

  if (trailing) {
    return null;
  }

  return rules;
}

function sanitizeCssImport(fragment: string, allowRemoteUrls: boolean): SanitizedCss | null {
  const remoteUrl = importedStylesheetUrl(fragment);

  if (!remoteUrl || !allowRemoteUrls) {
    return null;
  }

  return { css: `@import url("${remoteUrl.href}");`, hasResource: true, rejected: false };
}

function importedStylesheetUrl(fragment: string): URL | null {
  const match = cssImport.exec(fragment);

  if (!match) {
    return null;
  }

  const source = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
  return absoluteHttpsUrl(source);
}

function splitCss(value: string, separator: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === separator && depth === 0) {
      values.push(value.slice(start, index));
      start = index + 1;
    }
  }

  values.push(value.slice(start));
  return values;
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

function sanitizedDocument(html: string, allowPendingMetadata: boolean): Document {
  const source = document.implementation.createHTMLDocument('');
  const sourceTemplate = source.createElement('template');
  const inertStyles = extractSourceStyles(html);
  sourceTemplate.innerHTML = inertStyles.html;
  const presentationElements = new Map<string, Element>(
    inertStyles.styles.map(({ marker, opening, stylesheet }) => {
      const template = source.createElement('template');
      template.innerHTML = opening;
      const style = template.content.querySelector('style') ?? source.createElement('style');
      style.textContent = stylesheet;
      return [marker, style];
    }),
  );

  for (const element of [...sourceTemplate.content.querySelectorAll('link, style')]) {
    const marker = presentationMarker();
    presentationElements.set(marker, element);
    element.replaceWith(source.createTextNode(marker));
  }

  const pendingAttributes = allowPendingMetadata
    ? [
        'data-pending-img-src',
        'data-pending-stylesheet-id',
        'data-pending-style-id',
        'data-pending-inline-style-id',
      ]
    : [];
  const sanitized = DOMPurify.sanitize(sourceTemplate.innerHTML, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: [...allowedAttributes, 'src', 'href', 'rel', ...pendingAttributes],
    ALLOW_DATA_ATTR: allowPendingMetadata,
  });

  // A template keeps presentation elements in the detached body instead of
  // letting the HTML document parser relocate them into its head.
  const detached = document.implementation.createHTMLDocument('');
  const template = detached.createElement('template');
  template.innerHTML = sanitized;
  detached.body.append(template.content);

  const textWalker = detached.createTreeWalker(detached.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let textNode = textWalker.nextNode();

  while (textNode) {
    textNodes.push(textNode as Text);
    textNode = textWalker.nextNode();
  }

  for (const node of textNodes) {
    let remaining = node.data;
    const replacements: Node[] = [];

    while (true) {
      let nextMarker: string | undefined;
      let nextPresentation: Element | undefined;
      let nextIndex = remaining.length;

      for (const [marker, presentation] of presentationElements) {
        const markerIndex = remaining.indexOf(marker);

        if (markerIndex !== -1 && markerIndex < nextIndex) {
          nextMarker = marker;
          nextPresentation = presentation;
          nextIndex = markerIndex;
        }
      }

      if (!nextMarker || !nextPresentation) {
        break;
      }

      if (nextIndex > 0) {
        replacements.push(detached.createTextNode(remaining.slice(0, nextIndex)));
      }

      replacements.push(restoredPresentationElement(detached, nextPresentation, allowPendingMetadata, pendingAttributes));
      remaining = remaining.slice(nextIndex + nextMarker.length);
    }

    if (replacements.length === 0) {
      continue;
    }

    if (remaining) {
      replacements.push(detached.createTextNode(remaining));
    }

    node.replaceWith(...replacements);
  }

  return detached;
}

function sourceBodyPresentation(html: string): { style: string; face: string | null } {
  const source = new DOMParser().parseFromString(html, 'text/html');

  return {
    style: source.body.getAttribute('style') ?? '',
    face: source.body.getAttribute('face'),
  };
}

function extractSourceStyles(
  html: string,
): { html: string; styles: Array<{ marker: string; opening: string; stylesheet: string }> } {
  const styles: Array<{ marker: string; opening: string; stylesheet: string }> = [];
  let output = '';
  let position = 0;

  while (true) {
    const opening = /<style\b/gi;
    opening.lastIndex = position;
    const match = opening.exec(html);

    if (!match || match.index === undefined) {
      return { html: `${output}${html.slice(position)}`, styles };
    }

    const openingEnd = tagEnd(html, opening.lastIndex);

    if (openingEnd === null) {
      return { html: `${output}${html.slice(position)}`, styles };
    }

    const closing = styleClosingTag(html, openingEnd + 1);
    const marker = presentationMarker();
    const stylesheet = html.slice(openingEnd + 1, closing?.start ?? html.length);
    styles.push({ marker, opening: html.slice(match.index, openingEnd + 1), stylesheet });
    output += `${html.slice(position, match.index)}${marker}`;
    position = closing?.end ?? html.length;

    if (!closing) {
      return { html: output, styles };
    }
  }
}

function tagEnd(source: string, position: number): number | null {
  let quote = '';

  for (let index = position; index < source.length; index += 1) {
    const character = source[index];

    if (quote) {
      if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }

  return null;
}

function styleClosingTag(source: string, position: number): { start: number; end: number } | null {
  let quote = '';
  let comment = false;

  for (let index = position; index < source.length; index += 1) {
    const character = source[index];

    if (comment) {
      if (character === '*' && source[index + 1] === '/') {
        comment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      comment = true;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    const closing = /^<\/style(?:\s[^>]*)?>/i.exec(source.slice(index));

    if (closing) {
      return { start: index, end: index + closing[0].length };
    }
  }

  return null;
}

function presentationMarker(): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return `preview-presentation-${values[0]?.toString(36)}-${values[1]?.toString(36)}`;
}

function copyAttribute(source: Element, target: Element, name: string): void {
  const value = source.getAttribute(name);

  if (value !== null) {
    target.setAttribute(name, value);
  }
}

function restoredPresentationElement(
  document: Document,
  presentation: Element,
  allowPendingMetadata: boolean,
  pendingAttributes: readonly string[],
): Element {
  const restored = document.createElement(presentation.localName);

  if (presentation.localName === 'link') {
    copyAttribute(presentation, restored, 'href');
    copyAttribute(presentation, restored, 'rel');
  } else {
    restored.textContent = presentation.textContent;
  }

  if (allowPendingMetadata) {
    for (const attribute of pendingAttributes) {
      copyAttribute(presentation, restored, attribute);
    }
  }

  return restored;
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

function stylesheetResourceUrl(source: string, baseUrl: string | undefined): URL | null {
  const absoluteUrl = absoluteHttpsUrl(source);

  if (absoluteUrl || !baseUrl) {
    return absoluteUrl;
  }

  try {
    const url = new URL(source, baseUrl);

    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function registerRemoteUrl(resources: Map<string, number>, source: string): void {
  resources.set(source, (resources.get(source) ?? 0) + 1);
}

function registeredUrlCount(resources: ReadonlyMap<string, number>): number {
  return [...resources.values()].reduce((count, occurrences) => count + occurrences, 0);
}

function registeredUrlById(
  id: string,
  prefix: string,
  resources: ReadonlyMap<string, number> | undefined,
  restored: Map<string, number>,
): URL | null {
  const index = Number.parseInt(id.slice(prefix.length + 1), 10);

  if (!new RegExp(`^${prefix}-\\d+$`).test(id) || !resources || !Number.isSafeInteger(index)) {
    return null;
  }

  let remaining = index;

  for (const [source, occurrences] of resources) {
    if (remaining < occurrences) {
      return trustedRemoteUrl(source, resources, restored);
    }

    remaining -= occurrences;
  }

  return null;
}

function trustedRemoteUrl(
  source: string,
  resources: ReadonlyMap<string, number> | undefined,
  restored: Map<string, number>,
): URL | null {
  const url = absoluteHttpsUrl(source);

  if (!url) {
    return null;
  }

  const allowedCount = resources?.get(url.href) ?? 0;
  const restoredCount = restored.get(url.href) ?? 0;

  if (restoredCount >= allowedCount) {
    return null;
  }

  restored.set(url.href, restoredCount + 1);
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

function cidImageDataUrl(image: CIDImage): string | null {
  const bytes = new Uint8Array(image.bytes);

  if (!hasImageSignature(image.mimeType, bytes)) {
    return null;
  }

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:${image.mimeType};base64,${btoa(binary)}`;
}
