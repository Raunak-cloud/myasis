import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runServiceDirectory } from '../run-service-protocol.js';
const path=()=>join(runServiceDirectory(),'hr-outreach-active.json');
export function markHrActive():()=>void {
  mkdirSync(runServiceDirectory(),{recursive:true,mode:0o700});
  writeFileSync(path(),JSON.stringify({pid:process.pid}),{mode:0o600});
  return ()=>rmSync(path(),{force:true});
}
export function hrActive():boolean {
  try{const {pid}=JSON.parse(readFileSync(path(),'utf8'));if(!Number.isSafeInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch{return false;}
}
