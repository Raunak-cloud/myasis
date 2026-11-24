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

const applicationTimeZone = 'Australia/Sydney';
const applicationDate = new Intl.DateTimeFormat('en-AU', {
  timeZone: applicationTimeZone, day: 'numeric', month: 'short', year: 'numeric',
});
const applicationTime = new Intl.DateTimeFormat('en-AU', {
  timeZone: applicationTimeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const applicationCalendar = new Intl.DateTimeFormat('en-AU', {
  timeZone: applicationTimeZone, day: 'numeric', month: 'numeric', year: 'numeric',
});

function sydneyCalendarDay(timestamp: number): number {
  const parts = applicationCalendar.formatToParts(timestamp);
  const year = Number(parts.find(part => part.type === 'year')?.value);
  const month = Number(parts.find(part => part.type === 'month')?.value);
  const day = Number(parts.find(part => part.type === 'day')?.value);
  // Encode the local calendar date as a day number, independent of the day's elapsed hours.
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function formatApplicationWhen(iso: string, now: number): { date: string; time: string; dayLabel: string } {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return { date: iso, time: '', dayLabel: '' };
  const days = Math.max(0, sydneyCalendarDay(now) - sydneyCalendarDay(timestamp));
  const dayLabel = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
  return { date: applicationDate.format(timestamp), time: applicationTime.format(timestamp), dayLabel };
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

/** Whole days since an ISO timestamp. */
export function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
