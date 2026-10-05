import type { Brief, Evidence, MarketDiscovery } from './types.js';
import type { EvidenceStore } from './store.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit, UNTRUSTED } from '../llm/extract.js';
import { previewWebsite } from '../sources/website.js';
import { searchCompetitors } from './search-discovery.js';
import { config } from '../config.js';

type Proposal = { niche: string; audience: string };
export type CandidateCheck = { relevant: boolean; name: string; productQuote: string; marketQuote: string };

export function shortSeed(value: string): string {
  return value.toLowerCase().replace(/nepalese/g, 'nepali').replace(/\b(?:traditional|in australia|australia|australian|united states|united kingdom|new zealand)\b/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').trim().split(/\s+/).slice(0, 3).join(' ');
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
  if (check.relevant !== true || typeof check.name !== 'string' || typeof check.productQuote !== 'string' || (check.marketQuote != null && typeof check.marketQuote !== 'string') || !check.name.trim() || check.productQuote.trim().length < 12 || !item.text.includes(check.productQuote)) return;
  const nameWords = check.name.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!nameWords.length || !nameWords.every((w) => `${item.title} ${item.text}`.toLowerCase().includes(w))) return;
  let quote = check.marketQuote && item.text.includes(check.marketQuote) ? check.marketQuote : '';
  const regionWords: Record<string, RegExp> = { AU: /australia|australian|sydney|melbourne|brisbane/i, US: /united states|\busa\b|\bus shipping\b/i, GB: /united kingdom|\buk\b|london/i, NZ: /new zealand|auckland/i, CA: /canada|canadian|toronto/i };
  if (!check.marketQuote) quote = regionWords[country]?.test(check.productQuote) ? check.productQuote : item.text.split(/(?<=[.!?])\s+/).find((line) => regionWords[country]?.test(line) && line.length < 500) || '';
  if (!regionWords[country]?.test(quote) && regionWords[country]?.test(check.productQuote)) quote = check.productQuote;
  return { name: check.name.trim(), website: new URL(item.url).origin + '/', evidenceId: item.id, productQuote: check.productQuote, marketQuote: quote, region: regionWords[country]?.test(quote) ? 'target' : 'unknown' };
}

export async function discoverMarket(brief: Brief, store: EvidenceStore, meter: CostMeter, log: (line: string) => void, deadline = Date.now() + 180_000): Promise<Brief> {
  const discovery: MarketDiscovery = { audienceBasis: brief.audience ? 'provided' : 'suggested', categoryBasis: brief.niche ? 'provided' : 'suggested', competitors: [], notes: [] };
  log('Discovering your market: category, likely audience and competitor websites...');
  let searched: string[] = [];
  try {
    log('Searching for competitor websites in the browser...');
    const live = await searchCompetitors(brief, log, Math.min(deadline, Date.now() + 100_000));
    discovery.searches = live.searches;
    discovery.searchQueries = live.queries;
    store.writeJson('search-discovery.json', live);
    if (live.websites.length) {
      searched = live.websites.map(candidateUrl).filter((u): u is string => Boolean(u));
      discovery.notes.push('Live browser searches supplied website leads. Each candidate was checked against its own public website; a search result alone does not verify a competitor.');
    } else discovery.notes.push(config.webSearch.enabled ? 'Browser discovery returned no usable website leads. Competitor discovery is limited; no AI guesses or previous-run leads were substituted.' : 'Browser discovery is disabled. Only websites supplied by you can be checked.');
    for (const search of live.searches) if (search.status !== 'ok') discovery.notes.push(`${search.engine} browser search (${search.status}): ${search.note}`);
  } catch (error) { discovery.notes.push(`Browser discovery unavailable: ${(error as Error).message}`); log('Browser competitor search unavailable; only checking websites provided by you.'); }
  let proposal: Proposal;
  try {
    proposal = await askJson<Proposal>({
      model: 'celeris-1-magnus', system: 'Build a starting research brief from what a user sells. Audience and category are hypotheses, not survey findings. The category must be a short 1-3 word search seed using common local product names, without country names. Do not suggest competitor names or websites: these are discovered only through live browser searches.',
      prompt: JSON.stringify({ product: brief.product, country: brief.country, audience: brief.audience, category: brief.niche }),
      schema: { type: 'object', properties: { niche: { type: 'string' }, audience: { type: 'string' } } },
      meter, thinking: false, maxTokens: 1_500, temperature: 0.1,
    });
  } catch {
    discovery.notes.push('Automatic setup could not reach the model. Research will use the product description; no competitor identities were invented.');
    proposal = { niche: '', audience: '' };
  }
  const seed = shortSeed(typeof proposal.niche === 'string' && proposal.niche.trim() ? proposal.niche : brief.product);
  const expanded = { ...brief, niche: brief.niche || seed, audience: brief.audience || String(proposal.audience || '').trim().slice(0, 600) };
  const provided = brief.websites.map(candidateUrl).filter((u): u is string => Boolean(u) && u !== candidateUrl(brief.ownWebsite || ''));
  const candidates = [...new Set([...provided, ...searched])].filter((u) => u !== candidateUrl(brief.ownWebsite || '')).slice(0, 8);
  const checked = await mapLimit(candidates, 2, async (url) => {
    log(`Checking competitor website: ${url}`);
    if (Date.now() >= deadline) { discovery.notes.push(`Could not check ${url}: research time limit reached.`); return; }
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
  discovery.notes.push('This bounded research is not an exhaustive search of the whole market.');
  if (!discovery.competitors.length && !brief.websites.length) discovery.notes.push('No competitor website could be verified. Remaining research uses product searches; missing competitors are shown as a gap.');
  log(`Market setup ready: ${expanded.niche}; ${discovery.competitors.length} verified competitor websites. Audience is ${discovery.audienceBasis === 'suggested' ? 'a suggested segment to validate' : 'provided by you'}.`);
  return { ...expanded, competitors: [...new Set([...brief.competitors, ...discovery.competitors.map((c) => c.name)])], websites: [...new Set([...brief.websites, ...discovery.competitors.map((c) => c.website)])], discovery };
}
