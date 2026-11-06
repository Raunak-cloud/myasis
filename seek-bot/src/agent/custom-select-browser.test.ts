import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'patchright';
import {nativeReadback,nativeSelect} from './native-browser.js';

test('async portalled combobox commits the exact chosen option, survives blur and exposes its rendered selection',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent(`<label>School</label><div><span id=chosen></span><div><input id=school role=combobox aria-expanded=false aria-invalid=true></div></div>
   <div role=listbox><div role=option onclick="document.body.dataset.wrong='yes'">Other</div></div><button id=next>Next</button>
   <select id=native><option value=a>Native A</option><option value=b>Native B</option></select>
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
  await school.fill('SHIATS');await page.locator('#next').click();
  assert.equal((await nativeReadback(school) as any).invalid,'true','search text is not a school selection');
  await nativeSelect(school,'Other');
  const selected=await nativeReadback(school) as any;
  assert.equal(selected.value,'','React search input clears after a committed selection');
  assert.equal(selected.widgetText,'Other');assert.equal(selected.invalid,'false');
  assert.equal(await page.locator('body').getAttribute('data-wrong'),null,'an unrelated portal option is never selected');
  await nativeSelect(page.locator('#native'),'Native B');
  assert.equal(await page.locator('#native').inputValue(),'b');
  await assert.rejects(nativeSelect(school,'Unlisted University'),/Timeout/);
  assert.equal(await page.locator('#chosen').innerText(),'Other','no unrelated school or automatic fallback is invented');
 }finally{await browser.close();}
});
