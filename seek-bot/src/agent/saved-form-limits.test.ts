import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'patchright';
import {readSavedForm} from './saved-form.js';

test('large and slow saved forms remain readable without exposing credentials',{timeout:60000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent('<label>Answer one<textarea></textarea></label><label>Answer two<textarea></textarea></label><label>Answer three<textarea></textarea></label><label>Password<input type="password" value="never-expose-this-secret"></label>');
  const answer='Full candidate answer. '.repeat(2500);
  for(const input of await page.locator('textarea').all())await input.fill(answer);
  const form=await readSavedForm(page);
  assert.ok(JSON.stringify(form).length>120000);
  assert.equal(form.fields.filter(field=>field.currentValue===answer).length,3);
  assert.ok(!JSON.stringify(form).includes('never-expose-this-secret'));
  const frame=page.mainFrame();const evaluate=frame.evaluate.bind(frame);
  let evaluations=0;
  frame.evaluate=(async(...args:unknown[])=>{if(++evaluations===2){await new Promise(resolve=>setTimeout(resolve,16050));}return (evaluate as (...args:unknown[])=>Promise<unknown>)(...args);}) as typeof frame.evaluate;
  const start=Date.now();
  const slow=await readSavedForm(page);
  assert.ok(Date.now()-start>=16000,'the actual form read outlasts the removed 15-second deadline');
  assert.equal(slow.fields.filter(field=>field.currentValue===answer).length,3);
  assert.ok(!JSON.stringify(slow).includes('never-expose-this-secret'));
 }finally{await browser.close();}
});
