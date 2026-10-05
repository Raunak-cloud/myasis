import { createHash } from 'node:crypto';
import type { Page } from 'patchright';
import { config } from '../config.js';
import { distill } from '../browser/distill.js';
import { locateRef, observe, renderObservation, type Observation } from '../browser/observe.js';
import { settle, visit } from '../browser/session.js';
import { BlockedError } from '../core/politeness.js';
import { BudgetExceededError, celerisChat, approxTokens, type ChatMessage, type CostMeter, type ToolCall, type ToolSchema } from '../llm/celeris.js';
import { extractRecords, UNTRUSTED } from '../llm/extract.js';

/**
 * The browser agent: given a goal and a starting page, it browses like a
 * researcher — searching, opening, scrolling, paging — and collects records
 * that match a schema, each tied to the URL it came from.
 *
 * Loop shape (browser-use / Skyvern): observe → Magnus picks up to four
 * actions → run them, stopping at the first surprise → observe again.
 * Extraction runs on celeris-1 against the full page, so raw page text never
 * floods the reasoning transcript. Hard rails, not the model, decide when to
 * stop: step cap, spend cap, repeated no-op actions, and any wall.
 */

export type AgentStatus = 'done' | 'blocked' | 'budget' | 'stuck' | 'max-steps' | 'error';

export interface AgentRecord extends Record<string, unknown> {
  sourceUrl: string;
}

export interface AgentResult {
  status: AgentStatus;
  summary: string;
  records: AgentRecord[];
  notes: string[];
  visited: string[];
  steps: number;
}

export interface AgentOptions {
  goal: string;
  startUrl: string;
  /** JSON Schema `properties` of one record the goal is collecting. */
  recordProperties: Record<string, unknown>;
  recordKey: (record: Record<string, unknown>) => string;
  meter: CostMeter;
  maxSteps?: number;
  maxRecords?: number;
  /** Hosts the agent may navigate to; empty allows any. */
  allowedHosts?: string[];
  log?: (line: string) => void;
}

const MAX_ACTIONS_PER_TURN = 4;

const TOOLS: ToolSchema[] = [
  tool('navigate', 'Open a URL in the current tab.', { url: { type: 'string' } }),
  tool('click', 'Click an interactive element by its [number].', { ref: { type: 'integer' } }),
  tool('type', 'Type into an input by its [number]. Set submit to press Enter afterwards (e.g. to run a search).', {
    ref: { type: 'integer' },
    text: { type: 'string' },
    submit: { type: 'boolean' },
  }),
  tool('select', 'Choose an option in a <select> by its [number] and the visible option text.', { ref: { type: 'integer' }, option: { type: 'string' } }),
  tool('scroll', 'Scroll the page to load or reveal more content.', { direction: { type: 'string', enum: ['down', 'up'] }, screens: { type: 'integer' } }),
  tool('back', 'Go back to the previous page.', {}),
  tool('extract', 'Extract every record matching the goal from the WHOLE current page (not only what is on screen) and save them. Use this once a page shows the data; scroll first if it loads more as you scroll.', {
    instruction: { type: 'string', description: 'What to extract here, specific to this page.' },
  }),
  tool('note', 'Remember a fact for later (a lead, a URL to visit, what has been covered).', { text: { type: 'string' } }),
  tool('done', 'Finish. Call when the goal is met, when enough records are saved, or when the data is not available here.', {
    summary: { type: 'string', description: 'What was found and what could not be found, in two or three sentences.' },
    success: { type: 'boolean' },
  }),
];

function tool(name: string, description: string, properties: Record<string, unknown>): ToolSchema {
  return { name, description, parameters: { type: 'object', properties, required: Object.keys(properties).filter((key) => key !== 'submit' && key !== 'screens') } };
}

export async function runAgent(page: Page, options: AgentOptions): Promise<AgentResult> {
  const log = options.log ?? (() => {});
  const maxSteps = options.maxSteps ?? config.agent.maxSteps;
  const maxRecords = options.maxRecords ?? 100;
  const records = new Map<string, AgentRecord>();
  const notes: string[] = [];
  const visited = new Set<string>();
  const result = (status: AgentStatus, summary: string): AgentResult => ({
    status,
    summary,
    records: [...records.values()],
    notes,
    visited: [...visited],
    steps,
  });

  let steps = 0;
  try {
    await visit(page, options.startUrl);
  } catch (error) {
    return result(error instanceof BlockedError ? 'blocked' : 'error', (error as Error).message);
  }
  visited.add(page.url());

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a marketing research agent driving a web browser that is NOT signed in to anything.',
        'You collect public data toward the goal, then finish. Work like an efficient researcher: use the site search and filters, open the most relevant results, scroll feeds that load more, and call extract when a page holds the data.',
        'Never sign in, create accounts, solve CAPTCHAs or try to get around a block; if a page demands any of these, finish and say so.',
        'Search-engine result pages (Google, Bing, DuckDuckGo and the like) are refused. Use the site\'s own search, menus and links, or open sites you already know by URL.',
        'Act only through the numbered elements in the latest observation; numbers change after every observation.',
        'Call done as soon as the goal is met or clearly cannot be met here. Do not wander off-topic.',
        UNTRUSTED,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `GOAL: ${options.goal}\n\nEach record you extract has these fields: ${Object.keys(options.recordProperties).join(', ')}. Collect up to ${maxRecords} records.`,
    },
  ];
  const observations = new Set<ChatMessage>();

  let stalls = 0;
  let repeats = 0;
  let lastSignature = '';
  let lastFingerprint = '';
  let note = '';

  while (steps < maxSteps) {
    steps += 1;
    const stuck = stalls >= config.agent.escalateAfterStalls;
    let observation: Observation;
    try {
      observation = await observe(page, { screenshot: stuck && config.agent.screenshots });
    } catch (error) {
      return result('error', `Could not read the page: ${(error as Error).message}`);
    }
    const fingerprint = hash(`${observation.url}|${observation.controls.map((c) => c.label).join('|')}|${observation.content}|${observation.scroll.y}`);
    if (fingerprint === lastFingerprint) {
      stalls += 1;
      note += '\nNOTE: the page did not change after your last actions. Try something different.';
    } else stalls = 0;
    lastFingerprint = fingerprint;
    if (stalls >= 5) return result('stuck', 'The page stopped responding to every action tried.');

    // Old observations become one-line stubs: only the latest is true, and it keeps the transcript small.
    for (const message of observations) {
      if (message.role !== 'user') continue;
      const first = typeof message.content === 'string' ? message.content.split('\n')[0] : '';
      message.content = first.startsWith('URL: ') ? `[earlier observation of ${first.slice(5)}]` : '[earlier observation omitted]';
    }
    observations.clear();
    const status = `Step ${steps}/${maxSteps}. Records saved so far: ${records.size}.${notes.length ? `\nYour notes:\n- ${notes.join('\n- ')}` : ''}${note}`;
    note = '';
    const text = `${renderObservation(observation)}\n\n${status}`;
    const observationMessage: ChatMessage = {
      role: 'user',
      content: observation.screenshot
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: observation.screenshot } }]
        : text,
    };
    observations.add(observationMessage);
    messages.push(observationMessage);
    trimTranscript(messages, config.agent.maxTranscriptTokens);

    let reply;
    try {
      reply = await celerisChat({
        model: 'celeris-1-magnus',
        messages,
        tools: TOOLS,
        requireTool: true,
        thinking: true,
        reasoningEffort: stuck ? 'xhigh' : 'low',
        meter: options.meter,
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) return result('budget', 'The research budget ran out mid-task.');
      return result('error', `Model call failed: ${(error as Error).message}`);
    }
    messages.push(reply.message);
    const plan = reply.toolCalls.slice(0, MAX_ACTIONS_PER_TURN);
    // Calls beyond the plan still need answers for the transcript to stay valid.
    const skipped = reply.toolCalls.slice(MAX_ACTIONS_PER_TURN);
    if (!plan.length) {
      messages.push({ role: 'user', content: 'Call a tool.' });
      stalls += 1;
      continue;
    }

    const signature = plan.map((call) => `${call.name}:${JSON.stringify(call.args)}`).join('|');
    repeats = signature === lastSignature ? repeats + 1 : 0;
    lastSignature = signature;
    if (repeats >= 3) return result('stuck', `Kept repeating ${plan[0].name} with no progress.`);

    let interrupted = false;
    for (const call of plan) {
      if (interrupted) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: an earlier action in this turn changed the page. Look again.' });
        continue;
      }
      if (call.name === 'done') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
        const summary = String(call.args.summary ?? '');
        log(`  agent done: ${summary}`);
        return result(call.args.success === false && records.size === 0 ? 'stuck' : 'done', summary);
      }
      const urlBefore = page.url();
      let outcome: string;
      try {
        outcome = await runTool(page, call, { options, records, notes, maxRecords });
      } catch (error) {
        if (error instanceof BlockedError) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: error.message });
          if (new URL(urlBefore).host === error.host) return result('blocked', error.message);
          outcome = '';
          interrupted = true;
          continue;
        }
        if (error instanceof BudgetExceededError) return result('budget', 'The research budget ran out mid-task.');
        outcome = `Failed: ${(error as Error).message.split('\n')[0].slice(0, 200)}`;
        interrupted = true;
      }
      log(`  agent ${call.name} ${JSON.stringify(call.args).slice(0, 100)} → ${outcome.slice(0, 100)}`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome });
      if (page.url() !== urlBefore) {
        visited.add(page.url());
        interrupted = true;
      }
      if (records.size >= maxRecords) return result('done', `Collected ${records.size} records.`);
    }
    for (const call of skipped) messages.push({ role: 'tool', tool_call_id: call.id, content: `Not run: at most ${MAX_ACTIONS_PER_TURN} actions per turn.` });
  }
  return result('max-steps', `Stopped after ${maxSteps} steps with ${records.size} records.`);
}

async function runTool(
  page: Page,
  call: ToolCall,
  state: { options: AgentOptions; records: Map<string, AgentRecord>; notes: string[]; maxRecords: number },
): Promise<string> {
  const args = call.args;
  if ('__parseError' in args) return 'Your arguments were not valid JSON. Try again.';
  switch (call.name) {
    case 'navigate': {
      const url = new URL(String(args.url), page.url()).toString();
      const allowed = state.options.allowedHosts ?? [];
      if (allowed.length && !allowed.some((host) => new URL(url).host.endsWith(host))) {
        return `Not allowed: stay on ${allowed.join(', ')}.`;
      }
      await visit(page, url);
      return `Opened ${page.url()}`;
    }
    case 'click': {
      const target = locateRef(page, Number(args.ref));
      if (!(await target.count())) return `No element [${args.ref}] on this page now; look again.`;
      // A link that opens a new tab is followed in this tab instead.
      const href = await target.evaluate((el) => (el instanceof HTMLAnchorElement && el.target === '_blank' ? el.href : '')).catch(() => '');
      if (href) {
        await visit(page, href);
        return `Opened ${page.url()}`;
      }
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: 8_000 });
      await settle(page, 4_000);
      return 'Clicked.';
    }
    case 'type': {
      const target = locateRef(page, Number(args.ref));
      if (!(await target.count())) return `No element [${args.ref}] on this page now; look again.`;
      await target.fill(String(args.text ?? ''), { timeout: 8_000 });
      if (args.submit) {
        await target.press('Enter');
        await settle(page, 5_000);
      }
      return args.submit ? 'Typed and submitted.' : 'Typed.';
    }
    case 'select': {
      const target = locateRef(page, Number(args.ref));
      await target.selectOption({ label: String(args.option) }, { timeout: 8_000 });
      await settle(page, 4_000);
      return 'Selected.';
    }
    case 'scroll': {
      const screens = Math.min(5, Math.max(1, Number(args.screens) || 1));
      const direction = args.direction === 'up' ? -1 : 1;
      for (let i = 0; i < screens; i++) {
        await page.mouse.wheel(0, direction * 850);
        await page.waitForTimeout(700);
      }
      await settle(page, 3_000);
      return `Scrolled ${args.direction ?? 'down'} ${screens} screen(s).`;
    }
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(page, 4_000);
      return `Back at ${page.url()}`;
    case 'note':
      state.notes.push(String(args.text ?? '').slice(0, 300));
      return 'Noted.';
    case 'extract': {
      const facts = await distill(page, 60_000);
      const found = await extractRecords<Record<string, unknown>>({
        content: facts.markdown,
        instruction: `${state.options.goal}\nOn this page: ${String(args.instruction ?? '')}`,
        itemProperties: state.options.recordProperties,
        key: state.options.recordKey,
        meter: state.options.meter,
        context: `Page: ${facts.title} — ${facts.url}`,
      });
      let added = 0;
      for (const record of found) {
        const key = state.options.recordKey(record);
        if (!key || state.records.has(key) || state.records.size >= state.maxRecords) continue;
        const quote = typeof record.text === 'string' ? record.text.trim() : '';
        state.records.set(key, { ...record, sourceUrl: page.url(), literalQuoteVerified: quote.length >= 20 && facts.markdown.includes(quote) });
        added += 1;
      }
      const sample = found.slice(0, 3).map((record) => JSON.stringify(record).slice(0, 160)).join('\n');
      return `Extracted ${found.length} records (${added} new, ${state.records.size} total).${sample ? `\nSample:\n${sample}` : ''}`;
    }
    default:
      return `Unknown tool ${call.name}.`;
  }
}

/** Drops the oldest turns (after the goal) when the transcript outgrows its budget, keeping tool-call pairs intact. */
function trimTranscript(messages: ChatMessage[], maxTokens: number): void {
  const size = () => messages.reduce((sum, m) => sum + approxTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')), 0);
  while (size() > maxTokens && messages.length > 6) {
    // Remove one user observation and everything up to the next observation.
    let end = 3;
    while (end < messages.length - 2 && messages[end].role !== 'user') end += 1;
    messages.splice(2, end - 2);
  }
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex');
