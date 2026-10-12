# Employer feed pilot

Admin accounts can select SmartRecruiters, Lever, Greenhouse, PageUp and Workday in run settings. Selection and employer watchlists are per account. Customer requests cannot enable a pilot source, including through saved settings, schedules or client-supplied environment flags.

## Discovery and applications

Lever uses the documented public Postings GET API. Greenhouse uses the documented public Job Board GET API. Both providers require employer credentials for API application submission; this app uses their hosted application pages instead.

PageUp reads the public `careers.pageuppeople.com` search and job pages. Workday reads the search/detail operations used by the employer's public `myworkdayjobs.com` career site. These are career-site readers, not a promise of a general public Workday integration API. Changes to those sites may require adapter updates. Custom employer domains are not supported in this pilot.

Every source enters the existing AI ranking, candidate-fit, resume selection, account-scoped saved answers, role deduplication, application caps, browser navigation guard, answer-grounding and submission-confirmation flow. There are no employer-specific answer or fit overrides. Read-only tests do not open application forms.

## Watchlists

- `LEVER_COMPANIES`: identifiers from `jobs.lever.co`, such as `objective,palantir,kasada`.
- `GREENHOUSE_BOARDS`: board identifiers, such as `theiconic,firmus,futuresecureai`.
- `PAGEUP_SITES`: comma-separated `Employer name|https://careers.pageuppeople.com/841/cw/en` entries.
- `WORKDAY_SITES`: comma-separated `Employer name|https://nine.wd105.myworkdayjobs.com/en-US/Nine_External_Career_Site` entries.

Up to 20 employers per source. URLs must be HTTPS on the provider's supported host pattern, without credentials, custom ports or query parameters. Job identities are stable per source and employer. A description is reloaded and the identity rechecked before applying. Workday detail must identify Australia. A closed job or changed identity is refused.

Lever/Greenhouse do not offer full-text job-board search. Their actual postings are fetched once per employer/run as a bounded snapshot (up to 2,000 per employer), and the whole snapshot enters AI ranking on the first search round. Later synthetic pages are empty: adaptive discovery must not stop before later postings are considered. No keyword/synonym rejection is added. The existing review, application and AI-spend limits still apply; larger boards require more ranking work. The fit model establishes whether a posting is an actual current vacancy before assessing eligibility; event registration and general resume collection do not count as job applications. Lever filters a supplied country code to Australia. Greenhouse may only supply free-text location; the usual candidate location checks and AI fit review still apply. Native keyword search is used for PageUp/Workday. Workday country facet parameters and option IDs are discovered from each employer response and reused to page Australian results, so global postings cannot displace them beyond the review limit. Sites without a country facet retain their existing search, and every detail is still checked for Australia. A failed employer is reported without hiding working ones; total source failure is an error, not an empty successful search.

Publication dates are used only when actually supplied. Greenhouse `updated_at` is not a publication date. Lever's public contract does not promise a posting date, so its age remains unknown; the age filter cannot guarantee recency for those listings. Existing unknown-date handling applies.

Network requests have a timeout, byte limit, pacing and no automatic redirect following or retry of a blocked/throttled source. Workday POST is only its read-only career search; no API application POST is implemented. Test mode uses one page per search term and at most 10 fit reviews across selected employer sources. AI costs and application counts continue to use the account's existing limits.

## Validation

`npm run build` in both packages; bot `node --test dist/employer-feeds.test.js dist/smartrecruiters.test.js dist/agent/apply-employer-job.test.js`; dashboard `tsx --test server/job-sources.test.ts test/activity.test.mjs` and `tsx scripts/test-smartrecruiters-ui.mts`. Fixtures make no employer submissions. The deployment script repeats these checks plus its existing regression and form-replay checks.

Primary provider contracts: https://github.com/lever/postings-api and https://docs.greenhouse.io/job-board.html. PageUp integration credentials are separate from these public career pages: https://developers.pageuppeople.com/Api/Recruitment/Hire.
