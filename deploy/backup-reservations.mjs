import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** SQLite's online backup API takes a coherent snapshot, including live WAL
 * transactions. Never archive a live database by copying its individual files. */
const [source, destination] = process.argv.slice(2);
if (!source || !destination || resolve(source) === resolve(destination)) throw Error('Distinct source and backup staging directories are required.');
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(source, entry.name, 'application-reservations.sqlite');
  if (!existsSync(path)) continue;
  const dir = join(destination, entry.name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const snapshot = join(dir, 'application-reservations.sqlite');
    await backup(db, snapshot);
    await chmod(snapshot, 0o600);
  } finally { db.close(); }
}
