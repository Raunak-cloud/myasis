# Application model routing

New customer runs use these server-managed roles:

| Work | Provider/model |
| --- | --- |
| Non-rejecting listing order | Celeris / celeris-1 |
| Suitability, intent, constraints and fit score | Celeris / celeris-1-magnus |
| Application answers, letters, native browser and sign-in | Celeris / celeris-1-magnus |
| Application specialist and supervision | Celeris / celeris-1-magnus |

Discovery remains ordinary keyword/location search. Ranking cannot reject a vacancy.
The fitter owns suitability decisions; application supervision cannot grant send authority.
Each route retains its transport, budget, canonical tool validation and receipt checks.
Failures never change models. Customer runs need only the server's Celeris credential.

Administrators can optionally select MiniMax M3.1 in **Apply → Run model** for their own account.
That choice covers the whole next run: listing order, fit review, writing, applying and supervision
all use OpenRouter's `minimax/minimax-m3.1-flash`. Only the selected provider credential enters the
run context; missing credentials fail before work starts. There is no Celeris fallback or usage in
a MiniMax run. Changing a saved preference does not switch a worker that is already running.

The server rechecks the active account owner's admin access for manual, queued, scheduled and
confirmed starts. Customer settings and forged selections resolve to Magnus; acting as an admin
for a customer does not unlock their saved model setting. The isolated form lab also resolves its
explicit comparison selection and credential through this same owner authorization.

Review cache fingerprints identify the actual review provider/model, so Magnus and MiniMax
assessments and fit handoffs cannot be mixed. Returning to a provider reuses only its own cache.
Letters and queue work still identify their applying model. Existing approved content and
submission/duplicate safeguards are preserved.

Validation: worker/dashboard builds; stage routing, account credentials/concurrency, fit provenance,
cache isolation, MiniMax transport, specialist permissions, extension answer isolation, and five
native browser prepare/approve/submit fixtures plus an in-place answer repair.

Provider/security references: https://docs.celeris.ai/making-requests ,
https://openrouter.ai/docs/guides/routing/model-fallbacks , and
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html .
