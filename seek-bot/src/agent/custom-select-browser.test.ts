import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'patchright';
import {nativeReadback,nativeSelect} from './native-browser.js';
import {observe,renderObservation} from './observe.js';
import {SpecialistRecovery} from './specialist-recovery.js';

test('async portalled combobox commits the exact chosen option, survives blur and exposes its rendered selection',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent(`<label for=school>School*</label><div class=select__value-container><span id=chosen class=select__single-value></span><div><input id=school role=combobox aria-expanded=false aria-invalid=true aria-required=true></div></div>
   <div role=listbox><div role=option onclick="document.body.dataset.wrong='yes'">Other</div></div><button id=next>Next</button>
   <label for=native>Native choice</label><select id=native><option value=a>Native A</option><option value=b>Native B</option></select>
   <script>
   const input=document.querySelector('#school');
   input.onclick=()=>{input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls','school-menu');};
   input.oninput=()=>{if(input.getAttribute('aria-expanded')!=='true')return;document.querySelector('#school-menu')?.remove();
    const query=input.value;setTimeout(()=>{if(input.value!==query)return;
     const menu=document.createElement('div');menu.id='school-menu';menu.setAttribute('role','listbox');
     for(const label of ['Christian Brothers University','Other']){if(!label.toLowerCase().includes(query.toLowerCase()))continue;
      const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
      option.onclick=()=>{document.querySelector('#chosen').textContent=label;input.value='';input.setAttribute('aria-expanded','false');input.setAttribute('aria-invalid','false');menu.remove();};menu.append(option);}
     document.body.append(menu);},75);};
   input.onblur=()=>{if(!document.querySelector('#chosen').textContent)input.value='';};
   </script>`);
  const school=page.locator('#school');
  await school.fill('SHIATS');
  const searching=await observe(page);
  const search=searching.fields.find(field=>field.hints?.includes('id=school'))!;
  assert.equal(search.currentValue,'','typed query is not a saved school in the canonical reader');
  assert.equal(search.searchValue,'SHIATS');assert.equal(search.selectionState,'searching');
  assert.match(renderObservation(searching),/query is not a saved answer/);
  await page.locator('#next').click();
  assert.equal((await nativeReadback(school) as any).invalid,'true','search text is not a school selection');
  const recovery=new SpecialistRecovery();recovery.observe(await observe(page));
  const goal={kind:'field-value',target:search.label.replace(/\s*\*$/,' *'),value:'Other'};
  recovery.accept('READ-ONLY SPECIALIST ADVICE.\n'+JSON.stringify({advice:'Choose the observed Other option.',recovery_goal:goal}));
  let ticket=JSON.parse(recovery.render().match(/RECOVERY ADVISORY\n([^\n]+)/)![1]);
  recovery.respond({advice_id:ticket.advice_id,decision:'adopt',reason:'Other is the offered truthful fallback.',observation_id:ticket.observation_id,operation_tool:'browser_action',operation_action:'select',operation_purpose:'Commit the observed Other choice.',verification:goal},[{name:'browser_action',description:'Native select',parameters:{type:'object',properties:{action:{enum:['select']}}}}]);
  await nativeSelect(school,'Other');
  const selected=await nativeReadback(school) as any;
  assert.equal(selected.value,'','React search input clears after a committed selection');
  assert.equal(selected.widgetText,'Other');assert.equal(selected.invalid,'false');
  assert.equal(selected.committedValue,'Other');assert.equal(selected.selectionState,'selected');
  const committed=await observe(page),field=committed.fields.find(field=>field.hints?.includes('id=school'))!;
  assert.equal(field.currentValue,'Other','canonical observer and native action readback agree');
  assert.equal(field.searchValue,'');assert.equal(field.selectionState,'selected');
  recovery.complete('browser_action',{action:'select',selector:'#school',value:'Other'},JSON.stringify(selected),false,true);recovery.observe(committed);
  ticket=JSON.parse(recovery.render().match(/RECOVERY ADVISORY\n([^\n]+)/)![1]);
  assert.match(recovery.check({advice_id:ticket.advice_id,observation_id:ticket.observation_id,result_id:ticket.result_id,assessment:'progress',reason:'The actual committed school is Other after blur.'}),/goal currently observed: true/);
  assert.equal(await page.locator('body').getAttribute('data-wrong'),null,'an unrelated portal option is never selected');
  await nativeSelect(page.locator('#native'),'Native B');
  assert.equal(await page.locator('#native').inputValue(),'b');
  await assert.rejects(nativeSelect(school,'Unlisted University'),/Timeout/);
  assert.equal(await page.locator('#chosen').innerText(),'Other','no unrelated school or automatic fallback is invented');
  await page.setContent('<label for=skills>Skills</label><div class=select__value-container><span class=select__multi-value__label>SQL</span><span class=select__multi-value__label>Python</span><input id=skills role=combobox value="New search"></div><label for=free>Free entry</label><input id=free role=combobox value="Permitted free text">');
  const tags=await observe(page);
  const skills=tags.fields.find(field=>field.hints?.includes('id=skills'))!;
  assert.equal(skills.currentValue,'SQL, Python','multi-select chips stay committed while a new query is typed');
  assert.equal(skills.searchValue,'New search');
  assert.equal((await nativeReadback(page.locator('#skills')) as any).committedValue,skills.currentValue);
  assert.equal(tags.fields.find(field=>field.hints?.includes('id=free'))?.currentValue,'Permitted free text','unrecognised free-entry combobox semantics are preserved');
 }finally{await browser.close();}
});
