import { plainReason } from './run-messages.ts';

export interface LogLine {
  seq: number;
  ts?: string;
  stream: 'out' | 'err' | 'sys';
  text: string;
}

type ActivityTone = 'done' | 'neutral' | 'warn' | 'bad';

interface ActivityEvent {
  id: string;
  title: string;
  detail?: string;
  tone: ActivityTone;
  outcome?: 'already-applied' | 'skipped' | 'needs-human' | 'failed';
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

export function activitySummary(lines: LogLine[]) {
  const found = Number(lastMatch(lines, /(\d+) unique listings discovered/i)?.[1] ?? 0);
  const reviewed = lines.filter((line) => /^\s*[✓✗]\s+\d+\s+·/.test(line.text)).length;
  // Matches are counted as they are found; the end-of-run total wins once it is printed.
  const suitable = Math.max(
    lines.filter((line) => /^\s*✓\s+\d+\s+·/.test(line.text)).length,
    Number(lastMatch(lines, /(\d+) qualifying jobs/i)?.[1] ?? 0),
  );
  /**
   * Counted from the log like the other three, rather than read from the run
   * status. The status reports what is running now, so the moment a run ends
   * its `applied` goes back to zero and the finished summary read "0
   * Submitted" beside a log that plainly listed four.
   */
  const submitted = lines.filter((line) => /✅\s*submitted/i.test(line.text)).length;
  const outcomeSummary = activityEvents(lines, Infinity).find((event) => event.title === 'Run complete')?.detail ?? null;
  return { found, reviewed, suitable, submitted, outcomeSummary, shortfall: reviewShortfall(lines, reviewed) };
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
    [/^recent /, 'already checked in the last week'],
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
  return `Only ${reviewed} new ${reviewed === 1 ? 'job was' : 'jobs were'} left to review (your limit is ${limit})` +
    (reasons.length ? `: ${reasons.join(', ')}.` : '.') +
    ' More or different job titles will find more.';
}

/**
 * Translate diagnostics before displaying them. Admins can see the original
 * first line here and the full diagnostic in the admin run console.
 */
export function formatActivityReason(raw: string, isAdmin = false): string {
  const message = (raw
    .replace(/^(?:Error:\s*)+/i, '')
    .split(/\r?\n|\s+Call log:/)[0]
    .trim()
    .slice(0, 300) || 'An unknown error occurred.').replace(/[.\s]+$/, '');
  const nextSteps: Array<[RegExp, string]> = [
    [/already running with this profile/i, 'Start the run again: Owtomate now closes the leftover browser first.'],
    [/search terms or target role/i, 'Add job titles under Your search, then start the run again.'],
    [/matching service is not configured|CELERIS_API_KEY/i, 'An AI service key is missing on the server, so an admin needs to add it.'],
    [/AuthorMist|humanizer/i, 'The humanizer service on the server is not ready.'],
    [/browser has disconnected|has been closed|Target closed/i, 'The browser closed during the run. Start the run again.'],
    [/Timeout \d+ms exceeded|timed out/i, 'The page was slow to respond. Starting again usually works.'],
    [/net::ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i, 'The connection dropped for a moment. Start the run again.'],
  ];
  const next = nextSteps.find(([pattern]) => pattern.test(message))?.[1];
  if (isAdmin) return next ? `${message}. ${next}` : `${message}.`;
  const plain = plainReason(message).replace(/[.\s]+$/, '');
  if (plain !== message) return `${plain}.`;
  // Known recovery steps explain the problem without exposing the diagnostic.
  return next ? next : `${plain}.`;
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
  const add = (line: LogLine, title: string, tone: ActivityTone, detail?: string): ActivityEvent => {
    const previous = events.at(-1);
    if (previous?.title === title && previous.detail === detail) return previous;
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
  let review: ActivityEvent | null = null;
  let reviewed = 0;
  let suitable = 0;
  let latestMatch = '';
  let application: { event: ActivityEvent; title: string; company: string; steps: string[] } | null = null;
  let finished = false;

  const reviewDetail = () =>
    `${reviewed} checked · ${suitable} profile ${suitable === 1 ? 'match' : 'matches'}` + (latestMatch ? ` · latest match: ${latestMatch}` : '');
  const applicationDetail = (extra?: string) =>
    [application?.company, ...(application?.steps ?? []), extra].filter(Boolean).join(' · ');

  for (const line of lines) {
    const text = line.text.trim();
    let match: RegExpMatchArray | null;
    if (line.stream === 'err' && text && !/^Warning:|^at\s/.test(text)) lastErrorOutput = text.replace(/^Fatal:\s*/i, '');

    if (/starting (live|search) run/i.test(text)) {
      add(line, 'Run started', 'done');
    } else if (/stop requested/i.test(text)) {
      add(line, 'Run stopped', 'neutral', 'You stopped this run. Anything already submitted stays submitted.');
      explained = true;
    } else if ((match = text.match(/(SEEK|Indeed) session OK/i))) {
      if (!boards.includes(match[1])) boards = [...boards, match[1]];
      const title = `Signed in to ${boards.join(' and ')}`;
      if (boardsEvent) boardsEvent.title = title;
      else boardsEvent = add(line, title, 'done');
    } else if ((match = text.match(/(SEEK|Indeed) Recommended -> (\d+)/i))) {
      // A feed with nothing in it is not news.
      if (Number(match[2]) > 0) add(line, `${match[1]} recommended ${match[2]} jobs for you`, 'done', 'These are reviewed first.');
    } else if ((match = text.match(/⚠ (SEEK|Indeed):\s*(.*)/i))) {
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
      add(line, 'Searching for more jobs', 'neutral', 'The first listings ran out, so the search is reading further pages.');
    } else if ((match = text.match(/Search page (\d+): (\d+) new listing/i))) {
      const last = events.at(-1);
      if (last?.title === 'Searching for more jobs') last.detail = `Page ${match[1]} added ${match[2]} new listings to review.`;
    } else if ((match = text.match(/^([✓✗])\s+(\d+)\s+·\s+(.+)$/))) {
      reviewed++;
      if (match[1] === '✓') {
        suitable++;
        const job = listing(match[3]);
        latestMatch = job.company ? `${job.title} at ${job.company}` : job.title;
      }
      if (!review) review = add(line, 'Reviewing jobs', 'neutral', reviewDetail());
      else review.detail = reviewDetail();
    } else if ((match = text.match(/→ Applying:\s*(.+?)\s+@\s+(.+)/i))) {
      currentJob = `${match[1]} at ${match[2]}`;
      application = { event: add(line, `Applying to ${match[1]}`, 'neutral', match[2]), title: match[1], company: match[2], steps: [] };
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
        application = null;
      } else {
        add(line, 'Application submitted', 'done', match[1] ? `${match[1]} this run` : undefined);
      }
    } else if ((match = text.match(/⏸ needs you:\s*(.*)/i))) {
      const detail = `${readableError(match[1])} Open Needs attention to finish it.`;
      if (application) {
        application.event.title = `${application.title} needs your answer`;
        application.event.tone = 'warn';
        application.event.outcome = 'needs-human';
        application.event.detail = detail;
        application = null;
      } else {
        add(line, 'Needs your attention', 'warn', detail).outcome = 'needs-human';
      }
    } else if (/↪ off-platform/i.test(text)) {
      if (application) {
        application.event.title = `Skipped ${application.title}`;
        application.event.tone = 'neutral';
        application.event.detail = `${application.company} · it continues on the employer's own website.`;
        application.event.outcome = 'skipped';
        application = null;
      }
    } else if ((match = text.match(/^– skipped \((.+)\):\s*(.+?)\s+@\s+(.+)$/i))) {
      // These decisions precede Applying, so there is no active application event.
      const alreadyApplied = /already applied/i.test(match[1]);
      add(
        line,
        `${alreadyApplied ? 'Already applied to' : 'Skipped'} ${match[2]}`,
        'neutral',
        `${match[3]} · ${alreadyApplied ? 'An application to this role is already recorded. No new application was sent.' : readableError(match[1])}`,
      ).outcome = alreadyApplied ? 'already-applied' : 'skipped';
    } else if ((match = text.match(/^↩ already applied\s*—\s*(.*)/i))) {
      if (application) {
        application.event.title = `Already applied to ${application.title}`;
        application.event.tone = 'neutral';
        application.event.outcome = 'already-applied';
        application.event.detail = `${application.company} · ${readableError(match[1])} No new application was sent.`;
        application = null;
      } else {
        add(line, 'Already applied', 'neutral', readableError(match[1])).outcome = 'already-applied';
      }
    } else if ((match = text.match(/^– skipped(?: \([^)]*\))?:\s*(.*)/i)) && application) {
      application.event.title = `Skipped ${application.title}`;
      application.event.tone = 'neutral';
      application.event.outcome = 'skipped';
      application.event.detail = `${application.company} · ${readableError(match[1])}`;
      application = null;
    } else if ((match = text.match(/Daily cap of (\d+) (?:already )?reached/i))) {
      add(line, "Today's application limit is reached", 'warn', `${match[1]} applications were sent today. Runs resume tomorrow.`);
      explained = true;
    } else if ((match = text.match(/Run cap of (\d+) reached/i))) {
      add(line, 'This run reached its limit', 'done', `${match[1]} applications is the most one run sends.`);
    } else if ((match = text.match(/✗\s+(?:unexpected )?error:\s*(.*)/i))) {
      if (application) {
        application.event.title = `Could not apply to ${application.title}`;
        application.event.tone = 'bad';
        application.event.outcome = 'failed';
        application.event.detail = `${application.company} · ${readableError(match[1])}`;
        application = null;
      } else {
        add(line, 'A step failed', 'bad', readableError(match[1]));
      }
    } else if ((match = text.match(/! fit check failed for (.+?):\s*(.*)/i))) {
      add(line, `Could not review a job at ${match[1]}`, 'warn', readableError(match[2]));
    } else if ((match = text.match(/semantic pre-ranking unavailable:\s*(.*)/i))) {
      add(line, 'Jobs were reviewed in search order', 'warn', readableError(match[1]));
    } else if (/🛑 The browser closed mid-run/i.test(text)) {
      add(line, 'The browser closed during the run', 'bad', `Nothing was sent${currentJob ? ` for ${currentJob}` : ''}. Start the run again.`);
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
    } else if ((match = text.match(/=== Run complete:\s*(\d+) new application/i))) {
      finished = true;
      add(
        line,
        'Run complete',
        'done',
        completionDetail(lines, suitable, Number(match[1]), events),
      );
    } else if ((match = text.match(/run finished \(exit ([^)]*)\)/i))) {
      finished = true;
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
  }

  // Reviewing is finished once the run is; until then it is live whenever nothing is being applied for.
  if (review) {
    if (finished) {
      review.title = `Reviewed ${reviewed} ${reviewed === 1 ? 'job' : 'jobs'}`;
      review.tone = 'done';
    } else if (!application) {
      review.live = true;
    }
  }
  if (application && !finished) application.event.live = true;
  return events.slice(-limit);
}

/** Reconcile matches with outcomes before the visible feed is shortened. */
function completionDetail(lines: LogLine[], suitable: number, submitted: number, events: ActivityEvent[]): string {
  const count = (outcome: ActivityEvent['outcome']) => events.filter((event) => event.outcome === outcome).length;
  const alreadyApplied = count('already-applied');
  const skipped = count('skipped');
  const needsHuman = count('needs-human');
  const failed = count('failed');
  const parts = [
    ...(suitable > 0 ? [`${suitable} profile ${suitable === 1 ? 'match' : 'matches'}`] : []),
    `${submitted} ${submitted === 1 ? 'application' : 'applications'} submitted`,
    ...(alreadyApplied ? [`${alreadyApplied} skipped: already applied`] : []),
    ...(skipped ? [`${skipped} skipped for other reasons`] : []),
    ...(needsHuman ? [`${needsHuman} ${needsHuman === 1 ? 'needs' : 'need'} your attention`] : []),
    ...(failed ? [`${failed} ${failed === 1 ? 'application' : 'applications'} failed`] : []),
  ];
  const remaining = Math.max(0, suitable - submitted - alreadyApplied - skipped - needsHuman - failed);
  if (remaining) {
    const reason = lastMatch(lines, /(?:Run|Daily) cap of \d+ (?:already )?reached/i)
      ? 'the application limit was reached'
      : lastMatch(lines, /anti-bot challenges/i) ? 'the job board blocked further attempts' : null;
    parts.push(`${remaining} matched ${remaining === 1 ? 'job' : 'jobs'} not submitted${reason ? `: ${reason}` : ''}`);
  }
  return `${parts.join(' · ')}.`;
}
