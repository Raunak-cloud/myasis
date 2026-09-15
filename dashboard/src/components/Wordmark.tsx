/**
 * The brand name as it is drawn: lowercase "owtomate" in a friendly script,
 * with "ow" in the accent colour — the owl hiding in "automate".
 *
 * Size comes from wherever it is placed; only the typeface and the two
 * colours belong to the mark.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`}>
      <span className="wordmark-ow">ow</span>tomate
    </span>
  );
}
