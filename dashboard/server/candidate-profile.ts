/**
 * The candidate's own details — shared shape between `profile.ts` (Postgres
 * CRUD, user-scoped) and `db/migrate-files.ts` (one-time import from the old
 * shared `profile.json`/`profile.txt`), so both agree on one interface and one
 * set of required-field rules instead of drifting apart.
 */
export interface CandidateProfile {
  fullName: string;
  email: string;
  phone: string;
  suburb: string;
  state: string;
  postcode: string;

  workRights: string;
  hasDriverLicence: boolean;
  willingToRelocate: boolean;
  willingToTravel: string;

  headline: string;
  experienceSummary: string;
  skills: string;
  highestQualification: string;

  expectedSalary: string;
  noticePeriod: string;

  linkedin: string;
  portfolio: string;

  pronouns: string;
  gender: string;
  disability: string;
  referralSource: string;
}

export const EMPTY_PROFILE: CandidateProfile = {
  fullName: '', email: '', phone: '', suburb: '', state: '', postcode: '',
  workRights: '', hasDriverLicence: false, willingToRelocate: false, willingToTravel: '',
  headline: '', experienceSummary: '', skills: '', highestQualification: '',
  expectedSalary: '', noticePeriod: '', linkedin: '', portfolio: '',
  pronouns: '', gender: '', disability: '', referralSource: 'Job board',
};

/** Which required fields are still blank — drives the setup checklist. */
export function profileGaps(p: CandidateProfile): string[] {
  const required: Array<[keyof CandidateProfile, string]> = [
    ['fullName', 'Full name'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['workRights', 'Work rights'],
    ['experienceSummary', 'Experience summary'],
  ];
  return required.filter(([k]) => !String(p[k] ?? '').trim()).map(([, label]) => label);
}
