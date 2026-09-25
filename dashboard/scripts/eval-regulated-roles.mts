/**
 * Does the AI respect Australian registration and licensing?
 *
 * An overseas-trained doctor cannot take a GP job without AHPRA registration;
 * nurses, lawyers, licensed trades, teachers and others are in the same
 * position with their own regulators. Both places the AI makes that call run
 * against real models: the job searches suggested from a résumé (through the
 * same filter the app applies), and the fit check on a listing. Recognition
 * cases (New Zealand, interstate licences, provisional or limited registration,
 * "eligible for" ads) and controls (credential held, unregulated work, the
 * nearby roles a candidate can do now) keep it from simply refusing.
 *
 *   npx tsx scripts/eval-regulated-roles.mts [runs=3]
 *
 * Every case runs `runs` times, since model judgments vary between calls.
 * Spends well under a dollar. Exits non-zero on any failed run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'owtomate-eval-'));
// Neutral run settings: an account's own city or salary floor must never decide a credential case.
process.env.ONSITE_CITY = '';
process.env.MIN_SALARY = '0';
process.env.MIN_HOURLY_RATE = '0';
process.env.WORK_ARRANGEMENTS = 'remote,hybrid,onsite';
const { searchTermsRequest, askGeminiForJson, normalizeGeneratedSearches, SEARCH_TERMS_SYSTEM } = await import('../server/search-terms.ts');
const { readEnv } = await import('../server/runner.ts');
type AssessFit = (job: unknown, profile: unknown) => Promise<{ decision: string; matchScore: number; reason: string }>;
const { assessFit } = (await import(new URL('../../seek-bot/dist/llm.js', import.meta.url).href)) as { assessFit: AssessFit };

interface Case {
  name: string;
  resume: string;
  /** Where the candidate and the job both are, so location never decides the case. */
  city: string;
  job: { title: string; description: string };
  expect: 'apply' | 'not-apply';
  /** For candidates who cannot yet practise: searches for work they may not legally do. */
  forbiddenSearch?: RegExp;
}

const SYD = 'Sydney NSW';
const CASES: Case[] = [
  // Overseas credentials only, for work regulated in Australia.
  { name: 'Overseas GP (Nepal) → GP', city: SYD, expect: 'not-apply',
    resume: 'Dr Sita Karki. MBBS, Tribhuvan University, Nepal. General practitioner, Kathmandu Model Hospital, 2017-2024. Moved to Sydney 2025.',
    job: { title: 'General Practitioner', description: 'Mixed-billing practice. Essential: current general or specialist registration with AHPRA and a Medicare provider number.' },
    forbiddenSearch: /\b(gp|general practitioner|doctor|medical officer|physician|registrar|resident medical)\b/i },
  { name: 'Overseas RN (Philippines) → Registered Nurse', city: 'Melbourne VIC', expect: 'not-apply',
    resume: 'Maria Santos. BSc Nursing, Philippines. Registered nurse (PRC Philippines), medical-surgical ward 2018-2024. Now in Melbourne.',
    job: { title: 'Registered Nurse', description: 'Medical ward. Requires current registration as a Registered Nurse with AHPRA (NMBA).' },
    forbiddenSearch: /\b(registered nurse|rn|clinical nurse|nurse unit manager|midwife)\b/i },
  { name: 'Overseas lawyer (India) → Solicitor', city: 'Brisbane QLD', expect: 'not-apply',
    resume: 'Rahul Mehta. LLB, University of Delhi. Advocate, Bar Council of Delhi, 2015-2023, commercial litigation.',
    job: { title: 'Commercial Solicitor', description: 'Must hold a current Queensland practising certificate or be eligible for one. 3+ years PAE.' },
    forbiddenSearch: /\b(solicitor|lawyer|barrister|legal counsel|associate)\b/i },
  { name: 'Overseas electrician (Poland) → Licensed Electrician', city: 'Perth WA', expect: 'not-apply',
    resume: 'Tomasz Nowak. Qualified electrician (Poland), 10 years commercial wiring. Arrived in Perth 2025. White Card.',
    job: { title: 'Licensed Electrician', description: 'Must hold a current WA electrical worker licence.' },
    forbiddenSearch: /\b(licensed electrician|electrician|electrical contractor|a-grade)\b/i },
  { name: 'Overseas pharmacist (UK GPhC) → Pharmacist', city: SYD, expect: 'not-apply',
    resume: 'Emma Clarke. MPharm, University of Nottingham. Registered with the UK GPhC; community pharmacist, Boots 2016-2024.',
    job: { title: 'Pharmacist', description: 'Community pharmacy. General registration as a pharmacist with AHPRA essential.' },
    forbiddenSearch: /\b(pharmacist|dispensary manager)\b/i },
  { name: 'Overseas physiotherapist (India) → Physiotherapist', city: SYD, expect: 'not-apply',
    resume: 'Priya Nair. Bachelor of Physiotherapy, Manipal. Physiotherapist, Mumbai sports clinic 2019-2024.',
    job: { title: 'Physiotherapist', description: 'Private practice. Must hold general registration with the Physiotherapy Board of Australia (AHPRA).' },
    forbiddenSearch: /\b(physiotherapist|physio)\b/i },
  { name: 'Overseas psychologist (US) → Psychologist', city: 'Melbourne VIC', expect: 'not-apply',
    resume: 'Dr Jordan Lee. PsyD, licensed psychologist in California 2015-2024, adult CBT.',
    job: { title: 'Psychologist', description: 'Clinic role. General registration as a psychologist with AHPRA required.' },
    forbiddenSearch: /\b(psychologist)\b/i },
  { name: 'Overseas dentist (Iran) → Dentist', city: SYD, expect: 'not-apply',
    resume: 'Dr Reza Ahmadi. DDS, Tehran University of Medical Sciences. General dentist 2012-2023.',
    job: { title: 'General Dentist', description: 'Registration with the Dental Board of Australia is essential.' },
    forbiddenSearch: /\b(dentist|dental surgeon)\b/i },
  { name: 'Overseas teacher (UK QTS) → Classroom Teacher', city: SYD, expect: 'not-apply',
    resume: 'Oliver Grant. PGCE, Qualified Teacher Status (England). Secondary maths teacher, Leeds 2015-2024.',
    job: { title: 'Secondary Mathematics Teacher', description: 'NSW school. Must hold current NESA accreditation to teach in NSW.' },
    forbiddenSearch: /\b(teacher|lecturer)\b(?! (aide|assistant))/i },
  { name: 'Overseas plumber (South Africa) → Licensed Plumber', city: 'Melbourne VIC', expect: 'not-apply',
    resume: 'Sipho Dlamini. Qualified plumber (South Africa), 12 years residential and commercial plumbing.',
    job: { title: 'Licensed Plumber', description: 'Must be a licensed plumber with the Victorian Building Authority.' },
    forbiddenSearch: /\b(plumber|gasfitter)\b(?! (trades? )?assistant)/i },
  { name: 'Overseas security guard → Security Officer (licensed)', city: SYD, expect: 'not-apply',
    resume: 'Bikram Thapa. Security guard, Dubai shopping mall 2016-2023; CCTV monitoring, access control.',
    job: { title: 'Security Officer', description: 'Must hold a current NSW Class 1A security licence.' } },
  { name: 'Overseas midwife (Kenya) → Midwife', city: 'Perth WA', expect: 'not-apply',
    resume: 'Grace Wanjiru. Diploma in Midwifery, Kenya Medical Training College. Registered midwife (Nursing Council of Kenya) 2014-2024.',
    job: { title: 'Midwife', description: 'Birth suite. Current registration as a midwife with AHPRA (NMBA) required.' },
    forbiddenSearch: /\b(midwife)\b/i },
  // Recognition rules.
  { name: 'NZ-registered nurse without AHPRA → Registered Nurse', city: SYD, expect: 'not-apply',
    resume: 'Aroha Walker. BN, University of Auckland. Registered nurse with a current Nursing Council of New Zealand practising certificate, Auckland City Hospital 2019-2025.',
    job: { title: 'Registered Nurse', description: 'Surgical ward. Current AHPRA (NMBA) registration as a Registered Nurse is essential.' } },
  { name: 'Doctor with provisional AHPRA registration → role needing general registration', city: SYD, expect: 'not-apply',
    resume: 'Dr Wei Zhang. MBBS, University of Sydney 2025. Intern at Westmead Hospital with provisional registration with AHPRA.',
    job: { title: 'Resident Medical Officer', description: 'PGY2+. General registration with AHPRA is essential.' } },
  { name: 'NSW-licensed electrician → Victorian electrician job (AMR)', city: 'Melbourne VIC', expect: 'apply',
    resume: 'Liam Murphy. A-grade electrician holding a current NSW contractor licence (Fair Trading) since 2018; commercial fit-outs. Now in Melbourne.',
    job: { title: 'Electrician', description: 'Commercial projects. Must be licensed to perform electrical work in Victoria.' } },
  { name: 'IMG with AMC passed → role open to those eligible for AHPRA', city: SYD, expect: 'apply',
    resume: 'Dr Sita Karki. MBBS, Nepal. AMC MCQ and Clinical examinations passed 2024. General practitioner, Kathmandu 2017-2024.',
    job: { title: 'Career Medical Officer', description: 'International medical graduates welcome. Must hold or be eligible for general registration with AHPRA; we support your registration.' } },
  { name: 'Overseas-trained RN WITH AHPRA → Registered Nurse', city: 'Melbourne VIC', expect: 'apply',
    resume: 'Maria Santos. BSc Nursing, Philippines. Current AHPRA registration as a Registered Nurse (NMW0001234567). Medical-surgical ward, Manila 2018-2023; RN, Monash Health 2024-present.',
    job: { title: 'Registered Nurse', description: 'Medical ward. Requires current registration as a Registered Nurse with AHPRA (NMBA).' } },
  { name: 'Overseas GP WITH AHPRA → GP', city: SYD, expect: 'apply',
    resume: 'Dr Sita Karki. MBBS, Nepal. AMC Clinical passed 2024; current AHPRA general registration (MED0001234567). GP, Kathmandu 2017-2024; GP registrar, Parramatta 2025-present.',
    job: { title: 'General Practitioner', description: 'Mixed-billing practice. Essential: current general or specialist registration with AHPRA.' } },
  { name: 'Lawyer admitted in NSW → Queensland solicitor role', city: 'Brisbane QLD', expect: 'apply',
    resume: 'Rahul Mehta. LLB (Delhi); Graduate Diploma in Legal Practice, College of Law. Admitted as a lawyer of the Supreme Court of NSW 2022; solicitor, Sydney firm 2022-2025, commercial litigation.',
    job: { title: 'Commercial Solicitor', description: 'Must hold a current Queensland practising certificate or be eligible for one. 3+ years PAE.' } },
  // Unregulated, or registration only desirable.
  { name: 'Overseas CA (ICAI) → Accountant, CPA desirable', city: SYD, expect: 'apply',
    resume: 'Ankit Shah. Chartered Accountant (ICAI, India). Management accountant 2016-2024: month-end, reconciliations, Xero and SAP. Full working rights.',
    job: { title: 'Management Accountant', description: 'Month-end close and reporting. CA/CPA qualified or working towards is desirable. Full working rights.' } },
  { name: 'Overseas civil engineer → Civil Engineer, chartered desirable', city: SYD, expect: 'apply',
    resume: 'Farah Khan. BE Civil, NED University. Site and design engineer, Karachi 2016-2024: road and drainage design in Civil 3D. Full working rights.',
    job: { title: 'Civil Engineer', description: 'Road and drainage design using Civil 3D. Chartered status with Engineers Australia desirable. Full working rights.' } },
  { name: 'Overseas software engineer → Software Engineer', city: SYD, expect: 'apply',
    resume: 'Anish Rai. BSc Computer Science, Kathmandu University. Full-stack developer 2019-2025 (React, Node.js). Full working rights.',
    job: { title: 'Software Engineer', description: 'React and Node.js. 3+ years. Full working rights.' } },
  { name: 'Overseas data analyst → Data Analyst', city: SYD, expect: 'apply',
    resume: 'Mei Tan. BCom Statistics, Malaysia. Data analyst 2018-2024: SQL, Power BI, Python. Full working rights.',
    job: { title: 'Data Analyst', description: 'SQL and Power BI reporting. Full working rights.' } },
  { name: 'Overseas chef → Chef', city: SYD, expect: 'apply',
    resume: 'Marco Rossi. Chef de partie, Rome restaurants 2014-2024. Italian cuisine, kitchen operations. Full working rights.',
    job: { title: 'Chef de Partie', description: 'Italian restaurant. 3+ years experience. Full working rights.' } },
  // Nearby roles a candidate who cannot yet practise can take now.
  { name: 'Overseas GP → Medical Receptionist', city: SYD, expect: 'apply',
    resume: 'Dr Sita Karki. MBBS, Tribhuvan University, Nepal. General practitioner, Kathmandu Model Hospital, 2017-2024: patient bookings, EMR, clinical documentation. Full working rights.',
    job: { title: 'Medical Receptionist', description: 'Busy GP clinic front desk: bookings, billing, Best Practice software. Full working rights.' } },
  { name: 'Overseas lawyer → Paralegal', city: 'Brisbane QLD', expect: 'apply',
    resume: 'Rahul Mehta. LLB, University of Delhi. Advocate 2015-2023, commercial litigation, contract drafting. Full working rights.',
    job: { title: 'Paralegal', description: 'Commercial litigation team. Document management and drafting. Law degree desirable. Full working rights.' } },
  { name: 'Overseas RN → Assistant in Nursing', city: 'Melbourne VIC', expect: 'apply',
    resume: 'Maria Santos. BSc Nursing, Philippines. Registered nurse (PRC), medical-surgical ward 2018-2024. Full working rights.',
    job: { title: 'Assistant in Nursing', description: 'Personal care for patients under RN supervision. Nursing students or overseas-trained nurses welcome. Full working rights.' } },
  { name: 'Overseas electrician → Electrical Trade Assistant', city: 'Perth WA', expect: 'apply',
    resume: 'Tomasz Nowak. Qualified electrician (Poland), 10 years commercial wiring. White Card. Full working rights.',
    job: { title: 'Electrical Trade Assistant', description: 'Assist licensed electricians on commercial sites. White Card required. Full working rights.' } },
  { name: 'Overseas teacher → Teacher Aide', city: SYD, expect: 'apply',
    resume: 'Oliver Grant. PGCE, QTS (England). Secondary maths teacher, Leeds 2015-2024. Working With Children Check (NSW). Full working rights.',
    job: { title: 'Teacher Aide', description: 'Support students in class under teacher direction. Working With Children Check required. Full working rights.' } },
];

const env = readEnv();
const apiKey = env.GEMINI_API_KEY ?? '';
const model = env.GEMINI_MODEL ?? 'gemini-3.7-flash';
const runs = Math.max(1, Number(process.argv[2]) || 3);

async function checkCase(c: Case): Promise<string[]> {
  const failures: string[] = [];
  for (let run = 1; run <= runs; run++) {
    if (c.forbiddenSearch) {
      const { prompt, schema } = searchTermsRequest(`<resume label="CV">\n${c.resume}\n</resume>`, []);
      const result = await askGeminiForJson(apiKey, model, SEARCH_TERMS_SYSTEM, prompt, schema, 0.9);
      const terms = result.ok ? normalizeGeneratedSearches((result.value as { searches?: unknown })?.searches) : [];
      const bad = terms.filter((term) => c.forbiddenSearch!.test(term));
      if (!result.ok || !terms.length || bad.length) failures.push(`run ${run} searches: ${terms.join(' | ') || (result.ok ? '(none)' : result.error)}${bad.length ? ` ← ${bad.join(', ')}` : ''}`);
    }
    const profile = {
      name: 'Candidate', email: 'c@example.com', phone: '0400000000', nationality: 'Not stated',
      expectedSalary: '', noticePeriod: '', willingToRelocate: true, experienceSummary: c.resume,
      skills: [], excludedDomains: [], securityClearance: '',
    };
    // A unique id per run: the fit check caches by job, and every run must be a fresh judgment.
    const job = { id: `eval-${c.name}-${run}-${Date.now()}`, company: 'Employer', location: c.city, url: 'https://example.com', ...c.job };
    const fit = await assessFit(job, profile).catch((error: Error) => ({ decision: 'error', matchScore: 0, reason: error.message }));
    if ((c.expect === 'apply') !== (fit.decision === 'apply')) failures.push(`run ${run} fit: ${fit.decision} — ${fit.reason.slice(0, 160)}`);
  }
  return failures;
}

// A few cases at a time: fast enough, and gentle on the model providers.
let failed = 0;
const queue = [...CASES];
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const failures = await checkCase(c);
    if (failures.length) failed++;
    console.log(`${failures.length ? '✗' : '✓'} ${c.name}${failures.map((f) => `\n    ${f}`).join('')}`);
  }
}));

console.log(failed ? `\n${failed} of ${CASES.length} cases failed at least one of ${runs} runs` : `\nall ${CASES.length} cases passed ${runs} runs each`);
process.exit(failed ? 1 : 0);
