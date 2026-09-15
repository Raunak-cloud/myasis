import { one, query } from './db/index.js';
import { readEnv } from './runner.js';

/**
 * Employer-site accounts Myasis created or used for a candidate.
 *
 * The password is not stored anywhere. The bot derives a unique one per site
 * and email from SITE_AUTH_SECRET (see seek-bot/src/site-auth.ts), so the
 * dashboard derives it again, with the same code, only when the signed-in
 * owner of a recorded account asks to see it.
 */

export interface SiteAccount {
  site: string;
  email: string;
  createdByMyasis: boolean;
  jobTitle: string | null;
  company: string | null;
  firstUsedAt: string;
  lastUsedAt: string;
}

export async function listSiteAccounts(userId: string): Promise<SiteAccount[]> {
  const rows = await query<{
    site: string;
    email: string;
    created_by_myasis: boolean;
    job_title: string | null;
    company: string | null;
    first_used_at: Date;
    last_used_at: Date;
  }>(
    `SELECT site, email, created_by_myasis, job_title, company, first_used_at, last_used_at
       FROM site_accounts WHERE user_id = $1 ORDER BY last_used_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    site: row.site,
    email: row.email,
    createdByMyasis: row.created_by_myasis,
    jobTitle: row.job_title,
    company: row.company,
    firstUsedAt: new Date(row.first_used_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
  }));
}

type SiteAuthModule = { sitePassword: (url: string, email: string, secret?: string) => string | null };

/** The password for one of this account's recorded site accounts, or null when there is no such account. */
export async function sitePasswordFor(userId: string, site: string, email: string): Promise<string | null> {
  const known = await one<{ site: string }>(
    'SELECT site FROM site_accounts WHERE user_id = $1 AND site = $2 AND email = $3',
    [userId, site, email.toLowerCase()],
  );
  if (!known) return null;
  const { sitePassword } = (await import(
    /* @vite-ignore */ new URL('../../seek-bot/dist/site-auth.js', import.meta.url).href
  )) as SiteAuthModule;
  const secret = process.env.SITE_AUTH_SECRET ?? readEnv().SITE_AUTH_SECRET;
  return sitePassword(`https://${site}`, email, secret);
}
