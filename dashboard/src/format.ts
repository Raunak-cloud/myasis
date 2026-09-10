export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Just the clock time, e.g. "3:42 pm" — the date is shown alongside it. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function relative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function scoreClass(score: number): string {
  if (score >= 85) return 'hi';
  if (score >= 70) return 'mid';
  return 'lo';
}

export function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/** Groups skip reasons into readable buckets for the breakdown panel. */
export function bucketReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('already applied')) return 'Already applied';
  // 'gemini:' is the legacy prefix — kept so older log entries still bucket.
  if (r.includes('ai fit check') || r.includes('gemini') || r.includes('stack mismatch'))
    return 'Stack mismatch';
  if (r.includes('on-site role outside')) return 'Wrong location';
  if (r.includes('salary')) return 'Below salary floor';
  if (r.includes('excluded domain')) return 'Excluded domain';
  if (r.includes('score')) return 'Score too low';
  if (r.includes('templated')) return 'Templated / spam';
  if (r.includes('injection')) return 'Prompt injection';
  if (r.includes('no apply control')) return 'No apply control';
  if (r.includes('dry_run')) return 'Dry run';
  return 'Other';
}

/** Whole days since an ISO timestamp. */
export function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
