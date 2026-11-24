import {isExternalApplicationUrl,jobBoardForUrl} from './job-board-url.js';

export interface GuestAccessProof {
 version:3;stage:'job-and-letter';access:'guest-confirmed'|'hosted-confirmed'|'registration-confirmed';
 checkedAt:string;checkedUrl:string;evidence:string;isolation:'no-employer-session';method:'form'|'email';
}
type AccessEvidence={preparation?:{version?:unknown;access?:unknown;isolation?:unknown;evidence?:unknown;checkedAt?:unknown;checkedUrl?:unknown;method?:unknown}};

/** Public direct-form sources for the free employer-site offer. The applier
 * still checks the actual form: a redirect must not turn into registration. */
export const GUEST_EMPLOYER_SOURCES = ['greenhouse'] as const;
export const GUEST_EMPLOYER_INSTRUCTION = 'GUEST EMPLOYER APPLICATIONS: Use direct or guest application forms only. Never create or recover an employer account. If the employer requires login or registration and offers no guest application, immediately finish skipped with that reason. Ordinary verification of an application email is allowed when it does not create an account. Reuse the candidate’s connected session for native job-board applications.';

/** A listing-only draft or a saved employer login never proves guest access. */
function confirmedPreparationEvidence(application:AccessEvidence):boolean {
 const proof=application.preparation;
 if(proof?.version!==3||proof.isolation!=='no-employer-session'||typeof proof.evidence!=='string'||!proof.evidence.trim()||typeof proof.checkedAt!=='string'||!Number.isFinite(Date.parse(proof.checkedAt))||typeof proof.method!=='string'||!['form','email'].includes(proof.method)||typeof proof.checkedUrl!=='string')return false;
 try{return new URL(proof.checkedUrl).protocol==='https:';}catch{return false;}
}
export function confirmedGuestPreparation(application:AccessEvidence):boolean {
 return confirmedPreparationEvidence(application)&&application.preparation?.access==='guest-confirmed'
  &&isExternalApplicationUrl(String(application.preparation.checkedUrl));
}
export function confirmedNativePreparation(application:AccessEvidence):boolean {
 if(!confirmedPreparationEvidence(application)||application.preparation?.access!=='hosted-confirmed')return false;
 const url=String(application.preparation.checkedUrl);
 return Boolean(jobBoardForUrl(url))&&!isExternalApplicationUrl(url);
}
export function confirmedRegistrationPreparation(application:AccessEvidence):boolean {
 return confirmedPreparationEvidence(application)&&application.preparation?.access==='registration-confirmed'
  &&application.preparation.method==='form'&&isExternalApplicationUrl(String(application.preparation.checkedUrl));
}

export function guestEmployerAccountRequired(url:string,guestOnly:boolean):boolean {
  if(!guestOnly)return false;
  return !jobBoardForUrl(url);
}
