import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type WriteStream } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import type { Brief, SourceId } from '../core/types.js';
import { candidateUrl } from '../core/discovery.js';
import { reviewEvidence } from '../core/quality.js';
import { SOURCES } from '../sources/index.js';
import { EvidenceStore } from '../core/store.js';
import { renderHtml, renderMarkdown } from '../report/render.js';
import { preparePublicReport, type Report } from '../report/synthesize.js';

/**
 * The local web interface: a form that starts a research run, its progress
 * live, and every past run's report.
 *
 * Each run is the CLI in a child process, so the interface stays up whatever
 * a run does, and a run can be stopped by ending its process. One run at a
 * time: every run drives the same browser profile.
 *
 * Bound to 127.0.0.1 only, and every POST must come from this page's own
 * origin: the interface spends model credit and drives a browser, so no other
 * site or machine may trigger it.
 */

const RUN_ID = /^[\w.-]+$/;
const runsDir = () => resolve(config.dataDir, 'runs');
const pagePath = fileURLToPath(new URL('../../ui/index.html', import.meta.url));
const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
const basePath = process.env.SCOUT_UI_BASE_PATH === '/market-research' ? '/market-research' : '';

interface ActiveRun {
  id: string;
  child: ChildProcess;
  lines: string[];
  listeners: Set<ServerResponse>;
  log: WriteStream;
  status: 'running' | 'stopping';
}

let active: ActiveRun | undefined;

export async function startUi(port = Number(process.env.SCOUT_UI_PORT) || 5190): Promise<void> {
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer((req, res) => {
    handle(req, res, origin).catch((error: Error) => send(res, 500, { error: error.message }));
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  console.log(`Market Scout is open at ${origin}  (Ctrl+C to quit)`);
  if (process.env.SCOUT_NO_OPEN === '1') return;
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', origin]] : process.platform === 'darwin' ? ['open', [origin]] : ['xdg-open', [origin]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
  const url = new URL(req.url ?? '/', origin);
  const path = url.pathname;

  if (req.method === 'POST') {
    // Same-origin only: a page on any other site cannot start or stop runs here.
    const from = req.headers.origin ?? '';
    if (from !== origin && from !== origin.replace('127.0.0.1', 'localhost')) return send(res, 403, { error: 'Forbidden origin' });
  }

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(pagePath, 'utf8')
      .replace('<body>', `<body data-base-path="${basePath}">`)
      .replace(/<script>[\s\S]*?<\/script>/, `<script src="${basePath}/app.js"></script>`));
    return;
  }

  if (req.method === 'GET' && path === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(pagePath, 'utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '');
    return;
  }

  if (req.method === 'GET' && path === '/api/sources') {
    return send(res, 200, {
      sources: SOURCES.map((source) => ({ id: source.id, label: source.label, describe: source.describe, queryHint: source.queryHint, unavailable: source.unavailable() })),
      celeris: Boolean(config.celeris.apiKey),
      budgetUsd: config.budget.usd,
    });
  }

  if (req.method === 'GET' && path === '/api/runs') return send(res, 200, { runs: listRuns(), active: active?.id ?? null });

  if (req.method === 'POST' && path === '/api/runs') {
    if (existsSync(resolve('..', '.deploying'))) return send(res, 503, { error: 'An update is being installed. Try again shortly.' });
    if (active) return send(res, 409, { error: 'A run is already in progress. Stop it or wait for it to finish.' });
    if (!config.celeris.apiKey) return send(res, 400, { error: 'CELERIS_API_KEY is not set in market-scout/.env.' });
    const body = (await readJson(req)) as Partial<Brief> & { maxTasks?: number; followUps?: number; budgetUsd?: number };
    const brief = toBrief(body);
    if (brief.ownWebsite && !candidateUrl(brief.ownWebsite)) return send(res, 400, { error: 'Your website must be a public HTTPS address.' });
    if (!brief.product && !brief.niche) return send(res, 400, { error: 'Describe the product or the niche.' });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${(brief.brand || brief.niche || 'research').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;
    const dir = join(runsDir(), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
    const args = [cliPath, 'research', '--brief', join(dir, 'brief.json'), '--run-dir', dir];
    if (body.maxTasks) args.push('--max-tasks', String(clamp(body.maxTasks, 1, 30)));
    if (body.followUps !== undefined) args.push('--follow-ups', String(clamp(body.followUps, 0, 12)));
    if (body.budgetUsd) args.push('--budget', String(clamp(body.budgetUsd, 0.1, 20)));
    launch(id, dir, args);
    return send(res, 201, { id });
  }

  const match = /^\/api\/runs\/([^/]+)(\/[a-z]+)?$/.exec(path);
  if (match && RUN_ID.test(match[1])) {
    const id = match[1];
    const dir = join(runsDir(), id);
    if (!existsSync(dir)) return send(res, 404, { error: 'No such run' });
    const action = match[2] ?? '';

    if (req.method === 'GET' && action === '/context') return send(res, 200, safeJson<Brief>(join(dir, 'brief.json')) ?? {});

    if (req.method === 'GET' && action === '/events') return stream(id, dir, res);

    if (req.method === 'POST' && action === '/stop') {
      if (active?.id !== id) return send(res, 409, { error: 'That run is not running.' });
      active.status = 'stopping';
      // Asked over IPC, the CLI closes its Chrome before exiting; a killed process would leave Chrome running (Windows has no SIGINT for children).
      const child = active.child;
      child.send?.({ type: 'stop' });
      setTimeout(() => child.exitCode === null && child.kill(), 15_000).unref();
      return send(res, 202, { ok: true });
    }

    if (req.method === 'POST' && action === '/report') {
      if (existsSync(resolve('..', '.deploying'))) return send(res, 503, { error: 'An update is being installed. Try again shortly.' });
      if (active) return send(res, 409, { error: 'Wait for the current run to finish.' });
      const archive = join(dir, 'previous-reports', new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(archive, { recursive: true });
      for (const file of ['report.html', 'report.md', 'report.json', 'insights.json', 'quality.json']) if (existsSync(join(dir, file))) copyFileSync(join(dir, file), join(archive, file));
      launch(id, dir, [cliPath, 'research', '--resume', dir]);
      return send(res, 202, { ok: true });
    }
  }

  // A finished run's report, and nothing else from the run folder.
  const report = /^\/runs\/([^/]+)\/report\.(html|md|json)$/.exec(path);
  if (req.method === 'GET' && report && RUN_ID.test(report[1])) {
    const file = join(runsDir(), report[1], `report.${report[2]}`);
    if (!existsSync(file)) return send(res, 404, { error: 'No report yet' });
    const data = safeJson<Report>(join(runsDir(), report[1], 'report.json'));
    if (!data) return send(res, 422, { error: 'Saved report data is unavailable; recheck the saved evidence before using this report.' });
    const type = { html: 'text/html; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json' }[report[2] as 'html'];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    const store = new EvidenceStore(join(runsDir(), report[1]));
    const content = data ? report[2] === 'html' ? renderHtml(data, store) : report[2] === 'md' ? renderMarkdown(data, store) : JSON.stringify(preparePublicReport(data, store), null, 2) : readFileSync(file, 'utf8');
    res.end(report[2] === 'html' ? content.replace('href="/"', `href="${basePath}/"`) : content);
    return;
  }

  send(res, 404, { error: 'Not found' });
}

function launch(id: string, dir: string, args: string[]): void {
  writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));
  const log = createWriteStream(join(dir, 'run.log'), { flags: 'a' });
  const child = spawn(process.execPath, args, { cwd: resolve('.'), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const run: ActiveRun = { id, child, lines: [], listeners: new Set(), log, status: 'running' };
  active = run;
  const emit = (line: string) => {
    run.lines.push(line);
    log.write(`${line}\n`);
    for (const client of run.listeners) client.write(`data: ${JSON.stringify({ line })}\n\n`);
  };
  for (const output of [child.stdout, child.stderr]) {
    let buffer = '';
    output?.setEncoding('utf8');
    output?.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      parts.forEach(emit);
    });
    output?.on('end', () => { if (buffer.trim()) emit(buffer); });
  }
  child.on('exit', (code) => {
    const report = safeJson<{ status?: string }>(join(dir, 'report.json'));
    const outcome = run.status === 'stopping' ? 'stopped' : code === 0 ? (report?.status === 'partial' ? 'partial' : 'done') : 'failed';
    writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ status: outcome, finishedAt: new Date().toISOString() }));
    emit(`[run ${outcome}]`);
    for (const client of run.listeners) {
      client.write(`event: end\ndata: ${JSON.stringify({ outcome })}\n\n`);
      client.end();
    }
    log.end();
    if (active === run) active = undefined;
  });
}

/** Server-sent events: the log so far, then each new line, then an end event. */
function stream(id: string, dir: string, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const run = active?.id === id ? active : undefined;
  const history = run ? run.lines : existsSync(join(dir, 'run.log')) ? readFileSync(join(dir, 'run.log'), 'utf8').split(/\r?\n/).filter(Boolean) : [];
  for (const line of history) res.write(`data: ${JSON.stringify({ line })}\n\n`);
  if (!run) {
    res.write(`event: end\ndata: ${JSON.stringify({ outcome: statusOf(dir) })}\n\n`);
    res.end();
    return;
  }
  run.listeners.add(res);
  res.on('close', () => run.listeners.delete(res));
}

export function statusOf(dir: string): string {
  if (active && resolve(dir) === join(runsDir(), active.id)) return 'running';
  const state = safeJson<{ status: string }>(join(dir, 'run-state.json'));
  if (state) return state.status === 'running' ? 'incomplete' : state.status;
  const log = existsSync(join(dir, 'run.log')) ? readFileSync(join(dir, 'run.log'), 'utf8') : '';
  const last = [...log.matchAll(/\[run (done|partial|stopped|failed)\]/g)].at(-1)?.[1];
  if (last === 'failed' || last === 'stopped' || last === 'partial') return last;
  if (existsSync(join(dir, 'report.html'))) return safeJson<{ status?: string }>(join(dir, 'report.json'))?.status === 'partial' ? 'partial' : 'done';
  return last ?? 'incomplete';
}

function listRuns() {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .filter((id) => RUN_ID.test(id) && existsSync(join(runsDir(), id, 'brief.json')))
    .map((id) => {
      const dir = join(runsDir(), id);
      const brief = safeJson<Brief>(join(dir, 'brief.json'));
      const report = safeJson<{ headline?: string; cost?: string; version?: number; quality?: { included: number; excluded: number; unverified: number; customerItems: number } }>(join(dir, 'report.json'));
      return {
        id,
        brand: brief?.brand ?? '',
        niche: brief?.niche ?? '',
        product: brief?.product ?? '',
        country: brief?.country ?? '',
        startedAt: statSync(join(dir, 'brief.json')).mtime.toISOString(),
        status: statusOf(dir),
        headline: report?.headline ?? '',
        cost: report?.cost ?? '',
        version: report?.version ?? 1,
        quality: report && brief ? reviewEvidence(new EvidenceStore(dir).all(), brief).quality : undefined,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function toBrief(body: Partial<Brief>): Brief {
  const text = (value: unknown, max = 400) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
  const list = (value: unknown, max = 10) =>
    (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : []).map((item) => text(item, 200)).filter(Boolean).slice(0, max);
  const known = new Set(SOURCES.map((source) => source.id));
  return {
    autoDiscover: body.autoDiscover !== false,
    product: text(body.product),
    niche: text(body.niche, 120),
    brand: text(body.brand, 80),
    ownWebsite: text(body.ownWebsite, 200),
    competitors: list(body.competitors),
    websites: list(body.websites),
    country: (text(body.country, 2) || 'AU').toUpperCase(),
    language: (text(body.language, 5) || 'en').toLowerCase(),
    audience: text(body.audience),
    goals: list(body.goals, 6),
    sources: list(body.sources, 20).filter((id): id is SourceId => known.has(id as SourceId)),
  };
}

function safeJson<T>(file: string): T | undefined {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number(value) || min));

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
