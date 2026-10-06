import { getPool, one } from '../server/db/index.js';
try {
  const exists=await one<{exists:boolean}>("SELECT to_regclass('marketing_jobs') IS NOT NULL AS exists");
  const row=exists?.exists?await one<{n:number}>("SELECT count(*)::int n FROM marketing_jobs WHERE status='running'"):{n:0};
  console.log(row?.n ?? 0);
} catch {console.error('Cannot check active marketing jobs; deployment must wait.');console.log(1);}
finally {await getPool().end();}
