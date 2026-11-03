import {browserTargetProperties} from './browser-target.js';

/** Both advertised spellings use the same read-only snapshot operation. */
export const snapshotProperties = {screenshot:{type:'boolean'},...browserTargetProperties};

export function isSnapshotOperation(name:string,args:Record<string,unknown>):boolean {
  return name==='take_snapshot'||name==='browser_action'&&args.action==='take_snapshot';
}

/** The compatibility action accepts only the standalone snapshot arguments.
 * In particular, a read cannot carry a send intent or mutation arguments. */
export const snapshotActionContract = {
  type:'object',additionalProperties:false,
  properties:{action:{type:'string',enum:['take_snapshot']},...snapshotProperties},required:['action'],
};
