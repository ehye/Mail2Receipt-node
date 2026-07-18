import { renderPreviewBodyStyle, renderPreviewHtml, type PreparedPreview } from './policy';

export function buildPreviewDocument(preview: PreparedPreview, allowRemoteContent: boolean): string {
  const imageSources = allowRemoteContent ? 'data: https:' : 'data:';
  const styleSources = "'unsafe-inline'";
  const fontSources = allowRemoteContent ? 'https:' : "'none'";
  const bodyStyle = renderPreviewBodyStyle(preview, allowRemoteContent);
  const bodyStyleAttribute = bodyStyle ? ` style="${escapeAttribute(bodyStyle)}"` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src ${styleSources}; font-src ${fontSources}; object-src 'none'; base-uri 'none'; form-action 'none'"><style>@page { size: A5 portrait; margin: 10mm; } html,body{margin:0} img{max-width:100%;height:auto}</style></head><body${bodyStyleAttribute}>${renderPreviewHtml(preview, allowRemoteContent)}</body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
