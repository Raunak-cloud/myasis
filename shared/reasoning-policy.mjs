/** Provider vocabularies differ. Callers request high only for targeted
 * escalation; Magnus names that level xhigh. Unknown values never escalate. */
export function celerisReasoningEffort(requested) {
  if (requested === 'high' || requested === 'xhigh') return 'xhigh';
  return requested === undefined || requested === 'low' ? 'low' : 'medium';
}
