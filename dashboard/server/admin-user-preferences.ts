import type { AdminPreferenceSection } from '../src/admin-user-preferences.js';
import { loadProfile } from './profile.js';
import { listAnswers } from './answers.js';
import { runSettingsSnapshotForUser } from './settings.js';
import { applyRunPolicy, entitlementsFor, PLATFORMS_CHOSEN_KEY, EMPLOYER_SOURCES_CHOSEN_KEY } from './entitlements.js';
import { isCredentialQuestion } from '../../seek-bot/src/blocked-questions.js';
import { EMPLOYER_SOURCES } from '../../seek-bot/src/employer-source-config.js';

const names: Record<string, string> = {
  seek: 'SEEK', indeed: 'Indeed', smartrecruiters: 'SmartRecruiters', greenhouse: 'Greenhouse',
  pageup: 'PageUp', workday: 'Workday', onsite: 'Onsite', hybrid: 'Hybrid', remote: 'Remote',
  fulltime: 'Full time', parttime: 'Part time', contract: 'Contract', casual: 'Casual',
  tailored: 'AI tailored', reuse: 'Saved letter', none: 'None',
};
const list = (value: string) => value.split(',').map(v => names[v.trim()] ?? v.trim()).filter(Boolean).join(', ');
const decode = (value: string) => Buffer.from(value || '', 'base64').toString('utf8');
const money = (value: string) => Number(value) > 0 ? `A$${Number(value).toLocaleString('en-AU')}` : 'No minimum';

/** Uses the same per-account resolution and plan policy as scheduled runs. Read-only. */
export async function adminUserPreferences(userId: string, email: string): Promise<AdminPreferenceSection[]> {
  const entitlement = await entitlementsFor(userId, email);
  const [profile, snapshot, answers] = await Promise.all([
    loadProfile(userId), runSettingsSnapshotForUser(userId, { unlimited: entitlement.tier === 'admin' }), listAnswers(userId),
  ]);
  const { settings, saved } = snapshot;
  const effective = applyRunPolicy(settings, entitlement, 'auto', saved[PLATFORMS_CHOSEN_KEY] === '1', saved[EMPLOYER_SOURCES_CHOSEN_KEY] === '1');
  const field = (label: string, key: string, format: (v: string) => string = v => v, empty = 'Not set') => ({
    label, value: format(effective[key] ?? '') || empty,
    ...(saved[key] !== undefined && saved[key] !== effective[key]
      ? { note: `Saved preference: ${format(saved[key]) || empty}. The value above is used for scheduled runs.` } : {}),
  });
  const sections: AdminPreferenceSection[] = [
    { title: 'Search preferences', fields: [
      field('Search keywords', 'KEYWORDS'), field('Companies to avoid', 'EXCLUDED_COMPANIES', list, 'None'),
      field('Job sources', 'PLATFORMS', list, 'None selected'), field('Office city', 'ONSITE_CITY', v => v, 'No restriction'),
      field('Work arrangements', 'WORK_ARRANGEMENTS', list, 'Any'), field('Job types', 'JOB_TYPES', list, 'Any'),
      field('Search radius', 'SEARCH_RADIUS_KM', v => Number(v) > 0 ? `${v} km from home` : 'No distance restriction'),
      field('Minimum annual salary', 'MIN_SALARY', money), field('Minimum hourly rate', 'MIN_HOURLY_RATE', money),
      field('Minimum match', 'MIN_SCORE', v => `${v}%`), field('Maximum listing age', 'MAX_AGE_DAYS', v => `${v} days`),
      field('Daily application limit', 'MAX_APPS_PER_DAY'), field('Jobs reviewed per run', 'MAX_EVALUATIONS', v => !v || v === 'none' ? 'No limit' : v),
      { label: 'Scheduled runs per 24 hours', value: String(entitlement.autoRunsPerDay) },
    ] },
    { title: 'Custom instructions', fields: [field('Run instructions', 'AI_INSTRUCTIONS_B64', decode, 'None')] },
    { title: 'Cover letter preferences', fields: [
      field('Cover letter mode', 'COVER_LETTER_MODE', v => names[v] ?? v),
      field('Cover letter instructions', 'COVER_LETTER_INSTRUCTIONS', v => v, 'None'),
      field('Saved cover letter', 'COVER_LETTER_TEXT_B64', decode, 'None'),
    ] },
    { title: 'Profile details', fields: [
      ['Full name', profile.fullName], ['Application email', profile.email], ['Phone', profile.phone],
      ['Home suburb', profile.suburb], ['State', profile.state], ['Postcode', profile.postcode],
      ['Work rights', profile.workRights], ['Driver’s licence', profile.hasDriverLicence ? 'Yes' : 'No'],
      ['Willing to relocate', profile.willingToRelocate ? 'Yes' : 'No'], ['Willing to travel', profile.willingToTravel],
      ['Headline', profile.headline], ['Experience summary', profile.experienceSummary], ['Skills', profile.skills],
      ['Highest qualification', profile.highestQualification], ['Expected salary', profile.expectedSalary],
      ['Notice period', profile.noticePeriod], ['LinkedIn', profile.linkedin], ['Portfolio', profile.portfolio],
      ['Pronouns', profile.pronouns], ['Gender', profile.gender], ['Disability / adjustments', profile.disability],
      ['Referral source', profile.referralSource],
    ].map(([label, value]) => ({ label, value: value || 'Not provided' })) },
    { title: 'Saved application answers', fields: answers.filter(answer => !isCredentialQuestion(answer))
      .map(answer => ({ label: answer.question, value: answer.answer })) },
  ];
  const sources = EMPLOYER_SOURCES.filter(source => effective.PLATFORMS.split(',').includes(source.id));
  if (sources.length) sections.splice(1, 0, { title: 'Selected employer searches', fields: sources.map(source => field(source.label, source.key, v => v.split(',').join('\n'), 'None')) });
  return sections;
}
