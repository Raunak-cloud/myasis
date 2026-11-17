import {one,query} from './db/index.js';
import {readSiteState,type SeekState} from './seek-state.js';
import {FREE_APPLICATIONS} from '../src/pricing.js';
import {SEEK_CONNECTION_APPLICATIONS,type FreeTrialOffer} from '../src/free-trial.js';

export function verifiedSeekConnection(state:SeekState|null):boolean {
  return state?.signedIn===true && state.source==='run' && Boolean(state.account?.trim());
}

/** Only an observed owner-profile SEEK session earns the once-per-account reward.
 * Disconnecting never revokes earned credits and reconnecting never adds more. */
export async function freeTrialOffer(userId:string):Promise<FreeTrialOffer|undefined> {
  const trial=await one<{seek_connected_at:Date|null}>('SELECT seek_connected_at FROM new_user_trials WHERE user_id=$1',[userId]);
  if(!trial)return;
  if(!trial.seek_connected_at){
    const state=readSiteState(userId,'seek');
    if(verifiedSeekConnection(state)){
      const rows=await query(`UPDATE new_user_trials SET seek_connected_at=now(),seek_account=$2 WHERE user_id=$1 AND seek_connected_at IS NULL RETURNING user_id`,[userId,state!.account!.trim()]);
      // Another verification can have awarded the same grant concurrently.
      if(rows.length || (await one<{seek_connected_at:Date|null}>('SELECT seek_connected_at FROM new_user_trials WHERE user_id=$1',[userId]))?.seek_connected_at)trial.seek_connected_at=new Date();
    }
  }
  return {employerSites:true,seekBonusApplications:SEEK_CONNECTION_APPLICATIONS,seekBonusAwarded:Boolean(trial.seek_connected_at)};
}

export function freeApplicationAllowance(trial:{seek_connected_at:unknown}|null|undefined):number {
  return FREE_APPLICATIONS+(trial?.seek_connected_at?SEEK_CONNECTION_APPLICATIONS:0);
}
