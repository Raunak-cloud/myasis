import type { Brief, Evidence, TaskResult } from './types.js';

export interface EvidenceReview {
  id: string;
  status: 'included' | 'excluded' | 'unverified';
  region: 'target' | 'unknown' | 'foreign';
  role: 'customer' | 'seller' | 'creator' | 'unknown';
  reason: string;
}
export interface QualitySummary {
  version: number;
  collected: number;
  included: number;
  excluded: number;
  unverified: number;
  regionUnknown: number;
  customerItems: number;
  reviews: EvidenceReview[];
}
const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const host = (s: string) => { try { return new URL(/^https?:/.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, ''); } catch { return ''; } };
const terms = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
export function sameWebsite(actual: string, requested: string): boolean {
  const a = host(actual), b = host(requested);
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)));
}
const COUNTRIES: Record<string, RegExp> = {
  AU: /\baustralia\b|\baustralian\b|\bsydney\b|\bmelbourne\b|\bbrisbane\b|\badelaide\b|\bperth\b|\bhobart\b|\bcanberra\b|\.com\.au\b/i,
  NZ: /\bnew zealand\b|\bauckland\b|\bwellington\b|\.co\.nz\b/i,
  US: /\bunited states\b|\busa\b|\bnew york\b|\blos angeles\b/i,
  GB: /\bunited kingdom\b|\blondon\b|\bbritain\b|\.co\.uk\b/i,
  CA: /\bcanada\b|\btoronto\b|\bvancouver\b|\bcanadian\b/i,
};

/** Keep raw evidence intact. Only reviewed items may feed planning and analysis. */
export function reviewEvidence(items: Evidence[], brief: Brief, now = Date.now()): { evidence: Evidence[]; quality: QualitySummary } {
  const domains = new Set(brief.websites.map(host).filter(Boolean));
  const brands = [brief.brand, ...brief.competitors].map(normal).filter((s) => s.length >= 4);
  const category = [...new Set(terms(`${brief.niche} ${brief.product}`))].filter((s) => !/^(australia|australian|traditional|evaluate|compare|online|delivery|website|business|brand|market|nepalese|nepali|nepal|sold|with|from|wear|clothing)$/.test(s));
  const apparel = /clothing|fashion|outfit|garment|dress|saree|sari|kurta|kurti|kurtha|topi|daura|suruwal|activewear/i.test(`${brief.product} ${brief.niche}`);
  const linkedAccounts = new Set(items.filter((i) => i.source === 'website').flatMap((i) => Array.isArray(i.attributes.socialLinks) ? i.attributes.socialLinks : []).map((u) => u.replace(/\/$/, '').toLowerCase()));
  const reviews = items.map((item): EvidenceReview => {
    const text = `${item.title} ${item.text}`;
    const identity = brands.some((b) => normal(item.author).includes(b)) || domains.has(host(String(item.attributes.landingUrl ?? item.attributes.domain ?? ''))) || (item.source === 'website' && domains.has(host(item.url)));
    const location = `${text} ${item.url} ${item.attributes.landingUrl ?? ''}`;
    const region = item.attributes.region === brief.country || COUNTRIES[brief.country]?.test(location) ? 'target' : 'unknown';
    let role: EvidenceReview['role'] = item.kind === 'ad' || item.source === 'website' || identity ? 'seller' : item.kind === 'video' || item.kind === 'profile' ? 'creator' : 'unknown';
    if (item.kind === 'comment' || (item.source === 'reddit' && item.kind === 'post') || item.attributes.customerReview === 'verified') role = identity ? 'seller' : 'customer';
    const base = { id: item.id, region, role } as const;
    try {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid source URL');
    } catch { return { ...base, status: 'unverified', reason: 'Source has no valid HTTP(S) citation.' }; }
    const collected = Date.parse(item.collectedAt);
    if (!Number.isFinite(collected) || collected > now + 300_000) return { ...base, status: 'unverified', reason: 'Collection date is missing, invalid or in the future.' };
    if (item.publishedAt && (!Number.isFinite(Date.parse(item.publishedAt)) || Date.parse(item.publishedAt) > now + 300_000)) return { ...base, status: 'unverified', reason: 'Published date is invalid or in the future; verify the source.' };
    if (Object.entries(item.metrics).some(([key, value]) => !Number.isFinite(value) || (/^(views|likes|comments|shares|saves|followers|rank|daysRunning|variants|wordCount|titleLength|metaDescriptionLength|h1Count|imagesWithoutAlt)$/.test(key) && value < 0))) return { ...base, status: 'unverified', reason: 'Source contains an invalid measurement; excluded from findings and scores.' };
    if (item.source === 'website' && /^https?:\/\//.test(item.query) && !sameWebsite(item.url, item.query)) return { ...base, status: 'excluded', reason: 'Page belongs to another website than the requested audit.' };
    if (item.attributes.discoveryStatus === 'rejected') return { ...base, status: 'excluded', reason: 'Automatic setup could not verify this site as a relevant competitor.' };
    if (apparel && item.source === 'autocomplete' && /\b(?:mailo|song|lyrics|chords|mp3|geet)\b/i.test(text)) return { ...base, status: 'excluded', reason: 'Search targets music rather than a clothing purchase or styling question.' };
    if (apparel && item.source === 'autocomplete' && /\bdraw\b|\bpaper\b|\bwedding card\b|\bbrand name ideas\b|\bforeigners.*married\b|\bindian marry\b/i.test(text)) return { ...base, status: 'excluded', reason: 'Search is about craft, naming or unrelated services rather than buying clothing.' };
    if (item.source === 'autocomplete' && region !== 'target' && /\b(?:in|from|near|shop|price in)\s+(?:nepal|india|kathmandu|delhi|siliguri|london|usa|canada|bangladesh)\b/i.test(text) && !COUNTRIES[brief.country]?.test(text)) return { ...base, status: 'excluded', region: 'foreign', reason: 'Search explicitly targets another market.' };
    if (apparel && item.kind === 'ad' && /parkinson|shilajit|supplement|donate|fundrais|trekk?ing|momo|restaurant|travel.*tour|rock band/i.test(text) && !identity) return { ...base, status: 'excluded', reason: 'Advertiser promotes another product category.' };
    if (apparel && item.kind === 'ad' && !identity && !/clothing|fashion|outfit|garment|dress|saree|sari|kurta|kurti|kurtha|topi|daura|suruwal|activewear|lehenga/i.test(text)) return { ...base, status: 'unverified', reason: 'No clothing product or verified retailer match.' };
    if (item.kind === 'ad' && !identity && !(category.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(text)))) return { ...base, status: 'unverified', reason: 'Advertiser has no verified brand, domain or product match.' };
    if (item.kind === 'profile' && !linkedAccounts.has(item.url.replace(/\/$/, '').toLowerCase())) return { ...base, status: 'unverified', reason: 'Account is not linked from an audited business website.' };
    if (item.source === 'website' && item.attributes.pageType !== 'sitemap' && !item.text.trim()) return { ...base, status: 'excluded', reason: 'Page contained no readable evidence.' };
    return { ...base, status: 'included', reason: identity ? 'Matched a supplied business or website.' : 'Relevant public evidence; location may be unconfirmed.' };
  });
  const included = new Set(reviews.filter((r) => r.status === 'included').map((r) => r.id));
  return {
    evidence: items.filter((i) => included.has(i.id)).map((i) => {
      const r = reviews.find((r) => r.id === i.id)!;
      const metrics = { ...i.metrics };
      // Older runs inferred activity from the last observation date. Google's
      // transparency date span does not establish whether a creative is active.
      if (i.source === 'google-ads') delete metrics.active;
      return { ...i, metrics, attributes: { ...i.attributes, reviewRegion: r.region, reviewRole: r.role } };
    }),
    quality: { version: 3, collected: items.length, included: included.size, excluded: reviews.filter((r) => r.status === 'excluded').length, unverified: reviews.filter((r) => r.status === 'unverified').length, regionUnknown: reviews.filter((r) => r.status === 'included' && r.region === 'unknown').length, customerItems: reviews.filter((r) => r.status === 'included' && r.role === 'customer').length, reviews },
  };
}

export function coverageState(result: TaskResult): string {
  if (!result.ok) return /blocked|refus|wall|challenge|captcha/i.test(result.note) ? 'Access unavailable' : 'Could not collect';
  return result.count > 0 ? 'Collected' : 'No results';
}

/** Absence and performance claims require data this collector does not possess. */
export function unsupportedClaim(text: string): boolean {
  return /high[- ]volume|monthly searches|likely profitable|proven winners?|dominat(?:e|es|ing).*market|no competitor|competitors? (?:lack|do not|don.t)|unmet demand|most searched|will (?:capture|convert|outperform)|prove(?:s)? that|willingness.*pay|pixels.*(?:buy|spend|run ads)/i.test(text);
}
