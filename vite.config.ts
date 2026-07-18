import { defineConfig } from 'vite';

const productionCsp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: https:; font-src https:; connect-src https:; worker-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
const developmentCsp = productionCsp
  .replace('connect-src https:', "connect-src 'self' https: ws: wss:");
const repositoryName =
  process.env.GITHUB_ACTIONS === 'true'
    ? process.env.GITHUB_REPOSITORY?.split('/')[1]
    : undefined;
const base = repositoryName ? `/${repositoryName}/` : '/';

export default defineConfig(({ command }) => ({
  base,
  plugins:
    command === 'serve'
      ? [
          {
            name: 'development-csp',
            transformIndexHtml: (html) => html.replace(productionCsp, developmentCsp),
          },
        ]
      : [],
}));
