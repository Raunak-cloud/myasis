import type { RoleFitCheck } from './role-fit.js';

export interface FitInstructionCheck {
  violated: boolean;
  ruleQuote: string;
  explanation: string;
}

/** The completed decision transport, shared with the account's durable history. */
export interface SavedFitAssessment {
  reviewReused?: boolean;
  roleFitCheck?: RoleFitCheck;
  workArrangementCheck?: { offered: Array<'onsite' | 'hybrid' | 'remote'>; evidence: string };
  instructionConflict?: string;
  instructionCheck?: FitInstructionCheck;
  shouldApply: boolean;
  decision: 'apply' | 'skip' | 'uncertain';
  matchScore: number;
  reason: string;
  evidence: string[];
  injectionSuspected: boolean;
}
