import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { brightDataBrowserEndpoint, employerBrowserProvider } from './employer-browser-config.js';
import { LIVE_VIEW_REQUEST_FILE, REMOTE_PREVIEW_FILE, type RemoteBrowserPreview } from './remote-browser-preview.js';
import { countHealth } from './run-health.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { hasCaptchaSurface } from './captcha/detect.js';
import { captchaRequestWithin, retryCaptchaSolve } from './captcha/retry.js';

interface RemoteSession {
  browser: Browser;
  page: Page;
  sessionId: string;
  timer: ReturnType<typeof setInterval>;
  publishing: boolean;
  closed: boolean;
}
const remoteSessions = new WeakMap<BrowserContext, RemoteSession>();
const previewFile = () => resolve(config.dataDir, REMOTE_PREVIEW_FILE);
// Bright Data otherwise submits a form after solving. Owtomate owns that decision.
const captchaOptions = [{ type: 'hcaptcha', submit_form: false }, { type: 'usercaptcha', submit_form: false }];

export const applicationBrowserName = (page: Page) => remoteSessions.has(page.context()) ? 'brightdata' : 'local';
/** CDP's file-path command addresses the browser's filesystem, not the worker's. */
export async function applicationUpload(page: Page, file: string): Promise<string | { name: string; mimeType: string; buffer: Buffer }> {
  if (applicationBrowserName(page) === 'local') return file;
  const buffer = await readFile(file);
  if (buffer.length > 50 * 1024 * 1024) throw new Error('The application document is too large for the cloud browser upload.');
  const mimeTypes: Record<string, string> = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword', '.txt': 'text/plain', '.rtf': 'application/rtf' };
  return { name: basename(file), mimeType: mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream', buffer };
}
export function selectRemotePage(page: Page): boolean {
  const remote = remoteSessions.get(page.context());
  if (!remote) return false;
  remote.page = page;
  return true;
}

function writePreview(frame: RemoteBrowserPreview): void {
  mkdirSync(config.dataDir, { recursive: true });
  const temporary = `${previewFile()}.${frame.sessionId}.tmp`;
  writeFileSync(temporary, JSON.stringify(frame), { mode: 0o600 });
  renameSync(temporary, previewFile());
}

async function publish(remote: RemoteSession): Promise<void> {
  if (remote.closed || remote.publishing) return;
  remote.publishing = true;
  try {
    const url = new URL(remote.page.url());
    // Navigation tokens and candidate-specific query strings are not needed by the viewer.
    const pageUrl = url.protocol === 'about:' ? remote.page.url() : url.origin;
    let wanted = false;
    try {
      const request = JSON.parse(readFileSync(resolve(config.dataDir, LIVE_VIEW_REQUEST_FILE), 'utf8'));
      wanted = Number.isFinite(request.at) && Date.now() - request.at < 6_000;
    } catch { /* No viewer: no paid screenshot traffic. */ }
    const data = wanted && pageUrl !== 'about:blank'
      ? await remote.page.screenshot({ type: 'jpeg', quality: 82, timeout: 5_000 }).then(bytes => bytes.toString('base64')).catch(() => null)
      : null;
    if (!remote.closed) writePreview({ sessionId: remote.sessionId, provider: 'brightdata', at: Date.now(), url: pageUrl, data });
  } catch { /* The run remains usable if the browser picture is temporarily unavailable. */ }
  finally { remote.publishing = false; }
}

/** One owned cloud connection per application, never a shared context or copied job-board session. */
export async function openEmployerBrowser(localPage: Page, connect: (endpoint: string, options: { timeout: number }) => Promise<Browser> = chromium.connectOverCDP.bind(chromium)): Promise<{ page: Page; close: () => Promise<void> }> {
  if (employerBrowserProvider(process.env) === 'local') return { page: localPage, close: async () => {} };
  const endpoint = brightDataBrowserEndpoint(process.env);
  let browser: Browser | undefined;
  try {
    browser = await connect(endpoint, { timeout: 45_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Missing private browser context');
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    const control = await context.newCDPSession(page);
    try {
      await control.send('Captcha.setAutoSolve' as never, { autoSolve: true, options: captchaOptions } as never);
    } finally { await control.detach().catch(() => {}); }
    // Only the provider's solver handles this context. CapMonster never receives it.
    const remote: RemoteSession = { browser, page, sessionId: randomUUID(), timer: undefined!, publishing: false, closed: false };
    remoteSessions.set(context, remote);
    remote.timer = setInterval(() => void publish(remote), 2_000);
    remote.timer.unref();
    await publish(remote);
    console.log('  Browser: Bright Data administrator pilot · a fresh session for this application');
    return { page, close: async () => {
      remote.closed = true;
      clearInterval(remote.timer);
      remoteSessions.delete(context);
      try {
        if (existsSync(previewFile()) && JSON.parse(readFileSync(previewFile(), 'utf8')).sessionId === remote.sessionId) unlinkSync(previewFile());
      } catch { /* A later session owns its own picture. */ }
      await remote.browser.close().catch(() => {});
    } };
  } catch {
    await browser?.close().catch(() => {});
    // CDP errors include the connection URL, including its password. Never log that URL.
    throw new Error('Bright Data browser connection failed. Check the Browser API zone credentials and account access.');
  }
}

/** Called at the shared CAPTCHA boundary, before any AI-selected interaction. */
export async function solveRemoteCaptcha(page: Page): Promise<boolean> {
  let session: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  try {
    session = await page.context().newCDPSession(page);
    // Own the retry sequence instead of racing the provider's background solver.
    // Keep it manual afterwards: a failed batch must not start an unbounded auto retry.
    await captchaRequestWithin(() => session!.send('Captcha.setAutoSolve' as never, { autoSolve: false, options: captchaOptions } as never), 15_000);
    const address = page.url();
    const result = await retryCaptchaSolve({
      solve: async () => session!.send('Captcha.solve' as never, { detectTimeout: 30_000, options: captchaOptions } as never) as Promise<{ status?: string }>,
      stillChallenged: async () => !page.isClosed() && page.url() === address && await hasCaptchaSurface(page),
      pause: () => new Promise(done => setTimeout(done, 1_500)),
      onAttempt: (attempt, status) => console.log(`[captcha] Bright Data attempt ${attempt}/3: ${status}.`),
    });
    countHealth(result.status === 'solved' ? 'captchaSolved' : result.status === 'cleared' ? 'captchaSelfCleared' : 'captchaFailed');
    return result.status !== 'failed';
  } catch {
    countHealth('captchaFailed');
    console.warn('[captcha] Bright Data could not complete the verification.');
    return false;
  } finally { await session?.detach().catch(() => {}); }
}
