# Application models

Admins can choose **Celeris Magnus** or **MiniMax M3.1** on Apply. The choice is saved immediately and applies to the next run. Ordinary accounts always use Celeris, including when an old saved preference or a client override requests another provider. Job matching, fit caches and background drafting remain on Celeris.

MiniMax uses the fixed OpenRouter model `minimax/minimax-m3.1-flash`. Configure `OPENROUTER_API_KEY` in Admin → Config → Models. The server rechecks the active account's admin status and selects credentials before spawning a worker. API keys never go into account settings or the dashboard bundle. An unavailable selected provider fails explicitly; it does not silently fall back to a different model.

Both providers run the same application loop, receive the same offered browser tools and screenshots, and use the same recovery and candidate-confirmation rules. Read-only specialist consultations use the selected application provider and share the parent's spending meter. OpenRouter reasoning blocks are retained unchanged across tool turns. Provider retries only regenerate replies; they cannot replay browser actions.

Authentication tools declare their input-selection alternatives in the shared schema: credential filling requires `targets` or `refs`; code entry requires `targets`, `ref` or `refs`. Empty selections are rejected before browser or mailbox work. Rejected arguments are failed tool calls in the admin diagnostics and recovery flow, and cannot count as successful browser mutations. The agent still chooses every input and repair.

OpenRouter's `usage.cost` is the billing source when present. Otherwise the meter uses published non-discounted token rates; absent usage reserves estimated input and the requested output allowance and records the final charge as unknown. Every generation, including an incomplete reply, counts toward the same per-application budget. These amounts are USD; Celeris and OpenRouter have separate account balances.

For a fair synthetic comparison, keep the form seed, fictional candidate, tools, screenshots, base/progress budgets and time allowance identical. Give each attempt a unique email challenge namespace to prevent old verification emails or delivery idempotency keys from contaminating a retry. Report independent employer receipts, elapsed time, all model charges, tool errors and successful recoveries. A single paired trial is a smoke comparison, not a general reliability benchmark.
