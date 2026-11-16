# Dropdown recovery rules

1. After typing into an autocomplete field, wait up to three seconds for its own dropdown to return suggestions, an explicit no-results message, or an error. Report loading and an empty response separately.
2. Read only the menu linked to that field, including menus inside an iframe or open shadow root. Never use another field's suggestions.
3. Automatically click only one enabled option whose complete label exactly matches the requested answer, ignoring case and extra whitespace. Never guess the first result or use a fuzzy match.
4. If wording differs or several options match, return the visible labels to the AI. It must inspect fresh controls and choose a match supported by the candidate's evidence.
5. After clicking, check the saved value or committed selection, whether the dropdown closed, and whether the field remains invalid. A click or typed text alone does not prove selection.
6. If the result is empty, still loading, an error, or has no matching option, stop the remaining action batch and report the field's actual state. Do not record the search text as a completed answer.
7. Try a truthful full name or alternate spelling from candidate evidence. Keep free text only if the form accepts it. Use Other only if the employer offers it and it is truthful. Never select an unrelated institution or invent an answer.
8. Keep normal tools available, including retries. Do not lock an action or search. Give the AI fresh evidence and ask it to change approach when earlier attempts fail.
9. If clicking times out, report selection as unconfirmed. Inspect fresh evidence before another action; do not assume that nothing happened or automatically replay the click.
10. If a genuinely different approach still cannot resolve a required selection, report the specific unresolved field before the spending budget runs out. Ask the candidate only when a required personal fact is missing.

11. After two consecutive invalid tool calls or execution errors, or three decisions with no visible page/field progress, take a fresh screenshot and send it with the six most recent action results. Ask the AI to compare the image with current controls, diagnose the failure, and choose a different supported approach. Newly retrieved candidate evidence counts as progress.
12. After the fresh screenshot, allow normal actions. If another two consecutive errors or three unchanged decisions occur without progress, stop with the actual observed cause instead of continuing until the spending limit. If screenshot capture itself fails twice, report that honestly. Preserve uncertain-send handling and never retry a possible submission blindly.

These rules describe the browser behavior and recovery guidance implemented in the applying agent. This file is documentation; the executable checks and agent instructions enforce the behavior.
