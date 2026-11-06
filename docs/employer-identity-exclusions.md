# Employer identity exclusions

Only full canonical name equality (case, spacing and trailing legal suffixes)
can exclude a listing before AI review. Substrings, acronyms, corporate groups
and spelling similarity are research proposals, never exclusion decisions.

The selected application model resolves other names before suitability review.
The discovery catalog uses the same resolver through its existing MiniMax route
and catalog spending reservations. No candidate facts are sent to the registry.
Only employer/exclusion names are queried at the fixed HTTPS ABN Lookup endpoint;
redirects, challenges, oversized responses and unavailable sources are refused.
No arbitrary model-supplied URLs are fetched.

An AI exclusion must identify the saved exclusion and cite supplied registry
records sharing an ABN, including a legal entity record. Ambiguous clearances
need legal entity evidence for both sides. Registry search rankings are fuzzy;
they are not identity proof. Up to two AI rounds may investigate canonical legal
names. Missing coverage, provider errors, invented references and inconsistent
identifiers remain unresolved. Application review records these as a technical
identity issue, without creating a candidate personal question or fit rejection;
the catalog defers the review. Neither path submits an application.

Decisions and in-flight requests are scoped to the owner, selected model,
exclusions and supplied employer evidence. Resolved decisions expire after 15
minutes; unresolved results are not cached. Registry reads are single-flight
and bounded to 48 distinct query names in each application-run resolver.
Current-run identity decisions and source references enter pipeline diagnostics.
Existing application history is not rewritten. The application fit-policy version
changes so old suitability rejections can be reconsidered under the new policy.

The guard against unsupported identifiers is a transport/evidence check, not a
claim that an AI identity judgment is infallible. Unregistered, foreign or hidden
employers and ambiguous brands may remain unresolved. This intentionally trades
some coverage for fewer unsupported exclusions or clearances. It adds model
latency and usage for nonexact employers, public lookups for ambiguous names,
and a one-time increase in reviews after cache invalidation. A small regression
set cannot establish 99.9% real-world accuracy.

Verification: `node --test seek-bot/dist/company-identity.test.js`,
`node seek-bot/dist/company-match.test.js`, targeted review-budget fixtures,
and the catalog review/extraction checks. Live public-data diagnostics must use
an isolated output directory and never start a customer application run.

Design references: [ABN Lookup](https://abr.business.gov.au/),
[OpenRefine reconciliation](https://openrefine.org/docs/technical-reference/reconciliation-api).
