# Admin form speed pilot

The pilot is limited to admin-owned runs by the dashboard, after caller overrides.
Enable Admin -> Config -> Browser -> Admin form speed pilot. Normal customer runs
retain their existing behaviour. Live application runs remain headed.

The pilot groups visible questions by a response/prompt budget (maximum 24) while
preserving model grounding, browser readback and submission validation. It detects
same-count control replacements, shadow roots and frames before continuing a batch.
No employer-specific answers or selectors are added.

Exact profile-grounded answers may be reused in process memory for 30 minutes.
The scope includes owner directory, full profile, job, supporting evidence, saved
answers, date, model endpoint, reasoning mode and observed form context. Question
options/metadata must match; refs are remapped. Validation repairs, credentials,
unsupported/composed answers and injections are excluded. Dashboard callers with
knowledge overrides bypass this worker cache. Entries are bounded and are never
saved to a shared answer file.

Resume/letter uploads read metadata from the original file-input node even when
a site replaces it. Transport is not acceptance: the agent still observes upload
errors and the submission gate still verifies the complete form.

Live testing also found incomplete popup lists and unrelated selected chips
in blocked-question handoffs. Picker choices now use their observed owner,
native lists retain all choices, and the candidate can write a known answer
when captured choices do not include it. Retries still match and verify that
fact against the current employer form; saving an answer never submits a job.

Artificial pauses between verified fills and agent turns are skipped in the pilot.
Navigation/actionability, CAPTCHA waits, job-board pacing, final grounding checks
and independent confirmation remain active. A completed background-review deadline
is cleared, avoiding an idle worker waiting for the unused deadline to expire.

Validation: npm run test:form-speed; run model-forms, plan-loop, submit-gate,
fill-verify and resume-sync with FORM_SPEED_PILOT=true. The fixture compares the
same 20-field page with/without the pilot using mocked AI; its speed ratio is not
a real-application speed estimate. Deploy also runs the new fixture and recorded
employer-page replay. Never accept changed replay baselines just to pass a test.
