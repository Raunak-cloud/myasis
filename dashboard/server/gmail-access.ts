import { one, query } from './db/index.js';
import { isAdmin } from './admin-access.js';
import { readEnv } from './runner.js';
import { chromeGoogleAccounts } from './chrome-accounts.js';
import { gmailConnection } from './gmail-connection.js';
import { upsertSettingRow } from './db/records.js';
import { accountUnavailable } from './account-lifecycle.js';

export type GmailProvider = 'browser' | 'mcp';
export function browserGmailStatus(account: string | null, accounts: string[], consent?: string) {
  const saved = accounts.map(email => email.trim().toLowerCase());
  const matched = Boolean(account && saved.includes(account));
  const connected = matched && consent === account;
  const error = !account ? 'Save your profile email before connecting Gmail.'
    : !matched && saved.length ? `Your profile uses ${account}, but this browser is signed in as ${saved.join(', ')}. Connect your profile Gmail address or update your profile email.`
    : matched && consent !== account ? `Connect browser Gmail to allow mailbox access for ${account}.`
    : !matched ? `Sign in to ${account} in your private browser, then connect browser Gmail.`
    : null;
  return { connected, account: matched ? account : null, configured: true, error };
}
export function browserGmailUrl(account: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account.trim().toLowerCase())}`;
}
export function gmailProviderPolicy(admin: boolean, publicEnabled: boolean, preferred?: string): { provider: GmailProvider; providers: GmailProvider[] } {
  const providers: GmailProvider[] = admin ? ['browser', 'mcp'] : publicEnabled ? ['mcp'] : ['browser'];
  return { providers, provider: providers.includes(preferred as GmailProvider) ? preferred as GmailProvider : providers.at(-1)! };
}
export async function gmailAccess(userId: string) {
  const owner = await one<{ email: string; profile_email: string }>('SELECT u.email,p.email AS profile_email FROM users u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.blocked_at IS NULL', [userId]);
  const saved = await query<{ key: string; value: string }>("SELECT key,value FROM settings WHERE user_id=$1 AND key IN ('GMAIL_PROVIDER','GMAIL_BROWSER_CONSENT')", [userId]);
  const settings = Object.fromEntries(saved.map(row => [row.key, row.value]));
  const publicEnabled = ({ ...readEnv(), ...process.env }).GMAIL_MCP_PUBLIC_ENABLED === 'true';
  const admin = Boolean(owner && isAdmin(owner.email));
  const policy = gmailProviderPolicy(admin, publicEnabled, settings.GMAIL_PROVIDER || 'browser');
  const account = owner?.profile_email?.trim().toLowerCase() || null;
  const browser = browserGmailStatus(account, chromeGoogleAccounts(userId), settings.GMAIL_BROWSER_CONSENT);
  const mcp = policy.providers.includes('mcp') ? await gmailConnection(userId) : null;
  const selected = policy.provider === 'mcp' ? mcp! : browser;
  return { ...selected, connected: Boolean(owner && !accountUnavailable(userId) && selected.connected), ...policy, admin, publicEnabled, browser, mcp };
}
export async function selectGmailProvider(userId: string, provider: unknown) {
  const access = await gmailAccess(userId);
  if (!access.providers.includes(provider as GmailProvider)) throw new Error('That Gmail connection method is not available for this account.');
  await upsertSettingRow(userId, 'GMAIL_PROVIDER', provider as string);
}
export async function allowBrowserGmail(userId: string) {
  const access = await gmailAccess(userId);
  if (!access.providers.includes('browser')) throw new Error('Browser Gmail is not available for this account.');
  const owner = await one<{ email: string }>('SELECT email FROM profiles WHERE user_id=$1', [userId]);
  if (!owner?.email) throw new Error('Save your profile email before connecting Gmail.');
  // Explicit consent is separate from a Chrome Google SSO session.
  await upsertSettingRow(userId, 'GMAIL_BROWSER_CONSENT', owner.email.trim().toLowerCase());
  await upsertSettingRow(userId, 'GMAIL_PROVIDER', 'browser');
}
export async function disableBrowserGmail(userId: string) {
  await query("DELETE FROM settings WHERE user_id=$1 AND key='GMAIL_BROWSER_CONSENT'", [userId]);
}
