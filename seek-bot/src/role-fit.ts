/** Agent-authored matching evidence, retained for audit and application context. */
export interface RoleFitCheck {
  alignment: 'aligned' | 'mismatch' | 'uncertain';
  employerEvidence: string;
  candidateEvidence: string;
  explanation: string;
}
