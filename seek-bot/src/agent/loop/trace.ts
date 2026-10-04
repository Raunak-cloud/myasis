import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'patchright';
import { config } from '../../config.js';
import type { JobListing } from '../../types.js';
import { isExternal } from '../guards.js';
import type { AgentTermination, ToolContext } from '../tools.js';

// Part of the agent loop, split from loop.ts by concern; loop.ts re-exports it.

export interface TraceStep {
  step: number;
  url: string;
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable version of the call, e.g. `click "Apply without an account"`. */
  label: string;
  result?: string;
  screenshot?: string;
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function describeCall(ctx: ToolContext, tool: string, args: Record<string, unknown>): string {
  if (tool === 'click') {
    const action = ctx.observation.actions.find((candidate) => candidate.ref === String(args.ref));
    return `click "${action?.text ?? String(args.ref)}"`;
  }
  if (tool === 'answer_questions') {
    const refs = Array.isArray(args.refs) ? args.refs.map(String) : [];
    const labels = ctx.observation.fields.filter((field) => refs.includes(field.ref)).map((field) => field.label);
    return `answer ${labels.length} question(s): ${labels.slice(0, 6).join('; ')}${labels.length > 6 ? '…' : ''}`;
  }
  if (tool === 'click_point') return `click at (${args.x},${args.y}): ${String(args.reason ?? '')}`;
  if (tool === 'evaluate_script') return `script: ${String(args.function ?? '').replace(/s+/g, ' ').slice(0, 200)}`;
  if (tool === 'navigate_page') return `navigate ${String(args.type)}${args.url ? ` ${String(args.url)}` : ''}`;
  if (['click_element', 'fill_element', 'hover', 'upload_file'].includes(tool)) return `${tool.replace(/_/g, ' ')} ${String(args.ref ?? '')}`;
  if (tool === 'finish') return `finish ${String(args.status)}: ${String(args.reason ?? '')}`;
  return tool.replace(/_/g, ' ');
}

export const SITE_HINTS = () => resolve(config.dataDir, 'site-hints.json');
export const TRACE_DIR = () => resolve(config.dataDir, 'traces');

export interface SiteHint {
  steps: string[];
  updatedAt: string;
}

export function loadSiteHints(): Record<string, SiteHint> {
  try {
    return existsSync(SITE_HINTS()) ? (JSON.parse(readFileSync(SITE_HINTS(), 'utf8')) as Record<string, SiteHint>) : {};
  } catch {
    return {};
  }
}

/**
 * Keeps the record a person would want: the full step-by-step trace, with
 * screenshots, for anything that needs them; and for an employer site that
 * was completed, the step outline as a hint for the next application there.
 */
export function persistTrace(job: JobListing, outcome: AgentTermination, trace: TraceStep[], finalUrl: string): void {
  try {
    // Successful applications need the same audit trail: recovery mistakes
    // can happen before confirmation too. Existing trace retention applies.
    if (outcome.status === 'needs-human' || outcome.status === 'skipped' || outcome.status === 'applied' || outcome.status === 'rehearsed') {
      mkdirSync(TRACE_DIR(), { recursive: true });
      writeFileSync(
        resolve(TRACE_DIR(), `${job.id}.json`),
        JSON.stringify({ jobId: job.id, title: job.title, company: job.company, outcome, finalUrl, savedAt: new Date().toISOString(), steps: trace }),
      );
    }
    const host = hostOf(finalUrl);
    if ((outcome.status === 'applied' || outcome.status === 'rehearsed') && host && isExternal(finalUrl) && trace.length) {
      const hints = loadSiteHints();
      hints[host] = { steps: trace.map((step) => step.label).slice(0, 40), updatedAt: new Date().toISOString() };
      writeFileSync(SITE_HINTS(), JSON.stringify(hints, null, 2));
    }
  } catch {
    /* a missing trace must never fail an application */
  }
}

/**
 * Centre the unanswered field before taking the handoff screenshot.
 *
 * Found by its ref when extraction saw it, otherwise by its label text (a
 * field only the accessibility snapshot showed). When neither finds it, the
 * page as it stands is still captured: the candidate is better served by the
 * page the run stopped on than by "no capture".
 */
export async function captureBlockedField(page: Page, ref: string | undefined, label: string): Promise<string | undefined> {
  let field: ReturnType<Page['locator']> | undefined;
  let priorOutline: { outline: string; outlineOffset: string } | undefined;
  const plain = async () => page.screenshot({ type: 'jpeg', quality: 65 })
    .then((shot) => `data:image/jpeg;base64,${shot.toString('base64')}`)
    .catch(() => undefined);
  try {
    const byRef = ref ? page.locator(`[data-field-id="${ref}"], [data-field-id^="${ref}:"]`).first() : undefined;
    const text = label.replace(/[\s*:]+$/, '').trim();
    const byLabel = text ? page.getByLabel(text, { exact: false }).first() : undefined;
    const byText = text ? page.getByText(text, { exact: false }).first() : undefined;
    for (const candidate of [byRef, byLabel, byText]) {
      if (candidate && await candidate.isVisible().catch(() => false)) { field = candidate; break; }
    }
    if (!field) return await plain();
    priorOutline = await field.evaluate((element) => {
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      const html = element as HTMLElement;
      const prior = { outline: html.style.outline, outlineOffset: html.style.outlineOffset };
      html.style.outline = '3px solid #2563a6';
      html.style.outlineOffset = '3px';
      return prior;
    });
    const shot = await page.screenshot({ type: 'jpeg', quality: 65 });
    return `data:image/jpeg;base64,${shot.toString('base64')}`;
  } catch {
    return await plain();
  } finally {
    if (field && priorOutline) {
      await field.evaluate((element, prior) => {
        const html = element as HTMLElement;
        html.style.outline = prior.outline;
        html.style.outlineOffset = prior.outlineOffset;
      }, priorOutline).catch(() => {});
    }
  }
}
