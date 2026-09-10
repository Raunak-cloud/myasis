/**
 * Reads one-time verification codes from the candidate's Gmail.
 *
 * Employer sites (Oracle, Workday, SmartRecruiters, SuccessFactors) gate
 * applications behind "enter the code we just emailed you". The bot cannot
 * read email, so every one of those ended as needs-human — 22 identical
 * clicks on one Oracle form before the step budget ran out.
 *
 * Access is deliberately narrow: the read-only Gmail scope, a refresh token
 * the user granted from the dashboard, and searches limited to recent mail
 * that looks like a code. Nothing is sent, labelled or deleted.
 */

export interface VerificationCode {
  code: string;
  from: string;
  subject: string;
  receivedAt: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export function gmailConfigured(): boolean {
  return Boolean(process.env.GMAIL_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function accessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: process.env.GMAIL_REFRESH_TOKEN ?? '',
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Gmail token refresh returned no access token');
  return json.access_token;
}

async function gmailGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface MessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: MessagePart[];
}

interface Message {
  id: string;
  internalDate?: string;
  payload?: MessagePart & { headers?: Array<{ name: string; value: string }> };
}

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function bodyText(part: MessagePart | undefined): string {
  if (!part) return '';
  const own = part.body?.data ? decode(part.body.data) : '';
  const text = part.mimeType?.startsWith('text/html') ? own.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : own;
  return [text, ...(part.parts ?? []).map(bodyText)].join(' ');
}

/**
 * Pulls the code out of a message. Codes are 4–8 digits, or 6–8 letters and
 * digits, and sit near the word "code" (or "PIN"/"passcode"/"OTP"). Years,
 * phone numbers and order numbers are the usual false matches, so proximity
 * to that word wins over any bare number.
 */
export function extractCode(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`.replace(/\s+/g, ' ');
  const keyword = /(?:code|pin|passcode|otp|one[- ]time)/gi;
  const digitsAfter = /(?:code|pin|passcode|otp|one[- ]time)[^0-9]{0,60}?\b([0-9]{4,8})\b/i.exec(text);
  if (digitsAfter) return digitsAfter[1];
  const digitsBefore = /\b([0-9]{4,8})\b[^0-9]{0,40}(?:is your|verification|code)/i.exec(text);
  if (digitsBefore) return digitsBefore[1];
  // Letter-and-digit codes are case-sensitive: an uppercase run with at least one digit and one letter.
  for (const match of text.matchAll(keyword)) {
    const window = text.slice(match.index + match[0].length, match.index + match[0].length + 80);
    const alnum = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8}\b/.exec(window);
    if (alnum) return alnum[0];
  }
  const subjectOnly = /\b(\d{4,8})\b/.exec(subject);
  return subjectOnly ? subjectOnly[1] : null;
}

/**
 * Waits for a verification email that arrived after `since` and returns its
 * code. `hint` (the site or company name) prefers a matching sender or
 * subject when several code emails are present. Polls because the email is
 * usually still in flight when the page asks for the code.
 */
export async function findVerificationCode(options: {
  since: number;
  hint?: string;
  timeoutMs?: number;
}): Promise<VerificationCode | null> {
  if (!gmailConfigured()) throw new Error('Gmail is not connected for this account.');
  const token = await accessToken();
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  const hint = options.hint?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const query = encodeURIComponent('newer_than:1h (code OR verification OR verify OR passcode OR OTP OR "one-time")');
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    const list = await gmailGet<{ messages?: Array<{ id: string }> }>(token, `/messages?maxResults=10&q=${query}`);
    const candidates: VerificationCode[] = [];
    for (const { id } of list.messages ?? []) {
      if (seen.has(id)) continue;
      const message = await gmailGet<Message>(token, `/messages/${id}?format=full`);
      const receivedMs = Number(message.internalDate ?? 0);
      if (receivedMs && receivedMs < options.since) {
        seen.add(id);
        continue;
      }
      const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      const subject = header('subject');
      const from = header('from');
      const code = extractCode(subject, bodyText(message.payload));
      if (!code) {
        seen.add(id);
        continue;
      }
      candidates.push({ code, from, subject, receivedAt: new Date(receivedMs || Date.now()).toISOString() });
    }
    if (candidates.length) {
      const preferred = hint
        ? candidates.find((c) => `${c.from} ${c.subject}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(hint))
        : undefined;
      return preferred ?? candidates[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}
