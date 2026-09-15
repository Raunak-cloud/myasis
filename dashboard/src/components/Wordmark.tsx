/**
 * The brand name as it is drawn: lowercase, rounded, "my" in the accent colour.
 *
 * my + asis, read as "my oasis" — the relaxed side of letting Myasis apply for
 * you. Size and weight come from wherever it is placed; only the typeface and
 * the two colours belong to the mark.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`}>
      <span className="wordmark-my">my</span>asis
    </span>
  );
}
