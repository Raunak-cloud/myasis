import { getPool, migrate } from '../server/db/index.js';

try {
  const result = await migrate();
  if (!result.ok) throw new Error(result.error ?? 'Database migration failed.');
  console.log('Database schema applied.');
} finally {
  await getPool().end();
}
