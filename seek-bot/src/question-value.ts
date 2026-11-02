import type { QuestionControl, QuestionInput } from './question-snapshot.js';

export const PATTERN_INPUTS = new Set<QuestionInput>(['text','search','tel','email','url']);
const TEXT_INPUTS = new Set<QuestionInput>([...PATTERN_INPUTS,'textarea']);
const numeric = (value: string): number | null => /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
  && Number.isFinite(Number(value)) ? Number(value) : null;
const dateNumber = (value: string): number | null => {
  const parts = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;
  const [,y,m,d] = parts, year=Number(y),month=Number(m),day=Number(d);
  if (year<1||month<1||month>12||day<1||day>31) return null;
  const date = new Date(Date.UTC(2000,month-1,day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day ? date.getTime()/86400000 : null;
};
const weekStart = (year:number):number|null => {
  const fourth=dateNumber(`${String(year).padStart(4,'0')}-01-04`);
  if(fourth===null)return null;
  return fourth-((fourth+3)%7+7)%7;
};
/** Numeric units match each HTML type's step unit. No locale or local timezone
 * participates in date-only/month/week values or datetime-local validation. */
export function questionValueNumber(kind:QuestionInput,value:string):number|null {
  if(kind==='number'||kind==='range')return numeric(value);
  if(kind==='date')return dateNumber(value);
  if(kind==='month') {
    const match=/^(\d{4,})-(\d{2})$/.exec(value);
    if(!match||Number(match[1])<1||Number(match[2])<1||Number(match[2])>12)return null;
    const months=(Number(match[1])-1970)*12+Number(match[2])-1;
    return Number.isSafeInteger(months)?months:null;
  }
  if(kind==='week') {
    const match=/^(\d{4,})-W(\d{2})$/.exec(value);
    if(!match)return null;
    const start=weekStart(Number(match[1])),next=weekStart(Number(match[1])+1),week=Number(match[2]);
    return start!==null&&next!==null&&week>=1&&week<=(next-start)/7?(start+3)/7+week-1:null;
  }
  if(kind==='time') {
    const match=/^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/.exec(value);
    if(!match||Number(match[1])>23||Number(match[2])>59||Number(match[3]??0)>59)return null;
    return Number(match[1])*3600+Number(match[2])*60+Number(match[3]??0)+Number(match[4]??0);
  }
  if(kind==='datetime-local') {
    const parts=value.split(/[T ]/);
    if(parts.length!==2)return null;
    const date=dateNumber(parts[0]),time=questionValueNumber('time',parts[1]);
    return date===null||time===null?null:date*86400+time;
  }
  return null;
}

export function questionValueIssue(control:QuestionControl,value:string):string|null {
  const {kind,constraints:x}=control;
  if(TEXT_INPUTS.has(kind)&&(x.maxLength!==undefined&&value.length>x.maxLength||x.minLength!==undefined&&value.length<x.minLength))return 'Check the answer length.';
  if(kind==='email') {
    const email=/^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    if(!(control.multiple?value.split(',').map(item=>item.trim()):[value]).every(item=>email.test(item)))return 'Enter a valid email address.';
  }
  if(kind==='url') {try{new URL(value);}catch{return 'Enter a valid website URL.';}}
  if(kind==='color'&&!/^#[a-f0-9]{6}$/i.test(value))return 'Choose a valid colour.';
  if(!['number','range','date','month','week','time','datetime-local'].includes(kind))return null;
  const number=questionValueNumber(kind,value);
  if(number===null)return 'Use a valid value in the requested format.';
  const min=questionValueNumber(kind,x.min??(kind==='range'?'0':''));
  const max=questionValueNumber(kind,x.max??(kind==='range'?'100':''));
  const wraps=kind==='time'&&min!==null&&max!==null&&min>max;
  if(wraps?number<min!&&number>max!:min!==null&&number<min||max!==null&&number>max)return 'Use a value in the allowed range.';
  if(x.step?.toLowerCase()==='any')return null;
  const step=(numeric(x.step??'')??0)>0?Number(x.step):['time','datetime-local'].includes(kind)?60:1;
  const base=min??questionValueNumber(kind,x.stepBase??'')??0;
  const quotient=(number-base)/step;
  if(Math.abs(quotient-Math.round(quotient))>1e-7)return 'Use the requested value interval.';
  return null;
}
