import type { Brief, Evidence, MarketDiscovery } from './types.js';
import type { EvidenceStore } from './store.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit, UNTRUSTED } from '../llm/extract.js';
import { previewWebsite } from '../sources/website.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { searchCompetitors } from './search-discovery.js';

type Proposal = { niche: string; audience: string; candidates: Array<{ name: string; website: string }> };
export type CandidateCheck = { relevant: boolean; name: string; productQuote: string; marketQuote: string };

/** Reuse public sites from related research as leads, then verify them again. */
export function relatedWebsites(brief: Brief, runsDir: string): string[] {
  const words = (s: string) => new Set(s.toLowerCase().replace(/nepalese/g, 'nepali').match(/[a-z]{4,}/g)?.filter((w) => !/^(australia|australian|online|business|brand|market|sell|selling|with|from)$/.test(w)) ?? []);
  const target = words(`${brief.product} ${brief.niche}`);
  const found: string[] = [];
  try {
    for (const id of readdirSync(runsDir)) {
      try {
        const previous = JSON.parse(readFileSync(join(runsDir, id, 'brief.json'), 'utf8')) as Brief;
        if (previous.country !== brief.country) continue;
        const shared = [...words(`${previous.product} ${previous.niche}`)].filter((w) => target.has(w));
        if (shared.length < Math.min(2, target.size) || !target.size) continue;
        found.push(...(previous.websites ?? []).map(candidateUrl).filter((u): u is string => Boolean(u)));
      } catch { /* unrelated or unfinished run */ }
    }
  } catch { /* first run has no related public-source history */ }
  return [...new Set(found)].slice(0, 8);
}

export function candidateUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /^(localhost|[\d.]+)$|:|\.(local|internal|test)$/i.test(url.hostname)) return;
    return url.origin + '/';
  } catch { return; }
}

/** A model's name/URL suggestion is not a competitor until a page supports it. */
export function verifiedCandidate(item: Evidence, check: CandidateCheck, country: string): MarketDiscovery['competitors'][number] | undefined {
  if (!check.relevant || !check.name.trim() || check.productQuote.trim().length < 12 || !item.text.includes(check.productQuote)) return;
  const nameWords = check.name.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!nameWords.length || !nameWords.every((w) => `${item.title} ${item.text}`.toLowerCase().includes(w))) return;
  let quote = check.marketQuote && item.text.includes(check.marketQuote) ? check.marketQuote : '';
  const regionWords: Record<string, RegExp> = { AU: /australia|australian|sydney|melbourne|brisbane/i, US: /united states|\busa\b|\bus shipping\b/i, GB: /united kingdom|\buk\b|london/i, NZ: /new zealand|auckland/i, CA: /canada|canadian|toronto/i };
  if (!check.marketQuote) quote = regionWords[country]?.test(check.productQuote) ? check.productQuote : item.text.split(/(?<=[.!?])\s+/).find((line) => regionWords[country]?.test(line) && line.length < 500) || '';
  return { name: check.name.trim(), website: new URL(item.url).origin + '/', evidenceId: item.id, productQuote: check.productQuote, marketQuote: quote, region: regionWords[country]?.test(quote) ? 'target' : 'unknown' };
}

export async function discoverMarket(brief: Brief, store: EvidenceStore, meter: CostMeter, log: (line: string) => void): Promise<Brief> {
  const discovery: MarketDiscovery = { audienceBasis: brief.audience ? 'provided' : 'suggested', categoryBasis: brief.niche ? 'provided' : 'suggested', competitors: [], notes: [] };
  log('Discovering your market: category, likely audience and competitor websites...');
  const history = relatedWebsites(brief, dirname(store.dir));
  let searched: string[] = [];
  try {
    log('Searching for cited competitor websites...');
    const live = await searchCompetitors(brief, meter);
    if (live) {
      searched = live.websites.map(candidateUrl).filter((u): u is string => Boolean(u));
      discovery.searchQueries = live.queries;
      discovery.notes.push('Live web search supplied website leads. Each candidate was then checked against its own public website; search citations alone do not verify a competitor.');
    } else discovery.notes.push('Live web search is not configured or its research budget is unavailable. Competitor discovery uses checked leads from model knowledge or related research; it may miss businesses.');
  } catch (error) { discovery.notes.push((error as Error).message); log('Live competitor search unavailable; checking existing leads instead.'); }
  const known = [...new Set([...searched, ...history])].slice(0, 8);
  let proposal: Proposal;
  try {
    proposal = await askJson<Proposal>({
      model: 'celeris-1-magnus', system: 'Build a starting research brief from what a user sells. Audience and category are hypotheses, not survey findings. The category must be a short 1-3 word search seed using common local product names, without country names. Suggest up to four real direct competitors with their official HTTPS homepages that you know; do not invent a business or domain. Prefer retailers serving the specified country. Sites will be checked before use. Return fewer candidates if unsure.',
      prompt: JSON.stringify({ product: brief.product, country: brief.country, audience: brief.audience, category: brief.niche, alreadyProvided: brief.websites, publicWebsiteLeadsFromRelatedResearch: known, instruction: 'Consider these leads and relevant local synonyms for the product. Select direct sellers; sites still need fresh verification.' }),
      schema: { type: 'object', properties: { niche: { type: 'string' }, audience: { type: 'string' }, candidates: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, website: { type: 'string' } } } } } },
      meter, thinking: false, maxTokens: 1_500, temperature: 0.1,
    });
  } catch {
    discovery.notes.push('Automatic setup could not reach the model. Research will use the product description; no competitor identities were invented.');
    proposal = { niche: '', audience: '', candidates: [] };
  }
  const seed = String(proposal.niche || brief.product).toLowerCase().replace(/nepalese/g, 'nepali').replace(/\b(?:traditional|in australia|australia|australian|united states|united kingdom|new zealand)\b/g, '').trim().split(/\s+/).slice(0, 3).join(' ');
  const expanded = { ...brief, niche: brief.niche || seed, audience: brief.audience || String(proposal.audience || '').trim().slice(0, 600) };
  const guesses = searched.length ? [] : (Array.isArray(proposal.candidates) ? proposal.candidates : []).filter((c) => c && typeof c.website === 'string').map((c) => candidateUrl(c.website)).filter((u): u is string => Boolean(u));
  const candidates = [...new Set([...known, ...guesses])].filter((u) => !brief.websites.some((v) => candidateUrl(v) === u)).slice(0, 4);
  const checked = await mapLimit(candidates, 2, async (url) => {
    log(`Checking competitor website: ${url}`);
    try {
      const item = await previewWebsite(url);
      const check = await askJson<CandidateCheck>({
        model: 'celeris-1', system: `Check whether this page belongs to a direct seller of the user's product, not a directory, charity, supplier of unrelated goods or a parked domain. Extract the business name exactly as displayed. Quotes must be exact substrings of the supplied page. ${UNTRUSTED}`,
        prompt: `PRODUCT: ${brief.product}\nTARGET COUNTRY: ${brief.country}\nPAGE: ${item.url}\nTITLE: ${item.title}\n${item.text}`,
        schema: { type: 'object', properties: { relevant: { type: 'boolean' }, name: { type: 'string' }, productQuote: { type: 'string', description: 'Exact page text showing the relevant product being sold; empty if absent.' }, marketQuote: { type: 'string', description: 'Exact text showing stores, shipping or customers in the target country. Empty if not stated.' } } },
        meter, maxTokens: 800, temperature: 0,
      });
      const match = verifiedCandidate(item, check, brief.country);
      item.attributes.discoveryStatus = match ? 'verified' : 'rejected';
      store.add([item]);
      if (!match) { discovery.notes.push(`Could not verify ${url} as a relevant direct competitor.`); return; }
      log(`Found competitor: ${match.name} | ${match.website}`);
      return match;
    } catch (error) {
      discovery.notes.push(`Could not check ${url}: ${(error as Error).message.split('\n')[0].slice(0, 160)}`);
      log(`Competitor check unavailable: ${url}`);
      return;
    }
  });
  discovery.competitors = checked.filter((c): c is NonNullable<typeof c> => Boolean(c)).filter((c, i, a) => a.findIndex((v) => v.website === c.website) === i);
  if (!searched.length) discovery.notes.push('Without usable live search, competitor candidates came from prior research or model knowledge and were checked against public homepages.');
  discovery.notes.push('This bounded research is not an exhaustive search of the whole market.');
  if (history.length) discovery.notes.push('Public website leads from earlier research on similar products were considered and checked again.');
  if (!discovery.competitors.length && !brief.websites.length) discovery.notes.push('No competitor website could be verified. Remaining research uses product searches; missing competitors are shown as a gap.');
  log(`Market setup ready: ${expanded.niche}; ${discovery.competitors.length} verified competitor websites. Audience is ${discovery.audienceBasis === 'suggested' ? 'a suggested segment to validate' : 'provided by you'}.`);
  return { ...expanded, competitors: [...new Set([...brief.competitors, ...discovery.competitors.map((c) => c.name)])], websites: [...new Set([...brief.websites, ...discovery.competitors.map((c) => c.website)])], discovery };
}
