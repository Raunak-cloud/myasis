export interface RunIssue {
  id: string; at: string; severity: string; category: string; stage: string; message: string;
  attemptId?: string; jobId?: string; title?: string; tool?: string; step?: number;
  batchIndex?: number; disposition?: string; stack?: string[];
}
export interface RunAttempt {
  attemptId: string; jobId: string; title: string; company: string; startedAt: string;
  mode: string; outcome?: string;
}
export interface RunDiagnostics {
  runId: string; issues: RunIssue[]; attempts: RunAttempt[]; structured: boolean;
  note: string; retentionDays: number;
}
