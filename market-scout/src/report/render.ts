import { coverageState } from '../core/quality.js';
import { tierFor } from '../insights/ads.js';
import type { EvidenceStore } from '../core/store.js';
import type { Finding, Report } from './synthesize.js';

/**
 * The report as Markdown (for docs and chat) and as one self-contained HTML
 * page (for sharing). Citations are numbered in order of first use and link
 * to the exact ad, post or page.
 */

class Footnotes {
  private readonly order = new Map<string, number>();
  constructor(private readonly store: EvidenceStore) {}
  ref(ids: string[]): Array<{ n: number; url: string; label: string }> {
    return ids.flatMap((id) => {
      const item = this.store.get(id);
      if (!item) return [];
      if (!this.order.has(id)) this.order.set(id, this.order.size + 1);
      return [{ n: this.order.get(id)!, url: item.url, label: `${item.source} · ${item.author || item.title || item.url}`.slice(0, 120) }];
    });
  }
  list() {
    return [...this.order.entries()].map(([id, n]) => {
      const item = this.store.get(id)!;
      return { n, url: item.url, source: item.source, kind: item.kind, author: item.author, title: (item.title || item.text).slice(0, 140).replace(/\s+/g, ' ') };
    });
  }
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number | undefined, digits = 0) => (n !== undefined && Number.isFinite(n) ? n.toLocaleString('en', { maximumFractionDigits: digits }) : '—');

const stockLabel = (value: string | undefined) => {
  const status = value?.split('/').pop();
  return ({ InStock: 'In stock', OutOfStock: 'Out of stock', PreOrder: 'Pre-order', BackOrder: 'Back order', LimitedAvailability: 'Limited stock', Discontinued: 'Discontinued' } as Record<string, string>)[status || ''] || status || 'Not confirmed';
};

export function renderMarkdown(report: Report, store: EvidenceStore): string {
  const notes = new Footnotes(store);
  const cites = (ids: string[]) => notes.ref(ids).map((ref) => `[[${ref.n}]](${ref.url})`).join('');
  const finding = (f: Finding) => `${f.finding}${f.basis === 'inferred' ? ' *(inferred)*' : ''} ${cites(f.evidence)}${f.check?.startsWith('partly') ? ` — *check: ${f.check}*` : ''}\n  ${f.soWhat}`;
  const { insights } = report;
  const out: string[] = [];

  out.push(`# Marketing insights: ${report.brief.brand || report.brief.product}`);
  out.push(`_${report.brief.niche} · ${report.brief.country} · ${report.generatedAt.slice(0, 10)} · ${report.cost}_\n`);
  out.push(`**${report.headline}**\n`);

  if (report.brief.discovery) {
    out.push('## Your market');
    out.push(`Category: ${report.brief.niche}\n\nAudience (${report.brief.discovery.audienceBasis}): ${report.brief.audience || 'Not available'}`);
    for (const c of report.brief.discovery.competitors) out.push(`- [${c.name}](${c.website}) - ${c.region === 'target' ? 'Target-market evidence found' : 'Target market unconfirmed'} ${cites([c.evidenceId])}\n  Product evidence: "${c.productQuote}"`);
    for (const note of report.brief.discovery.notes) out.push(`- ${note}`);
  }

  out.push('## Key findings');
  if (report.quality) out.push(`Evidence reviewed: ${report.quality.included} usable / ${report.quality.collected} collected; ${report.quality.excluded} irrelevant; ${report.quality.unverified} unverified; ${report.quality.regionUnknown} with unconfirmed geography; ${report.quality.customerItems} customer sources.\n`);
  for (const item of report.executiveSummary) out.push(`- ${finding(item)}\n  **Action:** ${item.action}`);

  out.push('\n## Suggested tests');
  report.recommendations.forEach((rec, index) => out.push(`${index + 1}. **${rec.action}** (${rec.channel})\n   ${rec.hypothesis} ${cites(rec.evidence)}`));

  for (const section of report.sections) {
    out.push(`\n## ${section.title}`);
    for (const item of section.findings) out.push(`- ${finding(item)}`);
  }

  if (insights.keywords.clusters.length) {
    out.push('\n## Search ideas');
    out.push('| Cluster | Intent | Opportunity | Page to build | Keywords |\n|---|---|---|---|---|');
    for (const cluster of insights.keywords.clusters) out.push(`| ${cluster.name} | ${cluster.intent} | ${cluster.opportunity} | ${cluster.pageIdea} (${cluster.format}) | ${cluster.keywords.slice(0, 10).join(', ')} |`);
    if (insights.keywords.questions.length) out.push(`\n**Questions people ask:** ${insights.keywords.questions.slice(0, 40).join(' · ')}`);
  }

  if (insights.ads.winners.length) {
    out.push('\n## Advertising observations');
    out.push('| Advertiser | Tier | Days | Variants | Hook | Angle | CTA | Ad |\n|---|---|---|---|---|---|---|---|');
    for (const ad of insights.ads.winners.slice(0, 25)) {
      out.push(`| ${ad.advertiser} | ${tierFor(ad.daysRunning)} | ${num(ad.daysRunning)} | ${ad.variants} | ${ad.tags?.hook ?? ''} | ${ad.tags?.angle ?? ''} | ${ad.cta} | [${(ad.headline || ad.text).slice(0, 60).replace(/[|\n]/g, ' ')}](${ad.url}) |`);
    }
  }

  if (insights.social.voc.length) {
    out.push('\n## Independent customer feedback');
    for (const theme of insights.social.voc.slice(0, 20)) {
      out.push(`- **${theme.type}: ${theme.theme}** (${theme.mentions})`);
      for (const quote of theme.quotes.slice(0, 3)) out.push(`  - "${quote.quote}" [↗](${quote.url})`);
    }
  }

  if (insights.competitors.length) {
    out.push('\n## Competitor sites');
    out.push('AI summaries of seller claims. Check the linked source for prices and conditions.');
    out.push('| Site | Value proposition | Pricing | Offer / trial | Ad pixels | SEO issues |\n|---|---|---|---|---|---|');
    for (const site of insights.competitors) {
      const p = site.positioning;
      out.push(`| ${site.host} | ${p?.valueProposition ?? ''} | ${p ? p.priceTiers.map((t) => `${t.name} ${t.price}`).join(', ') || p.pricingModel : ''} | ${p ? [p.freeTrial, ...p.offers].filter(Boolean).join('; ') : ''} | ${site.pixels.join(', ')} | ${site.seoIssues.length} |`);
    }
  }

  for (const site of insights.competitors) {
    if (site.retail?.length) {
      out.push(`\n## Product listings: ${site.host}`);
      for (const product of site.retail) out.push(`- ${product.name}: ${product.price} ${product.currency || '(currency unknown)'}; stock ${stockLabel(product.availability)}. [Check listing](${product.url}) ${cites([product.evidenceId])}`);
    }
    for (const terms of site.serviceTerms ?? []) out.push(`\n### ${site.host}: ${terms.type}\n${terms.text}\n[Check current policy](${terms.url})`);
  }

  if (report.caveats.length) {
    out.push('\n## Caveats');
    for (const caveat of report.caveats) out.push(`- ${caveat}`);
  }
  out.push('\n## Coverage');
  for (const result of report.coverage) out.push(`- ${result.task.source} "${result.task.query}": ${result.ok ? `${result.count} items (${coverageState(result)})` : `${coverageState(result)} (${result.note})`}`);

  out.push('\n## Sources');
  for (const note of notes.list()) out.push(`${note.n}. [${note.source} ${note.kind}${note.author ? ` · ${note.author}` : ''}](${note.url}) — ${note.title}`);
  return out.join('\n');
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderHtml(report: Report, store: EvidenceStore): string {
  if (report.version !== 2) report = { ...report, headline: 'Older report: recheck its saved evidence before using conclusions.', executiveSummary: [], recommendations: [], sections: [] };
  const notes = new Footnotes(store);
  const cites = (ids: string[]) => notes.ref(ids).map((ref) => `<a class="cite" href="${esc(ref.url)}" title="${esc(ref.label)}" target="_blank" rel="noopener">${ref.n}</a>`).join('');
  const finding = (f: Finding, action?: string) => `
    <li class="finding">
      <p>${esc(f.finding)} ${f.basis === 'inferred' ? '<span class="tag">inferred</span>' : ''}${cites(f.evidence)}</p>
      <p class="muted">${esc(f.soWhat)}</p>
      ${f.check?.startsWith('partly') ? `<p class="check">Fact-check: ${esc(f.check)}</p>` : ''}
      ${action ? `<p class="action"><strong>Action:</strong> ${esc(action)}</p>` : ''}
    </li>`;
  const bars = (title: string, values: Array<{ value: string; weight: number; ads: number }>) =>
    values.length
      ? `<div class="bars"><h4>${esc(title)}</h4>${values.slice(0, 6).map((v) => `<div class="bar"><span>${esc(v.value)}</span><i style="--w:${Math.round(v.weight * 100)}%"></i><b>${pct(v.weight)}</b></div>`).join('')}</div>`
      : '';
  const { insights } = report;

  const body = `
<header>
  <p class="eyebrow">${esc(report.brief.niche)} · ${esc(report.brief.country)} · ${esc(report.generatedAt.slice(0, 10))}</p>
  <h1>${esc(report.brief.brand || report.brief.product)}</h1>
  <p class="lede">${esc(report.headline)}</p>
</header>

${report.brief.discovery ? `<section id="market"><h2>Your market</h2><p><strong>Product category:</strong> ${esc(report.brief.niche)}</p><p><strong>${report.brief.discovery.audienceBasis === 'suggested' ? 'Suggested audience' : 'Your audience'}:</strong> ${esc(report.brief.audience || 'Not available')}</p><p class="muted">The audience is a starting segment to test, not a verified buyer survey. Research market: ${esc(report.brief.country)}.</p><h3>Competitors and websites to audit</h3><ul>${report.brief.discovery.competitors.map((c) => `<li><a href="${esc(c.website)}" target="_blank" rel="noopener"><strong>${esc(c.name)}</strong> - ${esc(c.website)}</a>${cites([c.evidenceId])}<br><span class="small muted">${c.region === 'target' ? 'Target-market evidence found on the site' : 'Target market unconfirmed'}</span><details><summary>Why this competitor was selected</summary><blockquote>${esc(c.productQuote)}</blockquote>${c.marketQuote ? `<blockquote>${esc(c.marketQuote)}</blockquote>` : ''}</details></li>`).join('') || '<li>No competitor website could be verified.</li>'}</ul><details><summary>How the agent set up this research</summary><ul>${report.brief.discovery.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details></section>` : ''}

<section id="findings"><h2>Key findings</h2><ul class="findings">${report.executiveSummary.map((f) => finding(f, f.action)).join('')}</ul></section>

<section id="steps"><h2>What to test next</h2><p class="muted">These are experiments, not predicted results. Choose one, define a budget or time limit, and track enquiries or orders.</p><ol class="next-steps">${report.recommendations.map((r) => `<li><strong>${esc(r.action)}</strong><span class="tag">${esc(r.channel)}</span><p class="muted">${esc(r.hypothesis)}</p><span class="small">${cites(r.evidence)}</span></li>`).join('')}</ol></section>

${report.sections.map((s) => `<section><h2>${esc(s.title)}</h2><ul class="findings">${s.findings.map((f) => finding(f)).join('')}</ul></section>`).join('')}

${insights.keywords.clusters.length ? `<section><h2>Search ideas</h2><p class="muted">${insights.keywords.total} phrases from search autocomplete. Opportunity ranks clusters against each other by engine agreement, suggestion rank and intent; it is not search volume.</p><div class="scroll"><table>
  <thead><tr><th>Cluster</th><th>Intent</th><th title="Relative suggestion score; not monthly searches">Relative score</th><th>Page to build</th><th>Keywords</th></tr></thead>
  <tbody>${insights.keywords.clusters.map((c) => `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.intent)}</td><td class="num">${c.opportunity}</td><td>${esc(c.pageIdea)} <span class="muted">(${esc(c.format)})</span></td><td class="small">${esc(c.keywords.slice(0, 12).join(', '))}</td></tr>`).join('')}</tbody>
</table></div>${insights.keywords.questions.length ? `<h3>Questions people ask</h3><p class="chips">${insights.keywords.questions.slice(0, 40).map((q) => `<span>${esc(q)}</span>`).join('')}</p>` : ''}</section>` : ''}

${insights.ads.winners.length ? `<section><h2>Public advertising examples</h2><p class="muted">${insights.ads.total} ads from ${insights.ads.advertisers.length} advertisers. Ranked by days running × variants × placements, within each advertiser; no library shows commercial spend.</p>
<div class="grid">${bars('Hooks', insights.ads.patterns.hook)}${bars('Awareness stage', insights.ads.patterns.awareness)}${bars('Offers', insights.ads.patterns.offer)}${bars('CTAs', insights.ads.patterns.cta)}</div>
<div class="cards">${insights.ads.winners.slice(0, 24).map((ad) => `<article class="card"><p class="eyebrow">${esc(ad.advertiser)} · ${esc(ad.source)}</p><p class="tier tier-${esc(tierFor(ad.daysRunning).replace(/\s/g, '-'))}">${esc(tierFor(ad.daysRunning))} · ${num(ad.daysRunning)} days · ${ad.variants} variant${ad.variants === 1 ? '' : 's'}</p>${ad.headline ? `<h4>${esc(ad.headline)}</h4>` : ''}<p class="copy">${esc(ad.text.slice(0, 320))}</p>${ad.tags ? `<p class="small muted">Hook: ${esc(ad.tags.hook)} · ${esc(ad.tags.awareness)}<br>Angle: ${esc(ad.tags.angle)}</p>` : ''}<a href="${esc(ad.url)}" target="_blank" rel="noopener">View ad${ad.cta ? ` · ${esc(ad.cta)}` : ''} →</a></article>`).join('')}</div></section>` : ''}

${Object.keys(insights.social.topByPlatform).length ? `<section><h2>Content examples</h2>${Object.entries(insights.social.topByPlatform).map(([platform, posts]) => `<h3>${esc(platform)}</h3><div class="scroll"><table><thead><tr><th>Post</th><th>Engagement</th><th>Comparison</th></tr></thead><tbody>${posts.slice(0, 8).map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.text.slice(0, 140) || p.url)}</a><br><span class="muted">${esc(p.author)}</span></td><td class="num">${platform === 'reddit' ? `${num(p.engagementRate)} pts` : Number.isFinite(p.engagementRate) ? `${(p.engagementRate * 100).toFixed(2)}%` : '—'}</td><td class="num">${Number.isFinite(p.outlier) ? `${p.outlier}× (${esc(p.baseline || "sample baseline unknown")})` : '—'}</td></tr>`).join('')}</tbody></table></div>`).join('')}</section>` : ''}

${insights.social.voc.length ? `<section><h2>Independent customer feedback</h2><div class="cards">${insights.social.voc.slice(0, 18).map((t) => `<article class="card"><p class="eyebrow">${esc(t.type)} · ${t.mentions} mention${t.mentions === 1 ? '' : 's'}</p><h4>${esc(t.theme)}</h4>${t.quotes.slice(0, 3).map((q) => `<blockquote><a href="${esc(q.url)}" target="_blank" rel="noopener">“${esc(q.quote)}”</a></blockquote>`).join('')}</article>`).join('')}</div></section>` : ''}

${insights.competitors.length ? `<section><h2>Competitor sites</h2><p class="muted">AI summaries of seller claims. Verify prices, offers and conditions in the original pages. SEO checks apply only to collected pages.</p><div class="scroll"><table><thead><tr><th>Site</th><th>Positioning</th><th>Pricing &amp; offers</th><th>Installed tracking</th><th>SEO issues</th></tr></thead><tbody>${insights.competitors.map((s) => `<tr><td><strong>${esc(s.host)}</strong><br><span class="small muted">${esc(s.stack.join(', '))}</span></td><td>${esc(s.positioning?.valueProposition ?? '')}<br><span class="small muted">${esc(s.positioning?.differentiators.join(' · ') ?? '')}</span></td><td class="small">${esc(s.positioning ? [s.positioning.priceTiers.map((t) => `${t.name} ${t.price}${t.period ? `/${t.period}` : ''}`).join(', ') || s.positioning.pricingModel, s.positioning.freeTrial, ...s.positioning.offers].filter(Boolean).join(' · ') : '')}</td><td class="small">${esc(s.pixels.join(', ') || 'none found')}</td><td class="small">${s.seoIssues.slice(0, 6).map((i) => esc(i.issue)).join('<br>')}</td></tr>`).join('')}</tbody></table></div></section>` : ''}

${insights.competitors.some((site) => site.retail?.length || site.serviceTerms?.length) ? `<section><h2>Products and service information</h2><p class="muted">Prices are individual listings, not a market average. Unknown currency or stock stays unknown. Return and delivery conditions are linked below.</p>${insights.competitors.map((site) => `<h3>${esc(site.host)}</h3>${site.retail?.length ? `<div class="scroll"><table><thead><tr><th>Product</th><th>Listed price</th><th>Stock</th><th>Source</th></tr></thead><tbody>${site.retail.slice(0, 15).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.price)} ${esc(p.currency || 'currency not stated')}</td><td>${esc(stockLabel(p.availability))}</td><td><a href="${esc(p.url)}" target="_blank" rel="noopener">Check listing</a>${cites([p.evidenceId])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No structured product prices collected.</p>'}${(site.serviceTerms ?? []).map((t) => `<details><summary>${esc(t.type)} - view source terms</summary><p class="terms">${esc(t.text)}</p><a href="${esc(t.url)}" target="_blank" rel="noopener">Check current policy</a></details>`).join('')}`).join('')}</section>` : ''}

${report.caveats.length ? `<section><h2>Caveats</h2><ul>${report.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></section>` : ''}

${report.quality ? `<section><h2>Items set aside</h2><p class="muted">These items did not contribute to the findings or scores.</p><ul class="small">${report.quality.reviews.filter((r) => r.status !== 'included').slice(0, 100).map((r) => `<li>${esc(store.get(r.id)?.author || store.get(r.id)?.title || r.id)} - ${esc(r.reason)}</li>`).join('')}</ul></section>` : ''}
<section><h2>Research coverage</h2><ul class="small">${report.coverage.map((r) => `<li>${esc(r.task.source)} “${esc(r.task.query)}”: ${esc(coverageState(r))} · ${r.count} items${r.note ? ` — ${esc(r.note)}` : ''}</li>`).join('')}</ul><p class="small muted">${esc(report.cost)}</p></section>

<section><h2>Sources</h2><ol class="sources small">${notes.list().map((n) => `<li value="${n.n}"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.source)} ${esc(n.kind)}${n.author ? ` · ${esc(n.author)}` : ''}</a> — ${esc(n.title)}</li>`).join('')}</ol></section>`;

  const quality = report.quality;
  const overview = quality ? `<section id="quality" class="quality"><h2>How strong is the evidence?</h2><div class="stats"><div><strong>${quality.included}</strong><span>usable items</span></div><div><strong>${quality.excluded + quality.unverified}</strong><span>items set aside</span></div><div><strong>${quality.regionUnknown}</strong><span>location unconfirmed</span></div><div><strong>${quality.customerItems}</strong><span>customer sources</span></div></div><p>${report.status === 'partial' ? 'Limited report: there are not enough source records for key findings.' : 'Key findings describe collected measurements and source records. They do not establish market size or guarantee results.'}</p>${!quality.customerItems ? '<p class="warn">No independent customer feedback was collected. Customer needs still need validation.</p>' : ''}</section>` : '<p class="legacy">This is an older report without the new evidence checks. Recheck its saved evidence before acting.</p>';
  const simplified = body.replace(/<section><h2>([^<]+)<\/h2>([\s\S]*?)<\/section>/g, (_match, title, contents) => `<details class="detail"><summary>${title}</summary>${contents}</details>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Scout Brief</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1c1a;--muted:#6b6862;--line:#e4e1da;--card:#ffffff;--accent:#2f5d50;--accent-soft:#e3eee9;--warn:#a2461f;--bar:#2f5d50}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--fg:#ecebe7;--muted:#a3a09a;--line:#2e2d2a;--card:#1d1d1b;--accent:#8cc4b2;--accent-soft:#22332e;--warn:#e59a74;--bar:#8cc4b2}}
:root[data-theme="dark"]{--bg:#151514;--fg:#ecebe7;--muted:#a3a09a;--line:#2e2d2a;--card:#1d1d1b;--accent:#8cc4b2;--accent-soft:#22332e;--warn:#e59a74;--bar:#8cc4b2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:40px 16px 80px}
header{padding-bottom:24px;border-bottom:1px solid var(--line)}h1{font-size:2.1rem;line-height:1.15;margin:.2em 0}
.lede{font-size:1.2rem;max-width:60ch}.eyebrow{text-transform:uppercase;letter-spacing:.06em;font-size:.75rem;color:var(--muted);margin:0}
.report-nav{display:flex;gap:18px;flex-wrap:wrap;font-size:.85rem;margin-bottom:24px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stats div{display:flex;flex-direction:column;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:10px}.stats strong{font-size:1.65rem}.stats span{font-size:.85rem;color:var(--muted)}.quality{padding:20px;background:var(--accent-soft);border-radius:12px;margin-bottom:28px}.next-steps{padding:0;list-style-position:inside;display:grid;gap:12px}.next-steps li{padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--card)}.next-steps p{margin:8px 0 0}.detail{margin-top:16px;padding:16px;border:1px solid var(--line);border-radius:10px}.detail>summary{font-size:1rem;font-weight:600;cursor:pointer}.detail[open]>summary{margin-bottom:18px}.terms{white-space:pre-wrap;font-size:.85rem}.legacy{padding:16px;background:var(--accent-soft);border-radius:8px}section{margin-top:32px}h2{font-size:1.35rem;margin:0 0 12px}h3{font-size:1.05rem;margin:20px 0 8px}h4{margin:6px 0;font-size:1rem}
.muted{color:var(--muted)}.small{font-size:.875rem}.warn{color:var(--warn)}
.findings{list-style:none;padding:0;margin:0;display:grid;gap:12px}.finding{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.finding p{margin:0 0 4px}
.action{margin-top:8px!important}.check{font-size:.85rem;color:var(--warn)}
.tag{font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted);margin-left:4px}
.cite{display:inline-block;min-width:1.4em;text-align:center;font-size:.72rem;background:var(--accent-soft);color:var(--accent);border-radius:4px;margin-left:3px;text-decoration:none;padding:0 3px;vertical-align:super}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}.num{text-align:right;white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:4px}.card p{margin:0}.copy{font-size:.9rem;white-space:pre-line}
.card a{color:var(--accent);margin-top:auto;font-size:.9rem}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--accent-soft);font-size:.9rem}blockquote a{color:inherit;text-decoration:none}
.tier{font-size:.8rem;color:var(--accent)}.tier-testing,.tier-unknown-age{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:12px 0 20px}.bars h4{font-size:.85rem;color:var(--muted);font-weight:600}
.bar{display:grid;grid-template-columns:1fr 90px 40px;align-items:center;gap:8px;font-size:.85rem;margin:4px 0}.bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar i{height:8px;border-radius:4px;background:linear-gradient(90deg,var(--bar) var(--w),var(--line) var(--w))}.bar b{font-weight:500;text-align:right}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips span{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:.85rem;background:var(--card)}
a{color:var(--accent)}.sources li{margin:2px 0}
</style></head><body><main><nav class="report-nav"><a href="/">Back to your research</a><a href="#quality">Evidence quality</a><a href="#findings">Key findings</a><a href="#steps">Next steps</a><a href="report.md" download>Download report</a></nav>${simplified.replace('</header>', '</header>' + overview)}</main></body></html>`;
}
