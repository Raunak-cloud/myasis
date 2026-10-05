import { evidence } from '../core/store.js';
import { httpJson } from '../core/politeness.js';
import type { Evidence } from '../core/types.js';
import type { Source } from './source.js';

/**
 * What people actually type, from public search-box suggestions — the method
 * behind AnswerThePublic. Each seed is expanded with question, comparison and
 * buying modifiers (and, for larger budgets, a–z), across four engines. A
 * suggestion's position is the engine's own popularity order, and a phrase
 * suggested by several engines is a stronger signal than one.
 *
 * No SERP scraping: Google's results pages sit behind SearchGuard, and
 * getting around that is what the 2026 SerpApi suits are about.
 */

type Engine = 'google' | 'youtube' | 'bing' | 'amazon';

export const QUESTION_PREFIXES = ['how', 'what', 'why', 'which', 'where', 'when', 'who', 'can', 'is', 'are', 'does', 'should'];
export const SUFFIXES = ['for', 'vs', 'versus', 'alternative', 'best', 'near me', 'price', 'cost', 'review', 'reviews', 'cheap', 'free', 'without', 'with', 'like', 'or', 'and', 'to', 'not working', 'ideas', 'tips', 'examples', 'reddit'];
const PREFIXES = ['best', 'top', 'cheap', 'buy', ...QUESTION_PREFIXES];

/** Amazon marketplace ids by country; others fall back to the US store. */
const AMAZON: Record<string, { host: string; mid: string }> = {
  US: { host: 'completion.amazon.com', mid: 'ATVPDKIKX0DER' },
  AU: { host: 'completion.amazon.com.au', mid: 'A39IBJ37TRP1C6' },
  GB: { host: 'completion.amazon.co.uk', mid: 'A1F83G8C2ARO7P' },
  UK: { host: 'completion.amazon.co.uk', mid: 'A1F83G8C2ARO7P' },
  CA: { host: 'completion.amazon.ca', mid: 'A2EUQ1WTGCTBG2' },
  DE: { host: 'completion.amazon.de', mid: 'A1PA6795UKMFR9' },
  IN: { host: 'completion.amazon.in', mid: 'A21TJRUUN4KGV' },
};

export function expansions(seed: string, wide: boolean): string[] {
  const s = seed.trim().toLowerCase();
  const variants = new Set<string>([s]);
  for (const prefix of PREFIXES) variants.add(`${prefix} ${s}`);
  for (const suffix of SUFFIXES) variants.add(`${s} ${suffix}`);
  if (wide) for (const letter of 'abcdefghijklmnopqrstuvwxyz') variants.add(`${s} ${letter}`);
  return [...variants];
}

async function suggest(engine: Engine, query: string, country: string, language: string): Promise<string[]> {
  const q = encodeURIComponent(query);
  const hl = language.toLowerCase();
  const gl = country.toUpperCase();
  // About one request a second per engine: cheap for them, and well inside what a person typing produces.
  const minGapMs = 1_100;
  switch (engine) {
    case 'google':
    case 'youtube': {
      const ds = engine === 'youtube' ? '&ds=yt' : '';
      const body = await httpJson<[string, string[]]>(`https://suggestqueries.google.com/complete/search?client=firefox${ds}&hl=${hl}&gl=${gl}&ie=utf-8&oe=utf-8&q=${q}`, { minGapMs, api: true });
      return Array.isArray(body?.[1]) ? body[1] : [];
    }
    case 'bing': {
      const body = await httpJson<[string, string[]]>(`https://api.bing.com/osjson.aspx?market=${hl}-${gl}&query=${q}`, { minGapMs, api: true });
      return Array.isArray(body?.[1]) ? body[1] : [];
    }
    case 'amazon': {
      const store = AMAZON[gl] ?? AMAZON.US;
      const body = await httpJson<{ suggestions?: Array<{ value?: string }> }>(`https://${store.host}/api/2017/suggestions?mid=${store.mid}&alias=aps&prefix=${q}`, { minGapMs, api: true });
      return (body.suggestions ?? []).map((s) => s.value ?? '').filter(Boolean);
    }
  }
}

export const autocomplete: Source = {
  id: 'autocomplete',
  label: 'Search autocomplete (Google, YouTube, Bing, Amazon)',
  describe: 'Autocomplete suggestions in the order returned by each engine. Useful topic ideas; suggestion order does not measure popularity, search volume or local buyer demand.',
  queryHint: 'A short seed phrase of 1-3 words (e.g. "protein powder", "crm for startups"). Add "|amazon" to include Amazon for physical products.',
  defaultLimit: 200,
  unavailable: () => '',
  async run(task, ctx) {
    const [seed, flag] = task.query.split('|').map((part) => part.trim());
    const engines: Engine[] = ['google', 'youtube', 'bing', ...(flag === 'amazon' ? (['amazon'] as const) : [])];
    // Bounded work even when a seed produces very few suggestions.
    const queries = expansions(seed, false).slice(0, 8);
    const found = new Map<string, Evidence>();
    // Engines are different hosts, so they run side by side; each paces itself.
    await Promise.all(
      engines.map(async (engine, engineIndex) => {
        let mine = 0;
        const share = Math.floor(task.limit / engines.length) + (engineIndex < task.limit % engines.length ? 1 : 0);
        for (const query of queries) {
          // Each engine stops on its own once it has given its share.
          if (mine >= share || Date.now() >= (ctx.deadline ?? Infinity)) return;
          let suggestions: string[];
          try {
            suggestions = await suggest(engine, query, ctx.brief.country, ctx.brief.language);
          } catch (error) {
            ctx.collectionNotes?.push(`${engine} autocomplete unavailable: ${(error as Error).message.slice(0, 120)}`);
            ctx.log(`  ${engine} autocomplete stopped: ${(error as Error).message}`);
            return;
          }
          suggestions.forEach((phrase, index) => {
            if (mine >= share || typeof phrase !== 'string') return;
            const text = phrase.trim().toLowerCase();
            const id = `${engine}:${text}`;
            if (!text || found.has(id)) return;
            mine += 1;
            const isQuestion = new RegExp(`^(${QUESTION_PREFIXES.join('|')})\\b`).test(text) || text.endsWith('?');
            found.set(
              id,
              evidence({
                source: 'autocomplete',
                kind: isQuestion ? 'question' : 'keyword',
                key: id,
                url: engineUrl(engine, text),
                title: text,
                text,
                metrics: { rank: index + 1, words: text.split(/\s+/).length },
                attributes: { engine, seed, expansion: query },
                query: task.query,
              }),
            );
          });
        }
      }),
    );
    return [...found.values()].slice(0, task.limit);
  },
};

function engineUrl(engine: Engine, text: string): string {
  const q = encodeURIComponent(text);
  return {
    google: `https://www.google.com/search?q=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    bing: `https://www.bing.com/search?q=${q}`,
    amazon: `https://www.amazon.com/s?k=${q}`,
  }[engine];
}
