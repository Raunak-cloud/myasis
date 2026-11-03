import { getPool, migrate } from '../server/db/index.js';
import { backfillSecurityRetryCooldowns } from '../server/security-retry.js';

try {
  const result = await migrate();
  if (!result.ok) throw new Error(result.error ?? 'Database migration failed.');
  console.log(`Security retry cooldowns initialized: ${await backfillSecurityRetryCooldowns()}.`);
  console.log('Database schema applied.');
} finally {
  await getPool().end();
}
