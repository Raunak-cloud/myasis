import { parseHTML } from 'linkedom';
import { GmailMcpClient, GmailRequestTimeoutError, GMAIL_IO_TIMEOUT_MS, safeGmailError, type GmailMessage } from './gmail-mcp-client.js';
import { verificationEmailMatchDecision, readVerificationEmailsLocally, verificationContextWords, type LocalVerificationEmail, type VerificationPurpose, type VerificationEmailMatchReason } from './verification-email-local.js';
import type { PreparedApplication } from './application-review-types.js';
import type { ApplyOutcome } from './types.js';
import { config } from './config.js';
import { applicationAllowance } from './application-allowance.js';
import { verificationMailboxMessageAllowed } from './gmail-verification-policy.js';
import type {VerificationFallback,VerificationValue} from './verification-email-ai.js';

export const gmailAvailable = () => Boolean(process.env.GMAIL_MCP_URL && process.env.GMAIL_MCP_TOKEN && process.env.GMAIL_MCP_ACCOUNT);
export const gmailAccount = () => process.env.GMAIL_MCP_ACCOUNT || '';
function gmailClient(network?: typeof fetch, options?: { signal?: AbortSignal; requestTimeoutMs?: number }) {
  if (!gmailAvailable()) throw new Error('Connect Gmail in Setup before reading verification emails or submitting email applications.');
  return new GmailMcpClient({ url: process.env.GMAIL_MCP_URL!, token: process.env.GMAIL_MCP_TOKEN!, account: gmailAccount() }, network, options);
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
  if (!verificationMailboxMessageAllowed(message)) return false;
  const date = Date.parse(message.date || '');
  return Number.isFinite(date) ? date >= Math.max(earliest, now - VERIFICATION_MAX_AGE_MS) && date <= now + VERIFICATION_CLOCK_SKEW_MS : allowUndated;
}

/** Read recent owner mail for the applying agent. Identity, purpose and which
 * credential to use are the agent's decisions, not string-matching vetoes. */
export async function verificationEmailsForAgent(options: { hint?: string; requestedAt?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<
  { messages: Array<{ email: LocalVerificationEmail; date?: string }> } | { error: string }
> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? GMAIL_IO_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const client = gmailClient(undefined, { signal });
  const earliest = Math.max(Date.now() - VERIFICATION_MAX_AGE_MS, Number.isFinite(options.requestedAt) ? options.requestedAt! - VERIFICATION_CLOCK_SKEW_MS : 0);
  const context = verificationContextWords({ hint: options.hint }).filter(word => word.length <= 100).slice(0, 12);
  const query = `after:${Math.floor(earliest / 1000)} (code OR verify OR verification OR confirm OR confirmation OR activate OR activation OR password OR passcode OR OTP OR "sign in" OR reset)`
    + (context.length ? ` (${context.map(word => `"${word}"`).join(' OR ')})` : '');
  try {
    while (!signal.aborted) {
      const threads = await client.search(query);
      const messages = new Map<string, GmailMessage>();
      for (const thread of threads.slice(0, 5)) {
        for (const message of await client.thread(thread.id)) {
          if (verificationMessageIsFresh(message, earliest, Date.now(), process.env.GMAIL_ACCESS_MODE === 'browser')) messages.set(message.id, message);
        }
      }
      if (messages.size) return { messages: [...messages.values()].sort((a, b) => (Date.parse(b.date || '') || 0) - (Date.parse(a.date || '') || 0))
        .slice(0, 10).map((message, position) => ({ email: verificationMessage(message, position), date: message.date })) };
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); done(); }, 2000);
        const aborted = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted();
      });
    }
    return { error: 'The mailbox wait ended before recent verification messages were found. Inspect the current sign-in page before requesting another email.' };
  } catch (error) {
    return { error: signal.aborted ? 'The verification mailbox read ended or was cancelled. This does not establish that the email never arrived.' : safeGmailError(error).message };
  } finally { await client.close(); }
}
class VerificationPollWindowExpired extends Error {
  constructor() { super('The bounded verification-email polling window ended.'); this.name = 'VerificationPollWindowExpired'; }
}
export interface VerificationPollSummary {
  termination: 'matched' | 'poll-window-expired' | 'request-timeout' | 'request-error' | 'cancelled';
  completedSearches: number; completedReads: number; completedPolls: number;
  lastCompletedCheckAt?: string; finalCheckIncomplete: boolean;
  siteHost?: string; purpose?: VerificationPurpose;
  messageChecks: VerificationMessageChecks;
}
export interface VerificationMessageChecks {
  examinedMessages: number; matchedMessages: number; extractionUnavailableMessages: number;
  rejections: Partial<Record<Exclude<VerificationEmailMatchReason, 'matched'>, number>>;
}
export async function findVerificationInGmail(options: { hint?: string; site?: string; want?: 'code' | 'link' | 'either'; purpose?: VerificationPurpose; allowAlternative?: boolean; timeoutMs?: number; requestTimeoutMs?: number; requestedAt?: number; signal?: AbortSignal; log?: (message: string) => void; fallback?:VerificationFallback } = {}) {
  const timeoutMs = Math.floor(options.timeoutMs ?? 90_000), startedAt = Date.now(), deadline = startedAt + timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { error: 'The verification email wait expired.' };
  if (options.signal?.aborted) return { error: 'The verification email wait was cancelled.' };
  const window = new AbortController();
  const timer = setTimeout(() => window.abort(new VerificationPollWindowExpired()), timeoutMs);
  const lifetime = options.signal ? AbortSignal.any([options.signal, window.signal]) : window.signal;
  let client: GmailMcpClient | undefined;
  let matchingEmailSeen = false;
  let inFlight: { operation: 'search' | 'read'; startedAt: number } | undefined;
  let completedSearches = 0, completedReads = 0, completedPolls = 0;
  let lastCompletedCheckAt: string | undefined, pollInProgress = false;
  // Message IDs stay private and in memory. Repeated thread reads or the same
  // message appearing in several polls do not inflate diagnosis counts.
  const messageDecisions = new Map<string, { reason: VerificationEmailMatchReason; extractionAvailable: boolean }>();
  const messageChecks = (): VerificationMessageChecks => {
    const checks: VerificationMessageChecks = { examinedMessages: messageDecisions.size, matchedMessages: 0, extractionUnavailableMessages: 0, rejections: {} };
    for (const decision of messageDecisions.values()) {
      if (decision.reason === 'matched') { checks.matchedMessages++; if (!decision.extractionAvailable) checks.extractionUnavailableMessages++; }
      else checks.rejections[decision.reason] = (checks.rejections[decision.reason] ?? 0) + 1;
    }
    return checks;
  };
  let siteHost: string | undefined;
  try { if (options.site) siteHost = new URL(options.site.includes('://') ? options.site : `https://${options.site}`).hostname; } catch { /* Never persist arbitrary site text, paths or tokens. */ }
  const checkLifetime = () => {
    if (!lifetime.aborted && Date.now() >= deadline) window.abort(new VerificationPollWindowExpired());
    lifetime.throwIfAborted();
  };
  const summary = (termination: VerificationPollSummary['termination']): VerificationPollSummary => ({ termination, completedSearches, completedReads, completedPolls,
    ...(lastCompletedCheckAt ? { lastCompletedCheckAt } : {}), finalCheckIncomplete: pollInProgress,
    ...(siteHost ? { siteHost } : {}), ...(options.purpose ? { purpose: options.purpose } : {}), messageChecks: messageChecks() });
  // This callback belongs to the owner/run logger. Only bounded operation
  // metadata leaves the private mailbox layer: never queries or mail content.
  const diagnostic = (event: Record<string, string | number | boolean>) => options.log?.(`  [mailbox-diagnostic] ${JSON.stringify(event)}`);
  const request = async <T>(operation: 'search' | 'read', work: () => Promise<T>, counts: (value: T) => Record<string, number>): Promise<T> => {
    const stage = { operation, startedAt: Date.now() };
    inFlight = stage;
    diagnostic({ operation, phase: 'started', elapsedMs: Date.now() - startedAt });
    try {
      const value = await work();
      checkLifetime();
      diagnostic({ operation, phase: 'completed', durationMs: Date.now() - stage.startedAt, ...counts(value) });
      if (operation === 'search') completedSearches++; else completedReads++;
      inFlight = undefined;
      return value;
    } catch (error) {
      diagnostic({ operation, phase: 'interrupted', durationMs: Date.now() - stage.startedAt,
        classification: lifetime.reason instanceof VerificationPollWindowExpired ? 'poll-window-expired'
          : options.signal?.aborted ? 'cancelled' : error instanceof GmailRequestTimeoutError ? 'request-timeout' : 'request-error' });
      throw error;
    }
  };
  const requestTimeout = () => ({
    error: `The Gmail mailbox request timed out while ${inFlight?.operation === 'read' ? 'reading a message' : 'searching for verification mail'}. The mailbox result is incomplete; this does not establish that the email is missing. Retry the mailbox read or inspect its connection before requesting another email.`,
    reason: 'request-timeout' as const, poll: summary('request-timeout'),
  });
  const waitFailure = () => matchingEmailSeen
    ? { error: 'A matching verification email was found in Gmail, but its requested code or link could not be read. Try another supported authentication option or report the message-format problem; resending alone will not repair it.', reason: 'unreadable-message' as const, poll: summary('poll-window-expired') }
    : completedPolls > 0
      ? { error: `No matching verification email was found in ${completedPolls} completed Gmail check(s) as of ${lastCompletedCheckAt}. The bounded wait ended${pollInProgress ? ' before the final check completed' : ''}. This does not establish that the email never arrived or that mailbox access failed.`, reason: 'not-found' as const, poll: summary('poll-window-expired') }
      : { error: 'The verification-email wait ended before a complete Gmail check finished. The mailbox result is unknown; this does not establish a missing email or a mailbox access failure.', reason: 'incomplete-check' as const, poll: summary('poll-window-expired') };
  const examined = new Set<string>();
  // The browser adapter explicitly selects Most recent. Do not assume an API
  // provider's thread ordering; retain the complete timestamp comparison there.
  const orderedBrowserResults = process.env.GMAIL_ACCESS_MODE === 'browser';
  const context = verificationContextWords(options).filter(word => word.length <= 100).slice(0, 12);
  const earliest = Math.max(startedAt - VERIFICATION_MAX_AGE_MS,
    Number.isFinite(options.requestedAt) ? options.requestedAt! - VERIFICATION_CLOCK_SKEW_MS : 0);
  const query = (options.purpose === 'reset_password' ? '(password OR reset OR recovery)' : '(code OR verify OR verification OR confirm OR confirmation OR activate OR activation OR password OR passcode OR OTP OR "sign in")')
    + (context.length ? ` (${context.map(word => `"${word}"`).join(' OR ')})` : '');
  const fallbackExamined = new Set<string>();
  const fallbackResults = new Map<string,VerificationValue|null>();
  const read = async (emails: Array<{ id: string; email: LocalVerificationEmail; message:GmailMessage }>) => {
    for (const { id, email, message } of emails) {
      const decision = verificationEmailMatchDecision(email, options);
      if (decision.matched) matchingEmailSeen = true;
      let found = readVerificationEmailsLocally([email], { hint: options.hint || '', site: options.site || '', purpose: options.purpose, want: options.want || 'either' })
        ?? (options.allowAlternative ? readVerificationEmailsLocally([email], { hint: options.hint || '', site: options.site || '', purpose: options.purpose, want: 'either' }) : null);
      if (!found && decision.matched && options.fallback && !fallbackExamined.has(id) && fallbackExamined.size<2) {
        checkLifetime(); fallbackExamined.add(id);
        diagnostic({operation:'ai-extraction',phase:'started'});
        const candidate=await options.fallback(email,{hint:options.hint,site:options.site,purpose:options.purpose,
          want:options.allowAlternative?'either':options.want??'either'},{deadline,signal:lifetime}).catch(()=>null);
        checkLifetime();
        fallbackResults.set(id,verificationMessageIsFresh(message,earliest,Date.now(),orderedBrowserResults)?candidate:null);
        diagnostic({operation:'ai-extraction',phase:'completed',accepted:Boolean(fallbackResults.get(id))});
      }
      if (!found && decision.matched && verificationMessageIsFresh(message,earliest,Date.now(),orderedBrowserResults)) found=fallbackResults.get(id)??null;
      const previous = messageDecisions.get(id), current = { reason: decision.reason, extractionAvailable: Boolean(found) };
      messageDecisions.set(id, current);
      if (!previous || previous.reason !== current.reason || previous.extractionAvailable !== current.extractionAvailable) {
        const checks = messageChecks();
        diagnostic({ operation: 'match', phase: 'completed', examinedMessages: checks.examinedMessages, matchedMessages: checks.matchedMessages,
          extractionUnavailableMessages: checks.extractionUnavailableMessages,
          ...Object.fromEntries(Object.entries(checks.rejections).map(([reason, count]) => [reason, count!])) });
      }
      if (found) return found;
    }
    return null;
  };
  const report = (found: NonNullable<Awaited<ReturnType<typeof read>>>) => {
    checkLifetime();
    diagnostic({ operation: 'lookup', phase: 'finished', classification: 'matched', completedSearches, completedReads, completedPolls });
    options.log?.(`  Read the verification ${found.kind} through Gmail MCP.`); return { ...found, poll: summary('matched') };
  };
  try {
    client = gmailClient(undefined, { signal: lifetime, requestTimeoutMs: options.requestTimeoutMs });
    while (Date.now() < deadline) {
      checkLifetime(); pollInProgress = true;
      const searchEarliest = Math.max(earliest, Date.now() - VERIFICATION_MAX_AGE_MS);
      const threads = await request('search', () => client!.search(`after:${Math.floor(searchEarliest / 1000)} ${query}`),
        threads => ({ threadCount: threads.length }));
      const messages: GmailMessage[] = [];
      for (const thread of threads.slice(0, 5)) {
        checkLifetime();
        const batch = (await request('read', () => client!.thread(thread.id), messages => ({ messageCount: messages.length })))
          .filter(message => verificationMessageIsFresh(message, earliest, Date.now(), orderedBrowserResults));
        diagnostic({ operation: 'filter', phase: 'completed', freshMessageCount: batch.length });
        messages.push(...batch);
        messages.sort((a, b) => {
          const first = Date.parse(a.date || ''), second = Date.parse(b.date || '');
          return Number.isFinite(first) && Number.isFinite(second) ? second - first : 0;
        });
        const fresh = messages.filter(message => !examined.has(message.id) && verificationMessageIsFresh(message, earliest, Date.now(), orderedBrowserResults)).slice(0, 10);
        for (const message of fresh) {
          const found = await read([{ id: message.id, email: verificationMessage(message, 0), message }]);
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
        const found = await read(fresh.map((message, index) => ({ id: message.id, email: verificationMessage(message, index), message })));
        for (const message of fresh) examined.add(message.id);
        if (found) return report(found);
      }
      checkLifetime(); completedPolls++; lastCompletedCheckAt = new Date(Date.now()).toISOString(); pollInProgress = false;
      await new Promise<void>((done, reject) => {
        const cleanup = () => { clearTimeout(timer); lifetime.removeEventListener('abort', aborted); };
        const aborted = () => { cleanup(); reject(lifetime.reason); };
        const timer = setTimeout(() => { cleanup(); done(); }, Math.min(2000, Math.max(0, deadline - Date.now())));
        lifetime.addEventListener('abort', aborted, { once: true });
        if (lifetime.aborted) aborted();
      });
    }
    const failure = waitFailure();
    diagnostic({ operation: 'lookup', phase: 'finished', classification: failure.reason, completedSearches, completedReads, completedPolls });
    return failure;
  } catch (error) {
    const failure = error instanceof VerificationPollWindowExpired || lifetime.reason instanceof VerificationPollWindowExpired ? waitFailure()
      : options.signal?.aborted ? { error: 'The verification email wait was cancelled.', reason: 'cancelled' as const, poll: summary('cancelled') }
      : error instanceof GmailRequestTimeoutError ? requestTimeout()
      : { error: safeGmailError(error).message, reason: 'request-error' as const, poll: summary('request-error') };
    diagnostic({ operation: 'lookup', phase: 'finished', classification: failure.reason, completedSearches, completedReads, completedPolls });
    return failure;
  }
  finally { clearTimeout(timer); window.abort(new Error('The verification-email lookup ended.')); await client?.close(); }
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
