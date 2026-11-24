# Paid-user job index

The collector is independent of application runs. It reads active paid accounts, derives role/skill targeting from saved keywords and owned resumes, gathers public vacancies, shortlists by current preferences, reviews professional fit with MiniMax, and stores only confirmed matches in a **separate Neon-hosted PostgreSQL database, outside the VPS**. The crawler process can run on the VPS; the job catalog is never provisioned there. The administrator can search it under the admin-only **Jobs** sidebar tab. No job is approved, prepared, submitted or charged an application credit by this collector. Existing application schedules and fit criteria are unchanged.

```mermaid
flowchart LR
  A[Read-only paid accounts and owned resumes] --> B[Private targeting profiles]
  C[Public employer feeds, career links and sitemaps] --> D[Durable crawl queue]
  D --> F[Validated public job data and evidence]
  F --> R[Code shortlist and AI fit review]
  B --> R
  R -->|Confirmed match only| G[(Separate job database)]
  B --> H[Private preliminary matches]
  G --> H
  H --> I[Admin search]
```

## Administration

Admin → Jobs lets administrators filter saved matches and pause collection.
Operators can run one direct employer-feed and publisher-page cycle on demand.
Opening the dashboard or restarting services does not start collection.

## Collection and coverage

Built-in feed parsers cover Greenhouse and Workday, using their public job data. Existing paid-user employer selections and employer URLs are starting points. Career links and XML sitemaps expand discovery; observed ATS URLs can add new employers to the feed queue. Generic career pages use bounded JSON-LD `JobPosting` graph extraction. A page without readable public job data is not converted into a guessed vacancy.

Publisher extraction also reads scoped schema.org JobPosting microdata, including SuccessFactors job pages. Nested employer headquarters cannot supply a vacancy's country, and existing JSON-LD takes precedence. Lever vacancy pages are verified against the same posting's public Lever API record; the API supplies role-specific country, arrangement, duties and creation date, while the employer name and title must bind to the publisher HTML.

Ashby boards expose public vacancy identifiers in an embedded JSON assignment rather than anchor links. The collector parses that JSON as data without executing scripts, binds the organization slug to the publisher URL, and reads each full vacancy through its public page. It does not call Ashby's private API. A board summary never becomes a catalog job by itself. Published board IDs have a separate bounded link allowance so the generic 30-link navigation limit does not hide later vacancies.


Discovery uses explicit allowed role titles from the first standing-instruction directive, in addition to the saved keyword field; exclusions and personal answers are excluded from role terms. Close spelling/function equivalents such as AI developer/AI engineer and pet walking/dog walker can reach professional review without requiring two shared technical keywords. They never bypass the score, resume evidence, exclusion, geography, age or work-arrangement checks. HTTP fetches preserve publisher paths and query strings after URL validation; canonical URL normalization remains separate, preventing trailing-slash redirect loops without weakening destination checks.

The discovery reviewer uses medium reasoning, verbatim evidence choices and an explicit distinction between unknown listing metadata and missing mandatory candidate qualifications. Undisclosed pay, unstated arrangement and an unknown posting date remain unknown; they alone do not reject a discovery match. Explicit conflicts and mandatory qualification gaps remain blockers. A disclosed pay range can reach the saved minimum at its upper end, and metropolitan suburbs are part of the selected city. Earlier decisions are reconsidered under a new cache revision without deleting valid existing matches.


## Tags and matching

Stored fields include employer, title, canonical source URL, source identity, full available description, location, applicant-location restrictions, remote/hybrid/onsite/unknown arrangement, salary disclosed/unpaid/not mentioned, structured salary range/currency/period when supplied, employment type, occupation category, seniority, skills, suitability audiences, stated qualifications/experience/eligibility requirements, posting/closing dates, first seen and last verification.

Evidence accompanies tags; inferred occupation categories are marked inferred. Missing pay is not called unpaid. A postal location alone does not prove onsite work, and remote work does not prove eligibility from any country. An Australia-only admission policy runs before any AI call and again at final review and storage. Explicit publisher country codes/names or country-labelled job locations are required; remote roles must permit Australian residence, and foreign-only applicant restrictions veto an Australian office address. Bare cities without a validated subdivision, APAC, worldwide/remote labels, employer headquarters, currency and incidental description mentions do not establish eligibility. Unknown geography is counted separately and excluded pending better publisher evidence. The same policy validates existing catalog records during migration: non-Australian/unknown jobs and their versions/matches are removed; verified Australian records are retained. Reads quarantine unvalidated country-policy records. Country facts remain distinct from display labels, including Workday detail country data. Code shortlists current keywords or multiple shared skills so equivalent titles reach review. MiniMax M3.1 Flash then enforces current occupation instructions, minimum score, arrangements, city/radius, salary, job types, listing age and mandatory requirements against professional resume evidence. A match needs exact employer and candidate evidence. Fabricated quotes, malformed/truncated output, low scores, uncertainty and errors cannot admit jobs. These are **reviewed discovery matches**, never approval to prepare or submit an application. Private profiles retain derived terms, numeric preferences and fingerprints, not raw resume text or standing instructions. Resume evidence and instructions stay in bounded process memory. Email, phone and URL contact details are removed before AI review; identity is not a fit criterion. Unchanged resumes are cached; changed files/settings invalidate targeting and remove stale matches. Deleted, blocked or expired-paid owners and their private matches are purged on the next worker check, including while collection is paused. Catalog jobs and versions are removed when no current approved owner remains. The release migration removes the previous unreviewed catalog only; it never touches application history or customer settings.

## Persistence and operational boundaries

Jobs deduplicate by canonical URL, stripping tracking parameters while preserving vacancy identifiers. Distinct URLs are not guessed to be identical merely from an employer/title. A per-vacancy transaction lock protects simultaneous writes; content versions preserve prior public facts. Jobs disappear from current search when closed, expired or not verified for 14 days. Confirmed HTTP 404/410 and expired structured listings close existing entries; inaccessible pages are not falsely called closed.

The queue uses leased tasks, `FOR UPDATE SKIP LOCKED`, a single-worker advisory lock, owner-scoped matching, stale-lease protection and bounded retries (three failed task attempts). Pages and each feed source receive rotating turns; detail tasks take priority within a lane so blocked feeds cannot monopolize discovery. Interrupted cycles remain recorded. Requests are DNS-pinned to validated public IPv4 addresses, with every redirect checked, byte/time limits, robots rules, host pacing and no account cookies. Visible challenges are recorded as blocked; merely configuring a CAPTCHA library on an otherwise readable page is not treated as a challenge. There are at most 160 HTTP reads and 40 tasks per cycle, manual starts only, ten paginated feed batches per query and a 5,000-pending-task limit. Extraction/tagging use no AI. Fit review uses the existing OpenRouter MiniMax key with low reasoning (medium only for a validation correction), a 30-second request timeout, at most eight new owner-fair reviews per cycle, each with at most one separately budgeted correction for invalid typed/evidence output, and durable ceilings of 100 requests / US$1 of conservative reservations per database day. Charges or unknown charges are recorded separately in the catalog, never charged against a customer application run. There is no model fallback. Provider failures defer work. Negative/uncertain caching retains hashes and verdicts only, for seven days/one hour. No rejected description is staged in Neon. Feed detail queues retain public URLs and identifiers only. Changed resumes, settings or job descriptions invalidate cached reviews.

The worker has a dedicated read-only login to the application DB and a different writable login to its own DB. It has no application or billing write grants. Resume file reads stay within the owned file directory. Pause/resume actions record the admin actor. It never shares an application browser.

## Setup and verification

Create a dedicated database/project in Neon, then set its **direct** connection string in **Admin → Config → Job discovery → Neon database connection**. The reviewer uses the existing `OPENROUTER_API_KEY`; missing credentials cannot admit unreviewed jobs. Values are write-only to the browser. The catalog requires verified TLS and rejects localhost/IP literal endpoints, non-Neon hosts and known transaction-pooling endpoints. Direct connections preserve the crawler's session lock. No Neon subscription is purchased by this feature.

`deploy/install-job-index.sh` provisions only a limited read-only login to the existing application database and protected `/etc/owtomate-job-index.json`; it never creates a database on the VPS. Deployment applies the external database schema. Root can alternatively configure a connection through `dashboard/scripts/set-job-index-connection.mts`, receiving JSON from protected stdin rather than a CLI argument. Existing role passwords are not rotated by later installs. `JOB_INDEX_CONFIG` can select a separate configuration file. `npm run job-index:once` in `dashboard` performs one bounded indexing cycle.

Targeted checks: `npm run test:job-index`; PostgreSQL integration with `tsx --test server/job-index/store.test.ts` against an isolated generated schema; `tsx scripts/test-job-index-ui.mts`; `npm run build` in `dashboard`. Tests cover tags, missing/negative facts, expiry, JSON-LD graphs, canonical dedupe, private matching, robots/challenges/redirects, paid eligibility, caching, concurrent upserts and leases, stale workers, provider caps, private-data purge, an end-to-end synthetic crawl, and responsive admin controls. They never submit applications or contact employers.

Design references: [Schema.org JobPosting](https://schema.org/JobPosting), [Greenhouse public Job Board API](https://docs.greenhouse.io/job-board), [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html).

Additional checks cover AI evidence validation, selected-model transport and truncation, matching-only atomic storage, stale-owner rejection, legacy catalog cleanup, negative-cache privacy, review budgets, and failure/uncertainty handling. The crawler remains admin-only with no application browser or application/billing write grants.


The Jobs sidebar page is gated by admin entitlements; its existing `/api/admin/job-index` endpoints independently enforce administrator authentication. Expand a job to inspect its full public description, source/record identifiers, dates, tags, evidence and current owner match reasons/scores/model. This page does not initiate collection or applications when opened.
