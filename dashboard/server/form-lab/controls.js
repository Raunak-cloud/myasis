function formControls(spec,seed,index,embedded,base){
 const q=s=>document.querySelector(s),all=s=>[...document.querySelectorAll(s)];
 let r=seed+index*121;const later=fn=>{r^=r<<13;r^=r>>>17;r^=r<<5;return setTimeout(fn,250+(r>>>0)%1150);};
 function wire(){
  for(const f of spec.groups.flatMap(g=>g.fields)){
   if(f.kind==='multi')all(`[name="${f.name}"]`).forEach(el=>el.required=false);
   if(f.kind==='combo'){
    const input=q(`[name="${f.name}Text"]`),hidden=q(`[name="${f.name}"]`),menu=q('#menu-'+f.name);let version=0;
    const open=()=>{const current=++version;hidden.value='';input.setAttribute('aria-expanded','true');menu.textContent='Searching...';later(()=>{if(current!==version)return;menu.replaceChildren(...f.options.filter(v=>v.toLowerCase().includes(input.value.toLowerCase())).map(v=>{const option=document.createElement('div');option.role='option';option.tabIndex=0;option.textContent=v;option.onclick=()=>{hidden.value=v;input.value=v;input.setAttribute('aria-expanded','false');menu.replaceChildren();input.dispatchEvent(new Event('change',{bubbles:true}));};option.onkeydown=e=>{if(e.key==='Enter')option.click();};return option;}));});};
    input.oninput=open;input.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();menu.querySelector('[role=option]')?.focus();}};
   }
   if(f.kind==='dependent'){
    const parent=q(`[name="${f.parent}"]`);parent.onchange=()=>{const previous=q(`[name="${f.name}"]`);previous.disabled=true;previous.innerHTML='<option>Loading regions...</option>';later(()=>{const fresh=previous.cloneNode(false);fresh.disabled=false;fresh.innerHTML='<option value="">Choose...</option>'+f.options.map(v=>'<option>'+v+'</option>').join('');previous.replaceWith(fresh);q('#status').textContent='Regions loaded. Select your region.';});};
   }
   if(f.conditional){const update=()=>{const checked=q(`[name="${f.conditional.parent}"]:checked`);const el=q(`[name="${f.name}"]`);el.closest('[data-condition]').hidden=checked?.value!==f.conditional.value;el.disabled=checked?.value!==f.conditional.value;};all(`[name="${f.conditional.parent}"]`).forEach(el=>el.addEventListener('change',update));update();}
   if(f.kind==='editor')q(`[data-editor="${f.name}"]`).oninput=e=>{q(`[name="${f.name}"]`).value=e.target.innerText.trim();};
   if(f.kind==='file')q(`[name="${f.name}"]`).onchange=e=>{const status=q(`[data-upload="${f.name}"]`);e.target.dataset.uploadReady='false';status.textContent='Scanning files...';later(()=>{e.target.dataset.uploadReady='true';status.textContent=[...e.target.files].map(file=>file.name).join(', ')+' - ready';});};
  }
  const same=q('[name=sameAddress]');if(same)same.onchange=()=>{for(const el of all('[data-copy]')){const source=q(`[name="${el.dataset.copy}"]`);el.value=same.checked?source.value:'';el.readOnly=same.checked;}};
 }
 class Consent extends HTMLElement{connectedCallback(){if(this.shadowRoot)return;const root=this.attachShadow({mode:'open'});root.innerHTML='<style>label{display:block;padding:16px;border:1px solid #7f9ab0;font:16px system-ui}input{margin-right:12px}</style><label><input type="checkbox">'+this.dataset.label+' *</label>';root.querySelector('input').onchange=e=>{q(`[name="${this.dataset.name}"]`).value=e.target.checked?'on':'';};}}
 customElements.define('hard-consent',Consent);
 const initial=()=>{wire();q('#form').hidden=!!spec.addRows;q('#loading').hidden=true;if(spec.addRows)q('#add').disabled=false;};later(initial);
 if(spec.addRows){q('#form').hidden=true;q('#add').disabled=true;q('#add').onclick=()=>{q('#add').disabled=true;later(()=>{q('#form').hidden=false;q('#status').textContent='Qualification row added.';});};}
 // A delayed component refresh changes DOM identity while retaining user data.
 if(index===0||index===6)setTimeout(()=>{const field=q('input[type=text]');if(field){const fresh=field.cloneNode(true);fresh.value=field.value;field.replaceWith(fresh);q('#status').textContent='Draft component refreshed; entered text retained.';}},1750);
 q('#draft').onclick=()=>{q('#status').textContent='Draft saved. This does not complete the page.';};
 q('form').onsubmit=async event=>{
  event.preventDefault();if(spec.addRows&&q('#form').hidden)return;
  if(all('input[type=file]').some(el=>el.files.length&&el.dataset.uploadReady!=='true')){q('#feedback').textContent='Files are still scanning. Wait until each attachment says ready, then try Continue.';return;}
  const button=q('#continue');button.disabled=true;q('#status').textContent='Saving...';
  try{const response=await fetch(base+'/save/'+(index+1),{method:'POST',body:new FormData(event.target)}),result=await response.json();if(!response.ok){q('#feedback').textContent=result.error;return;}q('#status').textContent='Saved successfully.';if(embedded){parent.postMessage({type:'hard-compliance-saved'},'*');button.textContent='Saved';}else location.href=result.next;}
  catch{q('#feedback').textContent='The server could not be reached. Your entries are retained. Retry Continue.';}
  finally{button.disabled=false;}
 };
}
