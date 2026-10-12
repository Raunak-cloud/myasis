import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), n = sorted.length;
  return n ? n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : null;
};
const summary = { live: input.live, route: input.route, liveViewEnabled: input.liveViewEnabled, requestedTrials: input.trialCount, completedTrials: input.results.length, modes: {}, listingOverlap: [] };
for (const mode of ['headed', 'headless']) {
  const rows = input.results.filter(row => row.mode === mode), passed = rows.filter(row => row.ok);
  const searches = rows.flatMap(row => row.searches ?? []), details = rows.flatMap(row => row.details ?? []);
  summary.modes[mode] = {
    trials: rows.length, successfulTrials: passed.length,
    signedInTrials: rows.filter(row => row.session === 'signed-in').length,
    searches: searches.length, listingRows: searches.reduce((sum, row) => sum + row.count, 0), uniqueListings: new Set(searches.flatMap(row => row.ids)).size,
    completeSearches: searches.filter(row => row.complete).length, details: details.length, validDetails: details.filter(row => row.descriptionChars > 0).length,
    medianLaunchMs: median(passed.map(row => row.launchMs)), medianTotalMs: median(passed.map(row => row.totalMs)), medianSearchMs: median(searches.map(row => row.ms)), medianDetailMs: median(details.map(row => row.ms)),
    medianMeanPssMiB: median(passed.map(row => row.meanPssMiB)), medianPeakPssMiB: median(passed.map(row => row.peakPssMiB)), medianBrowserCpuSeconds: median(passed.map(row => row.browserCpuSeconds)), medianEncodedResponseBytes: median(passed.map(row => row.networkBytes)),
    challenges: rows.reduce((sum, row) => sum + (row.challenges ?? 0), 0), httpErrors: rows.flatMap(row => row.httpErrors ?? []), errors: rows.filter(row => !row.ok).map(row => row.error),
    liveFramesAllPassed: passed.every(row => row.liveFrames > 0 && row.screenshotBytes > 0), persistedCookies: rows.filter(row => row.persistedCookie).length,
    aiCalls: rows.reduce((sum, row) => sum + (row.aiCalls ?? 0), 0), paidSolves: rows.reduce((sum, row) => sum + (row.paidSolves ?? 0), 0), submissions: rows.reduce((sum, row) => sum + (row.submissions ?? 0), 0),
    userAgents: [...new Set(rows.map(row => row.browser?.userAgent).filter(Boolean))], windowSizes: rows.map(row => row.browser && ({ inner: row.browser.inner, outer: row.browser.outer })).filter(Boolean),
  };
}
for (const keyword of [...new Set(input.results.flatMap(row => row.searches ?? []).map(row => row.keyword))]) {
  const ids = mode => new Set(input.results.filter(row => row.mode === mode).flatMap(row => row.searches ?? []).filter(row => row.keyword === keyword).flatMap(row => row.ids));
  const headed = ids('headed'), headless = ids('headless'), union = new Set([...headed, ...headless]);
  const shared = [...headed].filter(id => headless.has(id)).length;
  summary.listingOverlap.push({ keyword, headed: headed.size, headless: headless.size, shared, union: union.size, jaccard: union.size ? shared / union.size : null });
}
console.log(JSON.stringify(summary, null, 2));
