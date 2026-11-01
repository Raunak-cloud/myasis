/** Provider vocabularies differ. Never send an unsupported effort or exceed
 * the operator's high ceiling. Celeris's next level above medium is forbidden. */
export function celerisReasoningEffort(requested) {
  return requested === undefined || requested === 'low' ? 'low' : 'medium';
}
