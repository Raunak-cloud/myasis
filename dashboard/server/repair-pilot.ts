export * from '../../seek-bot/src/repair-pilot.js';

/** Admission closes for the whole deployment. Existing workers can still use
 * their immutable repair builds while draining; shared files change only after
 * they exit. Empty/unknown markers retain the conservative legacy behavior. */
export function deploymentAllowsLiveRepair(marker:string|null):boolean {
  return marker===null||marker.trim()==='draining';
}

/** A diagnostic alone cannot authorize loading code into a live worker. The
 * worker must have yielded its browser and explicitly be waiting for repair. */
export function waitingRepairCheckpoint(runId:string,attemptId:string,events:Array<Record<string,unknown>>,now=Date.now()):boolean {
  const mine=events.filter(e=>e.runStartId===runId&&e.relatedAttemptId===attemptId);
  if(mine.some(e=>['repair_expired','repair_cancelled','repair_resume_error','repair_completed'].includes(String(e.category))))return false;
  return mine.some(e=>e.category==='repair_waiting'&&typeof e.at==='string'&&Number.isFinite(Date.parse(e.at))
    &&now>=Date.parse(e.at)&&now-Date.parse(e.at)<=6*60_000);
}
