# Magnus live test — 22 September 2026

## Outcome

The requested five additional submissions were **not achieved**. Five completed runs (141, 142, 145, 146, 147) performed 125 listing checks, including repeats, and submitted one application. Run 143 was intentionally stopped before applications to activate the user-approved broader work arrangements; the stop took approximately 61 seconds. Run 144 did not start because the prior run was still stopping.

Confirmed submission: Graduate Level Full Stack Developer, Red Dirt Equities Pty Ltd, SEEK job 94754876, 10:28:58 Sydney time. Confirmation URL: https://au.seek.com/job/94754876/apply/success. The account now has six recorded applications in total, five predating this test.

## Performance and coverage

- Successful application: approximately 30 seconds from opening to confirmed submission, seven navigation calls, about US$0.00694 for navigation. Cover-letter drafting and screening calls are additional.
- Discovery/ranking dominated elapsed time: ranking batches together took approximately 65–81 seconds per run; complete search runs took approximately six minutes.
- Account metrics recorded approximately US$0.308 in Celeris token costs during the test window, excluding Gemini drafting and other services. Two requests required retries.
- The successful flow generated a cover letter, preserved an existing résumé/profile, answered a screening question, skipped optional promotional controls and reached a confirmed success page. No form loop or coordinate misclick was observed in this one application.
- A separate synthetic live Magnus answer test with no supplied career history returned an empty, ungrounded answer for the optional field in 4.28 seconds. The field tool skips such optional answers; this is not proof that navigation can never revisit them.
- A separate synthetic browser test of the migrated Magnus page-state checker returned `ok` in 1.61 seconds.
- Humanizer was disabled by the Essential Pass and was not evaluated. Fresh-profile setup and actual sign-in recovery were not exercised.

## Findings and limits

Most reviewed listings were external-only, mismatched, or below the unchanged 75% score threshold. Remote Australia and hybrid Sydney were temporarily enabled with approval; one hybrid job qualified. No fit threshold, salary floor, candidate fact or duplicate safeguard was relaxed.

Ranking remained imperfect: a food-technology role reached detailed review, scores varied on repeated listings, and known external listings were reviewed again. Detailed fit checks prevented inappropriate submissions. One successful application is insufficient to establish a reliability improvement, and different jobs/settings make this an uncontrolled comparison with earlier Celeris-1 runs.

The runtime audit found page-state checks and sign-in recovery still used Celeris-1 after the initial migration. Commit 0a12773 migrated those paths to Magnus and was deployed after the test runs. Thus the observed test used Magnus for navigation, ranking, fit checks and answers, but still used Celeris-1 for page-state checks. The complete post-audit configuration has not completed five live applications. Regression tests passed; the page-state change also passed the live synthetic check above.

## Cleanup

The no-charge Essential Pass granted 50 credits and used one. Its remaining 49 credits were expired, not billed. Per-run application override was restored to null, automatic-apply pause restored to its original unpaused state, and work arrangements restored to the pre-test on-site setting. No run remains active. The product's normal automatic search-term renewal remains intact. Magnus deployment remains active.

Four further verified submissions are still required to satisfy the requested test target; this report does not claim completion or error-free operation.
