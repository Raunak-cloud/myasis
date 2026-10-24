/** Evidence returned only after source checks and a separate suitability review. */
export interface ResumeSearchSuggestion {
  query: string;
  matchType: 'direct' | 'transferable';
  reason: string;
  evidence: Array<{ resumeId: string; resumeLabel: string; quote: string }>;
}
