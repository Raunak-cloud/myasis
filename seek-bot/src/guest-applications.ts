import {jobBoardForHost} from './job-board-url.js';

/** Public direct-form sources for the free employer-site offer. The applier
 * still checks the actual form: a redirect must not turn into registration. */
export const GUEST_EMPLOYER_SOURCES = ['smartrecruiters','greenhouse'] as const;
export const GUEST_EMPLOYER_INSTRUCTION = 'FREE EMPLOYER APPLICATIONS: Use direct or guest application forms only. Never create or recover an employer account. If the employer requires login or registration and offers no guest application, immediately finish skipped with that reason. Ordinary verification of an application email is allowed when it does not create an account. Reuse the candidate’s connected SEEK session for SEEK-hosted applications.';

export function guestEmployerAccountRequired(url:string,guestOnly:boolean):boolean {
  if(!guestOnly)return false;
  try { return !jobBoardForHost(new URL(url).hostname); } catch { return true; }
}
