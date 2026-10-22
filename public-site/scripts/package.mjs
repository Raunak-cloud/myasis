import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const target = new URL('../.next/standalone/public-site/.next/static/', import.meta.url);
await mkdir(target, { recursive: true });
await cp(fileURLToPath(new URL('../.next/static/', import.meta.url)), fileURLToPath(target), { recursive: true });
