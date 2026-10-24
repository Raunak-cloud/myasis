import type { PreparedApplication } from './application-review-types.js';
import { submitApprovedEmail } from './gmail-mailbox.js';
import { withApplicationAllowance } from './application-allowance.js';
import { AppliedIndex, logOutcome, saveRunSummary } from './store.js';
import { countHealth } from './run-health.js';
import { config } from './config.js';

/** Exact approved emails need neither a job-board session nor form reconstruction. */
export async function runApprovedEmailBatch(drafts: PreparedApplication[]): Promise<boolean> {
  if (!drafts.length || !drafts.every(draft => draft.email)) return false;
  const browser = process.env.GMAIL_ACCESS_MODE === 'browser' ? await (await import('./browser.js')).launchBrowser() : null;
  try {
  const index = new AppliedIndex(); let applied = 0;
  console.log(`Submitting ${drafts.length} confirmed email application(s) through Gmail MCP.`);
  for (const draft of drafts) {
    if (index.appliedToday() >= config.limits.maxApplicationsPerDay) {
      console.log(`Daily cap of ${config.limits.maxApplicationsPerDay} reached.`);
      break;
    }
    const job = draft.job;
    console.log(`→ Applying: ${job.title} @ ${job.company}`);
    if (index.hasApplication(job)) {
      logOutcome({ status: 'already-applied', jobId: job.id, reviewId: draft.id, title: job.title, company: job.company, reason: 'An application to this role is already recorded.' });
      console.log('  Already submitted. No email sent.'); continue;
    }
    // The MCP server rechecks this exact, paid approval before it accesses Gmail.
    const outcome = await withApplicationAllowance(async () => index.appliedToday() < config.limits.maxApplicationsPerDay, () => submitApprovedEmail(draft));
    logOutcome({ ...outcome, reviewId: draft.id, title: job.title, company: job.company, url: job.url });
    countHealth('attempted');
    if (outcome.status === 'applied') {
      countHealth('applied'); applied++;
      index.add({ jobId: job.id, platform: job.platform || 'seek', title: job.title, company: job.company, location: job.location,
        url: job.url, appliedAt: outcome.at, score: 0, scoreReasons: ['Candidate-confirmed email application'],
        coverLetter: draft.coverLetter, answers: draft.answers, resume: draft.resume, external: true, submittedByMyasis: true });
      console.log(`  ✅ submitted [external] (${applied}/${drafts.length})`);
    } else if (outcome.status === 'needs-human') { countHealth('needsHuman'); console.log(`  ⏸ needs you: ${outcome.reason}`); }
  }
  saveRunSummary(drafts.length, false);
  console.log(`\n=== Run complete: ${applied} new application(s) ===`);
  return true;
  } finally { await browser?.close(); }
}
