import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'patchright';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { brightDataBrowserEndpoint, employerBrowserProvider } from './employer-browser-config.js';
import { LIVE_VIEW_REQUEST_FILE, remotePreviewFile, type RemoteBrowserPreview } from './remote-browser-preview.js';
import { currentApplicationWorker } from './application-workers.js';
import type { LiveWorkerId } from './live-workers.js';
import { countHealth } from './run-health.js';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { hasCaptchaSurface } from './captcha/detect.js';
import { captchaRequestWithin, retryCaptchaSolve, type CaptchaSolveResult } from './captcha/retry.js';
import { captchaDiagnosticSecrets, safeCaptchaDiagnostic } from './captcha/diagnostics.js';
import { beginCostRequest, recordBrightDataCost } from './cost-ledger.js';

interface RemoteSession {
  browser: Browser;
  page: Page;
  sessionId: string;
  timer: ReturnType<typeof setInterval>;
  publishing: boolean;
  closed: boolean;
  worker: LiveWorkerId;
  providerSessionId?: string;
  captchaControls: Map<Page, Promise<CaptchaControl>>;
}
interface CaptchaControl { session: CDPSession; inFlight?: Promise<boolean>; blocked: boolean; removeListeners: () => void }
const remoteSessions = new WeakMap<BrowserContext, RemoteSession>();
const previewFile = (worker: LiveWorkerId) => resolve(config.dataDir, remotePreviewFile(worker));
// Bright Data otherwise submits a form after solving. Owtomate owns that decision.
const captchaOptions = [{ type: 'hcaptcha', submit_form: false }, { type: 'usercaptcha', submit_form: false }];

function logCaptcha(remote: RemoteSession, page: Page, message: string, details: Record<string, unknown>): void {
  if (remote.closed) return;
  let host = 'unknown';
  try { host = new URL(page.url()).hostname; } catch { /* no URL before navigation */ }
  console.log(`[captcha] Bright Data ${message}. ${JSON.stringify({ sessionId: remote.sessionId, providerSessionId: remote.providerSessionId, host, ...details })}`);
}

/** One retained CDP controller per page, configured before the first navigation. */
function captchaControl(remote: RemoteSession, page: Page): Promise<CaptchaControl> {
  const existing = remote.captchaControls.get(page);
  if (existing) return existing;
  const ready = (async () => {
    const session = await page.context().newCDPSession(page);
    const secrets = captchaDiagnosticSecrets(process.env);
    const listeners = ['Captcha.detected', 'Captcha.waitForSolve', 'Captcha.solveFinished', 'Captcha.solveFailed'].map(event => {
      const listener = (payload: unknown) => logCaptcha(remote, page, `event ${event}`, { event, details: safeCaptchaDiagnostic(payload, secrets) });
      session.on(event as never, listener);
      return { event, listener };
    });
    const removeListeners = () => { for (const { event, listener } of listeners) session.removeListener(event as never, listener); };
    try {
      // Manual ownership from the start: never interrupt an already-running auto solver.
      await captchaRequestWithin(() => session.send('Captcha.setAutoSolve' as never, { autoSolve: false, options: captchaOptions } as never), 15_000);
      if (!remote.providerSessionId) {
        try {
          const result = await captchaRequestWithin(() => session.send('Browser.getSessionId' as never) as Promise<{ sessionId?: string }>, 5_000);
          if (typeof result?.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(result.sessionId)) remote.providerSessionId = result.sessionId;
        } catch (error) {
          // Metadata helps provider support; an unavailable metadata command must not stop an application.
          logCaptcha(remote, page, 'session metadata unavailable', { error: safeCaptchaDiagnostic(error, secrets) });
        }
      }
      return { session, blocked: false, removeListeners };
    } catch (error) {
      removeListeners();
      await captchaRequestWithin(() => session.detach(), 5_000).catch(() => {});
      throw error;
    }
  })();
  remote.captchaControls.set(page, ready);
  return ready;
}

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

function writePreview(frame: RemoteBrowserPreview, worker: LiveWorkerId): void {
  mkdirSync(config.dataDir, { recursive: true });
  const temporary = `${previewFile(worker)}.${frame.sessionId}.tmp`;
  writeFileSync(temporary, JSON.stringify(frame), { mode: 0o600 });
  renameSync(temporary, previewFile(worker));
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
    if (!remote.closed) writePreview({ sessionId: remote.sessionId, provider: 'brightdata', at: Date.now(), url: pageUrl, data }, remote.worker);
  } catch { /* The run remains usable if the browser picture is temporarily unavailable. */ }
  finally { remote.publishing = false; }
}

/** One owned cloud connection per application, never a shared context or copied job-board session. */
export async function openEmployerBrowser(localPage: Page, connect: (endpoint: string, options: { timeout: number }) => Promise<Browser> = chromium.connectOverCDP.bind(chromium)): Promise<{ page: Page; close: () => Promise<void> }> {
  if (employerBrowserProvider(process.env) === 'local') return { page: localPage, close: async () => {} };
  const endpoint = brightDataBrowserEndpoint(process.env);
  const endCostRequest = beginCostRequest('Bright Data');
  let browser: Browser | undefined;
  try {
    browser = await connect(endpoint, { timeout: 45_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Missing private browser context');
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    // Only the provider's solver handles this context. CapMonster never receives it.
    const remote: RemoteSession = { browser, page, sessionId: randomUUID(), worker: currentApplicationWorker(), timer: undefined!, publishing: false, closed: false, captchaControls: new Map() };
    remoteSessions.set(context, remote);
    await captchaControl(remote, page);
    remote.timer = setInterval(() => void publish(remote), 2_000);
    remote.timer.unref();
    await publish(remote);
    console.log('  Browser: Bright Data administrator pilot · a fresh session for this application');
    return { page, close: async () => {
      remote.closed = true;
      clearInterval(remote.timer);
      remoteSessions.delete(context);
      try {
        if (existsSync(previewFile(remote.worker)) && JSON.parse(readFileSync(previewFile(remote.worker), 'utf8')).sessionId === remote.sessionId) unlinkSync(previewFile(remote.worker));
      } catch { /* A later session owns its own picture. */ }
      await Promise.allSettled([...remote.captchaControls.values()].map(async ready => {
        const control = await ready;
        control.removeListeners();
        await captchaRequestWithin(() => control.session.detach(), 5_000).catch(() => {});
      }));
      await remote.browser.close().catch(() => {});
      await recordBrightDataCost(remote.providerSessionId);
      endCostRequest();
    } };
  } catch {
    await browser?.close().catch(() => {});
    await recordBrightDataCost();
    endCostRequest();
    // CDP errors include the connection URL, including its password. Never log that URL.
    throw new Error('Bright Data browser connection failed. Check the Browser API zone credentials and account access.');
  }
}

/** Called at the shared CAPTCHA boundary, before any AI-selected interaction. */
export async function solveRemoteCaptcha(page: Page): Promise<boolean> {
  const remote = remoteSessions.get(page.context());
  if (!remote || remote.closed) return false;
  const secrets = captchaDiagnosticSecrets(process.env);
  let control: CaptchaControl;
  try {
    control = await captchaControl(remote, page);
  } catch (error) {
    countHealth('captchaFailed');
    logCaptcha(remote, page, 'control unavailable', { error: safeCaptchaDiagnostic(error, secrets) });
    return false;
  }
  if (control.blocked) return false;
  if (control.inFlight) return control.inFlight;
  control.inFlight = (async () => {
    const address = page.url();
    const result = await retryCaptchaSolve({
      solve: async () => control.session.send('Captcha.solve' as never, { detectTimeout: 30_000, options: captchaOptions } as never) as Promise<CaptchaSolveResult>,
      stillChallenged: async () => !page.isClosed() && page.url() === address && await hasCaptchaSurface(page),
      pause: () => new Promise(done => setTimeout(done, 1_500)),
      onAttempt: (attempt, status, details) => logCaptcha(remote, page, `attempt ${attempt}/3: ${status}`, {
        phase: details.phase, elapsedMs: details.elapsedMs,
        ...(details.error !== undefined ? { error: safeCaptchaDiagnostic(details.error, secrets) } : {}),
        ...(details.response !== undefined ? { response: safeCaptchaDiagnostic(details.response, secrets) } : {}),
      }),
    });
    control.blocked = result.status === 'failed';
    countHealth(result.status === 'solved' ? 'captchaSolved' : result.status === 'cleared' ? 'captchaSelfCleared' : 'captchaFailed');
    return result.status !== 'failed';
  })().catch(error => {
    control.blocked = true;
    countHealth('captchaFailed');
    logCaptcha(remote, page, 'could not complete verification', { error: safeCaptchaDiagnostic(error, secrets) });
    return false;
  }).finally(() => { control.inFlight = undefined; });
  return control.inFlight;
}
