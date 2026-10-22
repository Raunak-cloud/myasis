import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
process.env.HOSTNAME = '127.0.0.1';
process.env.PORT ||= '5191';
const release = new URL('../.current/public-site/server.js', import.meta.url);
const built = new URL('../.next/standalone/public-site/server.js', import.meta.url);
await import(pathToFileURL(realpathSync(fileURLToPath(process.env.PUBLIC_SITE_USE_BUILD !== '1' && existsSync(release) ? release : built))).href);
