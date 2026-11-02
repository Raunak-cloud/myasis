import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'patchright';
import { captureQuestion } from './question-capture.js';
import { extractEmployerQuestions } from './question-evidence.js';
import { observe } from './observe.js';
import type { ToolContext } from './context.js';
import { sealQuestionSnapshot } from '../question-snapshot-node.js';
import { questionResponseIssue, type QuestionControl } from '../question-snapshot.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{}) });
  const context=await browser.newContext();
  // Match launchBrowser's existing development-only esbuild shim without
  // opening a candidate profile. Compiled production gets no init script.
  if(import.meta.url.endsWith('.ts'))await context.addInitScript({content:'globalThis.__name ??= value => value;'});
  page = await context.newPage();
  // setContent deliberately has no HTTP response for Patchright to rewrite
  // with the dev init script. Install that same helper in this fixture world.
  if(import.meta.url.endsWith('.ts'))await page.evaluate('globalThis.__name ??= value => value;');
  await page.route('**/*',route=>route.abort());
});
after(async()=>browser?.close());
const capture=async(selector:string)=>page.locator(selector).evaluate(captureQuestion);

test('official hidden ARIA labels and descriptions survive the complete evidence boundary',async()=>{
  await page.setContent('<span id="q" hidden>When can you start work?</span><span id="help" hidden>Use your earliest available date.</span><input id="date" type="date" aria-labelledby="q" aria-describedby="help" required>');
  const result=await capture('#date');
  assert.equal(result?.prompt,'When can you start work?');
  assert.deepEqual(result?.help,['Use your earliest available date.']);
  const ctx={page,observation:await observe(page)} as ToolContext;
  const captured=await extractEmployerQuestions(ctx,[{field_ref:ctx.observation.fields[0].ref}]);
  assert.equal(captured.issue,undefined);
  assert.equal(captured.questions?.[0].snapshot?.prompt,result.prompt);
});

test('custom radio and checkbox names may come from their own visible contents',async()=>{
  await page.setContent('<div role="radiogroup" aria-label="Current clearance"><div role="radio" tabindex="0" aria-checked="false">None</div><div role="radio" tabindex="-1" aria-checked="false">NV2</div></div>');
  const radio=await capture('[role="radio"]:first-child');
  assert.equal(radio?.completeness,'complete');
  assert.deepEqual(radio?.controls[0].choices.map(o=>o.label),['None','NV2']);
  await page.setContent('<div role="group" aria-label="Available days"><div role="checkbox" tabindex="0" aria-checked="false">Monday</div><div role="checkbox" tabindex="0" aria-checked="false">Tuesday</div></div>');
  assert.deepEqual((await capture('[role="checkbox"]:first-child'))?.controls[0].choices.map(o=>o.label),['Monday','Tuesday']);
});

test('separate named forms cannot merge identical date questions',async()=>{
  await page.setContent('<form aria-label="Current employment"><fieldset><legend>Start date</legend><label>Month<input id="current"></label><label>Year<input></label></fieldset></form><form aria-label="Previous employment"><fieldset><legend>Start date</legend><label>Month<input id="previous"></label><label>Year<input></label></fieldset></form>');
  const current=await capture('#current'),previous=await capture('#previous');
  assert.ok(current);assert.ok(previous);
  assert.deepEqual(current.context,['Current employment']);
  assert.deepEqual(previous.context,['Previous employment']);
  assert.notEqual(sealQuestionSnapshot(current).id,sealQuestionSnapshot(previous).id);
});

test('a native radio catalog extending outside its apparent question cannot claim completeness',async()=>{
  await page.setContent('<form><fieldset><legend>Current permission</legend><label><input id="one" type="radio" name="shared">Yes</label><label><input type="radio" name="shared">No</label></fieldset><fieldset><legend>Previous permission</legend><label><input type="radio" name="shared">Yes</label><label><input type="radio" name="shared">No</label></fieldset></form>');
  assert.notEqual((await capture('#one'))?.completeness,'complete');
});

test('open shadow controls retain outer groups and slotted original labels',async()=>{
  await page.setContent('<fieldset><legend>Employment start</legend><div id="host"><span slot="caption">Month</span></div></fieldset>');
  await page.locator('#host').evaluate(e=>{e.attachShadow({mode:'open'}).innerHTML='<label for="month"><slot name="caption"></slot></label><input id="month" type="month" required>';});
  const result=await capture('#month');
  assert.equal(result?.prompt,'Employment start');
  assert.equal(result.controls[0].label,'Month');
  assert.equal(result.controls[0].kind,'month');
});

test('display:contents labels are labels, not hidden questions',async()=>{
  await page.setContent('<label style="display:contents">Available from<input id="date" type="date"></label>');
  assert.equal((await capture('#date'))?.prompt,'Available from');
});

test('read-only date fields and empty custom catalogs cannot masquerade as answerable controls',async()=>{
  await page.setContent('<label>Start date<input id="date" type="date" readonly></label><div role="combobox" aria-label="Location">Choose<select hidden></select></div>');
  assert.equal((await capture('#date'))?.completeness,'recapture');
  assert.equal((await capture('[role="combobox"]'))?.completeness,'recapture');
});

test('a field changed into authentication after observation cannot become a saved personal question',async()=>{
  await page.setContent('<label id="label">Reference code<input id="code" name="reference"></label>');
  const ctx={page,observation:await observe(page)} as ToolContext;
  const ref=ctx.observation.fields[0].ref;
  await page.locator('#code').evaluate(node=>{node.setAttribute('name','verificationcode');(node as HTMLInputElement).value='PRIVATE_CURRENT_CODE';node.parentElement!.firstChild!.textContent='Verification code';});
  const result=await extractEmployerQuestions(ctx,[{field_ref:ref}]);
  assert.ok(result.issue);assert.equal(result.questions,undefined);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CURRENT_CODE'),false);
});

test('typed values agree with native browser format/range/step rules across edge cases',async()=>{
  const cases:Array<{kind:QuestionControl['kind'];value:string;constraints:QuestionControl['constraints']}>=[
    ...['0000-01-01','0030-02-28','1900-02-29','2000-02-29','2026-04-31','2026-11-03'].map(value=>({kind:'date' as const,value,constraints:{}})),
    ...['2026-W53','2020-W53','2026-W00','2021-W53','2024-W01'].map(value=>({kind:'week' as const,value,constraints:{}})),
    ...['23:59:60','23:59:59','10:00:00.001','10:00','24:00'].map(value=>({kind:'time' as const,value,constraints:{}})),
    ...['01:00','22:00','23:30'].map(value=>({kind:'time' as const,value,constraints:{min:'23:00',max:'02:00'}})),
    {kind:'date',value:'2026-11-04',constraints:{min:'2026-11-03',step:'2'}},
    {kind:'date',value:'2026-11-05',constraints:{min:'2026-11-03',step:'2'}},
    {kind:'month',value:'2026-02',constraints:{step:'3'}},
    {kind:'month',value:'2026-04',constraints:{step:'3'}},
    {kind:'number',value:'0.5',constraints:{stepBase:'0.5'}},
    {kind:'number',value:'1.5',constraints:{stepBase:'0.5'}},
    {kind:'number',value:'1.5',constraints:{step:'0'}},
    {kind:'number',value:'0x12',constraints:{}},
    {kind:'number',value:'1.',constraints:{}},
    {kind:'number',value:'1.2e2',constraints:{maxLength:1}},
    {kind:'number',value:'123',constraints:{min:'invalid',max:'invalid'}},
    {kind:'datetime-local',value:'2026-11-03T10:30:01',constraints:{}},
    {kind:'datetime-local',value:'2026-11-03T10:30:01',constraints:{step:'any'}},
    {kind:'url',value:'mailto:candidate@example.test',constraints:{}},
    {kind:'email',value:'candidate@example',constraints:{}},
    {kind:'email',value:'candidate@-invalid.test',constraints:{}},
  ];
  for(const item of cases) {
    const control:QuestionControl={id:'part0',label:'Original question',kind:item.kind,required:true,multiple:false,choices:[],constraints:item.constraints};
    const schema=sealQuestionSnapshot({version:2,source:{origin:'https://employer.test',path:'/apply'},prompt:control.label,context:[],help:[],completeness:'complete',controls:[control]});
    const native=await page.evaluate(({kind,value,constraints})=>{
      const input=document.createElement('input');input.type=kind;input.required=true;
      for(const [key,setting] of Object.entries(constraints))input.setAttribute(key==='stepBase'?'value':key,String(setting));
      input.value=value;
      return input.value!==''&&input.checkValidity();
    },item);
    assert.equal(questionResponseIssue(schema,{part0:item.value})===null,native,JSON.stringify(item));
  }
});
