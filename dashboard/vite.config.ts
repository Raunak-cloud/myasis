import { changeSchedule, scheduleFor } from './server/run-schedule.js';
import { accountSetupComplete } from './server/setup.js';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { userChromeDir, userDir } from './server/userdata.js';
import { runner, readEnv, readEnvSafe, isRunMode, type RunMode } from './server/runner.js';
import {
  listResumes, addResume, updateResume, deleteResume,
  listKnowledge, addKnowledgeFile, addKnowledgeNote, updateKnowledge, deleteKnowledge, knowledgeStats,
  resolveStored, previewText, fullContext, MIME,
} from './server/files.js';
import { attachScreencast } from './server/screencast.js';
import { loadQueue, updateQueueItem, answerForm } from './server/assist.js';
import { loadAttention, dismissAllAttention } from './server/attention.js';
import { loadSkipped, setVerdict } from './server/skipped.js';
import { setupStatus } from './server/setup.js';
import { loadProfile as loadCandidate, saveProfile, SalaryValidationError } from './server/profile.js';
import {
  loadUserSettings, saveUserSettings, runSettingsForUser,
  USER_SETTABLE_SETTINGS_KEYS, DAILY_APPLICATION_CAP_CHOSEN,
} from './server/settings.js';
import { query, one, health as dbHealth, migrate as dbMigrate } from './server/db/index.js';
import { upsertSettingRow } from './server/db/records.js';
import { matchThresholdError } from './src/runSettings.js';
import { CUSTOM_MIN_SCORE } from './src/pricing.js';
import { userRunLimitError, dailyApplicationLimit } from '../seek-bot/src/run-limits.js';
/** The resume note on Apply, once dismissed: a UI preference, never part of a run's settings. */
const BOARD_RESUMES_NOTE_DISMISSED = 'BOARD_RESUMES_NOTE_DISMISSED';
import { allowedOrigin, crossSite, hasSessionCookie, rateLimited, readJsonBody, readRawBodyLimited, requesterAddress, signedInShell, upgradeOriginAllowed, BodyTooLarge, DEFAULT_BODY_LIMIT, UPLOAD_BODY_LIMIT } from './server/http-guards.js';
import { marketScoutProxy } from './server/market-scout.js';
import { isAdmin as isAdminEmail } from './server/billing.js';
import { jobSourceSettingsError } from './server/job-sources.js';
import { migrateFilesToUser } from './server/db/migrate-files.js';
import { endPageView, pulsePageView, recordPageView, startVisitMaintenance } from './server/visits.js';
import { matchKeysFromRequest, reportRedditConversion } from './server/reddit-capi.js';
import { startProfileMaintenance } from './server/profile-prune.js';
import { startHealthMaintenance } from './server/health.js';
import { startTraceRetention } from './server/trace-retention.js';
import { googleAuthUrl, handleGoogleCallback, currentUser, logout, googleConfigured, pruneSessions, clearOauthCookie } from './server/auth.js';
import { listAnswers, saveAnswers, deleteAnswer } from './server/answers.js';
import {
  billingStatus,
  createCheckout,
  BillingPolicyError,
  fulfillCheckoutSession,
  handleStripeWebhook,
  isAdmin,
} from './server/billing.js';
import { isPaidPlanKey } from './src/pricing.js';
import { generateSearchTerms } from './server/search-terms.js';
import { limitSearchTerms } from './src/search-limits.js';
import { openSeekManualLogin } from './server/manual-login.js';
import { startSignin, stopSignin, sessionFor, signinSupported, attachSigninVnc } from './server/signin.js';
import { checkSignin, seekCheckInProgress, signOutOfBoard, waitForSigninChecks } from './server/seek-check.js';
import { readSeekState, readSiteState, type SeekState } from './server/seek-state.js';
import { beginGmailConnection, finishGmailConnection, disconnectGmail, clearGmailCookie } from './server/gmail-connection.js';
import { checkGmailMcp } from './server/gmail-mcp.js';
import { gmailAccess, selectGmailProvider, allowBrowserGmail, disableBrowserGmail } from './server/gmail-access.js';
import { GmailConnectionError } from '../seek-bot/src/gmail-mcp-client.js';
import { GmailServiceError } from '../seek-bot/src/gmail-mcp-service.js';
import { applyRunPolicy, discardRunStart, effectivePlatforms, entitlementsFor, PLATFORMS_CHOSEN_KEY, latestRunStartedAt, mayEditRunSetting, recordRunStart, recordFeatureUse, SEARCH_TERMS_FEATURE } from './server/entitlements.js';
import { handleAdminRequest } from './server/admin.js';
import { routeStatus } from './server/route.js';
import { reconcilePool, startProxyPool } from './server/proxy-pool.js';
import { alertsEnabled, alertsOffTokenValid, setAlertsEnabled } from './server/alerts.js';
import { dailySummaryEnabled, setDailySummaryEnabled } from './server/email-preferences.js';
import { deleteAccount } from './server/account-deletion.js';
import { AccountDeletionError, accountRequest } from './server/account-lifecycle.js';
import { setUpFromResume } from './server/quick-setup.js';
import { startRun, expectedSalaryRefusal } from './server/start-run.js';
import { listApplicationReviews, dismissApplicationReviews, reviewSelection, recoverApplicationReviews, editApplicationCoverLetter } from './server/application-reviews.js';
import { validateCoverLetterInstructions } from '../seek-bot/src/cover-letter-policy.js';
import { runDeviceFromHeaders } from './src/run-device.js';
import { autoScheduleFor, startAutoRunner, wakeAutoRunner } from './server/autorun.js';
import { startBlogScheduler } from './server/blog/index.js';
import { handleMarketing } from './server/marketing/api.js';
import { startMarketingWorker, stopMarketingWorker } from './server/marketing/worker.js';
import { blogPages } from './server/blog/pages.js';
import { publicWebsiteContent } from './server/public-website-content.js';
import { publicWebsiteProxy } from './server/public-website-proxy.js';
import { improvedStaticPages } from './server/marketing/page-publisher.js';
import { loadTodayStats } from './server/today.js';
import { listSiteAccounts, sitePasswordFor } from './server/site-accounts.js';
import { stopAllSignins } from './server/signin.js';
import { loadApplicationCosts } from './server/application-costs.js';

interface ApplicationRow {
  confirmation_status: 'unconfirmed' | null;
  job_id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  platform: string;
  score: number;
  salary: string | null;
  work_arrangement: string | null;
  age_days_at_apply: number | null;
  cover_letter: string | null;
  answers: unknown;
  score_reasons: unknown;
  outcome: string | null;
  applied_at: Date | string;
  external: boolean;
  site: string | null;
  actions: unknown;
  resume_name: string | null;
}

function rowToApplication(a: ApplicationRow) {
  return {
    confirmationStatus: a.confirmation_status ?? undefined,
    jobId: a.job_id,
    title: a.title,
    company: a.company,
    location: a.location,
    url: a.url,
    platform: a.platform,
    score: a.score,
    salary: a.salary ?? undefined,
    workArrangement: a.work_arrangement ?? undefined,
    ageDaysAtApply: a.age_days_at_apply ?? undefined,
    coverLetter: a.cover_letter ?? undefined,
    answers: a.answers ?? [],
    scoreReasons: a.score_reasons ?? [],
    outcome: a.outcome ?? undefined,
    appliedAt: new Date(a.applied_at).toISOString(),
    external: a.external === true,
    site: a.site ?? undefined,
    actions: Array.isArray(a.actions) ? a.actions : [],
    resumeName: a.resume_name ?? undefined,
  };
}

/**
 * Local control-plane API for the bot: reads its data files, manages the resume
 * library and knowledge base, and starts/stops runs.
 *
 * Every route below that touches an account's own data (profile, resumes,
 * knowledge, applications, run log, queue, run control, setup/attention)
 * resolves `currentUser(req.headers?.cookie)` first and returns 401 if no one
 * is signed in — mirroring `/api/billing/status`'s existing pattern — then
 * scopes every query/file path to that account's id. Application history
 * (`applications`) stays read-only apart from the user-recorded `outcome` —
 * that is the audit trail of what was actually sent to employers and nothing
 * here may rewrite it.
 *
 * Genuinely install-wide concerns are the deliberate exception and stay
 * unauthenticated/shared: secrets and machine config in `seek-bot/.env`
 * (`readEnv`/`readEnvSafe` — CELERIS_API_KEY, Chrome profile),
 * the Stripe webhook, and the browser/screencast debug
 * endpoints — this runs on localhost with one Chrome automation profile and
 * one installation no matter which account is signed in.
 */
function dataApi(): Plugin {
  const research = marketScoutProxy(async (req) => {
    const user = await currentUser(req.headers.cookie);
    return user ? (isAdmin(user.email) ? 'admin' : 'user') : null;
  }, upgradeOriginAllowed);
  const handler = (req: any, res: any, next: any) => {
    if (/^\/market-research(?:\/|\?|$)/.test(req.url ?? '')) return research(req, res);
    /**
     * The landing page is baked into the built HTML for crawlers. Someone
     * arriving with a session is about to see the app, and would otherwise
     * watch the landing flash past first, so they get the shell without it.
     */
    if (req.method === 'GET' && /^\/(?:index\.html)?(?:\?|$)/.test(req.url ?? '') && hasSessionCookie(req)) {
      const shell = signedInShell(resolve(import.meta.dirname, 'dist'));
      if (shell) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Vary', 'Cookie');
        return res.end(shell);
      }
    }
    if (!req.url?.startsWith('/api/')) return next();

    // Nothing under /api is a page; keep it out of search results.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    /**
     * Cross-origin reads are allowed only to callers with a reason: the
     * browser extension and a developer's localhost. The site's own pages are
     * same-origin and need none of this; anyone else gets no allow header.
     */
    const origin = allowedOrigin(req);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const send = (body: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    /**
     * A body the sender declares to be over the cap is refused before a byte
     * of it is read, with a 413 the client can act on. The readers below keep
     * a second cap on what actually arrives, for senders that do not say.
     */
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    const routeCap = /^\/api\/(resumes|knowledge)$/.test(route) ? UPLOAD_BODY_LIMIT : DEFAULT_BODY_LIMIT;
    if (declaredLength > routeCap) return send({ error: `The request is larger than ${Math.round(routeCap / 1024)} KB.` }, 413);

    // Every body is capped; a route that takes an upload passes the larger limit.
    const readBody = (limit = DEFAULT_BODY_LIMIT): Promise<any> => readJsonBody(req, limit);
    const readRawBody = (limit = DEFAULT_BODY_LIMIT): Promise<Buffer> => readRawBodyLimited(req, limit);

    /**
     * Requests a browser marks as started by another site are refused on
     * anything that changes state, and on the one GET with a side effect.
     * Stripe and other non-browser callers send no such header and are
     * left to each route's own authentication.
     */
    const mutating = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';
    if (mutating && route !== '/api/billing/webhook' && crossSite(req)) {
      return send({ error: 'Cross-site requests are not accepted.' }, 403);
    }

    /**
     * Rate limits, per address for what needs no sign-in and per account
     * for what costs money. A limit that trips answers 429 and does nothing.
     */
    const address = requesterAddress(req);
    const limits: Array<[RegExp, number, number, string]> = [
      [/^\/api\/auth\//, 30, 10 * 60_000, 'sign-in'],
      [/^\/api\/visit/, 120, 60_000, 'visits'],
      [/^\/api\/billing\//, 30, 10 * 60_000, 'billing'],
      [/^\/api\/search-terms\/generate$/, 10, 60 * 60_000, 'suggestions'],
      [/^\/api\/assist\/answer$/, 60, 60 * 60_000, 'answers'],
      [/^\/api\/(resumes|knowledge)$/, 30, 60 * 60_000, 'uploads'],
      [/^\/api\//, 600, 60_000, 'api'],
    ];
    for (const [pattern, limit, windowMs, name] of limits) {
      if (!pattern.test(route)) continue;
      if (name === 'uploads' && req.method !== 'POST') continue;
      if (rateLimited(`${name}:${address}`, limit, windowMs)) {
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        return send({ error: 'Too many requests. Try again in a little while.' }, 429);
      }
      break;
    }

    /** Every account-scoped route funnels through this — 401 if not signed in. */
    const withUser = (fn: (userId: string) => Promise<void> | void) =>
      currentUser(req.headers?.cookie).then((user) => {
        if (!user) return send({ error: 'Sign in required.' }, 401);
        return accountRequest(user.id, () => fn(user.id));
      }).catch((error) => {
        if (error instanceof BodyTooLarge) return send({ error: error.message }, 413);
        if (error instanceof AccountDeletionError) return send({ error: error.message }, error.status);
        throw error;
      });

    // The operator's dashboard: every route in it checks for an admin on each request.
    if (route.startsWith('/api/admin/')) return handleAdminRequest(req, res, url, send, readBody);
    if (route.startsWith('/api/marketing/')) return currentUser(req.headers.cookie).then(user => user
      ? handleMarketing(req,res,url,user,send,readBody)
      : send({error:'Sign in required.'},401));

    /**
     * Visitor beacons, from the page itself, signed in or not. They answer
     * kindly whatever happens: analytics must never break a page, and the
     * sender is not waiting to hear back anyway.
     */
    if (route === '/api/visit' && req.method === 'POST') {
      return readBody().then(async (b) => {
        const user = await currentUser(req.headers?.cookie).catch(() => null);
        const id = await recordPageView(req, b, user?.id ?? null).catch(() => null);
        return send({ id });
      });
    }
    if (route === '/api/visit/pulse' && req.method === 'POST') {
      return readBody().then(async (b) => {
        const user = await currentUser(req.headers?.cookie).catch(() => null);
        await pulsePageView(b, user?.id ?? null).catch(() => {});
        res.statusCode = 204;
        res.end();
      });
    }
    if (route === '/api/visit/leave' && req.method === 'POST') {
      return readBody().then(async (b) => {
        await endPageView(b).catch(() => {});
        res.statusCode = 204;
        res.end();
      });
    }

    switch (route) {
      case '/api/billing/status': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return currentUser(req.headers?.cookie).then(async (user) => {
          if (!user) return send({ error: 'Sign in to view payment details.' }, 401);
          try {
            return send(await billingStatus(user.id, user.email));
          } catch (error) {
            return send({ error: `Could not load payment details: ${(error as Error).message}` }, 503);
          }
        });
      }

      case '/api/billing/checkout': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return Promise.all([currentUser(req.headers?.cookie), readBody()]).then(async ([user, body]) => {
          if (!user) return send({ error: 'Sign in before purchasing a pass.' }, 401);
          if (!isPaidPlanKey(body?.planKey)) return send({ error: 'Choose a valid pass.' }, 400);
          try {
            return send(await createCheckout(user, body.planKey, {
              quotedAt: body.quotedAt, sourceGrantId: body.sourceGrantId,
              amountCents: body.amountCents, expiresAt: body.expiresAt,
            }));
          } catch (error) {
            if (error instanceof BillingPolicyError) return send({ error: error.message }, error.status);
            const message = (error as Error).message;
            // Our own refusals are written for the customer; anything from Stripe is logged and replaced.
            const ours = /not configured|top-ups require|top-up checkout/i.test(message);
            if (!ours) console.warn('[billing] checkout failed:', message);
            return send({ error: ours ? message : 'Checkout could not be opened. Try again in a minute.' }, 503);
          }
        });
      }

      case '/api/billing/confirm': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return Promise.all([currentUser(req.headers?.cookie), readBody()]).then(async ([user, body]) => {
          if (!user) return send({ error: 'Sign in to confirm this payment.' }, 401);
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
          if (!/^cs_/.test(sessionId)) return send({ error: 'Invalid checkout session.' }, 400);
          try {
            // This path has a browser behind it, so the ad click id and Reddit's
            // own cookie come along; the webhook path has neither.
            const result = await fulfillCheckoutSession(sessionId, user.id, matchKeysFromRequest(req));
            // A paying account gets its dedicated address now, not at the next reconcile.
            void reconcilePool().catch((error) => console.warn('[proxy-pool] reconcile after payment failed:', (error as Error).message));
            return send({ ok: true, ...result, status: await billingStatus(user.id, user.email) });
          } catch (error) {
            console.warn('[billing] confirm failed:', (error as Error).message);
            return send({ error: 'The payment could not be confirmed yet. If you were charged, it will be credited within a few minutes.' }, 400);
          }
        });
      }

      case '/api/billing/webhook': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        const signatureHeader = req.headers?.['stripe-signature'];
        const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
        if (!signature) return send({ error: 'Missing payment signature.' }, 400);
        return readRawBody(DEFAULT_BODY_LIMIT).then(async (rawBody) => {
          try {
            await handleStripeWebhook(rawBody, signature);
            void reconcilePool().catch((error) => console.warn('[proxy-pool] reconcile after payment failed:', (error as Error).message));
            return send({ received: true });
          } catch (error) {
            return send({ error: `Webhook rejected: ${(error as Error).message}` }, 400);
          }
        });
      }

      case '/api/applications/costs': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return withUser(async (userId) => {
          const actor = await currentUser(req.headers?.cookie);
          if (!isAdminEmail(actor?.email)) return send({ error: 'Admins only.' }, 403);
          return send(await loadApplicationCosts(userId, userDir(userId)));
        });
      }
      case '/api/applications': {
        return withUser(async (userId) => {
          if (req.method === 'PATCH') {
            // Only the user-recorded outcome is writable; the record of what
            // was actually sent to an employer stays immutable.
            const b = await readBody();
            await query(
              `UPDATE applications SET outcome = $3
                WHERE user_id = $1 AND job_id = $2 AND submitted_by_myasis`,
              [userId, b.jobId, b.patch?.outcome ?? null],
            );
            const rows = await query<ApplicationRow>(
              `SELECT job_id, title, company, location, url, platform, score, salary, work_arrangement,
                      age_days_at_apply, cover_letter, answers, score_reasons, outcome, applied_at,
                      external, site, actions, resume_name, confirmation_status
                 FROM applications
                WHERE user_id = $1 AND (submitted_by_myasis OR confirmation_status = 'unconfirmed')
                ORDER BY applied_at DESC`,
              [userId],
            );
            return send({ ok: true, applications: rows.map(rowToApplication) });
          }
          const rows = await query<ApplicationRow>(
            `SELECT job_id, title, company, location, url, platform, score, salary, work_arrangement,
                    age_days_at_apply, cover_letter, answers, score_reasons, outcome, applied_at,
                    external, site, actions, resume_name, confirmation_status
               FROM applications
              WHERE user_id = $1 AND (submitted_by_myasis OR confirmation_status = 'unconfirmed')
              ORDER BY applied_at DESC`,
            [userId],
          );
          return send(rows.map(rowToApplication));
        });
      }
      case '/api/site-accounts': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return withUser(async (userId) => send(await listSiteAccounts(userId)));
      }

      case '/api/site-accounts/password': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          const body = await readBody();
          const password = await sitePasswordFor(userId, String(body?.site ?? ''), String(body?.email ?? ''));
          if (!password) return send({ error: 'Owtomate has no account on that site for you.' }, 404);
          return send({ password });
        });
      }

      case '/api/log': {
        return withUser(async (userId) => {
          const rows = await query(
            `SELECT job_id AS "jobId", status, title, company, reason, url, ts
               FROM run_events WHERE user_id = $1 ORDER BY ts`,
            [userId],
          );
          return send(rows);
        });
      }
      case '/api/settings': {
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            const body = await readBody();
            if (body?.updates?.COVER_LETTER_INSTRUCTIONS !== undefined) {
              try { validateCoverLetterInstructions(body.updates.COVER_LETTER_INSTRUCTIONS); }
              catch (error) { return send({ error: (error as Error).message }, 400); }
            }
            /**
             * The fine-tuning settings decide how a run behaves, and belong
             * to the tiers that drive runs. The form hides them; this is what
             * actually withholds them.
             */
            const settingsUser = await currentUser(req.headers?.cookie);
            const sourceError = jobSourceSettingsError(body?.updates ?? {}, isAdminEmail(settingsUser?.email));
            if (sourceError) return send({ error: sourceError.error }, sourceError.status);
            const entitlements = await entitlementsFor(userId, settingsUser?.email);
            const updates: Record<string, string> = {};
            for (const [key, value] of Object.entries(body?.updates ?? {})) {
              if (!USER_SETTABLE_SETTINGS_KEYS.includes(key as (typeof USER_SETTABLE_SETTINGS_KEYS)[number])) continue;
              if (!mayEditRunSetting(key, entitlements)) continue;
              updates[key] = String(value ?? '');
            }
            if (updates.MIN_SCORE !== undefined) {
              const error = matchThresholdError(updates.MIN_SCORE, entitlements.tier === 'admin' ? 0 : CUSTOM_MIN_SCORE);
              if (error) return send({ error }, 400);
            }
            const limitError = userRunLimitError(updates);
            if (limitError) return send({ error: limitError.message }, 400);
            // Boards that differ from what a run would have used are the person's own choice, kept from now on.
            const before = await loadUserSettings(userId);
            if (updates.PLATFORMS !== undefined && updates.PLATFORMS.trim() !== effectivePlatforms(before, entitlements)) {
              await upsertSettingRow(userId, PLATFORMS_CHOSEN_KEY, '1');
            }
            const settings = await saveUserSettings(userId, updates);
            if (updates.MAX_APPS_PER_DAY !== undefined) {
              await upsertSettingRow(userId, DAILY_APPLICATION_CAP_CHOSEN, '1');
              settings[DAILY_APPLICATION_CAP_CHOSEN] = '1';
            }
            return send({ ok: true, settings: { ...settings, KEYWORDS: limitSearchTerms(settings.KEYWORDS ?? ''), PLATFORMS: effectivePlatforms(settings, entitlements),
              MAX_APPS_PER_DAY: String(dailyApplicationLimit(entitlements.tier === 'intensive' && settings[DAILY_APPLICATION_CAP_CHOSEN] !== '1' ? undefined : settings.MAX_APPS_PER_DAY)) } });
          }
          // What the run screen shows is what a run would use, not the raw saved value.
          const viewer = await currentUser(req.headers?.cookie);
          const saved = await loadUserSettings(userId);
          const entitlements = await entitlementsFor(userId, viewer?.email);
          return send({ ...saved, KEYWORDS: limitSearchTerms(saved.KEYWORDS ?? ''), PLATFORMS: effectivePlatforms(saved, entitlements),
            MAX_APPS_PER_DAY: String(dailyApplicationLimit(entitlements.tier === 'intensive' && saved[DAILY_APPLICATION_CAP_CHOSEN] !== '1' ? undefined : saved.MAX_APPS_PER_DAY)) });
        });
      }

      case '/api/search-terms/generate': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          // The free plan gets a fixed number of these; checked here, where the model call is made, not only on the page.
          const user = await currentUser(req.headers?.cookie);
          const allowance = (await entitlementsFor(userId, user?.email)).searchTermSuggestionsLeft;
          if (allowance !== null && allowance <= 0) {
            return send({ error: 'You have used your free suggestion. Paid passes include unlimited suggestions.' }, 403);
          }
          const body = await readBody();
          const result = await generateSearchTerms(userId, body ?? {});
          if (result.ok && allowance !== null) await recordFeatureUse(userId, SEARCH_TERMS_FEATURE);
          return send(result.ok ? result : { error: result.error }, result.ok ? 200 : result.status ?? 500);
        });
      }

      case '/api/signin/signout': {
        return withUser(async (userId) => {
          if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
          const body = await readBody();
          if (body?.site !== 'seek' && body?.site !== 'indeed') return send({ error: 'Say which job board to sign out of.' }, 400);
          const result = await signOutOfBoard(userId, body.site);
          if (!result.ok) return send({ error: result.error }, 409);
          return send({ ok: true, seek: readSeekState(userId), indeed: readSiteState(userId, 'indeed') });
        });
      }

      // ---- emails about problems with the account ----
      case '/api/email-alerts/off': {
        /**
         * The link at the foot of every alert. It carries its own proof — a
         * signature over the account id — so it works from a mail app with
         * nobody signed in, and for that account only. Mail providers call it
         * with POST for their one-click unsubscribe; a person opens it with GET.
         */
        const account = url.searchParams.get('u') ?? '';
        if (!alertsOffTokenValid(account, url.searchParams.get('t') ?? '')) return send({ error: 'This link is not valid.' }, 400);
        return setAlertsEnabled(account, false).then(() => {
          if (req.method === 'POST') return send({ ok: true });
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owtomate</title><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;line-height:1.6;color:#11141c"><h1 style="font-size:20px">Alert emails are off</h1><p>Owtomate will no longer email you about problems with your account. You can turn them back on in Settings at any time.</p><p><a href="/">Open Owtomate</a></p></body>');
        });
      }
      case '/api/email-alerts': {
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            const body = await readBody();
            if (typeof body?.enabled !== 'boolean') return send({ error: 'Say whether the emails should be on or off.' }, 400);
            await setAlertsEnabled(userId, body.enabled);
          }
          return send({ enabled: await alertsEnabled(userId) });
        });
      }

      // ---- daily email preference and self-service account removal ----
      case '/api/daily-summary': {
        if (req.method !== 'GET' && req.method !== 'POST') return send({ error: 'GET or POST required.' }, 405);
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            if (!upgradeOriginAllowed(req)) return send({ error: 'Use Settings on this website to change email preferences.' }, 403);
            const body = await readBody();
            if (typeof body?.enabled !== 'boolean') return send({ error: 'Say whether the emails should be on or off.' }, 400);
            await setDailySummaryEnabled(userId, body.enabled);
          }
          return send({ enabled: await dailySummaryEnabled(userId) });
        });
      }
      case '/api/account': {
        if (req.method !== 'GET' && req.method !== 'DELETE') return send({ error: 'GET or DELETE required.' }, 405);
        // Authenticate directly: deletion drains withUser requests and must
        // never wait for its own request to finish.
        return currentUser(req.headers.cookie).then(async (user) => {
          if (!user) return send({ error: 'Sign in required.' }, 401);
          if (req.method === 'GET') return send({ email: user.email });
          if (!upgradeOriginAllowed(req) || !req.headers['content-type']?.startsWith('application/json')) {
            return send({ error: 'Use Settings on this website to delete your account.' }, 403);
          }
          const body = await readBody();
          if (typeof body?.confirmEmail !== 'string' || body.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
            return send({ error: 'Type your account email to confirm deletion.' }, 400);
          }
          try {
            await deleteAccount(user);
            res.setHeader('Set-Cookie', await logout(req.headers.cookie));
            return send({ ok: true });
          } catch (error) {
            if (error instanceof AccountDeletionError) return send({ error: error.message }, error.status);
            console.warn('[account-deletion] failed:', (error as Error).message);
            return send({ error: 'Your account could not be fully deleted. Please retry or contact support.' }, 503);
          }
        });
      }

      // ---- which connection this account's browser goes out on ----
      case '/api/route': {
        return withUser(async (userId) => {
          // Why an exit is failing is the operator's to act on, not the account's.
          const { exitProblem: _operatorOnly, ...status } = await routeStatus(userId);
          return send(status);
        });
      }

      // ---- resume library ----
      case '/api/resumes': {
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            const b = await readBody(UPLOAD_BODY_LIMIT);
            const r = await addResume(userId, b);
            if (!r.ok) return send({ error: r.error }, 400);
            /**
             * The details form is filled from the document that just arrived,
             * because the candidate has already written all of it down once.
             * Only blank fields are touched, and a failure here is not an
             * upload failure — the resume is saved either way.
             */
            // The upload sets the account up: details, email, job titles and city, filling only what is empty.
            const setup = await setUpFromResume(userId, r.resume?.id);
            // Said out loud either way: a form that stays empty with no word looks like nothing happened.
            if (setup.error) console.warn(`[autofill] user ${userId}: ${setup.error}`);
            return send({
              ok: true,
              resumes: await listResumes(userId),
              ...(setup.filled.length ? { autofilled: setup.filled } : {}),
              ...(setup.terms.length ? { terms: setup.terms } : {}),
              ...(setup.city ? { city: setup.city } : {}),
              ...(setup.error ? { autofillError: setup.error } : {}),
            });
          }
          if (req.method === 'PATCH') {
            const b = await readBody();
            return send({ ok: true, resumes: await updateResume(userId, b.id, b.patch ?? {}) });
          }
          if (req.method === 'DELETE') {
            const b = await readBody();
            return send({ ok: true, resumes: await deleteResume(userId, b.id) });
          }
          return send(await listResumes(userId));
        });
      }

      // ---- knowledge base the model can consult ----
      case '/api/knowledge': {
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            const b = await readBody(UPLOAD_BODY_LIMIT);
            if (b?.kind === 'note') {
              if (!b.text?.trim()) return send({ error: 'Note text is required.' }, 400);
              await addKnowledgeNote(userId, { label: b.label ?? 'Note', text: b.text });
              return send({ ok: true, items: await listKnowledge(userId) });
            }
            const r = await addKnowledgeFile(userId, b);
            return send(r.ok ? { ok: true, items: await listKnowledge(userId) } : { error: r.error }, r.ok ? 200 : 400);
          }
          if (req.method === 'PATCH') {
            const b = await readBody();
            return send({ ok: true, items: await updateKnowledge(userId, b.id, b.patch ?? {}) });
          }
          if (req.method === 'DELETE') {
            const b = await readBody();
            return send({ ok: true, items: await deleteKnowledge(userId, b.id) });
          }
          return send({ items: await listKnowledge(userId), stats: await knowledgeStats(userId) });
        });
      }

      // ---- viewing uploaded files ----
      case '/api/file': {
        // Raw download / inline view of a stored file.
        return withUser(async (userId) => {
          const kind = url.searchParams.get('kind') === 'resume' ? 'resume' : 'knowledge';
          const id = url.searchParams.get('id') ?? '';
          const found = await resolveStored(userId, kind, id);
          if (!found || !existsSync(found.path)) return send({ error: 'File not found.' }, 404);
          const ext = found.fileName.slice(found.fileName.lastIndexOf('.')).toLowerCase();
          // Only a PDF or plain text is shown in the browser; anything else is a download whatever was asked.
          const viewable = ext === '.pdf' || ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json';
          const disposition = url.searchParams.get('download') === '1' || !viewable ? 'attachment' : 'inline';
          res.statusCode = 200;
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
          res.setHeader(
            'Content-Disposition',
            `${disposition}; filename="${encodeURIComponent(found.fileName)}"`,
          );
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(found.path));
        });
      }

      case '/api/preview': {
        return withUser(async (userId) => {
          const kind = url.searchParams.get('kind') === 'resume' ? 'resume' : 'knowledge';
          const id = url.searchParams.get('id') ?? '';
          const r = await previewText(userId, kind, id);
          return send(r, r.ok ? 200 : 404);
        });
      }

      case '/api/knowledge/context':
        // Exactly what gets handed to the model.
        return withUser(async (userId) => {
          const r = await fullContext(userId);
          return send(r, r.ok ? 200 : 500);
        });

      case '/api/signin/session': {
        /**
         * A private browser for this account to sign in to SEEK with.
         *
         * GET reports whether one is open, POST opens it, DELETE closes it.
         * The VNC password is returned only to the authenticated owner and
         * only for their own session.
         */
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            if (runner.inUse(userId)) {
              return send({ error: 'Stop your current run first — Chrome cannot open the same profile twice.' }, 409);
            }
            // Same window, same profile; only the page it opens on differs.
            const body = await readBody();
            const target = body?.target === 'gmail' ? 'gmail' : body?.target === 'indeed' ? 'indeed' : 'seek';
            if (target === 'gmail') {
              const access = await gmailAccess(userId);
              if (!access.providers.includes('browser')) return send({ error: 'Browser Gmail is unavailable for this account.' }, 403);
              if (body?.consent !== true) return send({ error: 'Confirm Gmail mailbox access before connecting.' }, 400);
              const owner = await currentUser(req.headers?.cookie);
              const allowance = await billingStatus(userId, owner?.email);
              if (!isAdmin(owner?.email) && !allowance.paid.hasActiveIntensivePass) return send({ error: 'Gmail access requires an Intensive plan.' }, 403);
            }
            const result = await startSignin(userId, target, { assist: body?.manual !== true,
              expiresAt: typeof body?.resumeUntil === 'number' ? body.resumeUntil : undefined });
            if (!result.ok) return send({ error: result.error }, 409);
            if (target === 'gmail') await allowBrowserGmail(userId);
            return send({ ok: true, supported: true, session: result.session });
          }
          if (req.method === 'DELETE') {
            const target = sessionFor(userId)?.target;
            const cancelled = url.searchParams.get('cancel') === 'true';
            await stopSignin(userId);
            /**
             * Done is not proof of sign-in, so the site is checked directly
             * in this account's profile. Close is an explicit cancellation:
             * it ends the browser immediately and keeps the last known state.
             */
            const seek = !cancelled && target === 'seek' ? await checkSignin(userId, 'seek', false) : readSeekState(userId);
            const indeed = !cancelled && target === 'indeed' ? await checkSignin(userId, 'indeed', false) : readSiteState(userId, 'indeed');
            return send({ ok: true, cancelled, session: null, seek, indeed, checking: false });
          }
          const seek = readSeekState(userId);
          const indeed = readSiteState(userId, 'indeed');
          const priorState: Record<'seek' | 'indeed', SeekState | null> = { seek, indeed };
          /**
           * Only re-verify a board this account has some history with.
           *
           * An account with no `<site>-session.json` has never been prompted
           * to sign in to that board — there is nothing "expired" to check,
           * and probing it anyway used to write `signedIn: false` as fact,
           * which read back as "SEEK shows this account signed out. Sign in
           * again" for someone who had never once signed in. Skipping the
           * probe leaves the state `null`, so the Apply page keeps its
           * first-time copy ("Sign in once…") until there is a real prior
           * session worth reconfirming.
           */
          const verifySites = (crossSite(req) ? '' : url.searchParams.get('verify') ?? '')
            .split(',')
            .filter((site): site is 'seek' | 'indeed' => site === 'seek' || site === 'indeed')
            .filter((site) => priorState[site]?.signedIn === true);
          /**
           * A green tick must describe the live account, not a cached answer.
           * When the Apply page mounts it requests verification for the boards
           * it displays. Run them sequentially because both checks use the same
           * Chrome profile, which only one browser process may open at a time.
           * The page polls while `checking` is true and settles on each site's
           * freshly recorded answer.
           */
          // Not while a run is starting either: a check opened then would hold the profile the bot is about to launch on.
          if (verifySites.length && !sessionFor(userId) && !runner.inUse(userId)) {
            const [firstSite, ...remainingSites] = verifySites;
            // Start the first check before composing the response so
            // `checking` is already true and a cached tick cannot flash.
            let verification = checkSignin(userId, firstSite, false);
            for (const site of remainingSites) {
              verification = verification.then(() => checkSignin(userId, site, false));
            }
            void verification;
          }
          return send({
            supported: signinSupported(),
            session: sessionFor(userId),
            seek,
            indeed,
            checking: seekCheckInProgress(userId, 'seek') || seekCheckInProgress(userId, 'indeed'),
          });
        });
      }

      case '/api/browser/manual-login': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          // Only this account's own run blocks it: the profile Chrome would
          // open is this account's, and Chrome locks a profile in use.
          if (runner.stateFor(userId).running) {
            return send({ error: 'Stop your current run before opening a job-board sign-in window.' }, 409);
          }
          const target = url.searchParams.get('target') === 'gmail' ? 'gmail' : url.searchParams.get('target') === 'indeed' ? 'indeed' : 'seek';
          if (target === 'gmail') {
            if (url.searchParams.get('consent') !== 'true' || !(await gmailAccess(userId)).providers.includes('browser')) return send({ error: 'Confirm available Gmail mailbox access first.' }, 403);
          }
          const gmailProfile = target === 'gmail' ? await one<{ email: string }>('SELECT email FROM profiles WHERE user_id=$1', [userId]) : null;
          const result = await openSeekManualLogin(readEnv(), userChromeDir(userId), target, gmailProfile?.email);
          if (result.ok && target === 'gmail') await allowBrowserGmail(userId);
          return send(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : 409);
        });
      }

      // ---- review queue + extension backend ----
      case '/api/queue': {
        return withUser(async (userId) => {
          if (req.method === 'PATCH') {
            const b = await readBody();
            return send({ ok: true, queue: updateQueueItem(userId, b.jobId, b.patch ?? {}) });
          }
          return send(loadQueue(userId));
        });
      }

      case '/api/assist/answer': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          // The browser helper remains an Intensive feature even though customers cannot start runs manually.
          const assistUser = await currentUser(req.headers?.cookie);
          if (!(await entitlementsFor(userId, assistUser?.email)).fineTune) {
            return send({ ok: false, error: 'The browser helper is part of Get Owtomated.' }, 403);
          }
          const b = await readBody();
          const r = await answerForm(userId, {
            jobId: b?.jobId, title: b?.title, company: b?.company,
            description: b?.description, fields: Array.isArray(b?.fields) ? b.fields : [],
          });
          return send(r, r.ok ? 200 : 500);
        });
      }

      // ---- auth ----
      case '/api/auth/me': {
        return currentUser(req.headers?.cookie).then((u) =>
          send({ user: u, googleConfigured: googleConfigured() }),
        );
      }

      case '/api/auth/google': {
        const r = googleAuthUrl();
        if (!r.ok) return send({ error: r.error }, 400);
        res.statusCode = 302;
        // The nonce inside `state` is also set here, so the callback can prove the same browser started this.
        res.setHeader('Set-Cookie', r.cookie);
        res.setHeader('Location', r.url);
        return res.end();
      }

      case '/api/auth/callback/google': {
        if (url.searchParams.get('state')?.startsWith('gmail.')) return (async () => {
          const user = await currentUser(req.headers?.cookie);
          let error = '';
          try {
            if (!user) throw new GmailServiceError('unapproved', 'Sign in to Owtomate before connecting Gmail.');
            const allowance = await billingStatus(user.id, user.email);
            if (!isAdmin(user.email) && !allowance.paid.hasActiveIntensivePass) throw new GmailServiceError('unapproved', 'Gmail access requires an Intensive plan.');
            if (!(await gmailAccess(user.id)).providers.includes('mcp')) throw new GmailServiceError('unapproved', 'Gmail MCP is awaiting verification. Use browser Gmail in Settings.');
            await finishGmailConnection(user.id, url, req.headers?.cookie);
            await selectGmailProvider(user.id, 'mcp');
            await checkGmailMcp(user.id);
          } catch (reason) { error = reason instanceof GmailServiceError || reason instanceof GmailConnectionError ? reason.message : 'Gmail connection could not complete. Retry from Setup.'; }
          res.statusCode = 302;
          res.setHeader('Set-Cookie', clearGmailCookie());
          res.setHeader('Location', '/?tab=setup&gmail=' + (error ? 'error&gmail_error=' + encodeURIComponent(error.slice(0, 250)) : 'connected'));
          return res.end();
        })();
        return handleGoogleCallback(url.searchParams.get('code'), url.searchParams.get('state'), req.headers?.cookie).then(
          (r) => {
            if (!r.ok) {
              // Send the reason back to the app rather than a bare JSON error.
              res.statusCode = 302;
              res.setHeader('Set-Cookie', clearOauthCookie());
              res.setHeader('Location', '/?auth_error=' + encodeURIComponent(r.error ?? 'failed'));
              return res.end();
            }
            void pruneSessions();
            /**
             * A new account is a conversion. It is reported from here, and the
             * same id is handed to the page so the pixel can report it too —
             * Reddit keeps whichever arrives in better shape and drops the
             * other. Derived from the user id rather than generated, because
             * two random ids would never match and the sign-up would count
             * twice. Returning sign-ins carry no id and report nothing.
             */
            let signupParam = '';
            if (r.signedUp && r.userId) {
              const conversionId = `signup:${r.userId}`;
              signupParam = `?rdt_signup=${encodeURIComponent(conversionId)}`;
              reportRedditConversion({
                trackingType: 'SignUp',
                conversionId,
                externalId: r.userId,
                email: r.email,
                match: matchKeysFromRequest(req),
              });
            }
            res.statusCode = 302;
            res.setHeader('Set-Cookie', [r.cookie, clearOauthCookie()]);
            res.setHeader('Location', `/${signupParam}`);
            return res.end();
          },
        );
      }

      case '/api/auth/logout': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return logout(req.headers?.cookie).then((cookie) => {
          res.setHeader('Set-Cookie', cookie);
          return send({ ok: true });
        });
      }

      case '/api/db/health':
        return currentUser(req.headers?.cookie).then(async (u) => {
          if (!u || !isAdminEmail(u.email)) return send({ error: 'Admins only.' }, 403);
          const h = await dbHealth();
          return send({ ok: h.ok }, h.ok ? 200 : 503);
        });

      case '/api/db/migrate': {
        /**
         * A one-time import of the pre-database files into an account. It
         * creates the account it is told to, so it is for an admin alone:
         * open, it would let anyone claim the previous owner's resumes.
         */
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return Promise.all([currentUser(req.headers?.cookie), readBody()]).then(async ([actor, b]) => {
          if (!actor || !isAdminEmail(actor.email)) return send({ error: 'Admins only.' }, 403);
          const m = await dbMigrate();
          if (!m.ok) return send({ error: m.error }, 500);
          if (!b?.email) return send({ ok: true, schema: 'applied' });
          try {
            const r = await migrateFilesToUser(b.email, b.name);
            return send({ ok: true, schema: 'applied', ...r });
          } catch (e) {
            return send({ error: (e as Error).message }, 500);
          }
        });
      }

      case '/api/profile': {
        return withUser(async (userId) => {
          if (req.method === 'PATCH') {
            const b = await readBody();
            try {
              return send({ ok: true, profile: await saveProfile(userId, b ?? {}) });
            } catch (error) {
              if (error instanceof SalaryValidationError) return send({ error: error.message }, 400);
              throw error;
            }
          }
          return send(await loadCandidate(userId));
        });
      }

      case '/api/board-resumes': {
        // Saved resumes on SEEK or Indeed that Owtomate does not hold; the last run recorded them (seek-bot/src/resume-sync.ts).
        // Dismissed once, it stays dismissed for the account on every device.
        if (req.method === 'POST') {
          return withUser(async (userId) => {
            await upsertSettingRow(userId, BOARD_RESUMES_NOTE_DISMISSED, new Date().toISOString());
            send({ boards: [] });
          });
        }
        return withUser(async (userId) => {
          const dismissed = await one<{ value: string }>('SELECT value FROM settings WHERE user_id = $1 AND key = $2', [userId, BOARD_RESUMES_NOTE_DISMISSED]);
          if (dismissed?.value) return send({ boards: [] });
          const file = resolve(userDir(userId), 'board-resumes.json');
          let report: Record<string, any> = {};
          try { if (existsSync(file)) report = JSON.parse(readFileSync(file, 'utf8')); } catch { report = {}; }
          const strings = (value: unknown) => (Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : []);
          const boards = (['seek', 'indeed'] as const)
            .map((board) => ({
              board,
              names: strings(report[board]?.names),
              // Same-named copies the person replaced on the board; Owtomate sent its own instead.
              replaced: (Array.isArray(report[`${board}Replaced`]) ? report[`${board}Replaced`] : [])
                .filter((entry: any) => typeof entry?.name === 'string' && typeof entry?.uploadedAs === 'string')
                .map((entry: any) => ({ name: entry.name as string, uploadedAs: entry.uploadedAs as string })),
            }))
            .filter((entry) => entry.names.length || entry.replaced.length);
          return send({ boards });
        });
      }

      case '/api/setup/status':
        return withUser(async (userId) => send(await setupStatus(userId)));

      case '/api/attention':
        return withUser(async (userId) => send(await loadAttention(userId)));

      // Skipped jobs and the candidate's call on each (server/skipped.ts). Administrators only while it is tried out.
      case '/api/skipped':
        return withUser(async (userId) => {
          const user = await currentUser(req.headers?.cookie);
          if (!isAdmin(user?.email)) return send({ error: 'Not available on this account yet.' }, 403);
          if (req.method === 'POST') {
            const b = await readBody();
            const verdict = b?.verdict === null ? null : b?.verdict === 'apply' || b?.verdict === 'skip' ? b.verdict : undefined;
            if (verdict === undefined) return send({ error: 'Unknown verdict.' }, 400);
            const result = await setVerdict(userId, String(b?.jobId ?? ''), verdict, typeof b?.note === 'string' ? b.note : undefined);
            if (!result.ok) return send({ error: result.error }, 400);
          }
          return send({ items: await loadSkipped(userId) });
        });

      case '/api/gmail/connect':
      case '/api/gmail/connection':
      case '/api/gmail/status':
        return withUser(async (userId) => {
          const user = await currentUser(req.headers?.cookie);
          if (url.pathname === '/api/gmail/connection' && req.method === 'DELETE') {
            if (runner.inUse(userId)) return send({ error: 'Stop your run before changing Gmail access.' }, 409);
            if ((await gmailAccess(userId)).provider === 'browser') await disableBrowserGmail(userId); else await disconnectGmail(userId);
            return send({ ok: true });
          }
          if (url.pathname === '/api/gmail/connection' && req.method === 'PATCH') {
            if (runner.inUse(userId)) return send({ error: 'Stop your run before changing Gmail access.' }, 409);
            try { await selectGmailProvider(userId, (await readBody())?.provider); return send({ ok: true }); }
            catch (error) { return send({ error: (error as Error).message }, 403); }
          }
          const allowance = await billingStatus(userId, user?.email);
          const eligible = isAdmin(user?.email) || allowance.paid.hasActiveIntensivePass;
          if (url.pathname === '/api/gmail/connect') {
            if (req.method !== 'POST') return send({ error: 'POST required.' }, 405);
            if (!eligible) return send({ error: 'Gmail access requires an Intensive plan.' }, 403);
            if (!(await gmailAccess(userId)).providers.includes('mcp')) return send({ error: 'Gmail MCP is awaiting verification. Use browser Gmail in Settings.' }, 403);
            if (runner.inUse(userId)) return send({ error: 'Stop your run before changing Gmail access.' }, 409);
            try {
              const result = await beginGmailConnection(userId);
              res.setHeader('Set-Cookie', result.cookie); return send({ url: result.url });
            } catch (error) { return send({ error: error instanceof GmailServiceError ? error.message : 'Gmail could not connect. Try again shortly.' }, 503); }
          }
          if (url.pathname !== '/api/gmail/status' || req.method !== 'GET') return send({ error: 'Method not allowed.' }, 405);
          return send({ ...await gmailAccess(userId), eligible, needed: eligible });
        });

      case '/api/answers': {
        return withUser(async (userId) => {
          if (req.method === 'POST') {
            const b = await readBody();
            const answers = Array.isArray(b?.answers) ? b.answers : [];
            const result = await saveAnswers(userId, answers, typeof b?.jobId === 'string' ? b.jobId : undefined);
            return send({ ok: true, ...result, items: await listAnswers(userId) });
          }
          if (req.method === 'DELETE') {
            const b = await readBody();
            if (typeof b?.question === 'string') await deleteAnswer(userId, b.question);
            return send({ ok: true, items: await listAnswers(userId) });
          }
          return send({ items: await listAnswers(userId) });
        });
      }

      case '/api/trace': {
        // The step-by-step record (with screenshots) of an application that needs a person.
        return withUser(async (userId) => {
          const jobId = url.searchParams.get('jobId') ?? '';
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) return send({ error: 'jobId required' }, 400);
          const file = resolve(userDir(userId), 'traces', `${jobId}.json`);
          if (!existsSync(file)) return send({ error: 'No trace recorded for this job.' }, 404);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(readFileSync(file, 'utf8'));
        });
      }

      case '/api/attention/clear': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          const cleared = await dismissAllAttention(userId);
          return send({ ok: true, cleared, items: await loadAttention(userId) });
        });
      }

      case '/api/entitlements': {
        return withUser(async (userId) => {
          const user = await currentUser(req.headers?.cookie);
          return send(await entitlementsFor(userId, user?.email));
        });
      }

      case '/api/run/status': {
        // Runs are per-account now, so an account only ever sees its own.
        return withUser(async (userId) => {
          const selected = 'CELERIS_API_KEY';
          const hasKey = Boolean((process.env[selected] ?? readEnvSafe()[selected])?.trim());
          return send({ ...runner.stateFor(userId), hasKey, isOwner: true });
        });
      }

      case '/api/auto-apply': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          if (!upgradeOriginAllowed(req) || !req.headers['content-type']?.startsWith('application/json')) {
            return send({ error: 'Use the Apply page on this website to start or pause your schedule.' }, 403);
          }
          const user = await currentUser(req.headers?.cookie);
          const entitlements = await entitlementsFor(userId, user?.email);
          const body = await readBody();
          if (typeof body?.enabled !== 'boolean') return send({ error: 'Choose Start or Pause.' }, 400);
          const existing = await scheduleFor(userId);
          const mode = body.applicationMode ?? existing?.application_mode ?? 'auto';
          if (mode !== 'auto' && mode !== 'semi-auto') return send({ error: 'Choose Auto apply or Semi auto.' }, 400);
          if (body.enabled) {
            if (body.confirm !== true) return send({ error: 'Confirm your scheduled application runs before starting.' }, 400);
            if (!await accountSetupComplete(userId)) return send({ error: 'Complete your profile, resume and search settings first.' }, 428);
            const balance = await billingStatus(userId, user?.email);
            if (balance.totalRemaining < 1) return send({ error: 'Choose a pass to keep applying.' }, 402);
            if (existing?.enabled && existing.application_mode !== mode) return send({ error: 'Pause before changing application mode.' }, 409);
          }
          await changeSchedule(userId, body.enabled, mode, entitlements.autoRunsPerDay);
          if (!body.enabled) runner.stop(userId);
          else wakeAutoRunner();
          return send({ ok: true, entitlements: await entitlementsFor(userId, user?.email) });
        });
      }

      case '/api/auto-schedule': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return withUser(async (userId) => send(await autoScheduleFor(userId)));
      }

      case '/api/today': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return withUser(async (userId) => send(await loadTodayStats(userId)));
      }

      case '/api/run/last': {
        return withUser(async (userId) => {
          const startedAt = await latestRunStartedAt(userId);
          return send({ startedAt: startedAt?.toISOString() ?? null });
        });
      }

      case '/api/run/queue': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          const queueUser = await currentUser(req.headers?.cookie);
          const entitlements = await entitlementsFor(userId, queueUser?.email);
          // Queue scans are manual operations and therefore administrator-only.
          if (entitlements.tier !== 'admin') {
            return send({ error: 'Use Semi auto on the Apply page to prepare applications for review.' }, 403);
          }
          const salaryRefused = expectedSalaryRefusal(await loadCandidate(userId));
          if (salaryRefused) return send({ error: salaryRefused.error }, salaryRefused.status);
          // Same reasoning as /api/run: without this the scan inherits the
          // shared .env's search settings instead of this account's.
          const settings = applyRunPolicy(await runSettingsForUser(userId, { unlimited: entitlements.tier === 'admin' }), entitlements, 'manual');
          // Claimed like a run start, so a scan never closes a browser a run is using.
          if (!runner.claimStart(userId)) return send({ error: 'A run is already starting or in progress for this account.' }, 409);
          try {
            if (sessionFor(userId)) await stopSignin(userId);
            const ready = await waitForSigninChecks(userId);
            if (!ready.ok) return send({ error: ready.error }, 409);
            const runStartId = await recordRunStart(userId, 'scan', 'manual', null, runDeviceFromHeaders(req.headers)).catch(() => null);
            const r = await runner.startQueue(userId, settings, runStartId);
            if (!r.ok) await discardRunStart(runStartId).catch(() => {});
            return send(r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 409);
          } finally {
            runner.releaseStart(userId);
          }
        });
      }

      case '/api/run': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          const body = await readBody();
          const requested = body?.mode ?? 'search';
          if (!isRunMode(requested)) {
            return send({ error: 'This page is out of date. Reload it, then start the run again.' }, 400);
          }
          const mode: RunMode = requested;
          /**
           * A live run submits real applications to real employers, so it
           * requires an explicit confirmation flag. The UI asks first; this
           * check means a stray POST cannot fire one.
           */
          if (mode === 'live' && body?.confirm !== true) {
            return send({ error: 'Live runs require confirm: true.' }, 400);
          }
          const runUser = await currentUser(req.headers?.cookie);
          if (!runUser) return send({ error: 'Sign in before starting a run.' }, 401);
          const adminRun = isAdmin(runUser.email);
          /**
           * Entitlement, settings, allowance and deduction all live in
           * startRun, which the scheduler calls too — so a scheduled
           * application and a hand-started one obey exactly the same rules.
           */
          const result = await startRun({
            userId,
            email: runUser.email,
            mode,
            trigger: adminRun ? 'admin' : 'manual',
            startedBy: adminRun ? runUser.id : undefined,
            initiatorDevice: runDeviceFromHeaders(req.headers),
            clientOverrides: body?.overrides ?? {},
            scope: body?.scope,
            applicationMode: body?.applicationMode,
          });
          return send(result.ok ? { ok: true, mode: result.mode } : { error: result.error }, result.ok ? 200 : result.status);
        });
      }

      case '/api/application-reviews': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return withUser(async userId => {
          if (!runner.inUse(userId)) {
            // Recover completed/partially written results after a restart;
            // uncertain sends never become a fresh automatic retry.
            await recoverApplicationReviews(userId);
          }
          return send({ applications: await listApplicationReviews(userId) });
        });
      }

      case '/api/application-reviews/cover-letter': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async userId => {
          const body = await readBody();
          let selection;
          try { [selection] = reviewSelection([{ id: body?.id, revision: body?.revision }]); }
          catch (error) { return send({ error: (error as Error).message }, 400); }
          if (runner.inUse(userId)) return send({ error: 'Wait for the current run to finish before editing this application.' }, 409);
          try {
            const application = await editApplicationCoverLetter(userId, selection, body?.coverLetter);
            return send({ ok: true, application });
          } catch (error) { return send({ error: (error as Error).message }, 409); }
        });
      }

      case '/api/application-reviews/dismiss': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async userId => {
          const body = await readBody();
          try { await dismissApplicationReviews(userId, reviewSelection(body?.applications)); }
          catch (error) { return send({ error: (error as Error).message }, 400); }
          return send({ ok: true });
        });
      }

      case '/api/application-reviews/submit': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async userId => {
          const body = await readBody();
          if (body?.confirm !== true) return send({ error: 'Confirm the selected applications before submitting.' }, 400);
          const user = await currentUser(req.headers?.cookie);
          const result = await startRun({ userId, email: user?.email, mode: 'live', trigger: 'manual',
            approvals: body?.applications ?? [], initiatorDevice: runDeviceFromHeaders(req.headers) });
          return send(result.ok ? { ok: true } : { error: result.error }, result.ok ? 200 : result.status);
        });
      }

      case '/api/run/stop': {
        if (req.method !== 'POST') return send({ error: 'POST required' }, 405);
        return withUser(async (userId) => {
          const r = runner.stop(userId);
          return send(r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 409);
        });
      }

      case '/api/public/website': {
        if (req.method !== 'GET') return send({ error: 'GET required' }, 405);
        return publicWebsiteContent(url.searchParams.get('path') ?? '/', import.meta.dirname)
          .then(document => send(document ?? { error: 'Not found' }, document ? 200 : 404))
          .catch(() => send({ error: 'Public content is temporarily unavailable.' }, 503));
      }

      case '/api/run/stream': {
        return currentUser(req.headers?.cookie).then((user) => {
          if (!user) return send({ error: 'Sign in required.' }, 401);
          // The live console can contain an account's real name, suburb and
          // search terms (see main.ts's own startup logging), so the stream
          // is scoped to this account's own run and cannot reach another's.
          // Server-sent events: live console without polling.
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const since = Number(url.searchParams.get('since') ?? 0);
          for (const line of runner.backlog(user.id, since)) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
          const unsub = runner.subscribe(user.id, (line) => res.write(`data: ${JSON.stringify(line)}\n\n`));
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          req.on('close', () => {
            clearInterval(ping);
            unsub();
          });
        });
      }

      default:
        return send({ error: `unknown route ${route}` }, 404);
    }
  };

  return {
    name: 'seek-bot-data-api',
    // Braces matter: an arrow body would return `Server`, but the hook is void.
    configureServer(server) {
      server.middlewares.use(handler);
      server.middlewares.use(publicWebsiteProxy(process.env.PUBLIC_SITE_URL));
      server.middlewares.use(improvedStaticPages(import.meta.dirname,(url,html)=>server.transformIndexHtml(url,html)));
      server.middlewares.use(blogPages(resolve(import.meta.dirname, 'blog.html')));
      if (server.httpServer) { attachScreencast(server.httpServer); attachSigninVnc(server.httpServer); }
    },
    /**
     * Only the preview server schedules runs. Dev is someone's laptop with
     * the file watcher restarting it; applications must not go out from there.
     */
    configurePreviewServer(server) {
      server.middlewares.use(handler);
      server.middlewares.use(publicWebsiteProxy(process.env.PUBLIC_SITE_URL));
      server.middlewares.use(improvedStaticPages(resolve(import.meta.dirname,'dist')));
      server.middlewares.use(blogPages(resolve(import.meta.dirname, 'dist', 'blog.html')));
      if (server.httpServer) { attachScreencast(server.httpServer); attachSigninVnc(server.httpServer); }
      /**
       * Bring the database up to the code before anything queries it.
       *
       * schema.sql is idempotent, and a deploy that pulls new code without
       * running it leaves every query on a new column failing until someone
       * notices. A run could not even start that way. Doing it here means a
       * restart is the migration.
       */
      /**
       * The background workers wait for it, which is what "before anything
       * queries it" has to mean in practice.
       *
       * `void` here started them while the migration was still running, and
       * the autorun tick fires immediately on start. Its first query reads
       * users then resumes; the schema takes those two in the other order and
       * wants them exclusively, so Postgres saw a cycle and killed the tick —
       * four times on 18 September, every one of them within a minute of a
       * restart. Nothing was lost, the next tick a minute later found the
       * schema settled, and that is exactly why it survived unnoticed.
       *
       * `finally`, not `then`: a schema that fails to apply is already logged
       * and the workers already ran anyway. Sequencing them is the fix here;
       * refusing to start on a bad migration would be a different decision.
       */
      void dbMigrate()
        .then((r) => {
          if (!r.ok) console.error(`Database schema could not be applied: ${r.error}`);
          else startMarketingWorker();
        })
        .finally(() => {
          startAutoRunner();
          startVisitMaintenance();
          startProfileMaintenance();
          startHealthMaintenance();
          startTraceRetention();
          startProxyPool(() => runner.activeUserIds());
          startBlogScheduler();
        });

      /**
       * Leave nothing behind. pm2 stops this process with a signal; without
       * this the runs' and sign-ins' browsers outlive it, each still holding
       * an account's profile, and that account cannot run again until
       * someone finds the stray Chrome by hand.
       */
      let stopping = false;
      const shutdown = (signal: NodeJS.Signals) => {
        if (stopping) return;
        stopping = true;
        console.log(`[shutdown] ${signal}: stopping runs and sign-in browsers`);
        const runsStopped = runner.stopAll();
        stopMarketingWorker();
        const signinsStopped = stopAllSignins();
        // Keep the server alive through the 10-second escalation and browser cleanup.
        const shutdownDeadline = setTimeout(() => process.exit(1), 25_000);
        // Preserve the grace period for sign-in and marketing browser shutdown too.
        const browserGrace = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
        void Promise.all([runsStopped, signinsStopped, browserGrace]).finally(() => {
          clearTimeout(shutdownDeadline);
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
  };
}

/**
 * The public names this server answers to, behind the TLS proxy.
 *
 * `vite preview` refuses a request whose Host header it was not told about,
 * and the proxy passes the real one through, so the domain has to be declared
 * or every request from it returns "Blocked request". Taken from
 * `APP_BASE_URL` rather than written out here: one setting already decides the
 * public origin for magic links, Stripe redirects and the secure cookie, and a
 * second copy of it is a second thing to forget when the domain changes.
 */
function publicHosts(): string[] {
  const configured = process.env.APP_BASE_URL ?? readEnvSafe().APP_BASE_URL ?? '';
  try {
    const { hostname } = new URL(configured);
    if (!hostname || hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return [];
    return [hostname, hostname.startsWith('www.') ? hostname.slice(4) : `www.${hostname}`];
  } catch {
    return [];
  }
}

export default defineConfig({
  plugins: [react(), dataApi()],
  /**
   * The Reddit pixel id is baked in at build time. It is not a secret — every
   * visitor's browser is given it — but it does not belong in the source
   * either, so it comes from the same `.env` as everything else and the build
   * on the server picks it up. Empty when unset, which switches the pixel off
   * rather than loading it with a broken id.
   */
  define: {
    __REDDIT_PIXEL_ID__: JSON.stringify(process.env.REDDIT_PIXEL_ID ?? readEnvSafe().REDDIT_PIXEL_ID ?? ''),
    __META_PIXEL_ID__: JSON.stringify(process.env.META_PIXEL_ID ?? readEnvSafe().META_PIXEL_ID ?? ''),
  },
  /**
   * Not "spa": the app lives at / alone, with tabs in the query string, so
   * any other path is a mistake and should say so. In spa mode every typo
   * answered 200 with the landing page, which search engines index as a
   * duplicate of it.
   */
  appType: 'mpa',
  // Public content pages are plain HTML entries, so crawlers and visitors without scripts receive the whole page.
  build: { rollupOptions: { input: {
    main: 'index.html',
    guide: 'automate-job-applications-australia.html',
    privacy: 'privacy.html',
    terms: 'terms.html',
    // The shell server/blog/pages.ts renders posts into.
    blog: 'blog.html',
  } } },
  server: { port: 5180, open: true },
  /**
   * `open` is spelled out because preview inherits `server.open`: production runs
   * `vite preview` under pm2 with DISPLAY set, so every restart launched a Chrome
   * on the server showing this dashboard — about 580 MB that nobody was looking at.
   */
  preview: { allowedHosts: publicHosts(), open: false },
});
