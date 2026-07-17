import { renderPreviewHtml, type PreparedPreview } from './policy';

export function buildPreviewDocument(preview: PreparedPreview, allowRemoteImages: boolean): string {
  const imageSources = allowRemoteImages ? 'data: https:' : 'data:';

  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>@page { size: A5 portrait; margin: 10mm; } html,body{margin:0} img{max-width:100%;height:auto}</style></head><body>${renderPreviewHtml(preview, allowRemoteImages)}</body></html>`;
}
