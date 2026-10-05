import type { EvidenceStore } from '../core/store.js';
import type { Brief, TaskResult } from '../core/types.js';
import { askJson, type CostMeter } from '../llm/celeris.js';
import { mapLimit } from '../llm/extract.js';
import type { AdInsights } from '../insights/ads.js';
import type { SiteProfile } from '../insights/competitors.js';
import type { KeywordInsights } from '../insights/keywords.js';
import type { SocialInsights } from '../insights/social.js';

/**
 * The brief: Magnus writes findings from the measured insights, citing
 * evidence by number; code maps the numbers back, downgrades any "observed"
 * finding without a valid citation to "inferred", and a second Magnus pass
 * checks each observed finding against the evidence it cites. Unsupported
 * findings are removed, not softened.
 */

export interface Insights {
  keywords: KeywordInsights;
  ads: AdInsights;
  social: SocialInsights;
  competitors: SiteProfile[];
}

export interface Finding {
  finding: string;
  soWhat: string;
  basis: 'observed' | 'inferred';
  evidence: string[];
  check?: string;
}

export interface Recommendation {
  action: string;
  channel: string;
  hypothesis: string;
  impact: number;
  confidence: number;
  ease: number;
  ice: number;
  evidence: string[];
}

export interface Report {
  brief: Brief;
  generatedAt: string;
  headline: string;
  executiveSummary: Array<Finding & { action: string }>;
  sections: Array<{ id: string; title: string; findings: Finding[] }>;
  recommendations: Recommendation[];
  caveats: string[];
  insights: Insights;
  coverage: TaskResult[];
  cost: string;
}

/** Short numeric handles for evidence ids, so the model cites [12] instead of a hash. */
class Citations {
  private readonly byAlias = new Map<number, string>();
  private readonly byId = new Map<string, number>();
  alias(id: string | undefined): string {
    if (!id) return '';
    let n = this.byId.get(id);
    if (n === undefined) {
      n = this.byId.size + 1;
      this.byId.set(id, n);
      this.byAlias.set(n, id);
    }
    return `[${n}]`;
  }
  resolve(numbers: number[]): string[] {
    return [...new Set(numbers.map((n) => this.byAlias.get(n)).filter((id): id is string => Boolean(id)))];
  }
}

const fmt = (n: number, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : '?');

function digest(brief: Brief, insights: Insights, coverage: TaskResult[], cite: Citations): string {
  const { keywords, ads, social, competitors } = insights;
  const lines: string[] = [];

  lines.push('## SEARCH DEMAND (autocomplete; demand is relative, not volume; difficulty not measured)');
  lines.push(`${keywords.total} distinct phrases.`);
  for (const cluster of keywords.clusters.slice(0, 15)) {
    const first = keywords.topKeywords.find((keyword) => cluster.keywords.includes(keyword.phrase));
    lines.push(`- Cluster "${cluster.name}" (${cluster.intent}, opportunity ${cluster.opportunity}, ${cluster.keywords.length} phrases; page: ${cluster.pageIdea}; format: ${cluster.format}) e.g. ${cluster.keywords.slice(0, 6).join('; ')} ${cite.alias(first?.evidenceIds[0])}`);
  }
  if (keywords.questions.length) lines.push(`Questions asked: ${keywords.questions.slice(0, 25).join('; ')}`);
  for (const trend of keywords.trends.slice(0, 15)) lines.push(`- Trend: ${trend.keyword} ${trend.growth} ${cite.alias(trend.evidenceId)}`);

  lines.push('\n## ADS (ranked by longevity × variants × placements; no spend data)');
  lines.push(`${ads.total} ads. Advertisers: ${ads.advertisers.slice(0, 12).map((a) => `${a.name} (${a.ads} ads, ${a.active} active, median ${fmt(a.medianDays)}d, longest ${a.longest}d)`).join('; ')}`);
  for (const ad of ads.winners.slice(0, 25)) {
    lines.push(`- ${cite.alias(ad.id)} ${ad.advertiser} · ${ad.source} · ${ad.tier} (${fmt(ad.daysRunning)}d, ${ad.variants} variants) · hook: ${ad.tags?.hook ?? '?'} · angle: ${ad.tags?.angle ?? '?'} · awareness: ${ad.tags?.awareness ?? '?'} · offer: ${ad.tags?.offer ?? '?'} · CTA: ${ad.cta || '?'}\n  "${(ad.headline ? `${ad.headline} — ` : '') + ad.text.slice(0, 220).replace(/\s+/g, ' ')}"`);
  }
  for (const [name, values] of Object.entries(ads.patterns)) {
    if (values.length) lines.push(`Winning ${name}s (score-weighted share): ${values.slice(0, 6).map((v) => `${v.value} ${Math.round(v.weight * 100)}% (${v.ads} ads)`).join(', ')}`);
  }

  lines.push('\n## ORGANIC CONTENT (engagement normalised per platform; outlier = × the author\'s or search\'s median)');
  for (const [platform, posts] of Object.entries(social.topByPlatform)) {
    lines.push(`${platform}:`);
    for (const post of posts.slice(0, 6)) {
      lines.push(`- ${cite.alias(post.id)} @${post.author} ER ${fmt(post.engagementRate * (platform === 'reddit' ? 1 : 100), platform === 'reddit' ? 0 : 2)}${platform === 'reddit' ? ' pts' : '%'} · outlier ${fmt(post.outlier, 1)}× · ${Object.entries(post.metrics).filter(([k]) => ['views', 'likes', 'comments', 'shares', 'score'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')}\n  "${post.text.slice(0, 180).replace(/\s+/g, ' ')}"`);
    }
  }
  if (social.hashtags.length) lines.push(`Recurring hashtags: ${social.hashtags.slice(0, 15).map((h) => `#${h.tag} (${h.posts})`).join(', ')}`);

  lines.push('\n## VOICE OF CUSTOMER (verbatim quotes; weight = mentions × engagement)');
  for (const theme of social.voc.slice(0, 20)) {
    lines.push(`- ${theme.type.toUpperCase()}: ${theme.theme} — ${theme.mentions} mentions, weight ${theme.weight}`);
    for (const quote of theme.quotes.slice(0, 2)) lines.push(`  ${cite.alias(quote.evidenceId)} "${quote.quote}"`);
  }

  lines.push('\n## AUDITED WEBSITES');
  const ownName = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const site of competitors) {
    // Say whose site it is: a competitor's SEO issues were once recommended as the brand's own fixes.
    const own = Boolean(brief.brand) && site.host.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(ownName(brief.brand));
    lines.push(own ? `(${brief.brand}'s own site)` : `(a competitor's site, NOT ${brief.brand || 'the brand'}'s)`);
    const p = site.positioning;
    const home = site.pages.find((page) => page.type === 'home') ?? site.pages[0];
    const pricing = site.pages.find((page) => page.type === 'pricing');
    lines.push(`- ${site.host} ${cite.alias(home?.evidenceId)}${pricing ? ` pricing ${cite.alias(pricing.evidenceId)}` : ''}`);
    if (p) {
      lines.push(`  Value prop: ${p.valueProposition} | Audience: ${p.audience} | Category: ${p.category}`);
      lines.push(`  Differentiators: ${p.differentiators.join('; ')} | Pricing: ${p.pricingModel} ${p.priceTiers.map((t) => `${t.name} ${t.price}${t.period ? `/${t.period}` : ''}`).join(', ')} | Trial: ${p.freeTrial} | Offers: ${p.offers.join('; ')} | Guarantees: ${p.guarantees.join('; ')} | Proof: ${p.proof.join('; ')} | CTA: ${p.primaryCta}`);
    }
    lines.push(`  Ad pixels: ${site.pixels.join(', ') || 'none found'} | Stack: ${site.stack.join(', ') || '?'} | SEO issues: ${site.seoIssues.length} (${[...new Set(site.seoIssues.map((i) => i.issue.replace(/\d+/g, 'N')))].slice(0, 5).join('; ')}) | Sitemap sections: ${site.contentSections.slice(0, 12).join(', ')} (${site.contentTopics} topics)`);
  }

  lines.push('\n## COVERAGE');
  for (const result of coverage) {
    // Say what a count is: 700 autocomplete suggestions otherwise read as "a 700-item cluster".
    const unit = result.task.source === 'autocomplete' ? 'search suggestions collected (not search volume)' : 'items collected';
    lines.push(`- ${result.task.source} "${result.task.query}": ${result.ok ? `${result.count} ${unit}` : `not collected — ${result.note}`}`);
  }
  return lines.join('\n');
}

const FINDING = {
  type: 'object',
  properties: {
    finding: { type: 'string', description: 'One specific, quantified claim.' },
    soWhat: { type: 'string', description: 'Why it matters for this business.' },
    basis: { type: 'string', enum: ['observed', 'inferred'] },
    cites: { type: 'array', items: { type: 'integer' }, description: 'Evidence numbers that show it.' },
  },
};

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    executiveSummary: { type: 'array', items: { type: 'object', properties: { ...FINDING.properties, action: { type: 'string' } } } },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          channel: { type: 'string' },
          hypothesis: { type: 'string' },
          impact: { type: 'integer', minimum: 1, maximum: 10 },
          confidence: { type: 'integer', minimum: 1, maximum: 10 },
          ease: { type: 'integer', minimum: 1, maximum: 10 },
          cites: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    caveats: { type: 'array', items: { type: 'string' } },
  },
};

const SECTIONS: Array<{ id: string; title: string; focus: string; has: (insights: Insights) => boolean }> = [
  { id: 'demand', title: 'Search demand', focus: 'what people search for: the keyword clusters, their intent and opportunity, the questions asked, and any trends', has: (i) => i.keywords.total > 0 },
  { id: 'audience', title: 'Audience and voice of customer', focus: "the pains, desires, objections and alternatives in the audience's own words, and how often each comes up", has: (i) => i.social.voc.length > 0 },
  { id: 'ads', title: 'Ad intelligence', focus: 'which ads have run longest and been scaled, the hooks, angles, awareness stages, offers and CTAs that dominate among them, and how each advertiser differs', has: (i) => i.ads.total > 0 },
  { id: 'organic', title: 'Organic content', focus: 'which organic posts and videos outperform their baseline, and the formats, topics and hashtags they share', has: (i) => i.social.posts > 0 },
  { id: 'competitors', title: 'Competitor positioning', focus: 'how each competitor positions, prices and offers, which ad channels their pixels show they buy, and their SEO weaknesses (an audited site belongs to whoever the data says; never treat a competitor site as the brand’s own)', has: (i) => i.competitors.length > 0 || i.ads.advertisers.length > 1 },
  { id: 'content', title: 'Content and SEO opportunities', focus: "pages and content to create: high-opportunity keyword clusters and questions that competitors' site inventories and content do not cover", has: (i) => i.keywords.total > 0 },
];

const WRITER = [
  'You are a head of growth writing one part of a marketing-insights brief from collected data.',
  'Rules: every observed finding cites the evidence numbers shown in the data, e.g. [3]; quantify (counts, days, %, n) instead of adjectives; call something a pattern only when at least three independent items show it; label anything you conclude beyond the data as "inferred"; never invent numbers, brands or quotes. Demand and opportunity are relative scores from autocomplete: never call them search volume. Keep advice to the brief\'s country; ignore places that came from foreign search suggestions.',
].join('\n');

type RawFinding = { finding: string; soWhat: string; basis: 'observed' | 'inferred'; cites: number[] };

/**
 * Written in parts: one Magnus call per section, side by side, then one call
 * for the headline, summary and test backlog over the checked sections. A
 * single call for the whole brief spent Magnus' 16k output ceiling on
 * reasoning and was cut off. Every call opens with the same DATA block, so
 * Celeris' prefix cache serves it after the first.
 */
export async function synthesize(brief: Brief, insights: Insights, coverage: TaskResult[], store: EvidenceStore, meter: CostMeter): Promise<Omit<Report, 'cost'>> {
  const cite = new Citations();
  const data = digest(brief, insights, coverage, cite);
  const context = `DATA\n${data}\n\nBRIEF\n${JSON.stringify({ product: brief.product, niche: brief.niche, brand: brief.brand, competitors: brief.competitors, country: brief.country, audience: brief.audience, goals: brief.goals })}`;
  /**
   * Writers also cite inline ("… [12]"). Those numbers are this call's
   * aliases, which the renderer renumbers, so they are moved into the
   * citation list and taken out of the prose.
   */
  // "[3]", "[3][7]" and "[3, 7, 12]" alike.
  const inline = (...texts: string[]) =>
    texts.flatMap((text) => [...(text ?? '').matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((match) => match[1].split(',').map(Number)));
  const strip = (text: string) => (text ?? '').replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').trim();
  const resolve = (numbers: number[]) => cite.resolve(numbers).filter((id) => store.get(id));
  const toFinding = (item: RawFinding): Finding => {
    const evidence = resolve([...(item.cites ?? []), ...inline(item.finding, item.soWhat)]);
    return { finding: strip(item.finding), soWhat: strip(item.soWhat), basis: evidence.length ? item.basis : 'inferred', evidence };
  };

  const written = await mapLimit(SECTIONS.filter((section) => section.has(insights)), 3, async (section) => {
    try {
      const reply = await askJson<{ findings: RawFinding[] }>({
        model: 'celeris-1-magnus',
        system: WRITER,
        prompt: `${context}\n\nWrite the "${section.title}" section: 3-6 findings about ${section.focus}. Each finding is one specific claim with its "so what" for this business.`,
        schema: { type: 'object', properties: { findings: { type: 'array', items: FINDING } } },
        meter,
        thinking: false,
        maxTokens: 3_000,
        temperature: 0.2,
      });
      return { id: section.id, title: section.title, findings: (reply.findings ?? []).map(toFinding) };
    } catch {
      return { id: section.id, title: section.title, findings: [] as Finding[] };
    }
  });
  const sections = written.filter((section) => section.findings.length);
  if (!sections.length) throw new Error('no section of the brief could be written');

  await factCheck(sections.flatMap((section) => section.findings), data, store, meter);
  const kept = (finding: Finding) => finding.check !== 'unsupported';
  const checked = sections.map((section) => ({ ...section, findings: section.findings.filter(kept) })).filter((section) => section.findings.length);

  // The summary is written from the checked sections, so it cannot repeat a finding that failed its check.
  const numbered = checked
    .map((section) => `## ${section.title}\n${section.findings.map((f) => `- ${f.finding} (${f.basis}) ${f.evidence.map((id) => cite.alias(id)).join('')}`).join('\n')}`)
    .join('\n\n');
  const summary = await askJson<{
    headline: string;
    executiveSummary: Array<RawFinding & { action: string }>;
    recommendations: Array<Omit<Recommendation, 'ice' | 'evidence'> & { cites: number[] }>;
    caveats: string[];
  }>({
    model: 'celeris-1-magnus',
    system: `${WRITER}\nRecommendations are concrete tests a marketer can run next week, scored 1-10 for impact, confidence and ease.`,
    prompt: `${context}\n\nCHECKED FINDINGS\n${numbered}\n\nWrite: a one-line headline; 3-6 executive-summary findings (the most consequential of the checked findings, keeping their citations) each with the action it implies; 6-12 recommendations; caveats about what the data cannot show (no ad spend, autocomplete is relative demand not volume, keyword difficulty not measured, sources that were not collected).`,
    schema: SUMMARY_SCHEMA,
    meter,
    thinking: false,
    maxTokens: 3_500,
    temperature: 0.2,
  }).catch((error: Error) => ({
    // The checked sections stand without a summary.
    headline: '',
    executiveSummary: [],
    recommendations: [],
    caveats: [`The summary and test backlog could not be written (${error.message.slice(0, 160)}); re-run with --resume.`],
  }));

  return {
    brief,
    generatedAt: new Date().toISOString(),
    headline: summary.headline ?? '',
    executiveSummary: (summary.executiveSummary ?? []).map((item) => ({ ...toFinding(item), action: strip(item.action) })),
    sections: checked,
    recommendations: (summary.recommendations ?? [])
      .map((rec) => ({
        action: strip(rec.action),
        channel: rec.channel,
        hypothesis: strip(rec.hypothesis),
        impact: rec.impact,
        confidence: rec.confidence,
        ease: rec.ease,
        ice: rec.impact * rec.confidence * rec.ease,
        evidence: resolve([...(rec.cites ?? []), ...inline(rec.action, rec.hypothesis)]),
      }))
      .sort((a, b) => b.ice - a.ice),
    caveats: summary.caveats ?? [],
    insights,
    coverage,
  };
}

/** Marks each observed finding supported, partly or unsupported by the text of what it cites. */
async function factCheck(findings: Finding[], measured: string, store: EvidenceStore, meter: CostMeter): Promise<void> {
  const observed = findings.filter((finding) => finding.basis === 'observed').slice(0, 50);
  if (!observed.length) return;
  const blocks = observed.map((finding, index) => {
    const sources = finding.evidence.slice(0, 4).map((id) => {
      const item = store.get(id)!;
      const metrics = Object.entries(item.metrics).map(([k, v]) => `${k}=${v}`).join(', ');
      return `  · ${item.source} ${item.kind} by ${item.author || '?'}${metrics ? ` (${metrics})` : ''}: ${(item.title ? `${item.title} — ` : '') + item.text.slice(0, 450).replace(/\s+/g, ' ')}`;
    });
    return `[${index}] ${finding.finding}\n${sources.join('\n')}`;
  });
  try {
    const reply = await askJson<{ checks: Array<{ index: number; verdict: 'supported' | 'partly' | 'unsupported'; note: string }> }>({
      model: 'celeris-1-magnus',
      system: 'You are a strict fact-checker. Judge each claim against the evidence listed under it and the measured data. A claim that generalises (counts, patterns) is "partly" if the listed items show it for some but cannot show the whole; "unsupported" if the evidence contradicts it or does not show it at all.',
      // Counts, scores and shares are computed by code into the measured data; a claim citing them is checked against it, not marked unverifiable.
      prompt: `MEASURED DATA (computed by code from every collected item; treat as accurate)\n${measured}\n\nCLAIMS AND THEIR CITED EVIDENCE\n${blocks.join('\n\n')}`,
      schema: { type: 'object', properties: { checks: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, verdict: { type: 'string', enum: ['supported', 'partly', 'unsupported'] }, note: { type: 'string' } } } } } },
      meter,
      effort: 'low',
      maxTokens: 4_000,
    });
    for (const check of reply.checks ?? []) {
      const finding = observed[check.index];
      if (finding) finding.check = check.verdict === 'supported' ? 'supported' : check.verdict === 'partly' ? `partly: ${check.note}` : 'unsupported';
    }
  } catch {
    for (const finding of observed) finding.check = 'not checked';
  }
}
