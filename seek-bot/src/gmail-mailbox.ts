import { parseHTML } from 'linkedom';
import { GmailMcpClient, safeGmailError, type GmailMessage } from './gmail-mcp-client.js';
import { readVerificationEmailsLocally, verificationContextWords, type LocalVerificationEmail } from './verification-email-local.js';
import type { PreparedApplication } from './application-review-types.js';
import type { ApplyOutcome } from './types.js';
import { config } from './config.js';
import { applicationAllowance } from './application-allowance.js';

export const gmailAvailable = () => Boolean(process.env.GMAIL_MCP_URL && process.env.GMAIL_MCP_TOKEN && process.env.GMAIL_MCP_ACCOUNT);
export const gmailAccount = () => process.env.GMAIL_MCP_ACCOUNT || '';
function gmailClient(network?: typeof fetch) {
  if (!gmailAvailable()) throw new Error('Connect Gmail in Setup before reading verification emails or submitting email applications.');
  return new GmailMcpClient({ url: process.env.GMAIL_MCP_URL!, token: process.env.GMAIL_MCP_TOKEN!, account: gmailAccount() }, network);
}
export function verificationMessage(message: GmailMessage, position: number): LocalVerificationEmail {
  const document = parseHTML(`<html><body>${message.htmlBody || ''}</body></html>`).document;
  for (const node of document.querySelectorAll('script,style')) node.remove();
  // HTML-only messages have no rendered innerText. Preserve structural breaks
  // so a code in its own paragraph/cell cannot merge with the following word.
  for (const node of document.querySelectorAll('br,p,div,li,tr,td,th,table,h1,h2,h3,h4,h5,h6,section,article,header,footer,blockquote,pre,hr')) {
    node.before(document.createTextNode('\n'));
    node.after(document.createTextNode('\n'));
  }
  const text = (message.plaintextBody || document.body?.textContent || message.snippet || '').slice(0, 12_000);
  const links: Array<{ text: string; url: string }> = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    try {
      let url = new URL(anchor.getAttribute('href') || '');
      if (url.hostname.endsWith('.google.com') && url.pathname === '/url' && url.searchParams.get('q')) url = new URL(url.searchParams.get('q')!);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const text = (anchor.textContent || '').slice(0, 120), existing = links.find(link => link.url === url.href);
        if (existing) existing.text = `${existing.text} ${text}`.slice(0, 240);
        else links.push({ text, url: url.href });
      }
    } catch { /* Relative and malformed email links are not verification targets. */ }
  }
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try { const url = new URL(match[0]); if (!url.username && !url.password && !links.some(link => link.url === url.href)) links.push({ text: 'Link in email', url: url.href }); } catch {}
  }
  return { position, subject: message.subject || '', sender: message.sender || '', text, links: links.slice(0, 40) };
}
const VERIFICATION_MAX_AGE_MS = 15 * 60_000;
const VERIFICATION_CLOCK_SKEW_MS = 2 * 60_000;
export function verificationMessageIsFresh(message: GmailMessage, earliest: number, now = Date.now(), allowUndated = false) {
  if (message.labelIds?.some(label => ['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(label))) return false;
  const date = Date.parse(message.date || '');
  return Number.isFinite(date) ? date >= Math.max(earliest, now - VERIFICATION_MAX_AGE_MS) && date <= now + VERIFICATION_CLOCK_SKEW_MS : allowUndated;
}
export async function findVerificationInGmail(options: { hint?: string; site?: string; want?: 'code' | 'link' | 'either'; allowAlternative?: boolean; timeoutMs?: number; requestedAt?: number; signal?: AbortSignal; log?: (message: string) => void } = {}) {
  const timeoutMs = Math.floor(options.timeoutMs ?? 90_000), startedAt = Date.now(), deadline = startedAt + timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { error: 'The verification email wait expired.' };
  if (options.signal?.aborted) return { error: 'The verification email wait was cancelled.' };
  const lifetime = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const network: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime });
  let client: GmailMcpClient | undefined;
  const examined = new Set<string>();
  // The browser adapter explicitly selects Most recent. Do not assume an API
  // provider's thread ordering; retain the complete timestamp comparison there.
  const orderedBrowserResults = process.env.GMAIL_ACCESS_MODE === 'browser';
  const context = verificationContextWords(options).filter(word => word.length <= 100).slice(0, 12);
  const earliest = Math.max(startedAt - VERIFICATION_MAX_AGE_MS,
    Number.isFinite(options.requestedAt) ? options.requestedAt! - VERIFICATION_CLOCK_SKEW_MS : 0);
  const query = '(code OR verify OR verification OR confirm OR activation OR password OR passcode OR OTP OR "sign in")'
    + (context.length ? ` (${context.map(word => `"${word}"`).join(' OR ')})` : '');
  const read = (emails: LocalVerificationEmail[]) => {
    for (const email of emails) {
      const found = readVerificationEmailsLocally([email], { hint: options.hint || '', site: options.site || '', want: options.want || 'either' })
        ?? (options.allowAlternative ? readVerificationEmailsLocally([email], { hint: options.hint || '', site: options.site || '', want: 'either' }) : null);
      if (found) return found;
    }
    return null;
  };
  const report = (found: NonNullable<ReturnType<typeof readVerificationEmailsLocally>>) => {
    lifetime.throwIfAborted();
    options.log?.(`  Read the verification ${found.kind} through Gmail MCP.`); return found;
  };
  try {
    client = gmailClient(network);
    while (Date.now() < deadline) {
      lifetime.throwIfAborted();
      const searchEarliest = Math.max(earliest, Date.now() - VERIFICATION_MAX_AGE_MS);
      const threads = await client.search(`after:${Math.floor(searchEarliest / 1000)} ${query}`);
      const messages: GmailMessage[] = [];
      for (const thread of threads.slice(0, 5)) {
        if (Date.now() >= deadline) break;
        const batch = (await client.thread(thread.id)).filter(message => verificationMessageIsFresh(message, earliest, Date.now(), orderedBrowserResults));
        messages.push(...batch);
        messages.sort((a, b) => {
          const first = Date.parse(a.date || ''), second = Date.parse(b.date || '');
          return Number.isFinite(first) && Number.isFinite(second) ? second - first : 0;
        });
        const fresh = messages.filter(message => !examined.has(message.id) && verificationMessageIsFresh(message, earliest, Date.now(), orderedBrowserResults)).slice(0, 10);
        for (const message of fresh) {
          const found = read([verificationMessage(message, 0)]);
          if (!found) continue;
          const foundAt = Date.parse(message.date || ''), batchDates = batch.map(item => Date.parse(item.date || ''));
          // Search is newest-thread first. Stop only when this match reaches
          // the timestamp frontier, or the browser supplied its single latest
          // message without a timestamp. A new reply above an older code must
          // not hide a newer code in the following thread.
          if (orderedBrowserResults && batchDates.length && batchDates.every(Number.isFinite) && Number.isFinite(foundAt)
            && foundAt >= Math.max(...batchDates)) return report(found);
          if (orderedBrowserResults && batch.length === 1 && message === batch[0] && !Number.isFinite(batchDates[0])) return report(found);
          break;
        }
      }
      const fresh = messages.filter(message => !examined.has(message.id) && verificationMessageIsFresh(message, earliest, Date.now(), orderedBrowserResults)).slice(0, 10);
      if (fresh.length) {
        const found = read(fresh.map(verificationMessage));
        for (const message of fresh) examined.add(message.id);
        if (found) return report(found);
      }
      await new Promise<void>((done, reject) => {
        const cleanup = () => { clearTimeout(timer); lifetime.removeEventListener('abort', aborted); };
        const aborted = () => { cleanup(); reject(lifetime.reason); };
        const timer = setTimeout(() => { cleanup(); done(); }, Math.min(2000, Math.max(0, deadline - Date.now())));
        lifetime.addEventListener('abort', aborted, { once: true });
        if (lifetime.aborted) aborted();
      });
    }
    return { error: 'No matching verification email arrived through Gmail MCP within the wait.' };
  } catch (error) { return { error: lifetime.aborted
    ? options.signal?.aborted ? 'The verification email wait was cancelled.' : 'No matching verification email arrived through Gmail MCP within the wait.'
    : safeGmailError(error).message }; }
  finally { await client?.close(); }
}
export async function findCodeInGmail(options: { hint?: string; timeoutMs?: number; log?: (message: string) => void } = {}) {
  const found = await findVerificationInGmail({ ...options, site: options.hint, want: 'code' });
  if ('error' in found) return found;
  return found.kind === 'code' ? { code: found.value, subject: found.subject } : { error: 'The email carries a link rather than a code.' };
}
export async function submitApprovedEmail(draft: PreparedApplication): Promise<ApplyOutcome> {
  if (config.dryRun) return { status: 'rehearsed', jobId: draft.job.id, answers: draft.answers, stoppedAt: 'Approved email inspected; dry-run does not send email.' };
  if (!await applicationAllowance(true)) return { status: 'skipped', jobId: draft.job.id, reason: 'The account application allowance has been reached.' };
  if (!gmailAvailable()) return { status: 'needs-human', jobId: draft.job.id, url: draft.job.url, reason: 'Connect Gmail in Setup, then retry this approved email application.' };
  const client = gmailClient();
  try {
    const receipt = await client.sendApproved(draft.id, draft.revision);
    console.log(`  Gmail ${process.env.GMAIL_ACCESS_MODE === 'browser' ? 'browser' : 'MCP'} confirmed the application email${receipt.alreadySent ? ' (already sent; no duplicate)' : ''}.`);
    return { status: 'applied', jobId: draft.job.id, at: new Date().toISOString(), submitPressed: true,
      coverLetter: draft.coverLetter, answers: draft.answers, resume: draft.resume, site: draft.email?.to.split('@')[1] };
  } catch (error) { return { status: 'needs-human', jobId: draft.job.id, url: draft.job.url, reason: safeGmailError(error).message }; }
  finally { await client.close(); }
}
