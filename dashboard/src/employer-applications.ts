import {isEmployerSource} from '../../seek-bot/src/employer-source-config.js';

export const EMPLOYER_APPLICATIONS_ENABLED='EMPLOYER_APPLICATIONS_ENABLED';

/** Existing accounts stay enabled until their owner switches this off. */
export function employerApplicationsEnabled(settings:Record<string,string|undefined>):boolean {
 return settings[EMPLOYER_APPLICATIONS_ENABLED]!=='false';
}

/** Starting a board-only run must not erase employer sources saved for later. */
export function preserveEmployerSources(saved:string|undefined,requested:string,enabled:boolean):string {
 if(enabled)return requested;
 return [...new Set([...requested.split(',').map(id=>id.trim().toLowerCase()).filter(Boolean),...(saved??'').split(',').map(id=>id.trim().toLowerCase()).filter(isEmployerSource)])].join(',');
}
