import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { runDeadline } from './run-deadline.js';
import { TECHNICAL_RETRY_FILE, TECHNICAL_RETRY_REQUEST, TECHNICAL_RETRY_RESPONSE, type TechnicalRetryCandidate } from './technical-retry-types.js';

export function deferredTechnicalRetryKeys(): Set<string> {
  if(process.env.AUTO_TECHNICAL_RETRIES !== 'true')return new Set();
  try {
    const value=JSON.parse(readFileSync(resolve(config.dataDir,TECHNICAL_RETRY_FILE),'utf8'));
    return new Set(Array.isArray(value.keys)?value.keys.filter((key:unknown)=>typeof key==='string'):[]);
  }catch{return new Set();}
}

/** The dashboard claims existing owner records only after online matching falls short. */
export function claimTechnicalRetryFallback(shortfall: number,externalRemaining?:number): Promise<TechnicalRetryCandidate[]> {
  if(shortfall<=0 || !process.connected || process.env.AUTO_TECHNICAL_RETRIES!=='true' || runDeadline.reached)return Promise.resolve([]);
  const requestId=randomUUID();
  return new Promise(resolve=>{
    let settled=false;
    const finish=(rows:TechnicalRetryCandidate[])=>{
      if(settled)return;settled=true;
      process.off('message',receive);process.off('disconnect',disconnected);unwatch();resolve(rows);
    };
    const disconnected=()=>finish([]);
    const receive=(message:unknown)=>{
      const value=message as {type?:string;requestId?:string;candidates?:TechnicalRetryCandidate[]};
      if(value?.type===TECHNICAL_RETRY_RESPONSE && value.requestId===requestId)finish(Array.isArray(value.candidates)?value.candidates:[]);
    };
    let unwatch=()=>{};
    process.on('message',receive);process.once('disconnect',disconnected);
    unwatch=runDeadline.onReached(()=>finish([]));
    if(settled){unwatch();return;}
    process.send?.({type:TECHNICAL_RETRY_REQUEST,requestId,shortfall,...(Number.isFinite(externalRemaining)?{externalRemaining}: {})},error=>{if(error)finish([]);});
  });
}
