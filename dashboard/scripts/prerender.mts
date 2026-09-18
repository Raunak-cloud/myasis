import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';

/**
 * Bakes the landing page into dist/index.html after `vite build`.
 *
 * The app is a single page that draws itself with JavaScript, which left
 * crawlers and link previews with an empty <div id="root"> and a title. The
 * landing is the one page a visitor can see signed out, so its markup is
 * rendered here once, at build time, and placed inside the root. React
 * replaces it on mount; a crawler, a link unfurler or a browser with
 * scripts off reads it as is. The server drops the block for signed-in
 * visitors, who are about to see the app instead.
 */
const root = resolve(import.meta.dirname, '..');
const vite = await createServer({
  configFile: false,
  root,
  plugins: [react()],
  appType: 'custom',
  server: { middlewareMode: true },
  logLevel: 'error',
});
try {
  const { Landing } = await vite.ssrLoadModule('/src/components/Landing.tsx');
  const markup = renderToStaticMarkup(createElement(Landing, { googleConfigured: true }));
  const file = resolve(root, 'dist', 'index.html');
  const shell = readFileSync(file, 'utf8');
  const empty = '<div id="root"></div>';
  if (!shell.includes(empty)) throw new Error('dist/index.html has no empty root to fill');
  writeFileSync(file, shell.replace(empty, `<div id="root"><!--prerender-->${markup}<!--/prerender--></div>`));
  console.log(`prerendered the landing page into dist/index.html (${Math.round(markup.length / 1024)} KB)`);
} finally {
  await vite.close();
}
