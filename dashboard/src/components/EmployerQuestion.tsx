import { useId, useState } from 'react';
import type { QuestionControl, QuestionResponse, QuestionSnapshot, QuestionValue } from '../../../seek-bot/src/question-snapshot';
import { questionAnswerable } from '../../../seek-bot/src/question-snapshot';
import { dateAutocomplete, dateInputKind, splitDateInput } from '../question-date';

function Control({control:c,value,hideLabel,prompt,onChange}:{control:QuestionControl;value:QuestionValue|undefined;hideLabel:boolean;prompt?:string;onChange:(v:QuestionValue)=>void}) {
  const id=useId();
  const labelClass=hideLabel?'sr-only':undefined;
  // Partial saves are allowed: requiredness is checked per submitted snapshot,
  // so another untouched question must not prevent saving completed answers.
  const shared={id,disabled:false};
  // Patterns remain data and run only in a bounded server worker.
  const htmlConstraints={min:c.constraints.min,max:c.constraints.max,step:c.constraints.step,minLength:c.constraints.minLength,accept:c.constraints.accept};
  if(c.kind==='radio'||c.kind==='checkbox-group')return <fieldset className="employer-choices"><legend className={labelClass}>{c.label}</legend>{c.choices.map(o=><label key={o.id} className="employer-choice"><input type={c.kind==='radio'?'radio':'checkbox'} name={id} value={o.id} disabled={o.disabled} checked={Array.isArray(value)?value.includes(o.id):value===o.id} onChange={e=>onChange(c.kind==='radio'?o.id:e.target.checked?[...(Array.isArray(value)?value:[]),o.id]:(Array.isArray(value)?value:[]).filter(v=>v!==o.id))}/><span>{o.label}</span></label>)}</fieldset>;
  if(c.kind==='checkbox')return <label className="employer-choice"><input {...shared} type="checkbox" ref={node=>{if(node)node.indeterminate=value===undefined;}} checked={value===true} onChange={e=>onChange(e.target.checked)}/><span>{c.label}</span></label>;
  if(c.kind==='select') {
    const groups:Array<{name?:string;choices:typeof c.choices}>=[];
    for(const o of c.choices){const last=groups[groups.length-1];if(last&&last.name===o.group)last.choices.push(o);else groups.push({name:o.group,choices:[o]});}
    const options=groups.map((g,i)=>{const nodes=g.choices.map(o=><option key={o.id} value={o.id} disabled={o.disabled} hidden={o.hidden}>{o.label}</option>);return g.name?<optgroup key={i} label={g.name}>{nodes}</optgroup>:nodes;});
    return <label htmlFor={id}><span className={labelClass}>{c.label}</span><select {...shared} className="input" size={c.constraints.size} multiple={c.multiple} value={c.multiple?(Array.isArray(value)?value:[]):typeof value==='string'?value:''} onChange={e=>onChange(c.multiple?[...e.target.selectedOptions].map(o=>o.value):e.target.value)}>{!c.multiple&&<option value="" disabled>Choose…</option>}{options}</select></label>;
  }
  if(c.kind==='textarea')return <label htmlFor={id}><span className={labelClass}>{c.label}</span><textarea {...shared} className="input" rows={3} minLength={c.constraints.minLength} maxLength={Math.min(c.constraints.maxLength??4000,4000)} value={typeof value==='string'?value:''} onChange={e=>onChange(e.target.value)}/></label>;
  const date = dateInputKind(c, prompt);
  return <label htmlFor={id}><span className={labelClass}>{c.label}</span><input {...shared} {...htmlConstraints} {...date} className="input" multiple={c.multiple} maxLength={Math.min(c.constraints.maxLength??4000,4000)} value={typeof value==='string'?value:''} onChange={e=>onChange(e.target.value)}/></label>;
}

export function DateQuestion({ prompt, calendar, value, onChange }: {
  prompt: string;
  calendar: NonNullable<ReturnType<typeof splitDateInput>>;
  value: QuestionResponse;
  onChange: (response: QuestionResponse) => void;
}) {
  const errorId = useId();
  const [invalidDate, setInvalidDate] = useState('');
  function selectDate(date: string) {
    const response = calendar.write(date);
    setInvalidDate(response ? '' : date);
    onChange(response ?? {});
  }
  return <>
    <input type="date" className="input" aria-label={prompt} autoComplete={dateAutocomplete(prompt)}
      value={invalidDate || calendar.read(value)} onChange={event => selectDate(event.target.value)}
      aria-invalid={invalidDate ? true : undefined} aria-describedby={invalidDate ? errorId : undefined}/>
    {invalidDate && <small id={errorId} role="alert">Choose a date the employer accepts.</small>}
  </>;
}

export function EmployerQuestion({snapshot:s,value,onChange}:{snapshot:QuestionSnapshot;value:QuestionResponse;onChange:(v:QuestionResponse)=>void}) {
  const single=s.controls.length===1&&s.controls[0].label===s.prompt;
  const calendar = splitDateInput(s.controls);
  return <fieldset className="employer-question">
    <legend className={single && s.controls[0].kind === 'checkbox' ? 'sr-only' : undefined}>{s.prompt}</legend>
    {s.context.length > 0 && <div className="job-meta">{s.context.join(' · ')}</div>}
    {s.help.map((text, index) => <div key={index} className="job-meta">{text}</div>)}
    {!questionAnswerable(s) ? <p className="job-meta">The original form needs to be captured again before you can answer.</p>
      : calendar ? <DateQuestion prompt={s.prompt} calendar={calendar} value={value} onChange={onChange}/>
      : s.controls.map(c => <Control key={c.id} control={c} hideLabel={single} prompt={s.controls.length === 1 ? s.prompt : undefined}
        value={value[c.id]} onChange={v => onChange({ ...value, [c.id]: v })}/>)}
  </fieldset>;
}
