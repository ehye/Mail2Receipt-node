// @vitest-environment node

import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, resolveConfig, type ViteDevServer } from 'vite';

describe('development CSP', () => {
  let server: ViteDevServer | undefined;

  afterEach(async () => {
    await server?.close();
    vi.unstubAllEnvs();
  });

  it('permits Vite HMR without weakening the production document', async () => {
    server = await createServer({ server: { middlewareMode: true } });
    const index = await readFile(new URL('./index.html', import.meta.url), 'utf8');
    const developmentHtml = await server.transformIndexHtml('/', index);

    expect(developmentHtml).toContain("connect-src 'self' https: ws: wss:");
    expect(index).toContain("script-src 'self'");
    expect(index).toContain("style-src 'self' 'unsafe-inline'");
    expect(index).toContain("img-src data: https:");
    expect(index).toContain("font-src https:");
    expect(index).toContain('connect-src https:');
    expect(index).toContain("worker-src 'self'");
  });

  it('uses the repository path for GitHub Pages builds', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'ehye/Mail2Receipt-node');

    const config = await resolveConfig({}, 'build', 'production');

    expect(config.base).toBe('/Mail2Receipt-node/');
  });

  it('uses the root path outside GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '');
    vi.stubEnv('GITHUB_REPOSITORY', '');

    const config = await resolveConfig({}, 'build', 'production');

    expect(config.base).toBe('/');
  });
});
