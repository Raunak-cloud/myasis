import { useEffect, useMemo, useRef, useState } from 'react';
import { SetupChecklist, useSetupStatus } from './SetupChecklist';
import { FieldLabel } from './FieldLabel';
import { AUSTRALIAN_CITIES } from '../runSettings';

type Mode = 'rehearse' | 'live';

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

interface RunStatus {
  running: boolean;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  applied: number;
  hasKey: boolean;
  /** false when a run is active but belongs to a different account — the server withholds every other field then. */
  isOwner: boolean;
}

const CONTROLS = [
  { key: 'MAX_APPS_PER_RUN', label: 'Max applications', hint: 'stops after this many', help: 'The most applications this run can complete before stopping.' },
  { key: 'MAX_EVALUATIONS', label: 'Jobs to evaluate', hint: 'maximum 120', help: 'The most job listings this run will open and assess. Capped at 120 to keep runs bounded.' },
  { key: 'MIN_SCORE', label: 'Match threshold', hint: 'out of 100', help: 'Jobs scoring below this number are skipped. A higher number gives fewer, closer matches.' },
] as const;

const RUN_DEFAULTS: Record<string, string> = {
  KEYWORDS: '',
  TARGET_ROLE: '',
  PLATFORMS: 'seek',
  WORK_ARRANGEMENTS: 'remote,hybrid,onsite',
  ONSITE_CITY: 'Sydney',
  SEARCH_RADIUS_KM: '0',
  MIN_SALARY: '70000',
  MAX_AGE_DAYS: '14',
  MAX_APPS_PER_RUN: '5',
  MAX_EVALUATIONS: '40',
  MIN_SCORE: '60',
  MAX_APPS_PER_DAY: '20',
  PAGES_PER_KEYWORD: '1',
  COVER_LETTER_MODE: 'tailored',
  COVER_LETTER_TEXT_B64: '',
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

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  if (!value) return '';
  try {
    const binary = atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return '';
  }
}

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
  return { found, reviewed, suitable };
}

function activityEvents(lines: LogLine[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const add = (line: LogLine, title: string, tone: ActivityTone, detail?: string) => {
    const previous = events.at(-1);
    if (previous?.title === title && previous.detail === detail) return;
    events.push({ id: `${line.seq}-${events.length}`, title, detail, tone });
  };

  for (const line of lines) {
    const text = line.text.trim();
    let match: RegExpMatchArray | null;

    if (/starting (?:rehearse|live) run/i.test(text)) {
      add(line, 'Run started', 'done');
    } else if ((match = text.match(/(SEEK|Indeed) session OK/i))) {
      add(line, `Connected to ${match[1]}`, 'done');
    } else if ((match = text.match(/(SEEK|Indeed) Recommended -> (\d+)/i))) {
      add(line, `${match[2]} ${match[1]} Recommended jobs prioritised`, 'done');
    } else if ((match = text.match(/⚠ (SEEK|Indeed): (.+)/i))) {
      add(line, `${match[1]} unavailable this run`, 'warn', match[2]);
    } else if ((match = text.match(/(\d+) unique listings discovered/i))) {
      add(line, `Found ${match[1]} job listings`, 'done');
    } else if ((match = text.match(/(\d+) qualifying jobs/i))) {
      add(line, `${match[1]} suitable ${Number(match[1]) === 1 ? 'job' : 'jobs'} ready`, 'done');
    } else if ((match = text.match(/→ Applying:\s*(.+?)\s+@\s+(.+)/i))) {
      add(line, `Applying to ${match[1]}`, 'neutral', match[2]);
    } else if (/discarded a stale pre-filled cover letter/i.test(text)) {
      add(line, 'Prepared a fresh cover letter', 'neutral');
    } else if ((match = text.match(/✅ submitted\s*(?:\(([^)]+)\))?/i))) {
      add(line, 'Application submitted', 'done', match[1] ? `${match[1]} this run` : undefined);
    } else if (/🧪 rehearsed/i.test(text)) {
      add(line, 'Rehearsal completed', 'done', 'The form was completed without submitting.');
    } else if ((match = text.match(/⏸ needs you:\s*(.+)/i))) {
      add(line, 'Needs your attention', 'warn', match[1]);
    } else if ((match = text.match(/↪ off-platform.*?—\s*(.+)/i))) {
      add(line, 'Skipped an external application', 'warn', match[1]);
    } else if ((match = text.match(/(?:✗\s+(?:unexpected )?error:|Fatal:)\s*(.+)/i))) {
      add(line, 'Something went wrong', 'bad', match[1]);
    } else if ((match = text.match(/=== Run complete:\s*(\d+) new application/i))) {
      add(
        line,
        'Run complete',
        'done',
        `${match[1]} ${Number(match[1]) === 1 ? 'application' : 'applications'} submitted.`,
      );
    } else if (/run finished \(exit [^0]/i.test(text)) {
      add(line, 'Run stopped before completion', 'bad');
    }
  }

  return events.slice(-10);
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? 'next month'
    : new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' }).format(date);
}

function logTime(timestamp?: string): string {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? '--:--:--'
    : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

function logChannel(line: LogLine): string {
  if (line.stream === 'sys') return 'SYSTEM';
  if (line.stream === 'err') return 'ALERT';
  if (/✅\s*submitted|application submitted/i.test(line.text)) return 'SUBMITTED';
  if (/search|listing|discovered/i.test(line.text)) return 'SCAN';
  if (/^\s*✓\s*\d+\s*·|qualifying jobs/i.test(line.text)) return 'MATCH';
  if (/^\s*✗\s*\d+\s*·|^\s*\d+\s*×|Filtered out|fit check/i.test(line.text)) return 'UNSUITABLE';
  if (/Applying:|\bform\b|résumé|cover letter|rehearsed/i.test(line.text)) return 'APPLY';
  return 'TASK';
}

/**
 * The main screen: start a run and watch it.
 *
 * The default activity view turns verbose process output into a short timeline.
 * Full details remain available in a collapsed log for troubleshooting.
 */
export function RunPanel({
  onFinished,
  onGoSetup,
  onGoPricing,
}: {
  onFinished: () => void;
  onGoSetup: () => void;
  onGoPricing: () => void;
}) {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [mode, setMode] = useState<Mode>('rehearse');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<LogLine[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [stopConfirming, setStopConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outOfApplications, setOutOfApplications] = useState(false);
  /** Display preference only — MIN_SALARY is always stored/sent as an annual AUD figure. */
  const [salaryUnit, setSalaryUnit] = useState<'annual' | 'hourly'>('annual');
  const [freeResetsAt, setFreeResetsAt] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const setup = useSetupStatus();
  const consoleRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const tick = async () => {
      try {
        const s: RunStatus = await fetch('/api/run/status').then((r) => r.json());
        setStatus(s);
        if (!s.running) setStopConfirming(false);
        if (wasRunning.current && !s.running) onFinished();
        wasRunning.current = s.running;
      } catch {
        /* server restarting */
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [onFinished]);

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

  const running = status?.running ?? false;
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
  const val = (k: string, d = RUN_DEFAULTS[k] ?? '') => edits[k] ?? settings[k] ?? d;
  const setEdit = (key: string, value: string) =>
    setEdits((current) => ({ ...current, [key]: value }));
  /**
   * MIN_SALARY is always sent/stored as an annual AUD figure — scoring.ts's
   * own hourly-rate parsing already uses ~1800 billable hours/year to judge
   * a listed hourly rate against it, so the same factor is used here to
   * convert what the user types. Only the display unit is a preference.
   */
  const HOURLY_TO_ANNUAL = 1800;
  const minSalaryDisplay =
    salaryUnit === 'hourly'
      ? val('MIN_SALARY')
        ? String(Math.round((Number(val('MIN_SALARY')) / HOURLY_TO_ANNUAL) * 100) / 100)
        : ''
      : val('MIN_SALARY');
  const setMinSalaryDisplay = (raw: string) => {
    if (!raw.trim()) return setEdit('MIN_SALARY', '');
    const n = Number(raw);
    if (!Number.isFinite(n)) return setEdit('MIN_SALARY', raw); // let existing validation reject it
    setEdit('MIN_SALARY', String(salaryUnit === 'hourly' ? Math.round(n * HOURLY_TO_ANNUAL) : n));
  };
  const arrangements = val('WORK_ARRANGEMENTS').split(',').map((item) => item.trim()).filter(Boolean);
  const coverLetterMode = val('COVER_LETTER_MODE') === 'reuse' ? 'reuse' : 'tailored';
  const reusableCoverLetter = decodeBase64(val('COVER_LETTER_TEXT_B64'));
  const toggleArrangement = (item: string) => {
    const next = new Set(arrangements);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setEdit('WORK_ARRANGEMENTS', [...next].join(','));
  };
  const platforms = val('PLATFORMS').split(',').map((item) => item.trim()).filter(Boolean);
  const togglePlatform = (id: string) => {
    const next = new Set(platforms);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setEdit('PLATFORMS', [...next].join(','));
  };
  const summary = useMemo(() => activitySummary(lines), [lines]);
  const events = useMemo(() => activityEvents(lines), [lines]);
  const logSections = useMemo(() => {
    const sectionFor = (line: LogLine) => {
      const channel = logChannel(line);
      if (channel === 'MATCH') return 'matches';
      if (channel === 'APPLY') return 'applications';
      if (channel === 'SUBMITTED') return 'submitted';
      return 'process';
    };
    const sections = [
      { id: 'process', title: 'Search and review', lines: [] as LogLine[] },
      { id: 'matches', title: 'Suitable matches', lines: [] as LogLine[] },
      { id: 'applications', title: 'Applications in progress', lines: [] as LogLine[] },
      { id: 'submitted', title: 'Submitted applications', lines: [] as LogLine[] },
    ];
    const sectionMap = new Map(sections.map((section) => [section.id, section]));
    lines.forEach((line) => sectionMap.get(sectionFor(line))?.lines.push(line));
    return sections.filter((section) => section.lines.length > 0);
  }, [lines]);
  const latestApplicationLine = [...lines].reverse().find((line) => /→ Applying:/i.test(line.text));
  const latestOutcomeLine = [...lines].reverse().find((line) =>
    /✅ submitted|🧪 rehearsed|⏸ needs you:|↪ off-platform|✗ (?:unexpected )?error:/i.test(line.text),
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

  async function saveAndStart() {
    if (starting) return;
    setError(null);
    const updates = Object.fromEntries(REVIEW_KEYS.map((key) => [key, val(key)]));
    const numericKeys = [
      'MIN_SALARY', 'MAX_AGE_DAYS', 'MAX_APPS_PER_RUN', 'MAX_EVALUATIONS',
      'MIN_SCORE', 'MAX_APPS_PER_DAY', 'PAGES_PER_KEYWORD',
    ];
    const positiveKeys = [
      'MAX_APPS_PER_RUN', 'MAX_EVALUATIONS', 'MAX_APPS_PER_DAY', 'PAGES_PER_KEYWORD',
    ];
    if (!updates.KEYWORDS.trim()) {
      setError('Add at least one job title or search term.');
      return;
    }
    if (!updates.WORK_ARRANGEMENTS.trim()) {
      setError('Choose at least one work arrangement.');
      return;
    }
    if (!updates.PLATFORMS.trim()) {
      setError('Choose at least one job board.');
      return;
    }
    if (numericKeys.some((key) => !Number.isFinite(Number(updates[key])) || Number(updates[key]) < 0)) {
      setError('Check the numeric settings before starting.');
      return;
    }
    if (positiveKeys.some((key) => Number(updates[key]) < 1)) {
      setError('Application and search limits must be at least 1.');
      return;
    }
    if (Number(updates.MIN_SCORE) > 100) {
      setError('Match threshold must be between 0 and 100.');
      return;
    }
    if (updates.COVER_LETTER_MODE === 'reuse' && !decodeBase64(updates.COVER_LETTER_TEXT_B64).trim()) {
      setError('Paste the cover letter you want to reuse.');
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
        body: JSON.stringify({ mode, confirm: mode === 'live', overrides: updates }),
      });
      if (runResponse.status === 402) {
        setConfirming(false);
        setOutOfApplications(true);
        fetch('/api/billing/status')
          .then((r) => r.json())
          .then((s) => setFreeResetsAt(s?.free?.resetsAt ?? null))
          .catch(() => {});
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
      <div className="card run-controls-card">
        <div className="run-card-title">
          <h2>New run</h2>
          <p className="job-meta">Rehearse first, then apply when everything looks right.</p>
        </div>
        <div className="modes">
          <label className={`mode ${mode === 'rehearse' ? 'sel' : ''}`}>
            <input type="radio" checked={mode === 'rehearse'} disabled={running} onChange={() => setMode('rehearse')} />
            <div>
              <div className="mode-title">
                Rehearse <span className="badge warn">safe</span>
              </div>
              <div className="job-meta">
                Completes the full process but stops before submitting.
              </div>
            </div>
          </label>
          <label className={`mode ${mode === 'live' ? 'sel' : ''}`}>
            <input type="radio" checked={mode === 'live'} disabled={running} onChange={() => setMode('live')} />
            <div>
              <div className="mode-title">
                Apply for real <span className="badge bad">submits</span>
              </div>
              <div className="job-meta">Sends applications to employers automatically.</div>
            </div>
          </label>
        </div>

        <section className="run-options" aria-labelledby="run-limits-title">
          <h3 id="run-limits-title">Run limits</h3>
          <div className="grid-2 run-options-grid">
            {CONTROLS.map((c) => (
              <label className="field" key={c.key}>
                <FieldLabel label={c.label} help={c.help} />
                <input
                  className="input"
                  type="number"
                  value={val(c.key)}
                  disabled={running}
                  onChange={(e) => setEdit(c.key, e.target.value)}
                />
                <span className="job-meta">{c.hint}</span>
              </label>
            ))}
          </div>
        </section>

        {!status?.hasKey && (
          <div className="banner">Matching is not configured, so results will only use keywords.</div>
        )}
        {running && status?.isOwner === false && (
          <div className="banner">
            Another account is currently running — the shared browser can only do one run at a time. Try again once it finishes.
          </div>
        )}
        {error && <div className="banner banner-bad">{error}</div>}

        <div className="run-actions">
          {running && status?.isOwner === false ? (
            <button className="btn primary lg" disabled>
              Busy with another account's run
            </button>
          ) : running ? (
            <button className="btn btn-danger lg" onClick={() => setStopConfirming(true)}>
              ⏹ Stop run
            </button>
          ) : (
            <button
              className="btn primary lg"
              onClick={() => setConfirming(true)}
            >
              Start {mode === 'rehearse' ? 'rehearsal' : 'live run'}
            </button>
          )}
        </div>

        {!running && status?.finishedAt && (
          <p className="job-meta">
            Last run: {status.applied} submitted · exit {status.exitCode}
          </p>
        )}
      </div>

      <div className="card console-card">
        <div className="console-head">
          <div className="console-status">
            <strong>Activity</strong>
            <span className={`badge ${running ? 'ok' : 'muted'}`}>
              {running ? (
                <span className="in-progress-label">
                  In progress
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
          {lines.length > 0 && !running && (
            <button className="btn" onClick={() => setLines([])}>Clear</button>
          )}
        </div>

        {lines.length > 0 && (
          <div className="activity-stats" aria-label="Run progress">
            <div><strong>{summary.found}</strong><span>Found</span></div>
            <div><strong>{summary.reviewed}</strong><span>Reviewed</span></div>
            <div><strong>{summary.suitable}</strong><span>Suitable</span></div>
            <div><strong>{status?.applied ?? 0}</strong><span>Submitted</span></div>
          </div>
        )}

        <div ref={consoleRef} className="activity-body">
          {lines.length === 0 ? (
            <div className="console-empty">
              <strong>No activity yet</strong>
              <span>Start a run to follow its progress here.</span>
            </div>
          ) : (
            <>
              {running && (
                <div className="activity-current">
                  <span className="activity-pulse" aria-hidden="true" />
                  <div>
                    <strong>Now</strong>
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

              <details className="raw-log" open>
                <summary>View detailed log</summary>
                <div className="raw-terminal">
                  <div className="terminal-bar">
                    <div className="terminal-lights" aria-hidden="true">
                      <span /><span /><span />
                    </div>
                    <span className="terminal-title">myasis://local-activity</span>
                    <span className={`terminal-state ${running ? 'live' : ''}`}>
                      {running ? 'Live' : 'Session ended'}
                    </span>
                  </div>
                  <div className="raw-console">
                    {logSections.map((section) => (
                      <section className="terminal-section" key={section.id} aria-labelledby={`log-section-${section.id}`}>
                        <div className="terminal-section-head" id={`log-section-${section.id}`}>
                          <span>{section.title}</span>
                          <span>{section.lines.length}</span>
                        </div>
                        {section.lines.map((line) => (
                          <div key={line.seq} className={`terminal-line ${line.stream}`}>
                            <span className="terminal-time">{logTime(line.ts)}</span>
                            <span className="terminal-channel">{logChannel(line)}</span>
                            <span className="terminal-message">{line.text}</span>
                          </div>
                        ))}
                      </section>
                    ))}
                    {running && (
                      <section className="terminal-section terminal-section-active" aria-labelledby="log-section-active">
                        <div className="terminal-section-head" id="log-section-active"><span>Current activity</span></div>
                        <div className="terminal-line waiting">
                          <span className="terminal-time">{logTime(new Date().toISOString())}</span>
                          <span className="terminal-channel">ACTIVE</span>
                          <span className="terminal-message">Watching the next process event<span className="terminal-cursor" /></span>
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              </details>
            </>
          )}
        </div>
      </div>

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
              {freeResetsAt
                ? `You've used all your applications for now. Get a pass to keep applying today, or wait — your free applications reset on ${dateLabel(freeResetsAt)}.`
                : "You've used all your applications for now. Get a pass to keep applying today, or wait for your free applications to reset next month."}
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
        <div className="overlay center" onClick={() => !starting && setConfirming(false)}>
          <div className="card run-review-modal" role="dialog" aria-modal="true" aria-labelledby="run-review-title" onClick={(e) => e.stopPropagation()}>
            <div className="run-review-head">
              <div>
                <h2 id="run-review-title">Review run settings</h2>
                <p className="job-meta">Changes made here are saved before the run starts.</p>
              </div>
              <span className={`badge ${mode === 'live' ? 'bad' : 'warn'}`}>
                {mode === 'live' ? 'Live run' : 'Rehearsal'}
              </span>
            </div>

            <div className="run-review-body">
              {mode === 'live' && (
                <div className="banner banner-bad run-review-warning">
                  This run submits applications to employers. Submitted applications cannot be withdrawn here.
                </div>
              )}

              <section className="run-review-section">
                <h3>What to find</h3>
                <div className="field run-review-wide">
                  <FieldLabel label="Job boards" help="Which job boards to search and apply on this run. Both are searched, scored and deduplicated together as one combined pool." />
                  <div className="chips">
                    {JOB_BOARDS.map((board) => (
                      <button
                        type="button"
                        key={board.id}
                        className={`chip ${platforms.includes(board.id) ? 'on' : ''}`}
                        onClick={() => togglePlatform(board.id)}
                      >
                        {platforms.includes(board.id) ? '✓ ' : ''}{board.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="job-meta recommended-first-note">
                  Recommended jobs from each selected board are analysed first. Search terms expand the pool after those jobs.
                </p>
                <label className="field run-review-wide">
                  <FieldLabel label="Job titles and search terms" help="The roles and keywords used to search for job listings. Separate multiple terms with commas." />
                  <textarea
                    className="input"
                    rows={3}
                    value={val('KEYWORDS')}
                    onChange={(e) => setEdit('KEYWORDS', e.target.value)}
                  />
                </label>
                <label className="field run-review-wide">
                  <FieldLabel label="Target role" optional help="Use this when moving into a different type of work. Leave it blank to match your current experience." />
                  <input className="input" value={val('TARGET_ROLE')} onChange={(e) => setEdit('TARGET_ROLE', e.target.value)} />
                </label>
              </section>

              <section className="run-review-section">
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
                      value={reusableCoverLetter}
                      onChange={(event) => setEdit('COVER_LETTER_TEXT_B64', encodeBase64(event.target.value))}
                    />
                  </label>
                )}
              </section>

              <section className="run-review-section">
                <h3>Location and pay</h3>
                <div className="field run-review-wide">
                  <FieldLabel label="Work arrangements" help="Choose whether to include remote, hybrid, and on-site jobs." />
                  <div className="chips">
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
                    <FieldLabel label="Minimum salary" help="Jobs with a known salary below this are skipped, converted to a yearly figure either way. Jobs without a listed salary are still considered." />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="input"
                        type="number"
                        min="0"
                        step={salaryUnit === 'hourly' ? 1 : 5000}
                        value={minSalaryDisplay}
                        onChange={(e) => setMinSalaryDisplay(e.target.value)}
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <select
                        className="input"
                        style={{ flex: '0 0 auto', width: 92 }}
                        value={salaryUnit}
                        onChange={(e) => setSalaryUnit(e.target.value as 'annual' | 'hourly')}
                      >
                        <option value="annual">per year</option>
                        <option value="hourly">per hour</option>
                      </select>
                    </div>
                  </label>
                </div>
              </section>

              <section className="run-review-section">
                <h3>Run limits</h3>
                <div className="run-review-grid">
                  <label className="field">
                    <FieldLabel label="Max applications" help="The most applications this run can complete before stopping." />
                    <input className="input" type="number" min="1" value={val('MAX_APPS_PER_RUN')} onChange={(e) => setEdit('MAX_APPS_PER_RUN', e.target.value)} />
                  </label>
                  <label className="field">
                    <FieldLabel label="Jobs to evaluate" help="The most job listings this run will open and assess. Capped at 120 to keep runs bounded." />
                    <input className="input" type="number" min="1" max="120" value={val('MAX_EVALUATIONS')} onChange={(e) => setEdit('MAX_EVALUATIONS', e.target.value)} />
                  </label>
                  <label className="field">
                    <FieldLabel label="Match threshold" help="Jobs scoring below this number are skipped. A higher number gives fewer, closer matches." />
                    <input className="input" type="number" min="0" max="100" value={val('MIN_SCORE')} onChange={(e) => setEdit('MIN_SCORE', e.target.value)} />
                  </label>
                  <label className="field">
                    <FieldLabel label="Max listing age" help="Job listings older than this many days are skipped." />
                    <input className="input" type="number" min="0" value={val('MAX_AGE_DAYS')} onChange={(e) => setEdit('MAX_AGE_DAYS', e.target.value)} />
                  </label>
                  <label className="field">
                    <FieldLabel label="Daily application cap" help="The total number of applications allowed in one day, across all runs." />
                    <input className="input" type="number" min="1" value={val('MAX_APPS_PER_DAY')} onChange={(e) => setEdit('MAX_APPS_PER_DAY', e.target.value)} />
                  </label>
                  <label className="field">
                    <FieldLabel label="Search pages per term" help="How many result pages to check for each search term. More pages take longer." />
                    <input className="input" type="number" min="1" value={val('PAGES_PER_KEYWORD')} onChange={(e) => setEdit('PAGES_PER_KEYWORD', e.target.value)} />
                  </label>
                </div>
              </section>

              {error && <div className="banner banner-bad run-review-error">{error}</div>}
            </div>

            <div className="confirm-actions run-review-actions">
              <button className="btn" disabled={starting} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                className={`btn ${mode === 'live' ? 'btn-danger-solid' : 'primary'}`}
                disabled={starting}
                onClick={saveAndStart}
              >
                {starting
                  ? 'Saving and starting…'
                  : mode === 'live'
                    ? 'Save and apply for real'
                    : 'Save and start rehearsal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
