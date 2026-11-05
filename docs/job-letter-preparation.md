# Semi auto preparation

New Semi auto runs keep matching, listing age, company exclusions, salary,
duplicate checks and candidate instructions in the existing review pipeline.
For each matched job they open Apply before optional header Sign in and check
whether the application can be accessed. Existing accepted employer credentials
or an available email sign-in can be used. Missing login, new registration,
password resets, blocked or ambiguous access are skipped for that run.

The preparation stage has no application-field fill, file upload, arbitrary
script, final-submit or application-answer tools. Its browser transport rejects
application submissions and non-authentication writes, allowing read-only
GraphQL queries. Private sign-in writes use only the observed login page.
External navigation retains public-address and payment-page checks.

After access is verified, the existing evidence-checked cover-letter writer
uses the account's saved profile, documents and instructions. The draft binds
the selected account resume and its SHA-256, the job, letter and access result.
It records `preparation.stage=job-and-letter`, an empty answers list and no
uploads. This metadata is included in the immutable approval revision.
Skipped access never creates a Prepared row or spends a preparation credit.
Existing per-prepared-job credit accounting is unchanged.

Prepared Applications explains that the form is not filled yet. Selecting Apply
authorizes the existing applying agent to fill the form using current candidate
evidence, the approved resume and exact letter, then run the normal final
accuracy and receipt checks. Missing required personal facts still require the
candidate. Previously prepared complete forms remain supported. Changing an
old saved form's employer tenant or vacancy cannot reuse its approval.

Tests use native browser fixtures for Apply-before-Sign-in, untouched fields and
file inputs, unknown credentials, accepted owner-scoped login and submission
blocking. Draft tests check empty answers, selected resume bytes, stage-bound
revision hashes, letter edits and skipped-access behavior. Existing approved
form/session and user-status checks remain covered.
