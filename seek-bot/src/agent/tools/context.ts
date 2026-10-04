import { AsyncLocalStorage } from 'node:async_hooks';
import type { Page } from 'patchright';
import type { ApplicationAction, BlockedQuestion, CandidateProfile, JobListing } from '../../types.js';
import type { Observation } from '../observe.js';
import { RunGuards } from '../guards.js';
import type { SiteCredential } from '../../site-auth.js';

// Part of the agent's tools, split from tools.ts by concern; tools.ts re-exports it.

/**
 * How many fields one answer_questions call may take.
 *
 * It was one per turn, so a page of six employer questions cost six agent
 * turns and six answer calls: about a third of an application's time, spent
 * on round trips rather than on the form. Fields are now answered together
 * and filled in order, and the batch stops as soon as a fill changes the
 * form's shape, which is what one-per-turn was protecting against: a checkbox
 * that reveals dates, a selection that rebuilds the questions after it.
 */
export const ANSWER_BATCH = 6;

/**
 * The agent's entire action surface.
 *
 * Two rules shape every tool here:
 *
 * 1. Actions are addressed by `ref` — a token this run stamped onto a real,
 *    visible element during the last observation, or one from an
 *    accessibility snapshot. The general browser tools in raw-tools.ts (a
 *    snapshot across iframes, scripts, navigation, tabs) cover whatever the
 *    purpose-built ones cannot reach, and pass the same gates.
 * 2. The model chooses *which* control to act on. It does not author the
 *    candidate's answers: they come from the grounded answer path, which
 *    refuses to invent facts, and a form touched by the general tools is
 *    audited against the candidate's record before it is sent.
 */

export type AgentTermination =
  | { status: 'applied' }
  | { status: 'rehearsed'; stoppedAt: string }
  | {
      status: 'needs-human';
      /** Plain language, shown to the candidate. */
      reason: string;
      /** The technical version, for the log and the trace only. */
      detail?: string;
      questions?: BlockedQuestion[];
    }
  | { status: 'off-platform'; redirectedTo: string }
  | { status: 'already-applied'; reason: string }
  | { status: 'skipped'; reason: string };

export type ToolResult = { kind: 'ok'; message: string } | { kind: 'terminal'; outcome: AgentTermination };

export interface ToolContext {
  /** Counts tool calls; a call past its time limit is retired and can no longer press anything. */
  toolGeneration?: number;
  retiredGenerations?: number[];
  page: Page;
  job: JobListing;
  profile: CandidateProfile;
  guards: RunGuards;
  /** Replaced after every action; refs are only valid against this. */
  observation: Observation;
  /** Everything this run would transmit, so a dry run can show it. */
  captured: Array<{ question: string; answer: string }>;
  coverLetter?: string;
  /** Set only after a real cover-letter input or reveal control was observed. */
  /** The agent's own judgement on the current press: does it send the application? */
  declaredSubmit?: boolean;
  /** The agent's own statement, on the current press, of why the form has no place for a cover letter. */
  declaredNoLetter?: string;
  /** Moving on without a letter has been settled for this application (the agent's statement accepted). */
  letterResolved?: boolean;
  /** The agent's statement was questioned once against what the page shows. */
  letterChallenged?: boolean;
  /** Passwords set on a site in this attempt and not yet accepted by it, by host. */
  pendingCredentials?: Map<string, SiteCredential>;
  resumeUsed?: string;
  /** The board file name the resume went out as, once the documents step was settled. */
  resumeName?: string;
  /** The board's resume choice has been made Owtomate's for this application. */
  resumeSettled?: boolean;
  log: (line: string) => void;
  /** Side effects the candidate must be told about — see `ApplicationAction`. */
  actions: ApplicationAction[];
  submissionAttempted?: boolean;
  reloads?: number;
  /** Caption of the list-opening control clicked last, for options that do not name their question. */
  lastListQuestion?: string;
  /** The browser tools changed the form outside the grounded answer tools, so it is audited before sending. */
  rawUsed?: boolean;
  /** This tool call already passed the submit gate; the network backstop lets its form post through. */
  submitCleared?: boolean;
  /** This tool call's press was judged by the gate (submit or not), so its form post needs no second judgment. */
  pressJudged?: boolean;
  auditFailures?: number;
  /** Times the pre-submit audit flagged each field. */
  auditStrikes?: Map<string, number>;
  /** Sets of values the page already held that were checked and found to be the candidate's. */
  prefilledAudited?: Set<string>;
  /** What the last tool call did, for judging a dialog it raised. */
  lastActionLabel?: string;
  /** Browser dialogs answered since the last turn, reported to the agent. */
  dialogs?: string[];
  /** The agent asked to see the page; the next observation carries a screenshot. */
  wantScreenshot?: boolean;
  /** Recent failed requests and console errors, per tab, for get_diagnostics. */
  diagnostics?: WeakMap<Page, string[]>;
}

/** Which tool call the current code runs for, so an abandoned one can be told apart from the live one. */
export const toolRun = new AsyncLocalStorage<{ generation: number }>();

export const ok = (message: string): ToolResult => ({ kind: 'ok', message });

/** Records a side effect once per kind and site, and says so in the run log. */
export function noteAction(ctx: ToolContext, action: Omit<ApplicationAction, 'at'>): void {
  if (ctx.actions.some((known) => known.kind === action.kind && known.site === action.site && known.purpose === action.purpose)) return;
  ctx.actions.push({ ...action, at: new Date().toISOString() });
}

/** A site named the way the candidate knows it. */
export function siteName(host: string): string {
  if (/(^|\.)seek\.com(\.au)?$/.test(host)) return 'SEEK';
  if (/(^|\.)indeed\.com$/.test(host)) return 'Indeed';
  return host;
}
