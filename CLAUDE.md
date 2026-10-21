# Problem-Solving & Communication Philosophy

Think like a senior software developer. Prioritize holistic, architectural solutions over quick, band-aid, or hardcoded fixes. Always perform a web search to explore the best possible industry patterns and solutions when designing architecture or adding new features.

1. **System over Symptom:** Fix the underlying system structure to prevent entire classes of bugs, rather than patching single edge cases or adding rigid `if/else` workarounds.
2. **Smart & Scalable Design:** Choose flexible, maintainable, and declarative architecture over fragile, hyper-deterministic logic.
3. **Root Cause First:** Understand the broader data flow and system intent before writing code. Always deliver complete, production-grade solutions.
4. **Concise Communication:** Keep all explanations and answers very, very short, precise, and easily understandable.
5. **Direct & Objective Evaluation:** Never blindly agree with my decisions. Do not be overly friendly or agreeable. If my approach is right, confirm it directly. If it is wrong, state that immediately without sugarcoating and direct me to the correct path.

# Project notes

- Interface preference: keep pages professional and visually clear without adding extra information, explanatory text or controls unless explicitly requested.
- **Typecheck the dashboard with `npm run build`, never `tsc --noEmit -p .`** — the root tsconfig has `"files": []`, so that command checks nothing and passes silently.
- The dashboard runs `seek-bot/dist`, so build seek-bot after changing it.
- Deployment default: the user has requested that changes to this project always be deployed after verification. Commit the requested changes, push to `main`, then run `bash /home/myasis/myasis/deploy/deploy.sh` as root on the VPS without waiting for a separate deployment request.
  Use the deployment script so active runs finish before builds and restarts. Verify the live site after deployment.
- Employer-site login and account creation are automated with per-site credentials; government jobs are reviewed and applied for under the same candidate-fit rules as other jobs.
- x11vnc binds `127.0.0.1` only, behind the authenticated dashboard WebSocket. Never publish a VNC port.
- Never route the bot's outbound traffic through Cloudflare WARP.
- `market-scout/` is a standalone marketing-research browser agent (Celeris only). Run it from the compiled build (`npm run dev -- …`), never tsx (page-evaluate code breaks under `__name`). It is logged-out only: a block, wall or CAPTCHA stops that host and is never worked around. Reddit is official-API only. No Google SERP scraping. Checks: `npm test` and `npx tsc --noEmit -p .` in that folder.
- Weekly blog (`dashboard/server/blog`): posts live in Postgres and are rendered per request into `blog.html`, so publishing or hiding needs no deploy. Sources are declared in `sources.ts`; never use Google News RSS or Gemini Search grounding (their terms forbid republishing). Checks: `npx tsx server/blog/blog.test.ts`.
