# Semi auto preparation

New Semi auto runs keep matching, listing age, company exclusions, salary,
duplicate checks and candidate instructions in the existing review pipeline.
For each matched job they open Apply before optional header Sign in and check
whether the application can be accessed. Existing accepted employer credentials
or an available email sign-in can be used. Missing login, new registration,
password resets, blocked or ambiguous access are skipped for that run.
An already matched employer-site job can enter preparation immediately, without
waiting for every board-hosted listing to be reviewed. Auto apply retains its
existing preference for completing board-hosted applications first.
Unique Apply navigation controls on later employer pages are also followed
natively. Model-selected controls use refs from the latest observation;
invalid refs get a fresh observation and bounded feedback, rather than an
immediate job skip. Existing step and model-cost limits still apply.
Named candidate fields together with a resume/CV upload control also prove
application access when long listing text or dropdown options truncate the
page summary. This detection does not fill or advance the form.

The preparation stage has no application-field fill, file upload, arbitrary
script, final-submit or application-answer tools. It installs no network request
interceptor or GraphQL allowlist. Normal page requests, including SEEK's
`createLinkoutApplication` employer-portal handoff and sign-in requests, run
normally. Observed navigation destinations retain public-address and
payment-page checks, and native action checks restrict sign-in to authentication
fields and reject Apply buttons that submit forms. Portal navigation is not
proof of an employer submission.
Links and explicit non-submit buttons remain navigation even when a site wraps
its layout in a form; actual form-submit controls remain excluded.

After access is verified, the existing evidence-checked cover-letter writer
uses the account's saved profile, documents and instructions. The draft binds
the selected account resume and its SHA-256, the job, letter and access result.
It records `preparation.stage=job-and-letter`, an empty answers list and no
uploads. This metadata is included in the immutable approval revision.
Its hash uses a fixed field order so PostgreSQL JSONB round trips preserve
the worker's existing revision without changing the saved draft or consent.
Skipped access never creates a Prepared row or spends a preparation credit.
Existing per-prepared-job credit accounting is unchanged.

Prepared Applications explains that the form is not filled yet. Selecting Apply
authorizes the existing applying agent to fill the form using current candidate
evidence, the approved resume and exact letter, then run the normal final
accuracy and receipt checks. Missing required personal facts still require the
candidate. Previously prepared complete forms remain supported. Changing an
old saved form's employer tenant or vacancy cannot reuse its approval.

Tests use native browser fixtures for Apply-before-Sign-in, untouched fields and
file inputs, normal POST/GraphQL handoffs without request interception, popup
navigation, unknown credentials, accepted owner-scoped login and rejected
final-send decisions/form buttons. Draft tests check empty answers, selected resume bytes, stage-bound
revision hashes, letter edits and skipped-access behavior. Existing approved
form/session and user-status checks remain covered.
