import { hostOf as siteHost } from '../site-auth.js';
import { recordWall, walledHost } from '../site-walls.js';
import { commitAcceptedCredentials } from '../site-credentials.js';
import { recordFormPage } from '../form-corpus.js';
import { changedAnything, describeChanges, readChanges, startRecording, type PageChanges } from './page-changes.js';
import { lessonsFor, platformOf, reviewFailure } from './lessons.js';
import type { ApplicationAction } from '../types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'patchright';
import { measured } from '../pipeline.js';
import { config } from '../config.js';
import { jitter, waitForChallengeToClear, workingIn } from '../browser.js';
import { extractFields, readPickerOptions } from '../dom.js';
import type { CandidateProfile, JobListing, BlockedQuestion } from '../types.js';
import { CostMeter, celerisChat, type ChatMessage, type CelerisModel } from './celeris.js';
import { RunGuards, detectConfirmation, isExternal, listingIdIn, siteDomain } from './guards.js';
import { looksUnrendered, observe, waitForApplicationSurface } from './observe.js';
import { checkGeneralToolAnswers, executeTool, pageConfirmsSubmission, toolSchemas, type AgentTermination, type ToolContext, type ToolResult } from './tools.js';
import { embeddedSurface, watchTab } from './raw-tools.js';
import { isAustralianGovernmentUrl } from '../site-policy.js';
import { systemPrompt } from './loop/prompt.js';
import { LOOK_ONLY_TOOLS, GENERAL_TOOLS, MAX_PLAN, SURPRISE, missingRefs } from './loop/plan.js';
import { TraceStep, pathOf, hostOf, describeCall, TRACE_DIR, loadSiteHints, persistTrace, captureBlockedField } from './loop/trace.js';
import { trimTranscript, observationMessage, embeddedForms } from './loop/transcript.js';
import { confirmAuthentication } from './loop/accounts.js';
export * from './loop/prompt.js';
export * from './loop/plan.js';
export * from './loop/trace.js';
export * from './loop/transcript.js';
export * from './loop/accounts.js';

interface AgentRunResult {
  outcome: AgentTermination;
  captured: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  resumeUsed?: string;
  /** The board file name the resume went out as. */
  resumeName?: string;
  /** Side effects the candidate must be told about, whatever the outcome. */
  actions: ApplicationAction[];
  /** The employer site the attempt ended on, when it left the job board. */
  site?: string;
  /** The application's own submit control was pressed during this attempt. */
  submitPressed: boolean;
  steps: number;
  usage: string;
}

interface AgentRunOptions {
  page: Page;
  job: JobListing;
  profile: CandidateProfile;
  log?: (line: string) => void;
}

export async function runApplicationAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const { job, profile } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  /**
   * The tab being worked in. It changes: plenty of employer sites open the form,
   * or its next step, in a new tab. The agent used to keep looking at the tab it
   * started in, where nothing had changed, and press the same link again — a run
   * was found with the same application page open three times over, none of them
   * ever looked at. Whatever tab an action opened is where the application went.
   */
  let page = options.page;
  const tabsBefore = new Set(page.context().pages());
  const tabsLeft: Page[] = [];

  const meter = new CostMeter(config.celeris.budgetUsdPerApplication);
  const guards = new RunGuards({
    maxSteps: config.celeris.maxSteps,
    maxStepsPerPage: config.celeris.maxStepsPerPage,
    maxStuckMs: config.celeris.maxStuckMs,
    maxTotalMs: config.celeris.maxTotalMs,
    meter,
  });

  const ctx: ToolContext = {
    page,
    job,
    profile,
    guards,
    observation: { url: page.url(), title: '', actions: [], fields: [], text: '' },
    captured: [],
    log,
    actions: [],
  };

  /**
   * Which job this is, in a message of its own that is never compressed or
   * trimmed. It used to open the first page's description, so it went when
   * that page was compressed, and from the second page on the agent no longer
   * knew which job it was applying for — the one thing it needs on a careers
   * site that lands on a job list after sign-in. Kept out of the system prompt
   * so that prompt stays identical, and cached, across applications.
   */
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt() },
    // The listing's own words are data, quoted as such.
    { role: 'user', content: `APPLICATION: you are applying for the job titled ${JSON.stringify(job.title)} at ${JSON.stringify(job.company)} (${JSON.stringify(job.location)}). Every page from here on is part of this one application; if a site shows several jobs, this is the one to apply for.` },
  ];
  /**
   * Where each page description sits in the transcript.
   *
   * Only the page in front of the agent right now is worth its full weight.
   * Once it has moved on, the old description is dead space that still gets
   * re-sent every turn — by step twelve on an employer form that was ~26k
   * tokens per call and enough to exhaust the per-application spend cap twice
   * in one run. The tool results stay, so the agent still knows what it did;
   * it just stops re-reading pages it has already left.
   */
  const observationIndices: number[] = [];
  const compressSupersededObservations = () => {
    for (const index of observationIndices) {
      const message = messages[index];
      if (message?.role !== 'user') continue;
      const text = typeof message.content === 'string' ? message.content : '';
      const url = /^URL: (.+)$/m.exec(text)?.[1] ?? 'a previous page';
      messages[index] = { role: 'user', content: `[left ${url}]` };
    }
    observationIndices.length = 0;
  };
  let note = 'Complete this application. Begin by reading the page below.';
  /** Consecutive turns that produced no page change — the escalation trigger. */
  let stalls = 0;
  let repeats = 0;
  let lastSignature = '';
  /** A screenshot on the next turn, because the last action failed in a way text does not explain. */
  let needVision = false;
  /** The last turn's actions changed something in the page, as recorded there. */
  let lastChanged = false;
  /** A tool in the last turn reported a problem. */
  let lastFailed = false;
  /** Where and when verified progress happened, to confirm the sign-ins and sign-ups before it. */
  const progressLog: Array<{ site: string; at: string }> = [];
  /** Consecutive tool calls that threw; see the recovery note where tools run. */
  let toolErrors = 0;
  /** What the agent saw and did, step by step — kept for the dashboard when a person has to take over. */
  const trace: TraceStep[] = [];
  // Keep lightweight checkpoints even when Stop or a process exit prevents
  // the final trace from being written. Full screenshots remain in the final
  // trace; rewriting them after every action would amplify disk usage.
  const checkpoint = () => {
    try {
      mkdirSync(TRACE_DIR(), { recursive: true });
      writeFileSync(resolve(TRACE_DIR(), `${job.id}.live.json`), JSON.stringify({
        jobId: job.id, title: job.title, company: job.company,
        savedAt: new Date().toISOString(), status: 'in-progress',
        steps: trace.map(({ screenshot, ...step }) => step),
      }));
    } catch { /* Diagnostics must not interrupt an application. */ }
  };
  const hintedHosts = new Set<string>();
  let lastUrl = '';
  let lastFingerprint = '';
  /** The last tool only looked (a snapshot, a scroll): an unchanged page after it is not an action that failed. */
  let lastLookedOnly = false;

  const finish = async (ending: AgentTermination): Promise<AgentRunResult> => {
    /**
     * An attempt that ends on a limit or a stall after its submit was pressed
     * may have gone through: the page decides, through the independent
     * verifier, before it is reported as not sent (Accenture, 4 Oct: the
     * model allowance ran out on the step after Submit).
     */
    const outcome: AgentTermination = ending.status !== 'applied' && ending.status !== 'rehearsed' && ctx.submissionAttempted
      && await pageConfirmsSubmission(ctx)
      ? (log('  · the page confirms the application was received after the attempt ended'), { status: 'applied' })
      : ending;
    /**
     * What is actually worth asking the candidate: a required question the
     * profile could not answer. A control the form would not operate is not
     * one of them — their answer changes nothing about a dropdown that never
     * opens — so it stays a run outcome, with the form's own reason, instead
     * of arriving as a task they cannot complete.
     */
    /**
     * Only what the answerer itself said the profile cannot answer. A field
     * that had an answer and merely did not stay filled is the form's problem,
     * not a question: counting every required unfinished field here once put
     * four questions on a candidate's dashboard — salary, work rights, a
     * project, a motivation — all of which the agent had already answered from
     * their profile before a dialog swallowed the form.
     */
    const criticalQuestions = [...guards.ungrounded];
    const finalOutcome: AgentTermination =
      outcome.status === 'needs-human' && criticalQuestions.length === 0
        ? { status: 'skipped', reason: guards.unfillableReason() ?? outcome.reason }
        : outcome.status === 'needs-human'
          ? { ...outcome, reason: `Your answer is needed for: ${criticalQuestions.join('; ')}` }
          : outcome;
    /**
     * The technical detail goes to the log and the trace and stops there.
     * What leaves this function is written to the account's run events and
     * shown on the dashboard, so it carries only the plain reason.
     */
    if (outcome.status === 'needs-human' && outcome.detail) log(`  · ${outcome.detail}`);
    const visibleFields =
      finalOutcome.status === 'needs-human' && criticalQuestions.length
        ? await extractFields(page).catch(() => [])
        : [];
    const blockedQuestions = criticalQuestions.map((question) => {
      const shape = guards.fieldShapes.get(question);
      return {
        question,
        ...(shape?.prompt ? { prompt: shape.prompt } : {}),
        ...(shape?.kind ? { kind: shape.kind as BlockedQuestion['kind'] } : {}),
        ...(shape?.options?.length ? { options: shape.options } : {}),
        ref: visibleFields.find((field) => field.label === question)?.ref ?? shape?.ref,
      };
    });

    /**
     * A dropdown keeps its choices in a popup, so extraction never saw them
     * and the candidate was asked to free-type an answer to "Select an
     * option". Before handing these questions over, open each unanswered
     * picker and record what it really offers, so Needs attention shows the
     * employer's own list. Only for fields that blocked, and only when the
     * page is still open.
     */
    if (finalOutcome.status === 'needs-human') {
      for (const blocked of blockedQuestions) {
        if (blocked.options?.length || !blocked.ref) continue;
        const field = visibleFields.find((candidate) => candidate.ref === blocked.ref);
        const looksLikePicker =
          field?.autocomplete === true ||
          field?.kind === 'select' ||
          /select an option|choose|please select/i.test(`${blocked.question} ${blocked.prompt ?? ''}`);
        if (!looksLikePicker) continue;
        const options = await readPickerOptions(page, blocked.ref).catch(() => []);
        if (options.length > 1) blocked.options = options;
      }
    }
    if (finalOutcome.status === 'needs-human') {
      for (const blocked of blockedQuestions) {
        const screenshot = await captureBlockedField(page, blocked.ref, blocked.question);
        trace.push({
          step: trace.reduce((highest, item) => Math.max(highest, item.step), 0) + 1,
          url: page.url(),
          tool: 'needs_human',
          args: { field: blocked.question },
          label: `Needs your answer: ${blocked.prompt ?? blocked.question}`,
          result: `Employer field: ${blocked.question}`,
          screenshot,
        });
      }
    }
    persistTrace(job, finalOutcome, trace, page.url());
    confirmAuthentication(ctx.actions, progressLog, finalOutcome.status === 'applied' ? siteDomain(page.url()) : null);
    /**
     * A password Owtomate set is remembered once the site accepted it: the
     * account was created, or the application got in past the sign-in. It
     * used to be written when the form was filled, so a sign-up refused
     * because Owtomate's own 17 Sep Macquarie account already existed
     * replaced that account's password with one it never had, and every
     * later sign-in failed.
     */
    commitAcceptedCredentials(ctx.pendingCredentials, ctx.actions, ctx.profile.email);
    /**
     * A site Owtomate could not sign in to, which the attempt never got past,
     * is walled for the day like a failed security check. Its account exists
     * under a password Owtomate does not hold and its reset mail does not
     * come: Macquarie's portal cost four attempts across two runs on 3 Oct,
     * three to five minutes each, ending the same way every time.
     */
    // A failed employer-site attempt is reviewed in the background, and its lesson kept for the platform.
    if ((finalOutcome.status === 'skipped' || finalOutcome.status === 'needs-human') && isExternal(page.url())) {
      reviewFailure({
        host: siteHost(page.url()), company: job.company, title: job.title,
        reason: `${finalOutcome.reason}${outcome.status === 'needs-human' && outcome.detail ? ` (${outcome.detail})` : ''}`,
        steps: trace.map(({ tool, args, result, url }) => ({ tool, args, result, url })),
      });
    }
    if (finalOutcome.status !== 'applied' && finalOutcome.status !== 'rehearsed') {
      for (const action of ctx.actions) {
        if (action.kind !== 'authentication-prepared' || action.purpose !== 'sign_in') continue;
        const gotIn = ctx.actions.some((known) => (known.kind === 'signed-in' || known.kind === 'account-created') && known.site === action.site);
        if (!gotIn) recordWall(action.site, 'Owtomate could not sign in to this site and its password reset did not come through.', job.company);
      }
    }
    const plain: AgentTermination = finalOutcome.status === 'needs-human' ? { ...finalOutcome, detail: undefined } : finalOutcome;
    return {
      // Every needs-human carries the questions the profile could not answer, so
      // the dashboard can ask the candidate once and reuse the answers.
      outcome:
        plain.status === 'needs-human'
          ? {
              ...plain,
              questions: blockedQuestions.map(({ ref: _ref, ...question }) => question),
            }
          : plain,
      captured: ctx.captured,
      coverLetter: ctx.coverLetter,
      resumeUsed: ctx.resumeUsed,
      resumeName: ctx.resumeName,
      actions: ctx.actions,
      // An application finished on an employer's own site is reported as such.
      ...(isExternal(page.url()) ? { site: siteHost(page.url()) } : {}),
      submitPressed: Boolean(ctx.submissionAttempted),
      steps: guards.stepCount,
      usage: meter.summary(),
    };
  };

  await workingIn(page);
  watchTab(page, ctx);
  /** Where the latest take_snapshot result sits, so an older one stops being re-sent. */
  let lastSnapshotIndex = -1;
  for (;;) {
    const opened = page.context().pages().filter((tab) => !tabsBefore.has(tab) && !tab.isClosed()).at(-1);
    for (const tab of page.context().pages()) tabsBefore.add(tab);
    if (opened) {
      log('  ↪ the site continued in a new tab; following it');
      tabsLeft.push(page);
      page = opened;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else if (page.isClosed() && tabsLeft.length) {
      // A tab that closes itself hands the application back to the one that opened it.
      page = tabsLeft.pop()!;
    }
    if (ctx.page !== page) {
      ctx.page = page;
      await workingIn(page);
    }
    watchTab(page, ctx);
    /**
     * Deterministic checks run before the model gets a turn, in this order.
     * Confirmation is first — before the step budget too, so a sent
     * application is never reported as out of steps — and before friction,
     * because SEEK renders a SEEK Pass upsell on its own success page, which
     * the friction detector reads as a wall: reporting a submitted
     * application as needs-human would leave it unrecorded and set up a
     * duplicate on the next run.
     */
    if (await detectConfirmation(page)) return finish({ status: 'applied' });
    const budget = guards.nextStep();
    if (!budget.ok) return finish({ status: 'needs-human', reason: budget.reason, detail: budget.detail });

    // Another job's listing means this application's form is gone; nothing done on that page is for this job.
    const listing = listingIdIn(page.url());
    if (listing && listing !== job.id) {
      return finish({ status: 'skipped', reason: 'The application form closed before it was finished.' });
    }

    // A site whose check stopped an application within the day stops this one before any work on it.
    const wall = isExternal(page.url()) ? walledHost(siteHost(page.url()), job.company) : null;
    if (wall) {
      return finish({ status: 'skipped', reason: `${siteHost(page.url())} is not attempted today: ${wall.reason}` });
    }

    if (isAustralianGovernmentUrl(page.url())) {
      return finish({ status: 'skipped', reason: 'Australian government application sites are excluded.' });
    }
    if (isExternal(page.url()) && !config.allowExternalApply) {
      return finish({ status: 'off-platform', redirectedTo: page.url() });
    }

    /**
     * Security checks are infrastructure, not application-form decisions.
     * Resolve them before the model sees the page so it cannot click the
     * checkbox, mistake it for consent, or reload the verification page.
     */
    if (!(await waitForChallengeToClear(page, 60_000))) {
      const reason = 'The site security verification could not be cleared automatically.';
      if (isExternal(page.url())) recordWall(siteHost(page.url()), reason);
      return finish({ status: 'needs-human', reason, detail: 'CAPTCHA remained after the automatic solver attempt' });
    }

    /**
     * Never let the model see a half-rendered page. An empty observation is a
     * loading signal, not a "nothing to apply to" signal, and treating it as
     * the latter is how a good Quick Apply flow gets abandoned.
     */
    await waitForApplicationSurface(page);
    const wantScreenshot = config.celeris.useScreenshots && (stalls > 0 || needVision || Boolean(ctx.wantScreenshot));
    needVision = false;
    ctx.wantScreenshot = false;
    ctx.observation = await observe(page, { screenshot: wantScreenshot });
    for (let retry = 0; retry < 3 && looksUnrendered(ctx.observation); retry++) {
      // Cold SPA bundles on SEEK's apply flow have taken north of 15s to
      // hydrate. Keep waiting rather than asking the model about a blank page.
      await waitForApplicationSurface(page, 10_000);
      await jitter(800, 1_500);
      ctx.observation = await observe(page, { screenshot: wantScreenshot });
    }
    // Each distinct employer form page is kept for replay after code changes (form-corpus.ts).
    if (isExternal(page.url())) await recordFormPage(page, ctx.observation);

    /**
     * The page of the form this step is on: its path and its headings. A long
     * form earns steps by moving through its pages; one page does not.
     */
    const headings = await page
      .evaluate(() =>
        [...document.querySelectorAll('h1, h2, [role="heading"][aria-level="1"], [role="heading"][aria-level="2"]')]
          .map((node) => (node as HTMLElement).innerText?.trim() ?? '')
          .filter(Boolean)
          .slice(0, 3)
          .join('|'),
      )
      .catch(() => '');
    // What the form holds now outranks what a tool reported earlier; the pre-submit check reviews anything settled this way.
    const settled = guards.reconcileWithForm(ctx.observation.fields);
    if (settled.length) {
      ctx.rawUsed = true;
      log(`  · the form now holds an answer for ${settled.map((label) => `"${label}"`).join(', ')}`);
    }
    const pageBudget = guards.onPage(`${pathOf(page.url())}#${headings}`);
    if (!pageBudget.ok) return finish({ status: 'needs-human', reason: pageBudget.reason, detail: pageBudget.detail });

    // A page that has not changed since the last turn means the previous action
    // did nothing. Say so explicitly rather than letting the model repeat it.
    const fingerprint = JSON.stringify({
      actions: ctx.observation.actions.map(a => [a.text, a.disabled]),
      fields: ctx.observation.fields.map(f => [f.label, f.currentValue, f.options]),
      text: ctx.observation.text,
      // The observation is the main frame's; work inside an embedded form is progress too.
      embedded: config.celeris.rawTools ? await embeddedSurface(page) : '',
    });
    if (page.url() === lastUrl && fingerprint === lastFingerprint && (lastLookedOnly || lastChanged)) {
      // Looking is not failing (PERSOL's form was abandoned after scrolls and snapshots counted as six dead actions),
      // and an action the page visibly reacted to is not a dead one, whatever the observation's summary shows.
    } else if (page.url() === lastUrl && fingerprint === lastFingerprint) {
      stalls += 1;
      note = `${note}\n\nNOTE: nothing in the page changed in response to your last action (recorded in the page itself). Try a different approach.`;
      const disabledForward = ctx.observation.actions.find(action =>
        action.disabled && /\b(?:continue|next|review|submit|send application|apply)\b/i.test(action.text),
      );
      const visibleRequired = ctx.observation.fields.filter(field => field.required);
      const promotional = ctx.observation.fields.filter(field =>
        /\b(?:marketing|promotional|job alerts?|notifications?|calls?|texts?|sms|updates?)\b/i.test(field.label),
      );
      if (stalls >= 2 && disabledForward && visibleRequired.length === 0) {
        note +=
          `\nThe forward control "${disabledForward.text}" is disabled but no required FIELD is visible.` +
          (promotional.length
            ? ` The remaining ${promotional.map(field => `"${field.label}"`).join(', ')} field(s) are optional opt-ins; do not change them.`
            : '') +
          ' Treat this as an unfinished/loading form: use wait_for_page once, then reload_page once if it is still unchanged, and re-inspect.';
      }
      // Six actions without any effect is a wall, whatever they were called; stop spending the budget on it.
      if (stalls >= 6) {
        return finish({
          status: 'needs-human',
          reason: 'The page did not change in response to anything the agent tried.',
          detail: 'no progress after six actions on the same page',
        });
      }
    } else {
      stalls = 0;
      guards.recordProgress();
    }
    lastUrl = page.url();
    lastFingerprint = fingerprint;

    /**
     * Magnus reasons from every step. Trialled against celeris-1 for routine
     * steps on 2 Oct 2026 (4 runs each, same fixture application): both
     * finished in 5 steps with no failures, and celeris-1 was no faster
     * (133-147 s against 133-137 s). The step model is not where the time goes.
     */
    const model: CelerisModel = 'celeris-1-magnus';
    /**
     * Thinking harder where it pays. A routine step reasons briefly; a step
     * on a page that is not moving reasons at length, with the screenshot in
     * front of it and an explicit request to step back and form a theory
     * before acting. Paid only on the steps that are stuck.
     */
    const stuck = stalls >= config.celeris.escalateAfterStalls || lastFailed;
    if (stuck) {
      log(`  ↑ step ${guards.stepCount} stuck — ${model} thinking it through`);
      note = `${note}\n\nSTUCK: the last ${Math.max(stalls, 1)} action(s) did not get this page further. Before acting, reason it through: what you expected, what the recorded changes and the screenshot actually show, and why your approach is not working. Then try a genuinely different approach (another control or element, the keyboard, a snapshot to find the real element, a script to inspect the widget), not the same action again.`;
    }

    /**
     * Site hints: what worked on this host before, offered once as guidance.
     * A guide rather than a script — the page in front of the agent decides.
     */
    const host = hostOf(page.url());
    if (host && !hintedHosts.has(host)) {
      hintedHosts.add(host);
      const hint = loadSiteHints()[host];
      if (hint?.steps.length) {
        note = `${note}\n\nOn ${host} an earlier application succeeded with these steps (a guide, not a script):\n${hint.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`;
      }
      const lessons = isExternal(page.url()) ? lessonsFor(host) : [];
      if (lessons.length) {
        note = `${note}\n\nLessons from earlier attempts on ${platformOf(host)} forms, written after they failed (guidance, not rules; the page in front of you decides):\n${lessons.map((lesson) => `- ${lesson}`).join('\n')}`;
      }
    }

    if (ctx.dialogs?.length) {
      note = [ctx.dialogs.join('\n'), note].filter(Boolean).join('\n\n');
      ctx.dialogs = [];
    }
    if (config.celeris.rawTools) {
      note = [note, await embeddedForms(page)].filter(Boolean).join('\n\n');
    }

    compressSupersededObservations();
    observationIndices.push(messages.length);
    messages.push(observationMessage(ctx.observation, note));
    note = '';

    const trimmed = trimTranscript(messages, config.celeris.maxTranscriptTokens);
    const reply = await celerisChat({
      model,
      messages: trimmed,
      tools: toolSchemas({ vision: Boolean(ctx.observation.screenshot) }),
      requireTool: true,
      thinking: true,
      reasoningEffort: stuck ? 'xhigh' : 'low',
      meter,
    });

    /**
     * A plan for the page: the model may return several actions in the order
     * to take them (answer the fields, choose the options, attach, then the
     * forward control), and they run one after another without a model call
     * between them. Each is checked as it runs; the first surprise — a tool
     * reporting a problem, the page navigating or opening something new, a
     * planned ref no longer on the page — stops the rest, and the model sees
     * what happened and plans again.
     */
    const plan = reply.toolCalls.slice(0, MAX_PLAN);
    if (!plan.length) {
      // Nothing actionable came back. One nudge, then treat it as stuck.
      messages.push(reply.message);
      messages.push({ role: 'user', content: 'Call at least one tool. Choose refs from the observation above.' });
      stalls += 1;
      if (stalls >= config.celeris.escalateAfterStalls + 2) {
        return finish({
          status: 'needs-human',
          reason: 'The agent could not work out a next step on this page.',
          detail: 'the agent stopped proposing actions',
        });
      }
      continue;
    }

    /**
     * The same plan, again and again, on a page that is not changing is a
     * loop, not progress. One form ate 22 identical clicks before the step
     * budget ended it; stopping at the fourth saves the budget and the money.
     */
    const signature = plan.map((call) => `${call.name}:${JSON.stringify(call.args)}`).join('|');
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 3 && stalls >= 2) {
      return finish({
        status: 'needs-human',
        reason: 'The agent kept repeating the same action with no effect.',
        detail: `stuck repeating ${plan[0].name} with no effect on the page`,
      });
    }

    messages.push(reply.message);
    if (plan.length > 1) log(`  ▸ plan: ${plan.map((call) => call.name).join(' → ')}`);
    lastLookedOnly = plan.every((call) => LOOK_ONLY_TOOLS.has(call.name));
    lastChanged = false;
    lastFailed = false;
    const replies: Array<{ id: string; content: string }> = [];
    let ended: ToolResult | null = null;

    for (const [index, call] of plan.entries()) {
      if (index > 0) {
        // Every later step is checked against the page as it now is.
        const missing = await missingRefs(page, call.args);
        if (missing.length) {
          replies.push({ id: call.id, content: `Not run: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no longer on the page after the step before. Plan again from the fresh observation.` });
          continue;
        }
      }
      if (process.env.DEBUG_STEPS === 'true') log(`    step ${guards.stepCount}: ${call.name}(${JSON.stringify(call.args).slice(0, 120)})`);
      if (index > 0) {
        const budget = guards.nextStep();
        if (!budget.ok) return finish({ status: 'needs-human', reason: budget.reason, detail: budget.detail });
      }

      const step: TraceStep = {
        step: guards.stepCount,
        url: page.url(),
        tool: call.name,
        args: call.args,
        label: describeCall(ctx, call.name, call.args),
        screenshot: index === 0
          ? ctx.observation.screenshot ?? (await page.screenshot({ type: 'jpeg', quality: 35 }).then((b) => `data:image/jpeg;base64,${b.toString('base64')}`).catch(() => undefined))
          : undefined,
      };
      trace.push(step);
      checkpoint();

      const progressBefore = guards.progressCount;
      const looking = LOOK_ONLY_TOOLS.has(call.name);
      const startedAt = looking ? '' : await startRecording(page).catch(() => '');
      let result: ToolResult;
      try {
        result = await measured(`tool:${call.name}`, () => executeTool(ctx, call.name, call.args), { jobId: job.id });
        toolErrors = 0;
        if (guards.progressCount > progressBefore && call.name !== 'complete_authentication') {
          progressLog.push({ site: siteDomain(ctx.page.url()), at: new Date().toISOString() });
        }
      } catch (error) {
        const message = (error as Error).message.split('\n')[0].slice(0, 300);
        step.result = `Tool failed: ${message}`;
        checkpoint();
        /**
         * A thrown tool is usually the page, not the application: an overlay
         * intercepting a click, a control re-rendered mid-action. The agent gets
         * the error and a fresh look, as a person would retry. Only a closed
         * browser, or the same breakage three times running, ends the attempt —
         * as a skip, because the candidate cannot fix a site's technical fault
         * and "Needs attention" is kept for questions only they can answer.
         */
        if (/Target (page|closed)|browser has been closed|context or browser has been closed/i.test(message) || ++toolErrors >= 3) {
          log(`  · ${call.name} failed: ${message}`);
          return finish({ status: 'skipped', reason: 'A step on the employer site kept failing.' });
        }
        result = { kind: 'ok', message: `${call.name} failed: ${message}. Re-observe the page and try a different way to reach the same goal.` };
      }

      // What the action really did, recorded in the page, goes with what the tool said.
      let changes: PageChanges | null = null;
      if (result.kind === 'ok' && !looking && startedAt && ctx.page === page && !page.isClosed()) {
        changes = await readChanges(page, startedAt).catch(() => null);
        if (changes) {
          // Answers a general tool set are checked against the record now, not three pages later at submit.
          const check = GENERAL_TOOLS.has(call.name) ? await checkGeneralToolAnswers(ctx, changes.controls).catch(() => '') : '';
          if (/NOT SUPPORTED/.test(check)) lastFailed = true;
          result = { kind: 'ok', message: `${result.message}\n${describeChanges(changes)}${check}` };
          if (changedAnything(changes)) lastChanged = true;
          else ctx.wantScreenshot = true;
        }
      }

      step.result = result.kind === 'ok' ? result.message.slice(0, 600) : `ended: ${result.outcome.status}`;
      checkpoint();

      if (result.kind === 'terminal') {
        ended = result;
        replies.push({ id: call.id, content: 'The attempt ended here.' });
        break;
      }

      // Answering questions, attaching a resume or writing the letter all move the
      // application forward without necessarily changing the page, so they reset
      // the stuck timer just as a navigation does.
      if (['add_cover_letter', 'attach_resume'].includes(call.name) && !/could not|unavailable|failed|refused/i.test(result.message)) {
        guards.recordProgress();
      }

      if (call.name === 'take_snapshot') {
        // Only the newest snapshot is worth its weight; an older one is re-sent every turn for nothing.
        if (lastSnapshotIndex >= 0 && messages[lastSnapshotIndex]?.role === 'tool') {
          messages[lastSnapshotIndex] = { ...messages[lastSnapshotIndex], content: '[an earlier snapshot, superseded]' } as ChatMessage;
        }
        lastSnapshotIndex = messages.length + replies.length;
      }
      replies.push({ id: call.id, content: result.message });

      const surprise = SURPRISE.test(result.message) || Boolean(changes?.navigated) || ctx.page !== page
        || Boolean(changes?.appeared.some((entry) => entry.startsWith('[')));
      if (SURPRISE.test(result.message)) lastFailed = true;
      if (surprise && index < plan.length - 1) {
        for (const skipped of plan.slice(index + 1)) {
          replies.push({ id: skipped.id, content: 'Not run: the step before did not go as planned. Look at what happened and plan again from the fresh observation.' });
        }
        break;
      }
      if (index < plan.length - 1) await jitter(250, 600);
    }

    for (const entry of replies) messages.push({ role: 'tool', tool_call_id: entry.id, content: entry.content });
    if (ended && ended.kind === 'terminal') {
      // The confirmation page is authoritative even here: a submit click that
      // succeeded should be reported as applied, not as whatever the tool said.
      if (await detectConfirmation(page)) return finish({ status: 'applied' });
      return finish(ended.outcome);
    }
    needVision = lastFailed;

    // A tool may have moved the work to another tab (select_page).
    if (ctx.page !== page && !ctx.page.isClosed()) {
      tabsLeft.push(page);
      page = ctx.page;
    }
    await jitter(400, 1_100);
  }
}
