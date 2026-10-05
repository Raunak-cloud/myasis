# Market Scout

A browser agent that researches a market from public data and writes an evidence-cited marketing brief. It covers SEO keywords and questions, ads that keep running, organic content that gets traction, the audience's own words, and how competitors position and price.

Every model call goes to Celeris:
- **`celeris-1`** extracts records from pages, tags ads, picks key pages and reads ad screenshots.
- **`celeris-1-magnus`** plans the research, drives the browser agent, clusters keywords, reads competitor positioning, reads seller positioning. Code builds the public findings from measurements and cited records.

## Web interface

```bash
npm run ui        # builds, then opens http://127.0.0.1:5190
```

From the page you can:
- start a run from a form;
- watch each task as it runs;
- stop a run (the evidence collected so far is kept);
- open any past report;
- write or rewrite a run's report from its saved evidence.

The page listens on 127.0.0.1 only and accepts POSTs only from its own origin. One run at a time, because every run drives the same browser profile.

## Run it

```bash
npm ci
cp .env.example .env               # add CELERIS_API_KEY
npm run dev -- sources             # what can run with this configuration

npm run dev -- research \
  --product "Australian activewear brand for women who lift" \
  --niche "women's gym activewear" --brand "LiftLab" \
  --competitors "Gymshark,Alphalete,Lorna Jane" \
  --sites "https://www.lornajane.com.au" --country AU \
  --goal "ad angles that work" --goal "SEO keywords and content ideas"

npm run dev -- collect meta-ads "Gymshark"        # one source, printed
npm run dev -- agent https://www.trustpilot.com/review/gymshark.com "complaints and praise in recent reviews"
npm run dev -- research --resume .scout/runs/<run>  # re-analyse a run
```

Run the CLI from the compiled build (`npm run dev` or `npm run build && npm run scout`), not through tsx. Code that runs inside the page breaks under tsx's `__name` helper.

Each run writes these files to `.scout/runs/<time>-<brand>/`:
- `report.html`: the shareable brief
- `report.md`
- `report.json`
- `insights.json`
- `evidence.jsonl`: every item collected, written as it arrives
- `coverage.json`

## How a run works

```
brief ─► plan (Magnus) ─► collect, round 1 ─► follow-up plan from leads ─► collect, round 2
      ─► measure (code + celeris-1) ─► write brief (Magnus) ─► fact-check (Magnus) ─► render
```

- **Planning.** The planner reads each source's declaration: what it yields, what its query means, and whether it can run. Code checks the plan it returns and adds a fixed baseline of core tasks.
- **Follow-up round.** Round two goes after the leads round one turned up: advertisers nobody named, landing domains, subreddits and creators.
- **Reading a source.** Each browser source reads data in three tiers and moves to the next only when the earlier one finds nothing:
  1. **The platform's own JSON.** This means captured network responses (GraphQL, RPC) and embedded hydration data. Records are picked by what they are, not where they sit, so renamed wrappers don't break a source. This tier costs nothing and is exact.
  2. **The rendered page text.** `celeris-1` reads the distilled page, extracting chunk by chunk, and code merges the results.
  3. **The browser agent.** It takes over for data behind search boxes and filters. It sees numbered page elements and can only act on those, so it never writes selectors or scripts. Magnus picks up to four actions per turn. Hard limits on steps, spend and repeated no-op actions stop it, and so does any wall. When it stalls it switches to deeper reasoning and gets a screenshot.
- **Measuring.** Code does the measuring; the models only label.

| What | How it's measured |
|---|---|
| Keywords | Merged across engines. Intent comes from modifier rules. "Demand" is engine agreement plus suggestion rank: a relative signal, not volume. Magnus clusters the keywords but may only use phrases it was given. |
| Ads | Score = log(days running) × (1 + log(variants)) × placement breadth × still active. Tiers: 30, 60 and 90+ days. Ads are ranked within each advertiser. `celeris-1` tags hook, angle, awareness stage, offer and proof, then the tags are counted weighted by score. |
| Organic posts | Engagement is divided by views (TikTok, YouTube, Reels) or by followers (Instagram feed). Each post gets a comparison against its creator sample when enough posts exist, otherwise its search sample; the baseline is labelled. |
| Voice of customer | Only customer-source items, not seller or creator captions. Each verbatim quote is checked to be an exact substring of its source before it is kept. |
| Competitor sites | SEO checklist measured on the page. Stack and ad-pixel fingerprints. A content inventory from the sitemap. Magnus reads positioning and pricing from the site's own pages. |

- **The brief.** Public findings use measured records and exact citations. AI interpretations stay labelled in supporting detail. Suggested actions are experiments, not predicted results. Uncited and unchecked model claims cannot enter the summary.

## Sources

| Source | Route | Notes |
|---|---|---|
| `autocomplete` | Google, YouTube, Bing and Amazon suggest endpoints | Expands each seed with questions, comparisons, buying words and a–z. |
| `meta-ads` | Public Ad Library page (GraphQL captured). The Graph API is used when `META_AD_LIBRARY_TOKEN` is set and the country is EU/UK. | Follows a matching advertiser's own page of ads. No spend data for commercial ads. |
| `google-ads` | Ads Transparency Center, through its SearchCreatives RPC | Reads first- and last-shown dates. Copy for the longest-running creatives is read from screenshots. |
| `linkedin-ads` | Public LinkedIn Ad Library | Needs a headed browser. |
| `tiktok` | Public profiles, hashtags and search (rehydration JSON and item_list) | Views, likes, comments, shares and saves. |
| `tiktok-creative` | Creative Center (anonymous view) and the EU ad library | Shows only a few items when you aren't logged in. |
| `instagram` | `business_discovery` API, or public pages logged out | Logged out, post queries are refused. Instead each post page's meta gives likes, comments, date and caption. |
| `facebook` | Public page, logged out | Usually only a few posts before a login wall. |
| `youtube` | Data API v3 with `YOUTUBE_API_KEY`, or `ytInitialData` | |
| `reddit` | Official OAuth API only | Needs `REDDIT_CLIENT_ID`/`SECRET`. The anonymous endpoints are closed. |
| `trends` | Pinterest Trends API | Needs `PINTEREST_ACCESS_TOKEN`. |
| `website` | Sitemap and key pages in the browser | Obeys robots.txt. A cheap model picks the key pages from the homepage's links. |
| `agent` | Any public site | Use `"<url> :: <what to find>"`. Good for reviews, forums and marketplaces. |

To add a source, create one file in `src/sources/` that exports a `Source`, then add it to the list in `src/sources/index.ts`. The planner, analyzers and report all read the common `Evidence` shape, so nothing else changes.

## Operating rules

- **Logged out, always.** Collection uses public pages and never signs in.
- **A block means stop.** On a login wall, CAPTCHA or challenge, the host is abandoned. The scout does not solve challenges or disguise itself.
- **robots.txt (RFC 9309)** applies to the crawler: website audits and any URL the scout discovers. Public ad-transparency libraries, and the pages a task names explicitly, are visited as a person would visit them: one tab, paced per host.
- **No Google SERP scraping.** Search pages sit behind SearchGuard. Keyword research uses autocomplete instead. Keyword difficulty therefore isn't measured, and the brief says so.
- **Reddit needs API access.** Reddit is API-only, and its free tier is non-commercial. A commercial product needs Reddit's approval.
- **Personal data.** Quotes are kept short and linked to their source. Don't republish copied creative; summarise it.

## Checks

```bash
npm test                      # deterministic logic: robots, harvest, scoring, intent, SEO rules
npx tsc --noEmit -p .
```


## Evidence checks and simple interface (v2)

The main screen asks only what you sell. Audience, country, brand, competitors,
sources, goals and budget are under More options. Reports put evidence quality,
verified findings and suggested tests first; supporting detail is expandable.

- Raw evidence stays append-only. `quality.json` records each inclusion, rejection,
  uncertain identity and geographic assessment. Only reviewed evidence feeds follow-up
  planning and analysis. Generic suggestions are not confirmed local demand.
- Business ad searches use matched advertiser pages. Unrelated health, charity,
  travel and other-category ads are set aside for clothing research. Unknown identities
  are excluded from scoring until verified. Instagram profiles need a website link.
- Partly supported, unsupported, unchecked and uncited claims cannot be published.
  The summary uses measured source records rather than generating new conclusions.
- Ad date-span labels make no profitability claims. Social comparisons identify
  their creator-sample or search-sample baseline. Only customer comments/reviews feed
  customer feedback; creator captions remain content examples.
- Retail crawls reserve product, delivery, returns and sizing coverage. Structured
  product prices retain currency, stock status, evidence and URL. A pixel is installed
  tracking, not proof of active advertising.
- No-result, blocked, failed and partial runs have distinct states. Rechecking archives
  the previous report in `previous-reports/`. Older reports show a recheck warning.
- Search volume, market size and campaign profitability remain unknown unless a
  suitable measured data source is connected. The tool does not manufacture them.

Use `SCOUT_NO_OPEN=1` when running the local UI as a background service.

## Start with only a product

The default UI needs only **What do you sell?** The market defaults to Australia
and can be changed under More options. The agent proposes a category, likely
audience and up to four competitor homepages, visits each public homepage,
and requires exact product evidence before including a competitor in planning.
The audience stays labelled as a suggestion to validate. Candidates come from
model knowledge; homepage verification does not make this an exhaustive market
search. Failed checks remain visible as coverage gaps, never invented identities.

Optional audience/category/competitor overrides are available under **Add details
I already know**. Existing draft values are ignored unless this option is enabled.
The discovered context appears during the run and in the final report.

## Production

On Owtomate, admins open **Admin > Market research** at `/market-research/`.
The dashboard checks the existing admin session on every page, API and report
request and proxies to a separate PM2 service on loopback port 5190. Cookies
are not forwarded into Market Scout. POSTs require the Owtomate origin.
The UI serves JavaScript separately to work with the site's existing CSP.

`deploy/deploy.sh` builds and tests the service after waiting for active research
and job runs. Market Scout uses the existing server Celeris configuration through
`DOTENV_CONFIG_PATH`; its browser profile and research files remain separate from
job applications. This update does not add database tables.
