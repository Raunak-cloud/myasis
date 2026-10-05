import { runAgent } from '../agent/agent.js';
import { withPage } from '../browser/session.js';
import { evidence } from '../core/store.js';
import type { SourceId } from '../core/types.js';
import { googleAds, linkedinAds, pinterestTrends } from './ad-libraries.js';
import { autocomplete } from './autocomplete.js';
import { facebook, instagram } from './meta-social.js';
import { metaAds } from './meta-ads.js';
import { reddit } from './reddit.js';
import type { Source } from './source.js';
import { tiktok, tiktokCreative } from './tiktok.js';
import { website } from './website.js';
import { youtube } from './youtube.js';

/**
 * Open-ended research on any public site: forums, review sites, marketplaces,
 * news, communities. The planner writes the instruction; the agent browses
 * and returns findings, each with the page it came from.
 */
const agentSource: Source = {
  id: 'agent',
  label: 'Browser agent (any public website)',
  describe: 'Free-form browsing for anything the other sources do not cover: review sites (G2, Trustpilot, app stores), marketplaces, forums, comparison articles, communities. Slower and costlier; use for specific questions.',
  queryHint: '"<start URL> :: <what to find>", e.g. "https://www.trustpilot.com/review/acme.com :: complaints and praise in recent 1-3 and 5 star reviews". The start URL must be a specific site (a store, review page, forum, marketplace search); search-engine result pages (Google, Bing, DuckDuckGo…) are refused.',
  defaultLimit: 25,
  unavailable: () => '',
  async run(task, ctx) {
    const [rawUrl, ...goalParts] = task.query.split('::');
    const goal = goalParts.join('::').trim() || task.why;
    const startUrl = rawUrl.trim();
    if (!/^https?:\/\//.test(startUrl)) throw new Error('The agent needs a site to start from: "<https URL> :: <what to find>".');
    const outcome = await withPage((page) =>
      runAgent(page, {
        goal: `${goal}\nContext: researching ${ctx.brief.product} (${ctx.brief.niche}).`,
        startUrl,
        recordProperties: {
          title: { type: 'string', description: 'A short label for the finding.' },
          text: { type: 'string', description: 'The finding, quoting the page where possible.' },
          author: { type: 'string', description: 'Who wrote or published it, if shown.' },
          date: { type: 'string' },
          rating: { type: 'number', description: 'Star rating or score if shown, else 0.' },
          link: { type: 'string', description: 'The most specific link for this finding, if shown.' },
        },
        recordKey: (record) => `${String(record.link ?? '')}|${String(record.text ?? '').slice(0, 80)}`,
        meter: ctx.meter,
        maxRecords: task.limit,
        log: ctx.log,
      }),
    );
    ctx.log(`  agent ${outcome.status} after ${outcome.steps} steps: ${outcome.summary}`);
    return outcome.records.map((record) =>
      evidence({
        source: 'agent',
        kind: 'page',
        key: `${record.sourceUrl}|${String(record.text).slice(0, 120)}`,
        url: String(record.link || record.sourceUrl),
        title: String(record.title ?? ''),
        text: String(record.text ?? ''),
        author: String(record.author ?? ''),
        publishedAt: Number.isFinite(Date.parse(String(record.date))) ? new Date(String(record.date)).toISOString() : '',
        metrics: { rating: Number(record.rating) || Number.NaN },
        attributes: { foundOn: record.sourceUrl, goal },
        query: task.query,
      }),
    );
  },
};

export const SOURCES: Source[] = [autocomplete, metaAds, tiktokCreative, tiktok, instagram, facebook, youtube, reddit, googleAds, linkedinAds, pinterestTrends, website, agentSource];

export function sourceById(id: SourceId): Source | undefined {
  return SOURCES.find((source) => source.id === id);
}

export type { Source, SourceContext } from './source.js';
