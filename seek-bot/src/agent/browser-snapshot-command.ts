import {browserTargetProperties} from './browser-target.js';

/** Snapshot arguments for the single advertised browser_action operation. */
export const snapshotProperties = {screenshot:{type:'boolean'},...browserTargetProperties};

export function isSnapshotOperation(name:string,args:Record<string,unknown>):boolean {
  // Recognize the retired name only for historical traces and transcripts.
  return name==='take_snapshot'||name==='browser_action'&&args.action==='take_snapshot';
}

/** The snapshot action accepts only read-only snapshot arguments.
 * In particular, a read cannot carry a send intent or mutation arguments. */
export const snapshotActionContract = {
  type:'object',additionalProperties:false,
  properties:{action:{type:'string',enum:['take_snapshot']},...snapshotProperties},required:['action'],
};
