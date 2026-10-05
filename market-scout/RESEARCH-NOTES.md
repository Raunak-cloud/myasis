# Marketing agent improvements — researched 5 October 2026

Reviewed first-party documentation, rather than treating vendor advertising as independent proof of performance.

| Tool | Useful pattern | Implemented in Market Scout |
| --- | --- | --- |
| [Semrush search volume](https://www.semrush.com/kb/683-what-is-search-volume-in-semrush) | Country/database and averaging period matter; modeled volume is distinct from observed suggestions. | Explicit data availability; no fabricated search volume, difficulty or traffic. Suggestions link to collection records. |
| [Ahrefs volume accuracy](https://help.ahrefs.com/en/articles/72571-how-accurate-is-keyword-search-volume-in-ahrefs) | Search volume is an estimate, including in paid tools. | Observed facts and proposed tests are separated. No arbitrary confidence percentages or invented ICE scores. |
| [BabyLoveGrowth technical audit](https://www.babylovegrowth.ai/docs/dashboard/technical-audit), [content plan](https://www.babylovegrowth.ai/docs/dashboard/content-plan) | Page-specific review priorities and a clear content schedule help users act. | Source-linked page checks and a four-week test plan. Optional own website distinguishes fixes from competitor comparisons. |
| [Zeely campaign analysis](https://help.zeely.ai/en/articles/12459572-how-should-i-analyze-my-campaign-metrics-in-zeely) | Evaluate campaign outcomes over a selected reporting period using actual campaign metrics. | Test instructions specify qualified clicks, enquiries, orders and acquisition cost from the user's own analytics; public ads never imply sales, spend or ROAS. |
| [Google title guidance](https://developers.google.com/search/docs/appearance/title-link) | Title display depends on device width; a fixed character cutoff is not a Google rule. | Removed fixed truncation claims, automatic multiple-H1 penalties and minimum-word-count claims. Audit checks describe measurements and conditional actions. |

## Evidence safeguards

- A refreshed observation replaces its previous metrics and attributes. The append-only log retains history, but missing current counts never inherit stale values.
- Invalid citation protocols, credentials in links, invalid/future source dates, non-finite values and impossible negative counts are set aside before analysis. Negative Reddit scores remain valid.
- Prices require numeric non-negative structured offers, well-formed currency labels and same-site HTTP(S) listing links. Aggregate low prices remain labelled as the lowest listed price. Unknown currency and stock stay unknown.
- Public report details are rebuilt from reviewed records. AI-written positioning, invented keyword phrases, fabricated retail offers and unverified quotation text cannot substitute for source facts.
- Reports show source collection timestamps separately from report-generation time. Rewriting a saved report does not recollect or refresh data. Platform counts may be rounded.
- SEO priorities are suggested review order, not a health score, ranking forecast or guaranteed traffic impact. Empty alt text can be intentional for decorative images; noindex can be intentional.

## Limits and useful next additions

This is a bounded public-source research tool, not an exhaustive market census. Relevance and identity rules still need manual review in ambiguous cases. Public sellers' claims are not independent verification; source data can change or be inaccurate.

No Search Console, GA4, ad-account or licensed keyword-provider connection was added in this release. Those would enable actual business performance and country-specific estimated keyword metrics, with provider, date range, geography and attribution displayed. Implement these only through explicit authorized integrations; never fill missing fields with synthetic numbers.

Existing reports and downloads are revalidated when opened. **Recheck saved evidence** also writes updated report files and archives the originals before rewriting. Public comments are potential customer evidence; buyer identity is not independently verified.


## Live robustness audit, 5 October 2026

The default browser run `2026-10-05T11-51-33-research` completed but exposed incorrect completion labelling, an unverified ad-domain task, CAPTCHA failures represented as empty success, occasion videos without a clothing match, unverified model summaries, and slow autocomplete expansion. These are failure findings, not a market opportunity.

Implemented: optional live-search result URLs as website leads (followed by fresh homepage evidence checks), explicit search-provider failures, validation of malformed planner output and advertiser domains, neutral task reasons, per-host blocked follow-up exclusions, bounded autocomplete requests and total record limits, incremental coverage persistence, partial-report status, literal quote verification for browser-agent findings, clothing relevance checks for videos, snapshot-based social velocity and consistent comparison denominators, safe run IDs, collision-resistant run folders, and child-process startup/close handling. Removed unused AI clustering/tagging calls and automatic budget extension. Model cost remains an estimate; already in-flight requests can exceed the remaining estimate, and provider invoices/free quotas may differ.

The existing Google key successfully lists available models, but Gemini 2.5 Flash generation is unavailable to new users and Gemini 3.8 Flash returns HTTP 429 for quota/billing. Gemini generation is not claimed as operational on this account. Google quota must be restored for Gemini generation. The search-discovery adapter uses Brave Search API when BRAVE_SEARCH_API_KEY is configured, otherwise reports its absence and verifies model/history leads. It has not been live-validated against Brave on this account. Account credentials were not copied or printed.

Reference: [Brave Search API](https://api-dashboard.search.brave.com/documentation/quickstart). The optional collector makes one bounded search request and estimates $0.01 for a successful search. A search result alone does not prove product relevance or target-market service. Google Search grounding was evaluated but excluded: its current service terms prohibit using returned links as automated crawling leads.


### Production validation

All 52 automated checks and the TypeScript build passed on Windows and the production Linux host. The default 14-task/four-follow-up browser run produced 676 records; revalidation retained 492 and set aside 184 (80 irrelevant and 104 requiring verification). That is evidence filtering, not an independently measured accuracy percentage. The original report is now labelled limited.

The upgraded, bounded browser run `2026-10-05T12-22-49-nepali-clothing-e34c1078` used two independently supplied retailer URLs, autocomplete and website auditing: 77 records collected, 69 retained, 8 excluded. Autocomplete completed in 20.1 seconds; the two site tasks completed in 78.4 and 95.4 seconds. These timings come from different bounded queries, not a controlled speed benchmark.

Independent browser checks matched the collected variant-specific offers: House of Nepal Daura Suruwal Nepalese National Dress, Size 8/Blue, AUD 89; Boutique Nepal Nepali Daura Suruwal for Men, 42/RockBlue/With Topi, AUD 89; Boutique Nepal Red Nepali Velvet Dhaka Topi, 22.5 inches, AUD 15 and available to add to cart; its 23-inch variant was AUD 15 and sold out. Availability means the site displayed that state, not that an order or warehouse inventory was independently verified. The outfits include different accessories; pricing comparisons must preserve variants and bundle contents. No checkout or purchase was performed.

This small targeted sample supports those listing observations, not overall market accuracy or sales predictions. Customer quotations, country-specific search volume and business performance were not measured.

The final product-only browser run `2026-10-05T12-27-06-research-63a1c5d1` reused the two retailer leads from the independently seeded audit and freshly checked their homepage quotations before collection. It collected 102 records, retained 85 and excluded 17. This validates history-assisted setup, not unconfigured live search. Both retailers had direct target-market evidence on their pages. The report reader rechecks these quotations and normalizes suggested category punctuation.

### Browser-only discovery - 6 October 2026

The user requested browser-only competitor discovery. This replaces the optional Brave adapter above: no search-provider key or search API call is used. The collector opens bounded Google and Bing searches in Scout's own browser, records rendered organic links and visible citations, and verifies candidate homepages. AI-generated identities and previous-run website leads are removed from automatic discovery. Manual website inputs remain available. Search attempts, actual result text, timestamps, empty results and blocks are saved in search-discovery.json; reports show a browser-search log. Captchas and refusals stop that engine.

Live testing on the VPS found seven website leads for traditional Nepalese clothing in Australia, including House of Nepal, Boutique Nepal, Aarohi and Trendy Collections. Google's opaque /goto links required reading the displayed website citation. Unrelated Bing results were filtered before homepage verification. These are search leads, not a market-coverage or accuracy percentage.
