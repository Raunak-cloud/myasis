# SmartRecruiters administrator pilot

On the Apply page, an administrator opens **Start auto apply**, selects
**SmartRecruiters** under Job sources, and reviews the employer identifiers.
The initial watchlist is `Canva,KPMGAustralia1,Colliers`; up to 20 employer
identifiers can be saved for that administrator's account. The identifier is
the name following `careers.smartrecruiters.com/` in an employer's careers URL.

Discovery uses the public Posting API, with `country=au` and
`destination=PUBLIC`. Each search page requests at most 50 postings per
employer. Requests are paced, time out after 15 seconds, reject redirects and
responses over 1 MB, and do not retry HTTP errors. Failed employers are reported
while other feeds continue. No API key or application API is used.

This is an employer watchlist, not a search of every SmartRecruiters customer.
Existing title, age, employer exclusion, profile fit, application history and
run limits apply. Listings and full descriptions are read through the API;
only application attempts use the browser. Active/public/Australian status is
checked again before opening the application. Stable namespaced posting IDs
prevent collisions with SEEK/Indeed IDs; the existing employer/title check
also prevents duplicate attempts across sources.

Applications go through the existing employer application agent, confirmation
gate, account-specific profile/answers and recording path. Public API access
does not authorise direct API submissions. Dry runs do not open forms; the
existing rehearsal gate still prevents submission in rehearsal mode.

The dashboard sets `SMARTRECRUITERS_ADMIN_ENABLED` from the target account's
administrator status on every run. It is never user-settable. Customer settings
writes and run requests explicitly requesting this source are refused; stale
saved choices are removed at execution. An administrator starting a run for a
customer does not enable this pilot on that customer's account. Admin-only
SmartRecruiters runs do not require a SEEK or Indeed session.

Validation uses mocked API failures, closed/non-Australian/internal listings,
pagination, duplicate entries, unsafe URLs, bounded responses, account-access
checks and a local browser form. The fixture sends no real applications and
makes no model calls. Read-only live checks can use `SmartRecruitersDiscovery`
to fetch listings and details without invoking the application agent.

Official API references:
- https://developers.smartrecruiters.com/docs/endpoints
- https://developers.smartrecruiters.com/docs/authentication
- https://developers.smartrecruiters.com/docs/application-api
