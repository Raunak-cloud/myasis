import { plainReason } from './run-messages.ts';

export interface LogLine {
  seq: number;
  ts?: string;
  stream: 'out' | 'err' | 'sys';
  text: string;
}

export function runResultLabel(status: { running: boolean; finishedAt: string | null; exitCode: number | null; connectionLost?: boolean } | null, lines: LogLine[] = []): string {
  if (!status || status.connectionLost) return 'Checking status';
  if (status.running) return 'In progress';
  if (!status.finishedAt) return 'Ready';
  if (lines.some(line => /stop requested/i.test(line.text))) return 'Stopped';
  if (status.exitCode !== 0) return 'Stopped early';
  if (lines.some(line => /✗\s+(?:unexpected )?error:|Submission not confirmed:|^Fatal:|time limit; stopping the worker/i.test(line.text))) return 'Finished with issues';
  return 'Finished';
}

type ActivityTone = 'done' | 'neutral' | 'warn' | 'bad';
type ActivityOutcome = 'already-applied' | 'skipped' | 'needs-human' | 'failed' | 'unconfirmed' | 'prepared';
type OutcomeCounts = Record<ActivityOutcome, number>;

interface ActivityEvent {
  id: string;
  title: string;
  detail?: string;
  tone: ActivityTone;
  outcome?: ActivityOutcome;
  /** Elapsed application attempt time, included only for admins with valid timestamps. */
  durationMs?: number;
  /** What the run is doing right now: drawn with a live pulse while the run lasts. */
  live?: boolean;
}

function lastMatch(lines: LogLine[], pattern: RegExp): RegExpMatchArray | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].text.match(pattern);
    if (match) return match;
  }
  return null;
}

const cardRejection = /^\s*✗\s+.+\(from the search result(?:; not opened)?\)$/;

export function activitySummary(lines: LogLine[]) {
  const originalLines = lines;
  lines = lines.map(line => ({ ...line, text: line.text.replace(/^\[worker:[a-z]+\] /, '') }));
  const found = Number(lastMatch(lines, /(\d+) unique listings discovered/i)?.[1] ?? 0);
  const restored = lines.filter((line) => /^\s*Review slot restored:/.test(line.text)).length;
  const reviewed = Math.max(0, lines.filter((line) => /^\s*[✓✗]\s+\d+\s+·/.test(line.text) || cardRejection.test(line.text)).length - restored);
  // Matches are counted as they are found; the end-of-run total wins once it is printed.
  const suitable = Math.max(
    lines.filter((line) => /^\s*✓\s+\d+\s+·/.test(line.text)).length - restored,
    Number(lastMatch(lines, /(\d+) qualifying jobs/i)?.[1] ?? 0),
  );
  /**
   * Counted from the log like the other three, rather than read from the run
   * status. The status reports what is running now, so the moment a run ends
   * its `applied` goes back to zero and the finished summary read "0
   * Submitted" beside a log that plainly listed four.
   */
  const submitted = lines.filter((line) => /✅\s*submitted/i.test(line.text)).length;
  const prepared = lines.filter((line) => /^\s*Ready for confirmation:/i.test(line.text)).length;
  const outcomeSummary = activityEvents(originalLines, Infinity).find((event) => event.title === 'Run complete')?.detail ?? null;
  return { found, reviewed, suitable, submitted, prepared, outcomeSummary, shortfall: reviewShortfall(lines, reviewed) };
}

/**
 * Why a finished run reviewed fewer jobs than its limit, from the bot's own
 * "Filtered out" tally. "Reviewed 26" beside a limit of 100 reads as a
 * fault; almost always the search simply ran out of new listings, most of
 * them already checked in the last week. Null when there is nothing to
 * explain: the run is still going, or it did reach its limit.
 */
function reviewShortfall(lines: LogLine[], reviewed: number): string | null {
  if (!lastMatch(lines, /=== Run complete/)) return null;
  if (lastMatch(lines, /evaluation cap \(\d+\) reached/i)) return null;
  const limit = Number(lastMatch(lines, /\sMAX_EVALUATIONS=(\d+)/)?.[1] ?? 0);
  if (!limit || reviewed >= limit) return null;

  const groups: Array<[RegExp, string]> = [
    [/^unchanged rejection$|^recent fit-mismatch$|^recent below-score$/, 'previously rejected and unchanged'],
    [/^recent /, 'recently checked'],
    [/^listing age$|^posted /, 'past your age limit'],
    [/outside run scope|external application disabled/, 'of an application type this run skipped'],
    [/^excluded company/, 'from companies you excluded'],
    [/waiting for your answer/, 'waiting on your answer'],
    [/government/i, 'on government sites'],
    [/already applied/, 'already applied to'],
  ];
  const counts = new Map<string, number>();
  const start = lines.findIndex((line) => /^Filtered out:/.test(line.text.trim()));
  for (const line of start >= 0 ? lines.slice(start + 1) : []) {
    const match = line.text.match(/^\s*(\d+) × (.+)$/);
    if (!match) {
      if (line.text.trim()) break;
      continue;
    }
    const label = groups.find(([pattern]) => pattern.test(match[2].trim()))?.[1];
    if (label) counts.set(label, (counts.get(label) ?? 0) + Number(match[1]));
  }
  const reasons = [...counts].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} ${label}`);
  return `This run reviewed ${reviewed} ${reviewed === 1 ? 'job' : 'jobs'} out of a limit of ${limit}.` +
    (reasons.length ? ` Not reviewed: ${reasons.join(', ')}.` : '') +
    ' You can change your job titles to widen the search.';
}

/**
 * Translate diagnostics before displaying them. Admins can see the original
 * first line here and the full diagnostic in the admin run console.
 */
export function formatActivityReason(raw: string, isAdmin = false): string {
  const message = ((isAdmin ? raw : plainReason(raw))
    .replace(/^(?:Error:\s*)+/i, '')
    .split(/\r?\n|\s+Call log:/)[0]
    .trim()
    .slice(0, 300) || 'An unknown error occurred.').replace(/[.\s]+$/, '');
  const nextSteps: Array<[RegExp, string]> = [
    [/already running with this profile/i, 'Another application run is still active. Wait for it to finish.'],
    [/search terms or target role/i, 'Add job titles under Your search, then start the run again.'],
    [/matching service is not configured|CELERIS_API_KEY/i, 'An AI service key is missing on the server, so an admin needs to add it.'],
    [/browser has disconnected|has been closed|Target closed/i, 'The browser closed during the run. Start the run again.'],
    [/Timeout \d+ms exceeded|timed out/i, 'The page was slow to respond. Please try again later.'],
    [/net::ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i, 'The connection dropped for a moment. Start the run again.'],
  ];
  const next = nextSteps.find(([pattern]) => pattern.test(message))?.[1];
  if (isAdmin) return next ? `${message}. ${next}` : `${message}.`;
  const plain = plainReason(message).replace(/[.\s]+$/, '');
  if (plain !== message) return /[!?]$/.test(plain) ? plain : `${plain}.`;
  // Known recovery steps explain the problem without exposing the diagnostic.
  return next ? plainReason(next) : /[!?]$/.test(plain) ? plain : `${plain}.`;
}

/**
 * The run as a person would tell it: what happened, in a handful of lines.
 *
 * Built from the bot's own log, but not one line per log line. Steps that
 * repeat become one line that updates: sign-in to each board is one step,
 * reviewing is one step whose counts climb, each application is one step
 * whose outcome replaces "Applying". Steps that say nothing are left out —
 * "0 Indeed Recommended jobs prioritised" told the person nothing they could
 * use. What the run is doing now is marked live, so there is always one
 * clear answer to "what is it doing?".
 */
export function activityEvents(lines: LogLine[], limit = 14, isAdmin = false): ActivityEvent[] {
  const readableError = (raw: string) => formatActivityReason(raw, isAdmin);
  const events: ActivityEvent[] = [];
  // Several listings can share one visible entry. Count each logged outcome
  // independently so merging entries cannot create an unexplained remainder.
  const outcomes: OutcomeCounts = { 'already-applied': 0, skipped: 0, 'needs-human': 0, failed: 0, unconfirmed: 0, prepared: 0 };
  const confirming = lines.some(line => /APPLICATION_REVIEW_MODE=approved\b/.test(line.text));
  const recordOutcome = (event: ActivityEvent, outcome: ActivityOutcome) => {
    outcomes[outcome]++;
    event.outcome = outcome;
  };
  const add = (line: LogLine, title: string, tone: ActivityTone, detail?: string, distinct = false): ActivityEvent => {
    const previous = events.at(-1);
    if (!distinct && previous?.title === title && previous.detail === detail) return previous;
    const event: ActivityEvent = { id: `${line.seq}`, title, detail, tone };
    events.push(event);
    return event;
  };
  const listing = (rest: string) => {
    const match = rest.match(/^(.+?)\s+@\s+(.+?)(?:\s+\(|\s+—|\s+\[|$)/);
    return match ? { title: match[1].trim(), company: match[2].trim() } : { title: rest.trim(), company: '' };
  };
  /** The job in progress, so a failure can say which application it was. */
  let currentJob = '';
  /** The last thing the run printed as an error, for a run that exits without saying why. */
  let lastErrorOutput = '';
  /** Whether the reason the run stopped has already been shown. */
  let explained = false;
  let boards: string[] = [];
  let boardsEvent: ActivityEvent | null = null;
  let applicationLimitEvent: ActivityEvent | null = null;
  let review: ActivityEvent | null = null;
  let reviewed = 0;
  let suitable = 0;
  let latestMatch = '';
  const matchedJobs: string[] = [];
  type Application = { event: ActivityEvent; title: string; company: string; steps: string[]; startedAtMs: number };
  let application: Application | null = null;
  const applications = new Map<string, Application>();
  // The old sole-agent finish schema could not save questions. Its needs-human
  // judgements never created actionable tasks; do not direct old runs to an empty page.
  const questionlessJudgements = new Set<string>();
  const currentJobs = new Map<string, string>();
  let finished = false;
  let stopNotice: ActivityEvent | null = null;

  const reviewDetail = () =>
    `${reviewed} checked · ${suitable} profile ${suitable === 1 ? 'match' : 'matches'}` + (latestMatch ? ` · latest match: ${latestMatch}` : '');
  const applicationDetail = (extra?: string) =>
    [application?.company, ...(application?.steps ?? []), extra].filter(Boolean).join(' · ');
  const applicationLimit = (line: LogLine, title: string, detail: string) => {
    if (applicationLimitEvent) {
      applicationLimitEvent.title = title;
      applicationLimitEvent.detail = detail;
    } else applicationLimitEvent = add(line, title, 'done', detail);
  };
  const finishApplication = (line: LogLine) => {
    if (!application) return;
    const finishedAtMs = line.ts ? Date.parse(line.ts) : Number.NaN;
    if (isAdmin && Number.isFinite(application.startedAtMs) && Number.isFinite(finishedAtMs) && finishedAtMs >= application.startedAtMs) {
      application.event.durationMs = finishedAtMs - application.startedAtMs;
    }
    application = null;
  };

  for (const line of lines) {
    const worker = line.text.match(/^\[worker:([a-z]+)\] /)?.[1] ?? 'serial';
    const text = line.text.replace(/^\[worker:[a-z]+\] /, '').trim();
    application = applications.get(worker) ?? null;
    currentJob = currentJobs.get(worker) ?? '';
    let match: RegExpMatchArray | null;
    if (line.stream === 'err' && text && !/^Warning:|^at\s/.test(text)) lastErrorOutput = text.replace(/^Fatal:\s*/i, '');

    if (/starting (live|search) run/i.test(text)) {
      add(line, 'Run started', 'done');
    } else if (/stop requested/i.test(text)) {
      stopNotice = add(line, 'Stopping run', 'neutral', 'Your stop request was received. Applications already submitted stay submitted.');
      explained = true;
    } else if (/Run reached its .+ time limit; stopping the worker/i.test(text)) {
      stopNotice = add(line, 'Run time limit reached', 'warn', 'This run is stopping because it reached its time limit. Applications already submitted stay submitted.');
      explained = true;
    } else if ((match = text.match(/(SEEK|Indeed) session OK/i))) {
      if (!boards.includes(match[1])) boards = [...boards, match[1]];
      const title = `Signed in to ${boards.join(' and ')}`;
      if (boardsEvent) boardsEvent.title = title;
      else boardsEvent = add(line, title, 'done');
    } else if (/(SmartRecruiters|Lever|Greenhouse|PageUp|Workday) public job feed ready/i.test(text)) {
      add(line, `Searching ${text.match(/(SmartRecruiters|Lever|Greenhouse|PageUp|Workday) public job feed ready/i)?.[1]} jobs`, 'done', 'Looking for Australian vacancies at your selected employers.');
    } else if (/! (SmartRecruiters|lever|greenhouse|pageup|workday) employer .+ could not be searched:/i.test(text)) {
      add(line, 'Some employer jobs could not be searched', 'warn', 'Your search will continue with the other employers.');
    } else if ((match = text.match(/(SEEK|Indeed) Recommended -> (\d+)/i))) {
      // A feed with nothing in it is not news.
      if (Number(match[2]) > 0) add(line, `${match[1]} recommended ${match[2]} jobs for you`, 'done', 'New listings take priority over previously rejected jobs.');
    } else if ((match = text.match(/⚠ (SEEK|Indeed|SmartRecruiters|Lever|Greenhouse|PageUp|Workday):\s*(.*)/i))) {
      const accountActionNeeded = /sign(?:ed)? in|verification|cloudflare|captcha/i.test(text);
      const leftOut = /left out for the rest of this run/i.test(text);
      add(
        line,
        leftOut ? `${match[1]} blocked this run, so it continues on the other board` : `${match[1]} could not be used this run`,
        leftOut ? 'warn' : 'bad',
        leftOut
          ? `${match[1]} asked for a security check that could not be passed automatically. It will be tried again next run.`
          : `${readableError(match[2])} ${accountActionNeeded
            ? `Sign in to ${match[1]} on the Apply page or finish its verification, then start the run again.`
            : 'Owtomate will try again on the next run.'}`,
      );
    } else if ((match = text.match(/(\d+) unique listings discovered/i))) {
      add(line, `Found ${match[1]} job listings`, 'done', 'Ones already applied to or recently checked are skipped.');
    } else if (/job-title search continues/i.test(text)) {
      add(line, 'Searching for more jobs', 'neutral', 'Looking for more jobs that match your preferences.');
    } else if ((match = text.match(/Search page (\d+): (\d+) new listing/i))) {
      const last = events.at(-1);
      if (last?.title === 'Searching for more jobs') last.detail = `Found ${match[2]} more jobs to review.`;
    } else if (cardRejection.test(text)) {
      reviewed++;
      if (!review) review = add(line, 'Reviewing jobs', 'neutral', reviewDetail());
      else review.detail = reviewDetail();
    } else if ((match = text.match(/^([✓✗])\s+(\d+)\s+·\s+(.+)$/))) {
      reviewed++;
      if (match[1] === '✓') {
        suitable++;
        const job = listing(match[3]);
        latestMatch = job.company ? `${job.title} at ${job.company}` : job.title;
        matchedJobs.push(latestMatch);
      }
      if (!review) review = add(line, 'Reviewing jobs', 'neutral', reviewDetail());
      else review.detail = reviewDetail();
    } else if ((match = text.match(/^Review slot restored:\s*(.+)$/))) {
      reviewed = Math.max(0, reviewed - 1);
      suitable = Math.max(0, suitable - 1);
      const job = listing(match[1]);
      const restoredJob = job.company ? `${job.title} at ${job.company}` : job.title;
      const index = matchedJobs.lastIndexOf(restoredJob);
      if (index >= 0) matchedJobs.splice(index, 1);
      latestMatch = matchedJobs.at(-1) ?? '';
      if (review) review.detail = reviewDetail();
    } else if ((match = text.match(/→ (?:Applying|Preparing):\s*(.+?)\s+@\s+(.+)/i))) {
      questionlessJudgements.delete(worker);
      currentJob = `${match[1]} at ${match[2]}`;
      application = {
        event: add(line, `${/→ Preparing:/i.test(text) ? 'Preparing' : 'Applying to'} ${match[1]}`, 'neutral', match[2], true),
        title: match[1], company: match[2], steps: [],
        startedAtMs: line.ts ? Date.parse(line.ts) : Number.NaN,
      };
    } else if (application && /cover letter (added|included)|cover letter verified/i.test(text)) {
      if (!application.steps.includes('cover letter written')) application.steps.push('cover letter written');
      application.event.detail = applicationDetail();
    } else if (application && /→ submitting:/i.test(text)) {
      application.event.detail = applicationDetail('submitting');
    } else if (/discarded a stale pre-filled cover letter/i.test(text)) {
      if (application) {
        application.steps.push('replaced an old cover letter');
        application.event.detail = applicationDetail();
      }
    } else if ((match = text.match(/✅ submitted\s*(?:\[external\]\s*)?(?:\(([^)]+)\))?/i))) {
      if (application) {
        application.event.title = `Applied to ${application.title}`;
        application.event.tone = 'done';
        application.event.detail = applicationDetail(match[1] ? `${match[1].replace('/', ' of ')} this run` : undefined);
        finishApplication(line);
      } else {
        add(line, 'Application submitted', 'done', match[1] ? `${match[1]} this run` : undefined);
      }
    } else if (/^Agent judgement: needs-human:/i.test(text)) {
      questionlessJudgements.add(worker);
    } else if ((match = text.match(/⏸ needs (you|your answer):\s*(.*)/i))) {
      const actionable = match[1].toLowerCase() === 'your answer' || !questionlessJudgements.has(worker);
      const detail = `${readableError(match[2])}${actionable ? ' Open Needs attention to finish it.' : ''}`;
      if (application) {
        application.event.title = actionable ? `${application.title} needs your answer` : `Skipped ${application.title}`;
        application.event.tone = actionable ? 'warn' : 'neutral';
        recordOutcome(application.event, actionable ? 'needs-human' : 'skipped');
        application.event.detail = detail;
        finishApplication(line);
      } else {
        recordOutcome(add(line, actionable ? 'Needs your attention' : 'Application skipped', actionable ? 'warn' : 'neutral', detail), actionable ? 'needs-human' : 'skipped');
      }
    } else if (/↪ off-platform/i.test(text)) {
      if (application) {
        application.event.title = `Skipped ${application.title}`;
        application.event.tone = 'neutral';
        application.event.detail = `${application.company} · it continues on the employer's own website.`;
        recordOutcome(application.event, 'skipped');
        finishApplication(line);
      }
    } else if ((match = text.match(/^– skipped \((.+)\):\s*(.+?)\s+@\s+(.+)$/i))) {
      // These decisions precede Applying, so there is no active application event.
      const alreadyApplied = /already applied/i.test(match[1]);
      recordOutcome(add(
        line,
        `${alreadyApplied ? 'Already applied to' : 'Skipped'} ${match[2]}`,
        'neutral',
        `${match[3]} · ${alreadyApplied ? 'An application to this role is already recorded. No new application was sent.' : readableError(match[1])}`,
      ), alreadyApplied ? 'already-applied' : 'skipped');
    } else if ((match = text.match(/^↩ already applied\s*—\s*(.*)/i))) {
      if (application) {
        application.event.title = `Already applied to ${application.title}`;
        application.event.tone = 'neutral';
        recordOutcome(application.event, 'already-applied');
        application.event.detail = `${application.company} · ${readableError(match[1])} No new application was sent.`;
        finishApplication(line);
      } else {
        recordOutcome(add(line, 'Already applied', 'neutral', readableError(match[1])), 'already-applied');
      }
    } else if ((match = text.match(/^– skipped(?: \([^)]*\))?:\s*(.*)/i)) && application) {
      application.event.title = `Skipped ${application.title}`;
      application.event.tone = 'neutral';
      recordOutcome(application.event, 'skipped');
      application.event.detail = `${application.company} · ${readableError(match[1])}`;
      finishApplication(line);
    } else if (/Shared application allowance is reached/i.test(text)) {
      if (!applicationLimitEvent) applicationLimit(line, 'This run reached its limit', 'No more applications will be prepared or submitted in this run.');
    } else if ((match = text.match(/Daily cap of (\d+) (?:already )?reached/i))) {
      add(line, "Today's application limit is reached", 'warn', `The limit is ${match[1]} applications today. You can apply again when the daily allowance resets.`);
      explained = true;
    } else if ((match = text.match(/Run cap of (\d+) reached/i))) {
      if (outcomes.prepared === Number(match[1])) {
        applicationLimit(line, 'Applications saved for review', 'Prepared applications still need your confirmation before submission.');
      } else applicationLimit(line, 'This run reached its limit', `This run can prepare or submit up to ${match[1]} ${Number(match[1]) === 1 ? 'application' : 'applications'}.`);
    } else if ((match = text.match(/evaluation cap \((\d+)\) reached/i))) {
      add(line, 'Review limit reached', 'warn', `This run reviewed up to its limit of ${match[1]} jobs. Other listings may still be available to review.`);
    } else if ((match = text.match(/^Submission not confirmed:\s*(.*)/i))) {
      if (application) {
        application.event.title = `Submission not confirmed: ${application.title}`;
        application.event.tone = 'warn';
        application.event.detail = `${readableError(match[1])} Check your application history on the job site before trying again.`;
        recordOutcome(application.event, 'unconfirmed');
        finishApplication(line);
      } else recordOutcome(add(line, 'Submission not confirmed', 'warn', 'Check your application history on the job site before trying again.'), 'unconfirmed');
    } else if ((match = text.match(/✗\s+(?:unexpected )?error:\s*(.*)/i))) {
      if (application) {
        application.event.title = `Could not finish: ${application.title}`;
        application.event.tone = 'bad';
        recordOutcome(application.event, 'failed');
        application.event.detail = `${application.company} · ${readableError(match[1])}`;
        finishApplication(line);
      } else {
        add(line, 'A step failed', 'bad', readableError(match[1]));
      }
    } else if ((match = text.match(/! fit check failed for (.+?):\s*(.*)/i))) {
      add(line, `Could not review a job at ${match[1]}`, 'warn', readableError(match[2]));
    } else if ((match = text.match(/semantic pre-ranking unavailable:\s*(.*)/i))) {
      add(line, 'Jobs were reviewed in search order', 'warn', readableError(match[1]));
    } else if (/🛑 The browser closed mid-run/i.test(text)) {
      if (application) {
        application.event.title = `Submission not confirmed: ${application.title}`;
        application.event.tone = 'warn';
        application.event.detail = 'The application stopped unexpectedly. Check your application history on the job site before trying again.';
        recordOutcome(application.event, 'unconfirmed');
        finishApplication(line);
      } else add(line, 'The application stopped unexpectedly', 'bad', `Submission could not be confirmed${currentJob ? ` for ${currentJob}` : ''}.`);
      explained = true;
    } else if ((match = text.match(/🛑 \[(SEEK|Indeed)\] (\d+) anti-bot challenges/i))) {
      add(line, `${match[1]} is blocking automated visits`, 'bad', `${match[2]} verification challenges in a row, so ${match[1]} was stopped for this run. Let it rest for a few hours before running again.`);
    } else if (/No enabled platform has a working session/i.test(text)) {
      add(line, 'No job board was available', 'bad', 'None of the selected boards is signed in. Sign in on the Apply page, then start the run again.');
      explained = true;
    } else if ((match = text.match(/^Fatal:\s*(.*)/i))) {
      add(line, 'The run could not continue', 'bad', readableError(match[1]));
      explained = true;
    } else if ((match = text.match(/spawn failed:\s*(.*)/i))) {
      add(line, 'The run could not start', 'bad', readableError(match[1]));
      explained = true;
    } else if ((match = text.match(/Could not record application usage:\s*(.*)/i))) {
      add(line, 'An application was sent but not counted', 'warn', readableError(match[1]));
    } else if ((match = text.match(/^Ready for confirmation:\s*(.+?)\s+@\s+(.+)/i))) {
      if (application) {
        application.event.title = `Ready for confirmation: ${match[1]}`;
        application.event.tone = 'done';
        application.event.detail = `${match[2]} · ${confirming ? 'The application changed after confirmation. Review the updated version in Prepared Applications before confirming again.' : 'The form is filled. Choose it in Prepared applications to confirm submission.'}`;
        recordOutcome(application.event, 'prepared');
        finishApplication(line);
      } else recordOutcome(add(line, `Ready for confirmation: ${match[1]}`, 'done', match[2]), 'prepared');
    } else if ((match = text.match(/=== Semi auto complete:\s*(\d+) application/i))) {
      finished = true;
      add(line, 'Run complete', 'done', `${match[1]} application${match[1] === '1' ? '' : 's'} ready for your confirmation. Nothing submitted.`);
    } else if ((match = text.match(/=== Run complete:\s*(\d+) new application/i))) {
      finished = true;
      add(
        line,
        'Run complete',
        'done',
        completionDetail(lines, suitable, Number(match[1]), outcomes),
      );
    } else if ((match = text.match(/run finished \(exit ([^)]*)\)/i))) {
      finished = true;
      if (stopNotice) {
        stopNotice.title = 'Run stopped';
        stopNotice.detail = 'This run has stopped. Applications already submitted stay submitted.';
      }
      if (match[1] !== '0' && !explained) {
        add(
          line,
          'The run stopped unexpectedly',
          'bad',
          lastErrorOutput ? readableError(lastErrorOutput) : isAdmin
            ? `It exited with code ${match[1]} before finishing. Start the run again.`
            : 'The run stopped before finishing. Please try again.',
        );
      }
    }
    if (application) applications.set(worker, application);
    else applications.delete(worker);
    if (currentJob) currentJobs.set(worker, currentJob);
  }

  if (finished) for (const active of applications.values()) {
    active.event.title = `Not completed: ${active.title}`;
    active.event.detail = 'This attempt ended without a confirmed result. Check your application history on the job site before trying again.';
    active.event.tone = 'warn';
  }
  // Reviewing is finished once the run is; until then it is live whenever nothing is being applied for.
  if (review) {
    if (finished) {
      review.title = `Reviewed ${reviewed} ${reviewed === 1 ? 'job' : 'jobs'}`;
      review.tone = 'done';
    } else if (!applications.size) {
      review.live = true;
    }
  }
  if (!finished) for (const active of applications.values()) active.event.live = true;
  return events.slice(-limit);
}

/** Reconcile matches with every logged outcome, independently of the visible feed. */
function completionDetail(lines: LogLine[], suitable: number, submitted: number, outcomes: OutcomeCounts): string {
  const alreadyApplied = outcomes['already-applied'];
  const skipped = outcomes.skipped;
  const needsHuman = outcomes['needs-human'];
  const failed = outcomes.failed;
  const prepared = outcomes.prepared;
  const unconfirmed = outcomes.unconfirmed;
  const parts = [
    ...(suitable > 0 ? [`${suitable} profile ${suitable === 1 ? 'match' : 'matches'}`] : []),
    `${submitted} ${submitted === 1 ? 'application' : 'applications'} submitted`,
    ...(alreadyApplied ? [`${alreadyApplied} skipped: already applied`] : []),
    ...(skipped ? [`${skipped} skipped for other reasons`] : []),
    ...(needsHuman ? [`${needsHuman} ${needsHuman === 1 ? 'needs' : 'need'} your attention`] : []),
    ...(failed ? [`${failed} ${failed === 1 ? 'application' : 'applications'} failed`] : []),
    ...(unconfirmed ? [`${unconfirmed} ${unconfirmed === 1 ? 'submission' : 'submissions'} not confirmed`] : []),
    ...(prepared ? [`${prepared} ${prepared === 1 ? 'application awaits' : 'applications await'} your confirmation`] : []),
  ];
  const remaining = Math.max(0, suitable - submitted - alreadyApplied - skipped - needsHuman - failed - unconfirmed - prepared);
  if (remaining) {
    const reason = lastMatch(lines, /(?:Run|Daily) cap of \d+ (?:already )?reached|Shared application allowance is reached/i)
      ? 'the application limit was reached'
      : lastMatch(lines, /anti-bot challenges/i) ? 'the job board blocked further attempts' : null;
    parts.push(`${remaining} matched ${remaining === 1 ? 'job' : 'jobs'} not submitted${reason ? `: ${reason}` : ''}`);
  }
  return `${parts.join(' · ')}.`;
}
