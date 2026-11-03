# Application model routing

New customer runs use these server-managed roles:

| Work | Provider/model |
| --- | --- |
| Non-rejecting listing order | Celeris / celeris-1 |
| Suitability, intent, constraints and fit score | Celeris / celeris-1-magnus |
| Application answers, letters, native browser and sign-in | OpenRouter / minimax/minimax-m3.1-flash |
| Application specialist and supervision | OpenRouter / minimax/minimax-m3.1-flash |

Discovery remains ordinary keyword/location search. Ranking cannot reject a vacancy.
The fitter owns suitability decisions; application supervision cannot grant send authority.
Each route retains its transport, budget, canonical tool validation and receipt checks.
Failures never change models. Both server credentials are required before customer starts.

The dashboard pins the applying model for manual, queued, scheduled, approved and admin-triggered runs.
Old saved provider values are normalized at read/execution time without writing user preferences.
The old whole-run model selector is removed. Explicit Celeris application comparisons remain available
in the isolated admin form lab with fictional documents and reserved-domain forms.

Review cache fingerprints identify Magnus independently of the applying model. The assessment
version changed so previous selected-provider reviews are not reused as new Magnus reviews.
Letters and queue work still identify their applying model. Existing approved content and
submission/duplicate safeguards are preserved.

Validation: worker/dashboard builds; stage routing, account credentials/concurrency, fit provenance,
cache isolation, MiniMax transport, specialist permissions, extension answer isolation, and five
native browser prepare/approve/submit fixtures plus an in-place answer repair.

Provider references: https://docs.celeris.ai/making-requests and
https://openrouter.ai/docs/guides/routing/model-fallbacks .
