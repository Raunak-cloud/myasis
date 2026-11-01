/** A tested repair never authorizes a new application by itself. This gate is
 * intentionally independent of model output and fails closed on missing facts. */
export interface RepairRetryEvidence {
  ownerId: string;
  ownerEmail: string;
  activeAdmin: boolean;
  originalRunFinished: boolean;
  currentRunActive: boolean;
  schedulePaused: boolean;
  repairValidated: boolean;
  outcome: 'failed' | 'prepared' | 'submitted' | 'needs-attention' | 'unknown';
  sendState: 'proven-not-attempted' | 'confirmed' | 'uncertain' | 'unknown';
  mode: 'auto' | 'semi-auto' | 'prepare';
  candidateApprovedRevision: boolean;
  sameJobAndRevision: boolean;
}

export function repairRetryAllowed(e: RepairRetryEvidence): boolean {
  return e.ownerId === '1' && typeof e.ownerEmail === 'string' && e.ownerEmail.toLowerCase() === 'raunak.vision@gmail.com' && e.activeAdmin === true
    && e.originalRunFinished === true && e.currentRunActive === false && e.schedulePaused === false && e.repairValidated === true
    && e.outcome === 'failed' && e.sendState === 'proven-not-attempted' && e.sameJobAndRevision === true
    && (e.mode === 'auto' || e.mode === 'prepare' || e.mode === 'semi-auto' && e.candidateApprovedRevision === true);
}
