import { Worker } from 'node:worker_threads';
import { PATTERN_INPUTS } from './question-value.js';
import type { QuestionResponse, QuestionSnapshot } from './question-snapshot.js';

/** Employer patterns are untrusted code. Match HTML's Unicode-set, anchored
 * expressions in a bounded worker, never in the API server's event loop. */
export async function questionPatternIssue(answers:Array<{snapshot:QuestionSnapshot;response:QuestionResponse}>,timeoutMs=1000):Promise<string|null> {
  const checks=answers.flatMap(({snapshot,response})=>snapshot.controls.flatMap(control=>{
    const value=response[control.id];
    return PATTERN_INPUTS.has(control.kind)&&control.constraints.pattern!==undefined&&typeof value==='string'&&value
      ? [{pattern:control.constraints.pattern,values:control.kind==='email'&&control.multiple?value.split(',').map(item=>item.trim()):[value]}]:[];
  }));
  if(!checks.length)return null;
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    let valid=true;
    for(const {pattern,values} of workerData) {
      let regex;
      try {new RegExp(pattern,'v');regex=new RegExp('^(?:'+pattern+')$','v');}
      catch {continue;} // Invalid HTML patterns do not impose a constraint.
      if(!values.every(value=>regex.test(value))){valid=false;break;}
    }
    parentPort.postMessage(valid);
  `,{eval:true,workerData:checks,resourceLimits:{maxOldGenerationSizeMb:24,maxYoungGenerationSizeMb:8,stackSizeMb:4}});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await new Promise<string|null>(resolve=>{
      worker.once('message',valid=>resolve(valid===true?null:'Use the answer format requested by the employer.'));
      worker.once('error',()=>resolve('The employer answer format could not be validated safely. Your answers have not been saved.'));
      worker.once('exit',code=>{if(code!==0)resolve('The employer answer format could not be validated safely. Your answers have not been saved.');});
      timer=setTimeout(()=>resolve('The employer answer format exceeded its validation time limit. Your answers have not been saved.'),timeoutMs);
    });
  }finally{if(timer)clearTimeout(timer);await worker.terminate();}
}
