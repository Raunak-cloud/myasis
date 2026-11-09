/** Campaign values are labels, never a reason to retain click IDs or URL secrets. */
export interface VisitSource { source: string; medium: string; campaign: string; referrer: string }
export const UNKNOWN_SOURCE = 'Direct / unavailable';
const TRANSIT_HOSTS = new Set(['accounts.google.com', 'checkout.stripe.com', 'billing.stripe.com']);
export const isTransitHost = (host:string) => TRANSIT_HOSTS.has(host) || /^accounts\.google\.(?:com|(?:co|com)\.[a-z]{2}|[a-z]{2,3})$/.test(host);

export function entryReferrer(raw: string, ownHost: string): string {
  try {
    const url = new URL(raw), host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || host === ownHost.replace(/^www\./, '').toLowerCase() || isTransitHost(host)) return '';
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch { return ''; }
}

export function sourceLabel(source: string | null | undefined, referrer?: string | null): string {
  let label = source?.trim().toLowerCase();
  if (!label && referrer) {
    try { label = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* unavailable */ }
  }
  if (!label || label === UNKNOWN_SOURCE.toLowerCase() || isTransitHost(label)) return UNKNOWN_SOURCE;
  if (/^(?:www\.)?google\.[a-z.]+$/.test(label)) return 'google';
  const aliases: Record<string,string> = { 'bing.com':'bing', 'facebook.com':'facebook', 'm.facebook.com':'facebook', 'l.facebook.com':'facebook', 'instagram.com':'instagram','l.instagram.com':'instagram',
    'linkedin.com':'linkedin', 'lnkd.in':'linkedin', 'reddit.com':'reddit', 'old.reddit.com':'reddit', 'duckduckgo.com':'duckduckgo', 't.co':'x', 'twitter.com':'x', 'x.com':'x' };
  return aliases[label] ?? label;
}

export function captureVisitSource(search: string, referrer: string, ownHost: string): VisitSource {
  const clean = (value: string | null, max: number) => [...(value ?? '').trim()].filter(c=>c.charCodeAt(0)>=32 && c.charCodeAt(0)!==127).join('').slice(0,max);
  const params = new URLSearchParams(search);
  const explicit = clean(params.get('utm_source'),80) || (params.has('rdt_cid')?'reddit':params.has('gclid')||params.has('gbraid')||params.has('wbraid')?'google':params.has('msclkid')?'bing':params.has('fbclid')?'meta':'');
  const source=explicit?sourceLabel(explicit):'';
  return {source:source===UNKNOWN_SOURCE?'':source,medium:clean(params.get('utm_medium'),80),campaign:clean(params.get('utm_campaign'),160),referrer:entryReferrer(referrer,ownHost)};
}
