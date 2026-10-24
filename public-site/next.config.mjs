import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
// Only public pixel identifiers enter client bundles. No backend secrets are exported.
function publicPixel(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(resolve(directory, '../seek-bot/.env'), 'utf8').split(/\r?\n/).find(line => line.startsWith(`${key}=`));
    return (line?.slice(key.length + 1) ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  } catch { return ''; }
}

export default {
  output: 'standalone',
  outputFileTracingRoot: resolve(directory, '..'),
  poweredByHeader: false,
  // Stable metadata delivery for crawlers as well as ordinary browsers.
  htmlLimitedBots: /.*/,
  async redirects() {
    return [
      { source: '/index.html', destination: '/', statusCode: 301 },
      ...['privacy', 'terms', 'automate-job-applications-australia', 'blog'].map(path => ({ source: `/${path}.html`, destination: `/${path}`, statusCode: 301 })),
    ];
  },
  webpack(config, { webpack }) {
    config.resolve.modules.push(resolve(directory, 'node_modules'));
    // Shared TypeScript uses runtime .js imports; resolve its source when bundling.
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.js', '.ts', '.tsx'] };
    config.plugins.push(new webpack.DefinePlugin({
      __REDDIT_PIXEL_ID__: JSON.stringify(publicPixel('REDDIT_PIXEL_ID')),
      __META_PIXEL_ID__: JSON.stringify(publicPixel('META_PIXEL_ID')),
    }));
    return config;
  },
};
