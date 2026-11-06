# Verification email extraction

Authentication tools retain their private mailbox, purpose, requested-at freshness, browser account and application approval boundaries. The deterministic parser runs first. Only fresh, matching, unparsed mail may reach an optional per-application AI extractor.

The extractor builds a local map of possible codes and permitted links. It sends bounded authentication excerpts with code/URL/address values masked, candidate IDs, link labels and the requested purpose to the application's selected model. It does not send raw HTML, attachments, a mailbox thread, account credentials or private link destinations. Identity is checked locally, never delegated to the model. Treat the remaining email text as untrusted data.

The model returns a candidate ID and purpose, or `none`. Unknown IDs, malformed replies, extra fields and purpose changes are rejected. Codes resolve only to source tokens; links also require HTTPS, a trusted employer/provider destination, the observed ATS tenant and the existing purpose vetoes. No AI link can override a password-reset mismatch, choose another tenant, or authorize submission. SAP's `sapsf` hosting alias retains its company tenant just like `successfactors`.

Each application attempt has its own in-memory cache, original spending meter and at most three fallback generations. A repaired continuation retains the application's spending meter but begins a new extraction cache. Each mailbox lookup considers at most two distinct messages for fallback. Inference has a 25-second ceiling within the existing mailbox deadline, a 2,048-token response bound and no browser tools. A provider failure, ambiguity, missing candidate, exhausted budget or cancelled/expired window yields no credential. Recheck message freshness after inference. Repeated mailbox passes reuse a validated result; changed email/request evidence has a different cache key.

Only abstract started/completed/accepted diagnostics are recorded. Codes, links, mail text and model packets are not persisted by the extractor. Existing authentication tools still enter the private code or open the permitted link and require inspection of the employer response; extraction alone does not establish successful sign-in or submission.

Residual risks: a model can misclassify a source number or same-purpose link; it may abstain or time out. Added fallback inference costs and delays are charged to the selected application provider. Masking and bounded excerpts minimize disclosure, but surrounding authentication text still reaches that provider. Existing recognised formats take the unchanged local path.

Checks: `node --test dist/verification-email-ai.test.js dist/gmail-ai-fallback.test.js dist/verification-email-local.test.js dist/gmail-verification.test.js` after `npm run build` in `seek-bot`.

Design references: [structured extraction and validation](https://developers.openai.com/api/docs/guides/structured-outputs), [OpenRouter structured-output enforcement varies by provider](https://github.com/OpenRouterTeam/docs/blob/main/guides/features/structured-outputs.mdx). A schema does not prove semantic correctness; local verification remains mandatory.
