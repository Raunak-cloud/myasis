# Application model routing

New customer runs use these server-managed roles:

| Work | Provider/model |
| --- | --- |
| Non-rejecting listing order | OpenRouter / qwen/qwen3.7-flash |
| Suitability, intent, constraints and fit score | OpenRouter / qwen/qwen3.7-flash |
| Application answers, letters, native browser and sign-in | Celeris / celeris-1-magnus |

Discovery remains ordinary keyword/location search. Ranking cannot reject a vacancy.
The fitter owns suitability decisions; application supervision cannot grant send authority.
Each route retains its transport, budget, canonical tool validation and receipt checks.
Ranking and fit review use Qwen with reasoning disabled. The server uses
`OPENROUTER_JOB_REVIEW_API_KEY` when configured and otherwise uses `OPENROUTER_API_KEY`.
Failures never change models.

Administrators can optionally select MiniMax M3.1 in **Apply → Run model** for their own account.
That choice routes the next run's application work to OpenRouter's `minimax/minimax-m3.1-flash`.
The worker receives the server-owned review credential and the selected applying credential.
Changing a saved preference takes effect on the next run.

The server rechecks the active account owner's admin access for manual, queued, scheduled and
confirmed starts. Customer settings and forged selections resolve to Magnus; acting as an admin
for a customer does not unlock their saved model setting. The isolated form lab also resolves its
explicit comparison selection and credential through this same owner authorization.

Review cache fingerprints identify the Qwen review route and reply contract. The completed review
history still prevents repeat reviews across runs.
Letters and queue work still identify their applying model. Existing approved content and
submission/duplicate safeguards are preserved.

Provider/security references: https://docs.celeris.ai/making-requests ,
https://openrouter.ai/docs/guides/routing/model-fallbacks , and
https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html .
