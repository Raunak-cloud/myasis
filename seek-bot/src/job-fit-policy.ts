import { config } from './config.js';
import type { CandidateProfile } from './types.js';

/** The same suitability rules accompany discovery, full review and application. */
export const JOB_FIT_POLICY = `Apply the candidate's saved preferences consistently at every stage.
Allowed work arrangements are an allowlist. If only onsite is selected, remote and hybrid roles are not allowed. A remote role may be based in another city only when remote is an allowed arrangement; this never overrides the arrangement selection. Onsite and hybrid roles must be based in the selected office city or its suburbs. Read the full description: an actual work location in the ad overrides an ambiguous search-card location. If an ad offers several arrangements or locations, an explicitly allowed option is sufficient.
The selected office city is explicit permission for in-person work there. Do not invent a relocation or commute conflict from the home suburb, an assumed distance, or unwillingness to relocate. Enforce a separately stated commute or radius restriction when present; do not invent one.
Current search keywords, target role and standing instructions define the work requested. Stay within those job functions unless current instructions explicitly broaden them. Synonyms and different titles for the same function are allowed; unrelated occupations are not. A CV describing another career never broadens current requested work. Judge the actual work against the candidate's intended role and search preferences. Transferable skills can support work the candidate is seeking, including an explicitly requested career change. Shared tools, generic technical skills or a similar title alone do not make a different job function a match. Do not widen the candidate's career direction on their behalf. Equally, do not reject relevant work merely because its title differs from a search keyword.
For bounded occupation intent, distinguish performing the requested function from supporting people who perform it. Maintaining its records, selling its products, scheduling its staff or supplying its systems does not by itself make a different occupation equivalent. Shared subject matter and an incidental requested duty cannot redefine the whole role. Compare all dominant deliverables, including those that do not match; do not select only the matching duty. Administrative steps integral to performing the requested work remain allowed, but a predominantly administrative role supporting that work needs its own current authorization.
Use the same candidate evidence for seniority and required skills. Distinguish essential requirements from desirable experience and training opportunities. Missing optional experience is not a mandatory conflict. Explicit candidate exclusions still govern. A high match score never overrides a clear preference or mandatory eligibility conflict.`;

export function jobPreferenceContext(profile: CandidateProfile): string {
  return [
    `- allowed arrangements: ${config.rules.workArrangements.join(', ') || 'any'}`,
    `- on-site city: ${config.rules.onsiteCity ? `${config.rules.onsiteCity} (on-site and hybrid roles must be based there; remote roles may be elsewhere only if remote is allowed)` : 'not restricted'}`,
    `- allowed job types: ${config.rules.jobTypes.join(', ') || 'any'}`,
    `- minimum annual salary for salaried roles: ${config.rules.minSalary > 0 ? config.rules.minSalary : 'none'}`,
    `- minimum hourly rate for hourly roles: ${config.rules.minHourlyRate > 0 ? config.rules.minHourlyRate : 'none'} (do not also require annual earnings from a casual or part-time hourly role)`,
    `- excluded domains: ${profile.excludedDomains?.join('; ') || 'none'}`,
  ].join('\n');
}
