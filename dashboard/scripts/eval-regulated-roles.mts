/**
 * Does the AI respect Australian registration and licensing?
 *
 * An overseas-trained doctor cannot take a GP job without AHPRA registration;
 * an overseas nurse, lawyer or electrician is in the same position with their
 * own regulator. Both places the AI makes that call are exercised against real
 * models: the job searches suggested from a résumé, and the fit check on a
 * listing. Controls prove it still applies when registration is held and for
 * unregulated work.
 *
 *   npx tsx scripts/eval-regulated-roles.mts
 *
 * Spends a few cents of model calls. Exits non-zero on any failed case.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'owtomate-eval-'));
const { searchTermsRequest, askGeminiForJson, SEARCH_TERMS_SYSTEM } = await import('../server/search-terms.ts');
const { readEnv } = await import('../server/runner.ts');
const { assessFit } = await import('../../seek-bot/dist/llm.js');

interface Case {
  name: string;
  resume: string;
  /** Searches that would be for work the candidate cannot yet legally do in Australia. */
  forbiddenSearch?: RegExp;
  /** Where both the candidate and the job are, so location never decides the case. */
  city?: string;
  job: { title: string; description: string };
  expect: 'apply' | 'not-apply';
}

const CASES: Case[] = [
  {
    name: 'Overseas GP without AHPRA → GP role',
    resume: 'Dr Sita Karki. MBBS, Tribhuvan University, Nepal (2016). General practitioner, Kathmandu Model Hospital, 2017-2024: outpatient consultations, chronic disease management, minor procedures. Moved to Sydney 2025. Skills: patient assessment, EMR, clinical documentation.',
    forbiddenSearch: /\b(gp|general practitioner|doctor|medical officer|physician|registrar|resident medical)\b/i,
    job: { title: 'General Practitioner - Western Sydney', description: 'Busy mixed-billing practice seeks a GP. Essential: current general or specialist registration with AHPRA and eligibility for a Medicare provider number. FRACGP or equivalent highly regarded.' },
    expect: 'not-apply',
  },
  {
    name: 'Overseas RN without AHPRA → Registered Nurse role',
    resume: 'Maria Santos. BSc Nursing, University of Santo Tomas, Philippines. Registered nurse (PRC Philippines), St Luke\'s Medical Centre Manila 2018-2024, medical-surgical ward. Now in Melbourne on a work visa.',
    forbiddenSearch: /\b(registered nurse|rn\b|clinical nurse|nurse unit manager|midwife)\b/i,
    city: 'Melbourne VIC',
    job: { title: 'Registered Nurse - Medical Ward', description: 'Join our medical ward. Requirements: current registration as a Registered Nurse with AHPRA (NMBA). 2+ years acute experience.' },
    expect: 'not-apply',
  },
  {
    name: 'Overseas lawyer not admitted in Australia → Solicitor role',
    resume: 'Rahul Mehta. LLB, University of Delhi. Advocate enrolled with the Bar Council of Delhi, 2015-2023, commercial litigation and contract drafting. Relocated to Brisbane in 2024.',
    forbiddenSearch: /\b(solicitor|lawyer|barrister|legal counsel|associate lawyer)\b/i,
    city: 'Brisbane QLD',
    job: { title: 'Commercial Solicitor', description: 'Mid-tier firm seeks a solicitor with 3+ PAE. You must hold a current Queensland practising certificate or be eligible for one.' },
    expect: 'not-apply',
  },
  {
    name: 'Overseas electrician without Australian licence → Licensed Electrician role',
    resume: 'Tomasz Nowak. Qualified electrician (Poland), 10 years installing and maintaining commercial wiring. Arrived in Perth 2025. White Card holder.',
    forbiddenSearch: /\b(licensed electrician|electrician|electrical contractor|a-grade)\b/i,
    city: 'Perth WA',
    job: { title: 'Licensed Electrician', description: 'Commercial fit-outs. Must hold a current WA electrical worker licence. Own tools and vehicle.' },
    expect: 'not-apply',
  },
  {
    name: 'Control: overseas GP WITH AHPRA general registration → GP role',
    resume: 'Dr Sita Karki. MBBS, Tribhuvan University, Nepal. AMC Clinical examination passed 2024; current AHPRA general registration (MED0001234567). General practitioner, Kathmandu 2017-2024; GP registrar, Parramatta 2025-present.',
    job: { title: 'General Practitioner - Western Sydney', description: 'Busy mixed-billing practice seeks a GP. Essential: current general or specialist registration with AHPRA and eligibility for a Medicare provider number.' },
    expect: 'apply',
  },
  {
    name: 'Control: overseas software engineer → unregulated role',
    resume: 'Anish Rai. BSc Computer Science, Kathmandu University. Full-stack developer 2019-2025 (React, Node.js, PostgreSQL) for clients in Nepal and the UK. Full working rights in Australia.',
    job: { title: 'Software Engineer', description: 'Build React and Node.js services. 3+ years experience. Full working rights in Australia required.' },
    expect: 'apply',
  },
];

const env = readEnv();
const apiKey = env.GEMINI_API_KEY ?? '';
const model = env.GEMINI_MODEL ?? 'gemini-3.7-flash';
let failures = 0;

for (const c of CASES) {
  console.log(`\n■ ${c.name}`);

  if (c.forbiddenSearch) {
    const { prompt, schema } = searchTermsRequest(`<resume label="CV">\n${c.resume}\n</resume>`, []);
    const result = await askGeminiForJson(apiKey, model, SEARCH_TERMS_SYSTEM, prompt, schema, 0.9);
    const terms = result.ok ? ((result.value as { searches?: Array<{ query: string }> })?.searches ?? []).map((s) => s.query) : [];
    const bad = terms.filter((term) => c.forbiddenSearch!.test(term));
    const ok = result.ok && terms.length > 0 && bad.length === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} searches: ${terms.join(' | ') || (result.ok ? '(none)' : result.error)}${bad.length ? `  ← not yet allowed in Australia: ${bad.join(', ')}` : ''}`);
  }

  const profile = {
    name: 'Candidate', email: 'c@example.com', phone: '0400000000', nationality: 'Not stated',
    expectedSalary: '', noticePeriod: '', willingToRelocate: false, experienceSummary: c.resume,
    skills: [], excludedDomains: [], securityClearance: '',
  };
  const job = { id: `eval-${c.name}`, company: 'Employer', location: c.city ?? 'Sydney NSW', url: 'https://example.com', ...c.job };
  const fit = await assessFit(job as never, profile as never);
  const applied = fit.decision === 'apply';
  const ok = (c.expect === 'apply') === applied;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} fit: ${fit.decision} (${fit.matchScore}) — ${fit.reason.slice(0, 180)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
