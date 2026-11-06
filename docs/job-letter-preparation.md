# Semi auto preparation

Preparation reads a job listing, checks the match against the saved profile and
preferences, writes an evidence-checked cover letter and saves it for review.
The matching coordinator already opens and reads the listing. The preparation
writer uses that captured description and has no browser controller.

Preparation does not click Apply, follow employer redirects, check application
forms, sign in, register accounts, upload documents or submit applications.
Portal loading, login availability and access-check action budgets cannot block
a letter. There is no preparation access reviewer or network interceptor.

Matching, salary, listing age, excluded companies, duplicate protection, selected
resume binding, run limits and existing preparation credit accounting remain
in their existing stages. A readable description and candidate evidence are
required for a truthful letter. An employer-site match can be prepared without
waiting for every board-hosted listing to be reviewed.

The writer targets 250 words with 50% flexibility (125–375 words). Letters
above 250 and at or below 375 do not trigger shortening or a preparation
failure. Factual checks and explicit employer constraints still apply.

New drafts record `preparation.version=2`, `stage=job-and-letter`,
`access=not-checked` and the original listing URL. They bind the reviewed job,
exact letter and selected resume SHA-256, with empty answers and no uploads.
These values are included in the approval revision in a stable field order.
Version 1 access-checked drafts and older completed-form drafts keep their
existing hashes and approval semantics.

Prepared Applications explains that selecting Apply opens the application and
handles any required sign-in and form filling then. The existing applying
agent uses current candidate evidence, the approved resume and exact letter,
followed by normal accuracy and submission-receipt checks. Required missing
personal facts still go to the candidate. Preparation never authorizes a send.

Tests exercise preparation from a matched listing with a login-gated destination
and a submission-allowance callback that throws if called. They check no browser
dependency, empty answers, no-send trace, selected resume bytes, versioned
revision stability, letter edits and missing-description handling. Coordinator
fixtures continue to cover match criteria, duplicates, caps and preparation
without form filling; normal applying and historical form replay checks remain.
