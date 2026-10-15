# Application model selection

Administrators can choose **Celeris** or **Claude Haiku 5.5** on the Apply dashboard. The selection is saved per account and captured for the next run. It covers screening, ranking, CV choice, letter drafting and editing, answers, browser control, sign-in, recovery, actual-form verification, duplicate decisions, receipt verification and post-run search-term renewal. A provider failure never changes the selected model.

The server rechecks the account's administrator status and emits `APPLICATION_AI_MODEL`, `APPLICATION_AI_ADMIN_ENABLED` and `APPLICATION_AI_OWNER_ID` after caller overrides. Haiku additionally checks that `DATA_DIR` is that owner's directory. Non-administrator runs use Celeris and retain their existing rewriting service. Shared dashboard helpers use an asynchronous request scope rather than changing `process.env`.

Haiku requires a server-side `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`, configurable in Admin settings. Keys are never sent to the dashboard's browser. A missing key stops a Haiku run with a setup message. Direct Anthropic is preferred when both are configured; credentials and model do not change during the run.

## Haiku protocol

`agent/haiku.ts` uses native Messages: direct `claude-haiku-5-5`, or `anthropic/claude-haiku-5.5` through OpenRouter's `/api/v1/messages`. It uses native `tool_use`/`tool_result` blocks and native structured output. Effort follows the reasoning tier each call already asks for: calls Celeris answers without reasoning (fit, rules, ranking, yes/no checks) run at low effort with thinking off; reasoning calls run at medium with adaptive thinking, high when they ask for deeper reasoning; the browser conversation stays at one medium level so its cache holds. Tool conversations use automatic caching. A one-off prompt caches only its trusted prefix (the text before the first `<untrusted` data block), and only once that prefix has repeated, so unique prompts never pay for cache writes. Tools with closed schemas are sent with `strict: true`; if the provider refuses a strict schema, the run continues without it. It omits Magnus chat templates and unsupported sampling parameters. Original JSON schemas are validated with Ajv, including constraints moved to descriptions for provider compatibility.

Haiku has its own controller instructions. Earlier native thinking blocks and tool results remain unchanged; context rollover starts a fresh conversation from verified executor state, including any possible submission. Shared browser execution retains candidate grounding, actual-form checks, duplicate protection and explicit receipt checks. Custom browser tools are used; this does not implement Anthropic's separately hosted native browser toolset.

Cost records use actual provider charges when available. Direct native usage is explicitly estimated at published rates. Delayed OpenRouter billing remains partial; a usage-based estimate enforces the application budget without pretending it is an invoice.

Archived comparison harnesses and test results are not selectable dashboard models.

References: [Haiku migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [OpenRouter native Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true).
