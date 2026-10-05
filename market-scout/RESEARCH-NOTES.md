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
