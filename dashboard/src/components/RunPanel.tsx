import { useEffect, useMemo, useRef, useState } from 'react';
import { useEntitlements } from '../entitlements';
import { useBillingStatus } from '../billing';
import { useBoardsStatus } from '../boards';
import { SetupChecklist, useSetupStatus } from './SetupChecklist';
import { FieldLabel, InfoTip } from './FieldLabel';
import { AUSTRALIAN_CITIES, decodeSettingText, encodeSettingText } from '../runSettings';
import { SearchTermsGenerator } from './SearchTermsGenerator';
import { TermsInput } from './TermsInput';
import { SeekSignIn } from './SeekSignIn';
import { GmailConnect } from './GmailConnect';
import { LiveActionViewer } from './LiveActionViewer';
import { MascotLogo } from './MascotLogo';
import { useRunStatus } from '../runStatus';
import { fmtDateTime } from '../format';
import { MAX_SEARCH_TERMS } from '../search-limits';


interface LogLine {
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
}

interface AutoScheduleStatus {
  runsUsedToday: number;
  runsPerDay: number;
  /** Null while setup is unfinished. */
  nextRunAt: string | null;
  dueNow: boolean;
  timeZone: string;
  /** Why the last scheduled run could not start, until one does. */
  lastError: { message: string; at: string } | null;
  /** Nothing is scheduled until the account's setup is finished. */
  waitingForSetup: boolean;
  waitingForBoard: boolean;
  waitingForFirstRun: boolean;
}

const RUN_DEFAULTS: Record<string, string> = {
  KEYWORDS: '',
  PLATFORMS: 'seek',
  WORK_ARRANGEMENTS: 'remote,hybrid,onsite',
  ONSITE_CITY: 'Sydney',
  SEARCH_RADIUS_KM: '0',
  MIN_SALARY: '70000',
  MIN_HOURLY_RATE: '0',
  MAX_AGE_DAYS: '14',
  MAX_APPS_PER_RUN: '5',
  MAX_EVALUATIONS: '40',
  MIN_SCORE: '60',
  MAX_APPS_PER_DAY: '20',
  PAGES_PER_KEYWORD: '1',
  COVER_LETTER_MODE: 'tailored',
  COVER_LETTER_TEXT_B64: '',
  AI_INSTRUCTIONS_B64: '',
  EXCLUDED_COMPANIES: '',
};

const REVIEW_KEYS = Object.keys(RUN_DEFAULTS);
const ARRANGEMENTS = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On-site' },
];
/** Only boards with a real adapter — kept in sync with seek-bot/src/platforms.ts. */
const JOB_BOARDS = [
  { id: 'seek', label: 'SEEK' },
  { id: 'indeed', label: 'Indeed' },
];

function lastMatch(lines: LogLine[], pattern: RegExp): RegExpMatchArray | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].text.match(pattern);
    if (match) return match;
  }
  return null;
}

function activitySummary(lines: LogLine[]) {
  const found = Number(lastMatch(lines, /(\d+) unique listings discovered/i)?.[1] ?? 0);
  const reviewed = lines.filter((line) => /^\s*[✓✗]\s+\d+\s+·/.test(line.text)).length;
  const suitable = Number(lastMatch(lines, /(\d+) qualifying jobs/i)?.[1] ?? 0);
  /**
   * Counted from the log like the other three, rather than read from the run
   * status. The status reports what is running now, so the moment a run ends
   * its `applied` goes back to zero and the finished summary read "0
   * Submitted" beside a log that plainly listed four.
   */
  const submitted = lines.filter((line) => /✅\s*submitted/i.test(line.text)).length;
  return { found, reviewed, suitable, submitted };
}

/**
 * An error as a person can read it: the first line of the message, without
 * the browser driver's call log, plus the next step where one is known.
 * The message itself is always shown — "something went wrong" told nobody
 * what to do.
 */
function readableError(raw: string): string {
  const message = (raw
    .replace(/^(?:Error:\s*)+/i, '')
    .split(/\r?\n|\s+Call log:/)[0]
    .trim()
    .slice(0, 300) || 'An unknown error occurred.').replace(/[.\s]+$/, '');
  const nextSteps: Array<[RegExp, string]> = [
    [/already running with this profile/i, 'Start the run again: Owtomate now closes the leftover browser first.'],
    [/search terms or target role/i, 'Add job titles under Your search, then start the run again.'],
    [/matching service is not configured|CELERIS_API_KEY|GEMINI_API_KEY/i, 'An AI service key is missing on the server, so an admin needs to add it.'],
    [/AuthorMist|humanizer/i, 'The humanizer service on the server is not ready.'],
    [/browser has disconnected|has been closed|Target closed/i, 'The browser closed during the run. Start the run again.'],
    [/Timeout \d+ms exceeded|timed out/i, 'The page was slow to respond. Starting again usually works.'],
    [/net::ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i, 'The connection dropped for a moment. Start the run again.'],
  ];
  const next = nextSteps.find(([pattern]) => pattern.test(message))?.[1];
  return next ? `${message}. ${next}` : `${message}.`;
}

function activityEvents(lines: LogLine[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const add = (line: LogLine, title: string, tone: ActivityTone, detail?: string) => {
    const previous = events.at(-1);
    if (previous?.title === title && previous.detail === detail) return;
    events.push({ id: `${line.seq}-${events.length}`, title, detail, tone });
  };
  /** The job in progress, so a failure can say which application it was. */
  let currentJob = '';
  /** The last thing the run printed as an error, for a run that exits without saying why. */
  let lastErrorOutput = '';
  /** Whether the reason the run stopped has already been shown. */
  let explained = false;

  for (const line of lines) {
    const text = line.text.trim();
    let match: RegExpMatchArray | null;
    if (line.stream === 'err' && text && !/^Warning:|^at\s/.test(text)) lastErrorOutput = text.replace(/^Fatal:\s*/i, '');

    if (/starting live run/i.test(text)) {
      add(line, 'Run started', 'done');
    } else if (/stop requested/i.test(text)) {
      add(line, 'Run stopped', 'neutral', 'You stopped this run. Anything already submitted stays submitted.');
      explained = true;
    } else if ((match = text.match(/(SEEK|Indeed) session OK/i))) {
      add(line, `Connected to ${match[1]}`, 'done');
    } else if ((match = text.match(/(SEEK|Indeed) Recommended -> (\d+)/i))) {
      add(line, `${match[2]} ${match[1]} Recommended jobs prioritised`, 'done');
    } else if ((match = text.match(/⚠ (SEEK|Indeed):\s*(.*)/i))) {
      const accountActionNeeded = /sign(?:ed)? in|verification challenge|cloudflare|captcha/i.test(text);
      add(
        line,
        `${match[1]} could not be used this run`,
        'bad',
        `${readableError(match[2])} ${accountActionNeeded
          ? `Sign in to ${match[1]} on the Apply page or finish its verification, then start the run again.`
          : 'Owtomate will try again on the next run.'}`,
      );
    } else if ((match = text.match(/(\d+) unique listings discovered/i))) {
      add(line, `Found ${match[1]} job listings`, 'done');
    } else if ((match = text.match(/(\d+) qualifying jobs/i))) {
      add(line, `${match[1]} suitable ${Number(match[1]) === 1 ? 'job' : 'jobs'} ready`, 'done');
    } else if ((match = text.match(/→ Applying:\s*(.+?)\s+@\s+(.+)/i))) {
      currentJob = `${match[1]} at ${match[2]}`;
      add(line, `Applying to ${match[1]}`, 'neutral', match[2]);
    } else if (/discarded a stale pre-filled cover letter/i.test(text)) {
      add(line, 'Prepared a fresh cover letter', 'neutral');
    } else if ((match = text.match(/✅ submitted\s*(?:\(([^)]+)\))?/i))) {
      add(line, 'Application submitted', 'done', match[1] ? `${match[1]} this run` : undefined);
    } else if ((match = text.match(/⏸ needs you:\s*(.*)/i))) {
      add(line, currentJob ? `${currentJob} needs your attention` : 'Needs your attention', 'warn', `${readableError(match[1])} Open Needs attention to finish it.`);
    } else if (/↪ off-platform/i.test(text)) {
      add(line, 'Skipped an external application', 'warn', "This application continues on the employer's website.");
    } else if ((match = text.match(/Daily cap of (\d+) (?:already )?reached/i))) {
      add(line, "Today's application limit is reached", 'warn', `${match[1]} applications were sent today. Runs resume tomorrow.`);
      explained = true;
    } else if ((match = text.match(/Run cap of (\d+) reached/i))) {
      add(line, 'This run reached its limit', 'done', `${match[1]} applications is the most one run sends.`);
    } else if ((match = text.match(/✗\s+(?:unexpected )?error:\s*(.*)/i))) {
      add(line, currentJob ? `Could not apply to ${currentJob}` : 'A step failed', 'bad', readableError(match[1]));
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
      add(
        line,
        'Run complete',
        'done',
        `${match[1]} ${Number(match[1]) === 1 ? 'application' : 'applications'} submitted.`,
      );
    } else if ((match = text.match(/run finished \(exit ([^)]*)\)/i)) && match[1] !== '0' && !explained) {
      add(
        line,
        'The run stopped unexpectedly',
        'bad',
        lastErrorOutput ? readableError(lastErrorOutput) : `It exited with code ${match[1]} before finishing. Start the run again.`,
      );
    }
  }

  return events.slice(-12);
}


function formatRunDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`
    : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** What the schedule does, in one breath, for the info icon beside Auto apply. */
function autoApplySummary(e: NonNullable<ReturnType<typeof useEntitlements>>): string {
  const matches = e.scheduledMinScore === null ? 'Applies to jobs that match your settings' : `Applies to ${e.scheduledMinScore}%+ matches`;
  const jobs = e.scheduledJobsPerDay === null ? '' : ` Up to ${e.scheduledJobsPerDay} jobs reviewed daily.`;
  const runs = `${e.autoRunsPerDay} ${e.autoRunsPerDay === 1 ? 'run' : 'runs'}`;
  return `${runs} a day, spread across all 24 hours.${jobs} ${matches}, written in your own voice.`;
}

/** "next 6:00 pm" today, "next Wed 9:40 am" on another day. */
function nextRunShort(schedule: AutoScheduleStatus): string {
  if (schedule.waitingForSetup || schedule.waitingForBoard || schedule.waitingForFirstRun || !schedule.nextRunAt) return '';
  if (schedule.dueNow) return 'starting shortly';
  const at = new Date(schedule.nextRunAt);
  if (Number.isNaN(at.valueOf())) return '';
  const day = (date: Date) => new Intl.DateTimeFormat('en-AU', { dateStyle: 'short', timeZone: schedule.timeZone }).format(date);
  const time = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: schedule.timeZone }).format(at);
  if (day(at) === day(new Date())) return `next ${time}`;
  const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'short', timeZone: schedule.timeZone }).format(at);
  return `next ${weekday} ${time}`;
}

function nextRunLabel(schedule: AutoScheduleStatus): string {
  if (schedule.waitingForSetup) return 'Automatic runs start once your setup is complete';
  if (schedule.waitingForBoard) return 'Automatic runs begin after you connect a job board';
  if (schedule.waitingForFirstRun) return 'Automatic runs begin after you complete your first run';
  if (!schedule.nextRunAt) return 'Next run time unavailable';
  if (schedule.dueNow) return 'Starting shortly';
  const at = new Date(schedule.nextRunAt);
  if (Number.isNaN(at.valueOf())) return 'Next run time unavailable';
  const label = new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: schedule.timeZone,
  }).format(at);
  return `Next run ${label}`;
}

/**
 * The main screen: start a run and watch it.
 *
 * Verbose process output is converted into a short, user-facing timeline.
 * Raw diagnostics remain server-side and are never rendered in the product.
 */
export function RunPanel({
  lastRunAt,
  onFinished,
  onGoSetup,
  onGoPricing,
}: {
  lastRunAt: string | null;
  onFinished: () => void;
  onGoSetup: () => void;
  onGoPricing: () => void;
}) {
  /** One poll for the whole page; see runStatus.ts. */
  const status = useRunStatus();
  const [autoSchedule, setAutoSchedule] = useState<AutoScheduleStatus | null>(null);
  const [liveViewOpen, setLiveViewOpen] = useState(false);
  /**
   * On a phone the activity log is a modal opened from the run bar, not a
   * card below the fold: it is only wanted while a run is going, and left
   * inline it pushed everything else off the screen. Ignored above 900px,
   * where the log has its own column and is always visible.
   */
  const [activityOpen, setActivityOpen] = useState(false);
  /**
   * A standard account does not drive runs: it saves what work it wants and
   * Owtomate applies on a schedule. So it gets a statement of what is happening
   * rather than controls that would be refused.
   */
  const entitlements = useEntitlements();
  const billing = useBillingStatus();
  const boards = useBoardsStatus();
  /** No board signed in means no run can apply, so automatic runs have nothing to do until that is fixed. */
  const signedOutEverywhere = boards !== null && !boards.seek?.signedIn && !boards.indeed?.signedIn;
  const firstRun = Boolean(entitlements?.firstRunRequired && !entitlements.manualRuns);
  const driving = Boolean(entitlements?.manualRuns || firstRun);
  /** Admin runs have no limits: the limit fields are hidden and nothing is capped in the form. */
  const isAdmin = entitlements?.tier === 'admin';
  const outOfAllowance = Boolean(entitlements && !isAdmin && billing && billing.totalRemaining < 1);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<LogLine[]>([]);
  const [confirming, setConfirming] = useState(false);
  /** A sign-in check has the account's Chrome profile open; a run waits for it, so the button does too. */
  const [verifyingSignIn, setVerifyingSignIn] = useState(false);
  const [autoToggling, setAutoToggling] = useState(false);
  /** Each board's last known sign-in, read when the run settings open; null until known. */
  const [boardSignedIn, setBoardSignedIn] = useState<Record<string, boolean | null> | null>(null);
  /** Operator diagnostic: limit the next run to employer-site applications. */
  const [scope, setScope] = useState<'all' | 'external'>('all');
  const [stopConfirming, setStopConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [standingSaving, setStandingSaving] = useState(false);
  const [standingSaved, setStandingSaved] = useState(false);
  const [standingError, setStandingError] = useState<string | null>(null);
  /**
   * Which field the message belongs to, so it can be shown where the mistake
   * is rather than only at the bottom of a modal the user may have scrolled
   * past. `shake` re-triggers the nudge animation on every failed attempt.
   */
  const [errorField, setErrorField] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  /** Counts rejected attempts, so the same field failing twice still reacts. */
  const [attempt, setAttempt] = useState(0);
  const [outOfApplications, setOutOfApplications] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const setup = useSetupStatus();
  /** The steps only the account holder can do; an account without them is not on the schedule yet. */
  const accountSetupIncomplete = Boolean(
    setup?.checks.some((check) => ['resume', 'profile', 'keywords', 'where'].includes(check.id) && !check.done),
  );
  const consoleRef = useRef<HTMLDivElement>(null);
  const renewedTermsSeq = useRef(0);
  /** The fixed run bar on a phone; its height is what the page must leave clear. */
  const runBar = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then(setSettings).catch(() => {});
  }, []);

  /**
   * How tall the run bar is, published for the page to reserve.
   *
   * On a phone the bar is fixed to the bottom, so the page has to end above
   * it. Its height is not a constant — Stop run alone is one row, a start
   * button with its scope link and a reason is three — so it is measured
   * rather than guessed, and re-measured whenever it changes.
   */
  useEffect(() => {
    const bar = runBar.current;
    if (!bar) return;
    const publish = () => document.documentElement.style.setProperty('--run-bar-h', `${bar.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--run-bar-h');
    };
  }, []);

  // The activity modal behaves like the menu drawer: Escape closes it, and the page behind stays put.
  useEffect(() => {
    if (!activityOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActivityOpen(false);
    };
    document.body.classList.add('activity-open');
    window.addEventListener('keydown', close);
    return () => {
      document.body.classList.remove('activity-open');
      window.removeEventListener('keydown', close);
    };
  }, [activityOpen]);

  // The shared poll supplies the status; this only reacts to a run ending.
  useEffect(() => {
    if (!status) return;
    if (!status.running) setStopConfirming(false);
    if (wasRunning.current && !status.running) {
      onFinished();
      window.dispatchEvent(new Event('entitlements-refresh'));
    }
    wasRunning.current = status.running;
  }, [status, onFinished]);

  useEffect(() => {
    // Another account's run: the server refuses the stream outright (its
    // console can contain that account's real name/location/search terms),
    // so there is nothing to subscribe to until it's this account's turn.
    if (status?.isOwner === false) return;
    const es = new EventSource('/api/run/stream');
    es.onmessage = (e) => {
      const line: LogLine = JSON.parse(e.data);
      setLines((prev) => (prev.some((l) => l.seq === line.seq) ? prev : [...prev, line]));
    };
    return () => es.close();
  }, [status?.isOwner]);

  useEffect(() => {
    consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight });
  }, [lines]);

  useEffect(() => {
    const renewed = [...lines].reverse().find((line) => (
      line.seq > renewedTermsSeq.current && line.text.includes('Search terms renewed for the next run:')
    ));
    if (!renewed) return;
    renewedTermsSeq.current = renewed.seq;
    // Pull the conditional server-side update into the open form. Unsaved
    // edits still take precedence through `val`, so a person typing at the
    // same time keeps full control of the next run.
    void fetch('/api/settings')
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        if (value && typeof value === 'object') setSettings(value as Record<string, string>);
      })
      .catch(() => {});
  }, [lines]);

  const running = status?.running ?? false;
  async function setAutoApply(enabled: boolean) {
    if (autoToggling) return;
    setAutoToggling(true);
    setError(null);
    try {
      const response = await fetch('/api/auto-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not change automatic runs.');
      window.dispatchEvent(new CustomEvent('entitlements-changed', { detail: result.entitlements }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setAutoToggling(false);
    }
  }
  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    fetch('/api/signin/session')
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => {
        if (cancelled || !value) return;
        setBoardSignedIn({ seek: value.seek?.signedIn ?? null, indeed: value.indeed?.signedIn ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [confirming]);
  useEffect(() => {
    if (!running) setLiveViewOpen(false);
  }, [running]);
  useEffect(() => {
    if (!entitlements || entitlements.autoRunsPerDay === 0) {
      setAutoSchedule(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void fetch('/api/auto-schedule')
        .then((response) => (response.ok ? response.json() : null))
        .then((value) => {
          if (!cancelled) setAutoSchedule(value && typeof value.runsUsedToday === 'number' ? value as AutoScheduleStatus : null);
        })
        .catch(() => {});
    };
    refresh();
    const id = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [entitlements?.autoRunsPerDay, entitlements?.autoApplyPaused, entitlements?.firstRunRequired, status?.finishedAt]);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, status?.startedAt]);

  const startedAtMs = status?.startedAt ? Date.parse(status.startedAt) : Number.NaN;
  const finishedAtMs = status?.finishedAt ? Date.parse(status.finishedAt) : Number.NaN;
  const elapsedMs = Number.isFinite(startedAtMs)
    ? Math.max(0, (running || !Number.isFinite(finishedAtMs) ? clock : finishedAtMs) - startedAtMs)
    : null;
  /** An operator's application and review limits have no default: empty means none. */
  const optionalLimit = (key: string) => isAdmin && ['MAX_APPS_PER_RUN', 'MAX_EVALUATIONS', 'MAX_APPS_PER_DAY'].includes(key);
  /**
   * A number an operator set against this account, which runs use whatever is
   * typed here. Shown in the field rather than left to contradict it: the
   * review limit is one only for an admin, where the plan sets no number.
   */
  const forcedApplications = entitlements?.maxApplicationsPerRunOverride ?? null;
  const forcedEvaluations = isAdmin ? entitlements?.evaluationsPerRun ?? null : null;
  const val = (k: string, d = optionalLimit(k) ? '' : RUN_DEFAULTS[k] ?? '') => edits[k] ?? settings[k] ?? d;
  const setEdit = (key: string, value: string) =>
    setEdits((current) => ({ ...current, [key]: value }));
  const arrangements = val('WORK_ARRANGEMENTS').split(',').map((item) => item.trim()).filter(Boolean);
  const coverLetterMode = val('COVER_LETTER_MODE') === 'reuse' ? 'reuse' : 'tailored';
  const reusableCoverLetter = decodeSettingText(val('COVER_LETTER_TEXT_B64'));
  const runInstructions = decodeSettingText(val('AI_INSTRUCTIONS_B64'));

  /**
   * The standing search, editable where runs are started.
   *
   * Search terms and run instructions are saved settings that every later
   * run reads, scheduled or started by hand — so they belong on the page, not
   * only inside the start-run review a scheduled account never opens. Edits
   * share state with that review, so the two cannot disagree. Instructions
   * are shown only to plans that include them; the server ignores them for
   * the rest.
   */
  const standingKeys = entitlements?.fineTune
    ? ['KEYWORDS', 'EXCLUDED_COMPANIES', 'AI_INSTRUCTIONS_B64']
    : ['KEYWORDS', 'EXCLUDED_COMPANIES'];
  const standingDirty = standingKeys.some(
    (key) => edits[key] !== undefined && edits[key] !== (settings[key] ?? RUN_DEFAULTS[key] ?? ''),
  );
  async function saveStanding() {
    const terms = val('KEYWORDS').split(',').map((term) => term.trim()).filter(Boolean);
    if (!terms.length) return setStandingError('Add at least one job title or search term.');
    if (terms.length > MAX_SEARCH_TERMS) {
      return setStandingError(`Use at most ${MAX_SEARCH_TERMS} search terms; you have ${terms.length}.`);
    }
    setStandingError(null);
    setStandingSaving(true);
    try {
      const updates = Object.fromEntries(standingKeys.map((key) => [key, val(key)]));
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error ?? 'Could not save.');
      if (saved.settings) setSettings(saved.settings);
      setEdits((current) => {
        const next = { ...current };
        for (const key of standingKeys) delete next[key];
        return next;
      });
      setStandingSaved(true);
    } catch (reason) {
      setStandingError((reason as Error).message);
    } finally {
      setStandingSaving(false);
    }
  }
  const editStanding = (key: string, value: string) => {
    setStandingSaved(false);
    setStandingError(null);
    setEdit(key, value);
  };
  const discardStanding = () => {
    setStandingError(null);
    setEdits((current) => {
      const next = { ...current };
      for (const key of standingKeys) delete next[key];
      return next;
    });
  };
  const toggleArrangement = (item: string) => {
    const next = new Set(arrangements);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setEdit('WORK_ARRANGEMENTS', [...next].join(','));
  };
  const platforms = val('PLATFORMS').split(',').map((item) => item.trim()).filter(Boolean);
  /** Unknown until read; then only a board confirmed signed in can be used. */
  const boardUsable = (id: string) => boardSignedIn === null || boardSignedIn[id] === true;
  const unusableBoards = JOB_BOARDS.filter((board) => !boardUsable(board.id));
  const togglePlatform = (id: string) => {
    const next = new Set(platforms);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEdit('PLATFORMS', [...next].join(','));
  };
  const summary = useMemo(() => activitySummary(lines), [lines]);
  const events = useMemo(() => activityEvents(lines), [lines]);
  const latestApplicationLine = [...lines].reverse().find((line) => /→ Applying:/i.test(line.text));
  const latestOutcomeLine = [...lines].reverse().find((line) =>
    /✅ submitted|⏸ needs you:|↪ off-platform|✗ (?:unexpected )?error:/i.test(line.text),
  );
  const currentApplication = latestApplicationLine?.text.match(/→ Applying:\s*(.+?)\s+@\s+(.+)/i);
  const applyingNow = Boolean(
    currentApplication && (!latestOutcomeLine || latestApplicationLine!.seq > latestOutcomeLine.seq),
  );
  const currentActivity = applyingNow
    ? `Applying to ${currentApplication![1]} at ${currentApplication![2]}`
    : summary.suitable
      ? 'Preparing suitable jobs for application'
      : summary.found
        ? `Reviewing ${summary.found} job listings`
        : 'Searching for jobs';

  /**
   * One table for the ceilings, mirroring `RUN_LIMITS` in server/settings.ts.
   * These bound how much traffic a run makes: search load is terms x pages, and
   * a large value here is what earned a bot challenge that blocked the account.
   */
  const RUN_CAP_VALUES: Record<string, number> = {
    MAX_APPS_PER_RUN: 10,
    MAX_EVALUATIONS: 150,
    PAGES_PER_KEYWORD: 3,
    MAX_APPS_PER_DAY: 50,
  };
  const RUN_CAPS = [
    { key: 'MAX_APPS_PER_RUN', label: 'Max applications' },
    { key: 'MAX_EVALUATIONS', label: 'Jobs to evaluate' },
    { key: 'PAGES_PER_KEYWORD', label: 'Search pages per term' },
    { key: 'MAX_APPS_PER_DAY', label: 'Daily application cap' },
  ];
  const termCount = val('KEYWORDS').split(',').map((t) => t.trim()).filter(Boolean).length;

  /** The message for one field, rendered directly beneath it. */
  const FieldError = ({ field }: { field: string }) =>
    errorField === field && error ? (
      <span className="field-error" role="alert">{error}</span>
    ) : null;

  /** Reject a submission: message under the field, plus a nudge on the modal. */
  function fail(message: string, field?: string) {
    setError(message);
    setErrorField(field ?? null);
    setShaking(true);
    setAttempt((n) => n + 1);
  }

  /**
   * Bring the offending field into view once the message has rendered.
   *
   * Deliberately in an effect rather than inside `fail`: scrolling before the
   * re-render lands on the field's old position, and the message that explains
   * the problem is not on screen yet. Keyed on `attempt` so submitting the same
   * bad value twice scrolls again rather than sitting silent.
   */
  useEffect(() => {
    if (!attempt || !errorField) return;
    const el = document.querySelector<HTMLElement>(`[data-field="${errorField}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Focus without a second competing scroll, so the caret is where the fix is.
    el.focus?.({ preventScroll: true });
  }, [attempt, errorField]);

  async function saveAndStart() {
    if (starting) return;
    setError(null);
    setErrorField(null);
    const updates = Object.fromEntries(REVIEW_KEYS.map((key) => [key, val(key)]));
    // An operator's limit left empty is no limit; one they typed is checked like any other.
    const unlimited = (key: string) => optionalLimit(key) && !updates[key].trim();
    const numericKeys = [
      'MIN_SALARY', 'MIN_HOURLY_RATE', 'MAX_AGE_DAYS', 'MAX_APPS_PER_RUN', 'MAX_EVALUATIONS',
      'MIN_SCORE', 'MAX_APPS_PER_DAY', 'PAGES_PER_KEYWORD',
    ].filter((key) => !unlimited(key));
    const positiveKeys = [
      'MAX_APPS_PER_RUN', 'MAX_EVALUATIONS', 'MAX_APPS_PER_DAY', 'PAGES_PER_KEYWORD',
    ].filter((key) => !unlimited(key));
    if (!updates.KEYWORDS.trim()) {
      fail('Add at least one job title or search term.', 'KEYWORDS');
      return;
    }
    if (!updates.WORK_ARRANGEMENTS.trim()) {
      fail('Choose at least one work arrangement.', 'WORK_ARRANGEMENTS');
      return;
    }
    if (!updates.PLATFORMS.trim()) {
      fail('Choose at least one job board.', 'PLATFORMS');
      return;
    }
    if (!platforms.some(boardUsable)) {
      const chosen = JOB_BOARDS.filter((board) => platforms.includes(board.id)).map((board) => board.label);
      fail(`${chosen.join(' and ')} ${chosen.length === 1 ? 'is' : 'are'} not signed in. Sign in on the Apply page, or choose a board that is.`, 'PLATFORMS');
      return;
    }
    if (numericKeys.some((key) => !Number.isFinite(Number(updates[key])) || Number(updates[key]) < 0)) {
      fail('Check the numeric settings before starting.');
      return;
    }
    if (positiveKeys.some((key) => Number(updates[key]) < 1)) {
      fail('Application and search limits must be at least 1.');
      return;
    }
    if (Number(updates.MIN_SCORE) > 100) {
      fail('Match threshold must be between 0 and 100.', 'MIN_SCORE');
      return;
    }
    /**
     * Say so rather than silently trimming.
     *
     * The server clamps these anyway, so a larger number was accepted, saved,
     * and quietly reduced — leaving the field showing one value and the run
     * using another. Telling the user which field and what the ceiling is costs
     * nothing and avoids that.
     */
    const overCap = isAdmin ? undefined : RUN_CAPS.find(({ key }) => Number(updates[key]) > RUN_CAP_VALUES[key]);
    if (overCap) {
      fail(`${overCap.label} can be at most ${RUN_CAP_VALUES[overCap.key]}.`, overCap.key);
      return;
    }
    if (termCount > MAX_SEARCH_TERMS) {
      fail(`Use at most ${MAX_SEARCH_TERMS} search terms; you have ${termCount}.`, 'KEYWORDS');
      return;
    }
    if (entitlements?.fineTune && updates.COVER_LETTER_MODE === 'reuse' && !decodeSettingText(updates.COVER_LETTER_TEXT_B64).trim()) {
      fail('Paste the cover letter you want to reuse.', 'COVER_LETTER_TEXT_B64');
      return;
    }

    setStarting(true);
    try {
      const saveResponse = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const saved = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(saved.error ?? 'Could not save settings.');
      if (saved.settings) setSettings(saved.settings);
      setEdits({});

      const runResponse = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'live', confirm: true, overrides: updates, scope }),
      });
      if (runResponse.status === 402) {
        setConfirming(false);
        setOutOfApplications(true);
        return;
      }
      const result = await runResponse.json();
      if (!runResponse.ok) throw new Error(result.error ?? 'Failed to start.');
      setLines([]);
      setConfirming(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function stopRun() {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      const response = await fetch('/api/run/stop', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not stop the run.');
      setStopConfirming(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="run-layout">
      {setup && <div className="run-span">{<SetupChecklist status={setup} onFix={onGoSetup} />}</div>}
      <div className="run-side">
      <div className="card run-controls-card">
        <div className="panel-body">
        {!status?.hasKey && (
          <div className="banner">Matching is not configured, so results will only use keywords.</div>
        )}
        {running && status?.isOwner === false && (
          <div className="banner">
            Another account is currently running, and the shared browser can only do one run at a time. Try again once it finishes.
          </div>
        )}
        {error && <div className="banner banner-bad">{error}</div>}
        {/*
          Running out is silent otherwise: the scheduler just stops starting runs
          while the switch still reads "on". Found with the admin simulator.
        */}
        {outOfAllowance && (
          <div className="banner banner-bad out-of-applications" role="status">
            <span><strong>You're out of applications.</strong> Auto apply has stopped and will pick up again as soon as you get a pass.</span>
            <button type="button" className="btn primary" onClick={onGoPricing}>View plans</button>
          </div>
        )}

        <div className="run-actions" ref={runBar}>
          {/* Beside the run button on a phone; the desktop layout hides it. */}
          <button
            type="button"
            className={`btn activity-open${running ? ' live' : ''}`}
            aria-haspopup="dialog"
            onClick={() => setActivityOpen(true)}
          >
            {running && <span className="activity-open-dot" aria-hidden="true" />}
            Activity
          </button>
          {running && status?.isOwner === false ? (
            <button className="btn primary lg" disabled>
              Busy with another account's run
            </button>
          ) : running ? (
            <button className="btn btn-danger lg" onClick={() => setStopConfirming(true)}>
              ⏹ Stop run
            </button>
          ) : !driving ? null : (
            <>
              {/*
                A run without a résumé, a profile, search terms or a location
                is refused by the server anyway; the button says so before it
                is pressed rather than after.
              */}
              <button
                className="btn primary lg"
                disabled={accountSetupIncomplete || verifyingSignIn || boards === null || signedOutEverywhere || outOfAllowance}
                title={accountSetupIncomplete ? 'Finish your setup first.' : verifyingSignIn || boards === null ? 'Checking your job-board sign-ins first.' : signedOutEverywhere ? 'Sign in to a job board first.' : outOfAllowance ? 'Get a pass to keep applying.' : undefined}
                onClick={() => { setScope('all'); setConfirming(true); }}
              >
                {firstRun ? 'Start first run' : 'Start auto apply'}
              </button>
              {entitlements?.runScopes && (
                <button
                  type="button"
                  className="run-scope-link"
                  disabled={accountSetupIncomplete || verifyingSignIn}
                  title="Applies only where the employer's own site takes the application, on every board in the run."
                  onClick={() => { setScope('external'); setConfirming(true); }}
                >
                  Employer sites only <span className="beta-flag">Beta</span>
                </button>
              )}
              {accountSetupIncomplete && (
                <span className="job-meta">Finish the setup steps above to start a run.</span>
              )}
              {!accountSetupIncomplete && signedOutEverywhere && (
                <span className="job-meta">Sign in to SEEK below before starting your first run.</span>
              )}
              {firstRun && !accountSetupIncomplete && !signedOutEverywhere && (
                <span className="job-meta">Automatic runs begin only after this run completes successfully.</span>
              )}
            </>
          )}
        </div>

        {entitlements && entitlements.autoRunsPerDay !== 0 && (
          <div className={`run-auto-row${entitlements.autoApplyPaused || signedOutEverywhere ? ' paused' : ''}`}>
            <span className="run-auto-label">
              <span className="auto-apply-dot" aria-hidden="true" />
              Auto apply
            </span>
            <span className="job-meta">
              {entitlements.autoApplyPaused
                ? 'off'
                : autoSchedule?.waitingForSetup || (autoSchedule === null && accountSetupIncomplete)
                ? 'starts once your setup is complete'
                : autoSchedule?.waitingForBoard || signedOutEverywhere
                ? 'Waiting for sign-in'
                : autoSchedule?.waitingForFirstRun || firstRun
                ? 'waiting for you to complete your first run'
                : `${autoSchedule?.runsUsedToday ?? entitlements.autoRunsUsedToday} of ${entitlements.autoRunsPerDay} today${autoSchedule && nextRunShort(autoSchedule) ? ` · ${nextRunShort(autoSchedule)}` : ''}`}
            </span>
            {entitlements.canPauseAutoApply && !signedOutEverywhere && (
              <button
                type="button"
                role="switch"
                aria-checked={!entitlements.autoApplyPaused}
                aria-label="Automatic runs"
                className={`auto-switch${entitlements.autoApplyPaused || signedOutEverywhere ? '' : ' on'}`}
                disabled={autoToggling || signedOutEverywhere}
                title={signedOutEverywhere
                  ? 'Automatic runs need a signed-in job board. Sign in below first.'
                  : entitlements.autoApplyPaused
                  ? 'Turn automatic runs back on'
                  : 'Turn automatic runs off, for example once you have found a job or want a break'}
                onClick={() => void setAutoApply(entitlements.autoApplyPaused)}
              >
                <span className="auto-switch-knob" aria-hidden="true" />
              </button>
            )}
            <InfoTip
              label="Auto apply"
              help={`${autoApplySummary(entitlements)}${autoSchedule ? ` ${nextRunLabel(autoSchedule)}.` : ''}`}
            />
          </div>
        )}
        {autoSchedule?.lastError && !running && !entitlements?.autoApplyPaused && !signedOutEverywhere && (
          <div className="banner banner-bad run-auto-error" role="alert">
            <strong>The last scheduled run could not start.</strong> {autoSchedule.lastError.message}
          </div>
        )}

        {/* Job-board sign-in lives here rather than in Setup: it is the one
            thing a run cannot start without, and the browser it opens is what
            the person needs in front of them. */}
        {!running && (
          <>
            {/* Same rule the run applies: an account that cannot fine-tune gets Indeed from its pass, not from the setting. */}
            <SeekSignIn onVerifyingChange={setVerifyingSignIn} indeedEnabled={platforms.includes('indeed') || Boolean(entitlements?.indeedApplications && platforms.join(',') === 'seek')} />
            <GmailConnect compact />
          </>
        )}

        {!running && (lastRunAt || status?.finishedAt) && (
          <p className="job-meta last-run-line">
            Last run {fmtDateTime(lastRunAt ?? status!.finishedAt!)}
            {status?.finishedAt ? ` · ${status.applied} submitted` : ''}
          </p>
        )}
        </div>
      </div>

      <section className="card saved-search-card" aria-labelledby="saved-search-title">
        <div className="panel-body">
          <div className="saved-search-head">
            <h2 id="saved-search-title">Your search</h2>
            <span className="job-meta">Applies to all future runs</span>
          </div>
          <div className="field">
            <div className="saved-search-label">
              <label className="field-label" htmlFor="saved-search-terms">Job titles</label>
              <span className={`job-meta${termCount >= MAX_SEARCH_TERMS ? ' at-limit' : ''}`}>
                {`${termCount} of ${MAX_SEARCH_TERMS}`}
              </span>
            </div>
            <TermsInput
              id="saved-search-terms"
              value={val('KEYWORDS')}
              max={MAX_SEARCH_TERMS}
              disabled={standingSaving}
              onChange={(terms) => editStanding('KEYWORDS', terms)}
            />
            <SearchTermsGenerator
              currentTerms={val('KEYWORDS')}
              disabled={standingSaving}
              onGenerated={(terms) => editStanding('KEYWORDS', terms)}
            />
          </div>

          <div className="field">
            <FieldLabel
              label="Companies to avoid"
              optional
              help="Listings from these employers are rejected before AI review. Close misspellings are matched automatically."
            />
            <TermsInput
              id="saved-excluded-companies"
              value={val('EXCLUDED_COMPANIES')}
              disabled={standingSaving}
              itemLabel="company"
              ariaLabel="Companies to avoid"
              emptyPlaceholder="Type a company and press Enter"
              onChange={(companies) => editStanding('EXCLUDED_COMPANIES', companies)}
            />
            <span className="job-meta">Press Enter or comma to add a company. Matching is typo-tolerant.</span>
          </div>

          {entitlements?.fineTune && (
            <div className="field">
              <FieldLabel
                label="Run instructions"
                optional
                help="Jobs the AI should avoid or prefer. Checked before every application, in every future run."
              />
              <textarea
                id="saved-search-instructions"
                className="input"
                rows={2}
                maxLength={4_000}
                value={runInstructions}
                placeholder="e.g. Don't apply for senior or manager positions."
                aria-label="Run instructions"
                onChange={(event) => editStanding('AI_INSTRUCTIONS_B64', encodeSettingText(event.target.value))}
              />
            </div>
          )}

          {standingError && <div className="banner banner-bad" role="alert">{standingError}</div>}

          {standingDirty ? (
            <div className="saved-search-bar" role="status">
              <span>Unsaved changes</span>
              <div className="saved-search-bar-actions">
                <button type="button" className="btn btn-small" disabled={standingSaving} onClick={discardStanding}>
                  Discard
                </button>
                <button type="button" className="btn primary btn-small" disabled={standingSaving} onClick={() => void saveStanding()}>
                  {standingSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          ) : standingSaved ? (
            <div className="saved-search-bar saved" role="status">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <span>Saved. Your next run will use this.</span>
            </div>
          ) : null}
        </div>
      </section>
      </div>

      <div className={`card console-card${activityOpen ? ' open' : ''}`}>
        <div className="console-head">
          <div className="console-status">
            <strong>Activity</strong>
            <span className={`badge ${running ? 'bad' : 'muted'}`}>
              {running ? (
                <span className="in-progress-label">
                  <strong className="active-mode-label">Applying</strong>
                  <span>In progress</span>
                  {elapsedMs !== null && (
                    <time className="run-elapsed" aria-label={`Running for ${formatRunDuration(elapsedMs)}`}>
                      {formatRunDuration(elapsedMs)}
                    </time>
                  )}
                  <span className="flowing-dots" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                </span>
              ) : status?.finishedAt ? (
                <span className="finished-label">
                  Finished
                  {elapsedMs !== null && <time className="run-elapsed">{formatRunDuration(elapsedMs)}</time>}
                </span>
              ) : 'Ready'}
            </span>
          </div>
          <div className="console-actions">
            {running && (
              <button className="btn primary btn-small" onClick={() => setLiveViewOpen(true)}>
                View live action
              </button>
            )}
            {lines.length > 0 && !running && (
              <button className="btn" onClick={() => setLines([])}>Clear</button>
            )}
            {/* Only ever visible while this card is the phone's modal. */}
            <button type="button" className="btn activity-close" onClick={() => setActivityOpen(false)}>
              Close
            </button>
          </div>
        </div>

        {lines.length > 0 && (
          <div className="activity-stats" aria-label="Run progress">
            <div><strong>{summary.found}</strong><span>Found</span></div>
            <div><strong>{summary.reviewed}</strong><span>Reviewed</span></div>
            <div><strong>{summary.suitable}</strong><span>Suitable</span></div>
            <div>
              {/* Whichever knows more: the live counter mid-run, the log once it has ended. */}
              <strong>{Math.max(summary.submitted, status?.applied ?? 0)}</strong>
              <span>Submitted</span>
            </div>
          </div>
        )}

        <div ref={consoleRef} className="activity-body">
          {lines.length === 0 ? (
            <div className="console-empty">
              <strong>No activity yet</strong>
              <span>{driving ? 'Start a run to follow its progress here.' : 'Scheduled run activity will appear here.'}</span>
            </div>
          ) : (
            <>
              {running && (
                <div className="activity-current live">
                  {/* The owl reads the page while the run does: eyes scanning, the odd double-take. */}
                  <MascotLogo size={36} className="activity-owl" />
                  <div>
                    <strong>Applying now</strong>
                    <span>{currentActivity}</span>
                  </div>
                </div>
              )}

              <div className="activity-feed">
                {events.length ? events.map((event) => (
                  <div className={`activity-event ${event.tone}`} key={event.id}>
                    <span className="activity-dot" aria-hidden="true" />
                    <div>
                      <strong>{event.title}</strong>
                      {event.detail && <span>{event.detail}</span>}
                    </div>
                  </div>
                )) : (
                  <div className="activity-event neutral">
                    <span className="activity-dot" aria-hidden="true" />
                    <div><strong>Run started</strong><span>Preparing the search.</span></div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {liveViewOpen && running && <LiveActionViewer onClose={() => setLiveViewOpen(false)} />}

      {stopConfirming && running && (
        <div className="overlay center" onClick={() => !stopping && setStopConfirming(false)}>
          <div
            className="card confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="stop-run-title"
            aria-describedby="stop-run-description"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="stop-run-title">Stop this run?</h2>
            <p id="stop-run-description" className="dim">
              The current job application process will end. Applications already submitted will not be affected.
            </p>
            <div className="confirm-actions">
              <button className="btn" disabled={stopping} onClick={() => setStopConfirming(false)}>
                Keep running
              </button>
              <button className="btn btn-danger-solid" disabled={stopping} onClick={stopRun}>
                {stopping ? 'Stopping…' : 'Stop run'}
              </button>
            </div>
          </div>
        </div>
      )}

      {outOfApplications && (
        <div className="overlay center" onClick={() => setOutOfApplications(false)}>
          <div
            className="card confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="out-of-apps-title"
            aria-describedby="out-of-apps-description"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="out-of-apps-title">You're out of applications</h2>
            <p id="out-of-apps-description" className="dim">
              You have used all your applications. Get a pass to keep applying.
            </p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setOutOfApplications(false)}>
                Close
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setOutOfApplications(false);
                  onGoPricing();
                }}
              >
                View plans
              </button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div className="overlay center run-review-overlay" onClick={() => !starting && setConfirming(false)}>
          <div
            className="card run-review-modal"
            data-shake={shaking ? 'yes' : undefined}
            onAnimationEnd={() => setShaking(false)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-review-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="run-review-head">
              <div>
                <h2 id="run-review-title">{firstRun ? 'Review your first run' : 'Review run settings'}</h2>
                <p className="job-meta">Changes made here are saved before the run starts.</p>
              </div>
              <span className="badge bad">
                Live run{scope === 'external' ? ' · employer sites only' : ''}
              </span>
            </div>

            <div className="run-review-body">
              <div className="banner banner-bad run-review-warning">
                This run submits applications to employers. Submitted applications cannot be withdrawn here.
              </div>

              <section className="run-review-section run-review-search">
                <h3>What to find</h3>
                <div className="field run-review-wide">
                  <FieldLabel label="Job boards" help="Which job boards to search and apply on this run. Both are searched, scored and deduplicated together as one combined pool." />
                  <div className="chips" data-field="PLATFORMS">
                    {JOB_BOARDS.map((board) => {
                      const usable = boardUsable(board.id);
                      // A saved choice is kept for when the board is signed in again; it just is not used meanwhile.
                      const on = usable && platforms.includes(board.id);
                      return (
                        <button
                          type="button"
                          key={board.id}
                          className={`chip ${on ? 'on' : ''}`}
                          disabled={!usable}
                          aria-disabled={!usable}
                          title={usable ? undefined : `Sign in to ${board.label} on the Apply page to use it.`}
                          onClick={() => togglePlatform(board.id)}
                        >
                          {on ? '✓ ' : ''}{board.label}{usable ? '' : ' · not signed in'}
                        </button>
                      );
                    })}
                  </div>
                  {unusableBoards.length > 0 && (
                    <p className="job-meta board-signin-hint">
                      {unusableBoards.map((board) => board.label).join(' and ')} {unusableBoards.length === 1 ? 'is' : 'are'} not signed in, so {unusableBoards.length === 1 ? 'it' : 'they'} cannot be used. Sign in on the Apply page first.
                    </p>
                  )}
                  <FieldError field="PLATFORMS" />
                </div>
                <p className="job-meta recommended-first-note">
                  Recommended jobs from each selected board are analysed first. Search terms expand the pool after those jobs.
                </p>
                <div className="field run-review-wide">
                  <FieldLabel label="Job titles and search terms" help="The roles and keywords used to search for job listings. Separate multiple terms with commas." />
                  <TermsInput
                    id="review-search-terms"
                    dataField="KEYWORDS"
                    value={val('KEYWORDS')}
                    max={MAX_SEARCH_TERMS}
                    onChange={(terms) => setEdit('KEYWORDS', terms)}
                  />
                  <FieldError field="KEYWORDS" />
                  <SearchTermsGenerator
                    currentTerms={val('KEYWORDS')}
                    disabled={running}
                    onGenerated={(terms) => setEdit('KEYWORDS', terms)}
                  />
                </div>
                <div className="field run-review-wide">
                  <FieldLabel
                    label="Companies to avoid"
                    optional
                    help="Listings from these employers are rejected before ranking or AI fit review."
                  />
                  <TermsInput
                    id="review-excluded-companies"
                    dataField="EXCLUDED_COMPANIES"
                    value={val('EXCLUDED_COMPANIES')}
                    itemLabel="company"
                    ariaLabel="Companies to avoid"
                    emptyPlaceholder="Type a company and press Enter"
                    onChange={(companies) => setEdit('EXCLUDED_COMPANIES', companies)}
                  />
                  <span className="job-meta">Press Enter or comma to add a company. Matching is typo-tolerant.</span>
                </div>
                {entitlements?.fineTune && <label className="field run-review-wide">
                  <FieldLabel label="Run instructions" optional help="Tell Owtomate which otherwise suitable jobs to avoid or prefer. These saved instructions are checked for every job before applying." />
                  <textarea
                    className="input"
                    rows={3}
                    maxLength={4_000}
                    value={runInstructions}
                    onChange={(event) => setEdit('AI_INSTRUCTIONS_B64', encodeSettingText(event.target.value))}
                    aria-describedby="run-instructions-help"
                  />
                  <span className="job-meta" id="run-instructions-help">
                    This prompt applies to all future runs until you change it. Example: Don’t apply for senior positions or jobs that require weekend work.
                  </span>
                </label>}
              </section>

              {entitlements?.fineTune && <section className="run-review-section run-review-cover">
                <h3>Cover letter</h3>
                <div className="modes cover-letter-modes">
                  <label className={`mode ${coverLetterMode === 'tailored' ? 'sel' : ''}`}>
                    <input
                      type="radio"
                      name="cover-letter-mode"
                      checked={coverLetterMode === 'tailored'}
                      onChange={() => setEdit('COVER_LETTER_MODE', 'tailored')}
                    />
                    <div>
                      <div className="mode-title">Tailored by AI</div>
                      <div className="job-meta">Writes a natural, human-sounding letter for each specific role.</div>
                    </div>
                  </label>
                  <label className={`mode ${coverLetterMode === 'reuse' ? 'sel' : ''}`}>
                    <input
                      type="radio"
                      name="cover-letter-mode"
                      checked={coverLetterMode === 'reuse'}
                      onChange={() => setEdit('COVER_LETTER_MODE', 'reuse')}
                    />
                    <div>
                      <div className="mode-title">Reuse one letter</div>
                      <div className="job-meta">Sends the same letter exactly as provided for every application.</div>
                    </div>
                  </label>
                </div>
                {coverLetterMode === 'reuse' && (
                  <label className="field reusable-cover-letter">
                    <FieldLabel label="Letter to reuse" help="This text is used verbatim whenever an application asks for a cover letter." />
                    <textarea
                      className="input"
                      rows={7}
                      maxLength={12_000}
                      placeholder="Paste the complete cover letter, including greeting and sign-off."
                      data-field="COVER_LETTER_TEXT_B64"
                      value={reusableCoverLetter}
                      onChange={(event) => setEdit('COVER_LETTER_TEXT_B64', encodeSettingText(event.target.value))}
                    />
                    <FieldError field="COVER_LETTER_TEXT_B64" />
                  </label>
                )}
              </section>}

              <section className="run-review-section run-review-location">
                <h3>Location and pay</h3>
                <div className="field run-review-wide">
                  <FieldLabel label="Work arrangements" help="Choose whether to include remote, hybrid, and on-site jobs." />
                  <div className="chips" data-field="WORK_ARRANGEMENTS">
                    {ARRANGEMENTS.map((arrangement) => (
                      <button
                        type="button"
                        key={arrangement.id}
                        className={`chip ${arrangements.includes(arrangement.id) ? 'on' : ''}`}
                        onClick={() => toggleArrangement(arrangement.id)}
                      >
                        {arrangements.includes(arrangement.id) ? '✓ ' : ''}{arrangement.label}
                      </button>
                    ))}
                  </div>
                  <FieldError field="WORK_ARRANGEMENTS" />
                </div>
                <div className="grid-2">
                  <label className="field">
                    <FieldLabel
                      label="Distance from your address"
                      help="Searches only jobs within this many kilometres of the address in your profile, using SEEK's own location filter. Choose Anywhere to search the whole country."
                    />
                    <select
                      className="input"
                      value={val('SEARCH_RADIUS_KM')}
                      onChange={(e) => setEdit('SEARCH_RADIUS_KM', e.target.value)}
                    >
                      <option value="0">Anywhere</option>
                      {[5, 10, 25, 50, 100].map((km) => (
                        <option key={km} value={String(km)}>within {km} km</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <FieldLabel label="On-site city" help="On-site jobs are only considered when they are located in this city." />
                    <select className="input" value={val('ONSITE_CITY')} onChange={(e) => setEdit('ONSITE_CITY', e.target.value)}>
                      {!AUSTRALIAN_CITIES.includes(val('ONSITE_CITY') as typeof AUSTRALIAN_CITIES[number]) && val('ONSITE_CITY') && (
                        <option value={val('ONSITE_CITY')}>{val('ONSITE_CITY')}</option>
                      )}
                      {AUSTRALIAN_CITIES.map((city) => <option key={city} value={city}>{city}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <FieldLabel label="Minimum annual salary" help="Yearly and daily-rate jobs below this annual amount are skipped. Jobs without a listed salary are still considered." />
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="5000"
                      value={val('MIN_SALARY')}
                      onChange={(e) => setEdit('MIN_SALARY', e.target.value)}
                    />
                    <span className="job-meta">AUD per year</span>
                  </label>
                  <label className="field">
                    <FieldLabel label="Minimum hourly rate" help="Hourly jobs below this rate are skipped independently of your annual minimum." />
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      value={val('MIN_HOURLY_RATE')}
                      onChange={(e) => setEdit('MIN_HOURLY_RATE', e.target.value)}
                    />
                    <span className="job-meta">AUD per hour</span>
                  </label>
                </div>
              </section>

              {(isAdmin || entitlements?.fineTune || entitlements?.advancedFilters) && <section className="run-review-section run-review-limits">
                <h3>{isAdmin ? 'Run settings' : 'Run limits'}</h3>
                {isAdmin && (
                  <p className="job-meta run-review-unlimited">
                    Admin runs have no limits unless you set one here. Leave a field empty for none.
                    {(forcedApplications !== null || forcedEvaluations !== null)
                      && ' A greyed-out field was set for this account in Admin, and that number wins.'}
                  </p>
                )}
                <div className="run-review-grid">
                  {(isAdmin || entitlements?.fineTune) && <label className="field">
                    <FieldLabel
                      label="Max applications"
                      help={forcedApplications !== null
                        ? `An operator has set this account to ${forcedApplications} applications per run. Runs use that number.`
                        : isAdmin
                          ? 'The most applications this run can complete before stopping. Empty means no limit.'
                          : 'The most applications this run can complete before stopping. Capped at 10 per run.'}
                    />
                    <input
                      className="input"
                      data-field="MAX_APPS_PER_RUN"
                      type="number"
                      min="1"
                      max={isAdmin ? undefined : 10}
                      placeholder={isAdmin ? 'No limit' : undefined}
                      disabled={forcedApplications !== null}
                      value={forcedApplications !== null ? String(forcedApplications) : val('MAX_APPS_PER_RUN')}
                      onChange={(e) => setEdit('MAX_APPS_PER_RUN', e.target.value)}
                    />
                    <FieldError field="MAX_APPS_PER_RUN" />
                  </label>}
                  {isAdmin && (
                  <label className="field">
                    <FieldLabel
                      label="Jobs to evaluate"
                      help={forcedEvaluations !== null
                        ? `An operator has set this account to ${forcedEvaluations} listings a run. Runs use that number.`
                        : 'How many listings the AI reviews in this run before it stops looking. Empty means no limit.'}
                    />
                    <input
                      className="input"
                      data-field="MAX_EVALUATIONS"
                      type="number"
                      min="1"
                      placeholder="No limit"
                      disabled={forcedEvaluations !== null}
                      value={forcedEvaluations !== null ? String(forcedEvaluations) : val('MAX_EVALUATIONS')}
                      onChange={(e) => setEdit('MAX_EVALUATIONS', e.target.value)}
                    />
                    <FieldError field="MAX_EVALUATIONS" />
                  </label>
                  )}
                  {entitlements?.advancedFilters && <label className="field">
                    <FieldLabel label="Match threshold" help="Jobs scoring below this number are skipped. A higher number gives fewer, closer matches." />
                    <input className="input" data-field="MIN_SCORE" type="number" min="0" max="100" value={val('MIN_SCORE')} onChange={(e) => setEdit('MIN_SCORE', e.target.value)} />
                    <FieldError field="MIN_SCORE" />
                  </label>}
                  {entitlements?.advancedFilters && <label className="field">
                    <FieldLabel label="Max listing age" help="Job listings older than this many days are skipped." />
                    <input className="input" type="number" min="0" value={val('MAX_AGE_DAYS')} onChange={(e) => setEdit('MAX_AGE_DAYS', e.target.value)} />
                  </label>}
                  {(isAdmin || entitlements?.fineTune) && <label className="field">
                    <FieldLabel
                      label="Daily application cap"
                      help={isAdmin
                        ? 'The total number of applications allowed in one day, across all runs. Empty means no limit.'
                        : 'The total number of applications allowed in one day, across all runs. Capped at 50.'}
                    />
                    <input className="input" data-field="MAX_APPS_PER_DAY" type="number" min="1" max={isAdmin ? undefined : 50} placeholder={isAdmin ? 'No limit' : undefined} value={val('MAX_APPS_PER_DAY')} onChange={(e) => setEdit('MAX_APPS_PER_DAY', e.target.value)} />
                    <FieldError field="MAX_APPS_PER_DAY" />
                  </label>}
                  {(isAdmin || entitlements?.fineTune) && <label className="field">
                    <FieldLabel
                      label="Search pages per term"
                      help={isAdmin
                        ? 'How many result pages to check for each search term. More pages find more jobs and make the run longer.'
                        : 'How many result pages to check for each search term. This multiplies by your number of search terms, so it is capped at 3.'}
                    />
                    <input className="input" data-field="PAGES_PER_KEYWORD" type="number" min="1" max={isAdmin ? undefined : 3} value={val('PAGES_PER_KEYWORD')} onChange={(e) => setEdit('PAGES_PER_KEYWORD', e.target.value)} />
                    <FieldError field="PAGES_PER_KEYWORD" />
                  </label>}
                </div>
              </section>}

              {error && !errorField && <div className="banner banner-bad run-review-error">{error}</div>}
            </div>

            <div className="confirm-actions run-review-actions">
              <button className="btn" disabled={starting} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger-solid"
                disabled={starting}
                onClick={saveAndStart}
              >
                {starting ? 'Saving and starting…' : firstRun ? 'Start first run' : 'Save and apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
