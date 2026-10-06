import { createHash } from 'node:crypto';
import type { MarketingArticle, MarketingSite } from '../../src/marketingTypes.js';

export const COUNTRIES = ['AU', 'US', 'GB', 'CA', 'NZ', 'IN', 'SG', 'DE', 'FR'];
export const isId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const topicKey = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const articleHash = (article: MarketingArticle) => createHash('sha256').update(JSON.stringify(article)).digest('hex');

export function sameTopic(a: string, b: string): boolean {
  const left = new Set(topicKey(a).split(' ').filter((w) => w.length > 2 && !/^(the|and|for|how|your|with|guide)$/.test(w)));
  const right = new Set(topicKey(b).split(' ').filter((w) => w.length > 2 && !/^(the|and|for|how|your|with|guide)$/.test(w)));
  const shared = [...left].filter((w) => right.has(w)).length;
  return topicKey(a) === topicKey(b) || (Math.min(left.size, right.size) >= 3 && shared / Math.max(left.size, right.size) >= 0.8);
}

export function ownedLink(raw: string, website: string): string {
  const url = new URL(raw, website);
  if (url.protocol !== 'https:' || url.origin !== new URL(website).origin || url.username || url.password || /logout|delete|checkout/i.test(url.pathname)) throw new Error('Choose a public product or landing-page link on your website.');
  url.hash = ''; return url.href;
}

export function validateArticle(value: unknown, allowedRefs: string[]): MarketingArticle {
  const item = value as MarketingArticle;
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('The draft must be an article.');
  for (const key of ['title', 'slug', 'metaDescription', 'focusKeyword', 'lead'] as const) if (typeof item[key] !== 'string' || !item[key].trim() || item[key].length > (key === 'lead' ? 4000 : 500)) throw new Error(`The draft has invalid ${key}.`);
  const list = (v: unknown, cap: number): v is string[] => Array.isArray(v) && v.length <= cap && v.every((s) => typeof s === 'string' && s.length <= 8000);
  if (!list(item.targetSearches, 10) || !list(item.takeaways, 10) || !Array.isArray(item.sections) || item.sections.length < 2 || item.sections.length > 12) throw new Error('The draft is incomplete.');
  for (const s of item.sections) if (!s || typeof s.heading !== 'string' || !s.heading.trim() || s.heading.length > 300 || !list(s.paragraphs, 12) || !s.paragraphs.length || !list(s.bullets, 15)) throw new Error('A draft section is incomplete.');
  const strings = [item.lead, ...item.sections.flatMap((s) => [...s.paragraphs, ...s.bullets]), ...item.takeaways];
  const text = strings.join(' ');
  if (text.split(/\s+/).length < 140 || text.length > 35_000) throw new Error('The draft is truncated or too large to review.');
  const refs = [...text.matchAll(/\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/g)].flatMap((m) => m[1].split(/\s*[,;]\s*/));
  if (!refs.length || refs.some((r) => !allowedRefs.includes(r))) throw new Error('The draft needs valid source citations.');
  if (/\b(guaranteed (?:sales|conversions|rankings)|guarantee.*(?:rank.*first|page one)|proven high.converting)\b/i.test(text)) throw new Error('The draft makes an unsupported performance guarantee.');
  const slug = item.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
  if (!slug) throw new Error('The draft needs a usable URL slug.');
  return { title: item.title.trim(), slug, metaDescription: item.metaDescription.trim(), focusKeyword: item.focusKeyword.trim(), targetSearches: item.targetSearches, lead: item.lead.trim(), sections: item.sections.map((s) => ({ heading: s.heading, paragraphs: s.paragraphs, bullets: s.bullets })), takeaways: item.takeaways };
}

export function validateTimezone(value: string): string {
  if (!value || value.length > 70) throw new Error('Choose a valid timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); } catch { throw new Error('Choose a valid timezone.'); }
  return value;
}

function local(at: Date, formatter: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(formatter.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** One weekly slot in the site's timezone. A DST gap uses the next valid local minute. */
export function nextWeeklyRun(now: Date, day: number, time: string, timezone: string): Date {
  if (!Number.isInteger(day) || day < 0 || day > 6 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a weekday and a valid time.');
  validateTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const current = local(now, formatter);
  const [hour, minute] = time.split(':').map(Number); const targetMinute = hour * 60 + minute;
  let days = (day - current.day + 7) % 7;
  if (!days && current.minute >= targetMinute) days = 7;
  const target = new Date(`${current.date}T00:00:00Z`); target.setUTCDate(target.getUTCDate() + days);
  const targetDate = target.toISOString().slice(0, 10);
  for (let t = target.getTime() - 16 * 3600_000; t <= target.getTime() + 40 * 3600_000; t += 60_000) {
    if (t <= now.getTime()) continue;
    const candidate = local(new Date(t), formatter);
    if (candidate.date === targetDate && candidate.minute >= targetMinute) return new Date(t);
  }
  throw new Error('The schedule could not be calculated.');
}

export function publicationProblem(site: MarketingSite, admin: boolean, origin: string): string | null {
  if (!admin || site.publisher !== 'owtomate' || new URL(site.url).origin !== origin) return 'This website needs a CMS connection. Export the draft; built-in publishing is available to Owtomate admins for Owtomate.';
  if (!site.profileConfirmed) return 'Review and confirm the website profile before publishing.';
  const checked=Date.parse(site.research?.researchedAt || '');
  if (!Number.isFinite(checked) || checked>Date.now()+60_000 || Date.now() - checked > 7 * 86400_000) return 'Refresh the website research before publishing.';
  return null;
}
