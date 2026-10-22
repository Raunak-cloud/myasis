import { parseHTML } from 'linkedom';
import { GmailMcpClient, safeGmailError, type GmailMessage } from './gmail-mcp-client.js';
import { readVerificationEmails, type VerificationEmail } from './llm.js';
import type { PreparedApplication } from './application-review-types.js';
import type { ApplyOutcome } from './types.js';
import { config } from './config.js';
import { applicationAllowance } from './application-allowance.js';

export const gmailAvailable = () => Boolean(process.env.GMAIL_MCP_URL && process.env.GMAIL_MCP_TOKEN && process.env.GMAIL_MCP_ACCOUNT);
export const gmailAccount = () => process.env.GMAIL_MCP_ACCOUNT || '';
export function gmailClient(network?: typeof fetch) {
  if (!gmailAvailable()) throw new Error('Connect Gmail in Setup before reading verification emails or submitting email applications.');
  return new GmailMcpClient({ url: process.env.GMAIL_MCP_URL!, token: process.env.GMAIL_MCP_TOKEN!, account: gmailAccount() }, network);
}
export function verificationMessage(message: GmailMessage, position: number): VerificationEmail {
  const document = parseHTML(`<html><body>${message.htmlBody || ''}</body></html>`).document;
  for (const node of document.querySelectorAll('script,style')) node.remove();
  const text = (message.plaintextBody || document.body?.textContent || message.snippet || '').slice(0, 12_000);
  const links: Array<{ text: string; url: string }> = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    try {
      let url = new URL(anchor.getAttribute('href') || '');
      if (url.hostname.endsWith('.google.com') && url.pathname === '/url' && url.searchParams.get('q')) url = new URL(url.searchParams.get('q')!);
      if (url.protocol === 'https:' && !url.username && !url.password) links.push({ text: (anchor.textContent || '').slice(0, 120), url: url.href });
    } catch { /* Relative and malformed email links are not verification targets. */ }
  }
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try { const url = new URL(match[0]); if (!url.username && !url.password && !links.some(link => link.url === url.href)) links.push({ text: 'Link in email', url: url.href }); } catch {}
  }
  return { position, subject: message.subject || '', text, links: links.slice(0, 40) };
}
export async function findVerificationInGmail(options: { hint?: string; site?: string; want?: 'code' | 'link' | 'either'; timeoutMs?: number; log?: (message: string) => void } = {}) {
  const timeoutMs = options.timeoutMs ?? 90_000, deadline = Date.now() + timeoutMs;
  const lifetime = AbortSignal.timeout(timeoutMs);
  const network: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime });
  const client = gmailClient(network), examined = new Set<string>();
  try {
    while (Date.now() < deadline) {
      const threads = await client.search('(code OR verify OR verification OR confirm OR activation OR password OR passcode OR OTP OR "sign in")');
      const messages: GmailMessage[] = [];
      for (const thread of threads.slice(0, 5)) {
        if (Date.now() >= deadline) break;
        messages.push(...await client.thread(thread.id));
      }
      messages.sort((a, b) => Date.parse(b.date || '') - Date.parse(a.date || ''));
      const fresh = messages.filter(message => !examined.has(message.id)).slice(0, 10);
      if (fresh.length) {
        const found = await readVerificationEmails(fresh.map(verificationMessage), { hint: options.hint || '', site: options.site || '', want: options.want || 'either', deadline });
        for (const message of fresh) examined.add(message.id);
        if (found) { options.log?.(`  Read the verification ${found.kind} through Gmail MCP.`); return found; }
      }
      await new Promise(done => setTimeout(done, Math.min(2000, Math.max(0, deadline - Date.now()))));
    }
    return { error: 'No matching verification email arrived through Gmail MCP within the wait.' };
  } catch (error) { return { error: safeGmailError(error).message }; }
  finally { await client.close(); }
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
    console.log(`  Gmail MCP confirmed the application email${receipt.alreadySent ? ' (already sent; no duplicate)' : ''}.`);
    return { status: 'applied', jobId: draft.job.id, at: new Date().toISOString(), submitPressed: true,
      coverLetter: draft.coverLetter, answers: draft.answers, resume: draft.resume, site: draft.email?.to.split('@')[1] };
  } catch (error) { return { status: 'needs-human', jobId: draft.job.id, url: draft.job.url, reason: safeGmailError(error).message }; }
  finally { await client.close(); }
}
