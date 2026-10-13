const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const style = `<style>body{font:16px system-ui;color:#183043;background:#f3f7fb;padding:24px}main{max-width:720px;margin:auto;background:white;padding:28px;border-radius:14px}label{display:block;font-weight:650;margin:12px 0}input{padding:10px;border:1px solid #8aa0b3;border-radius:6px;width:280px;font:inherit}ul{list-style:none;padding:0;margin:8px 0;max-width:320px}li{padding:12px;border:1px solid #ccd9e4;cursor:pointer;background:#edf5ff}li:hover{background:#d5e7ff}small{color:#536c80}.error{color:#9d361e}fieldset{border:0;padding:0;margin:14px 0}iframe{width:100%;height:460px;border:0}</style>`;

function widget({choices=['Lidcombe North','Lidcombe'],label='Suburb',value='Lidcombe',delay=0,broken=false,portal=false,stale=false}={}) {
 const options = choices.map(choice => {
  const commit = `const input=this.getRootNode().querySelector('#target');${broken
   ? `this.getRootNode().querySelector('#status').textContent='Selection service unavailable; no selection was saved.';`
   : `this.getRootNode().querySelector('#status').textContent='Checking selection…';setTimeout(()=>{input.value=${JSON.stringify(choice)};input.setAttribute('data-committed',${JSON.stringify(choice)});input.setAttribute('aria-invalid','false');input.setAttribute('aria-expanded','false');input.getRootNode().querySelector('#choices').hidden=true;input.getRootNode().querySelector('#status').textContent='Selection accepted.';},${delay});`}`;
  return `<li tabindex="0" onclick="${esc(commit)}" onkeydown="if(event.key==='Enter')this.click()">${esc(choice)}</li>`;
 }).join('');
 const popup=`<div id="choices"><ul>${options}</ul></div>`;
 const field=`<fieldset><label for="target">${esc(label)} *</label><div><input id="target" value="${esc(value)}" required role="combobox" aria-controls="choices" aria-expanded="true" aria-invalid="true"><p id="status" class="error">Select an item to save this field.</p>${portal?'':popup}</div></fieldset>`;
 const rerender=stale ? `<script>new MutationObserver((rows,observer)=>{if(rows.some(row=>row.attributeName==='data-owt-recovery-ref')){observer.disconnect();setTimeout(()=>{const old=document.querySelector('#choices');const next=old.cloneNode(true);next.querySelectorAll('[data-owt-recovery-ref]').forEach(el=>el.removeAttribute('data-owt-recovery-ref'));old.replaceWith(next);document.querySelector('#status').textContent='The suggestion list refreshed; select from the current list.';},80);}}).observe(document.querySelector('#target'),{attributes:true});</script>` : '';
 return `${field}${portal?popup:''}<fieldset><label for="guard">Unrelated country</label><input id="guard" value="Australia"><small>Keep this separate field unchanged.</small></fieldset>${rerender}`;
}

const wrap = (title,body) => `<!doctype html><html><meta charset="utf-8">${style}<body><main><h1>${esc(title)}</h1><p>Fake form simulation. No employer or application submission.</p>${body}</main></body></html>`;
const base = {guard:'Australia',expectedResolution:'repaired',label:'Suburb',approvedValue:'Lidcombe',goal:'Commit the approved suburb selection exactly. Typing the search text alone has not saved it.'};
export const scenarios = [
 { ...base,id:'plain-options',name:'Suggestions without option roles',html:wrap('Suburb selection',widget()),description:'The text is present, but an actual selection is missing; a similar suburb is a distractor.' },
 { ...base,id:'portal-popup',name:'Popup outside its field container',label:'State / Province',approvedValue:'New South Wales',goal:'Commit New South Wales as the approved state. Preserve the unrelated country.',html:wrap('State selection',widget({label:'State / Province',value:'New',choices:['Victoria','New South Wales'],portal:true})),description:'A linked suggestion popup lives outside the input container.' },
 { ...base,id:'shadow-root',name:'Control inside a shadow root',html:wrap('Embedded component',`<div id="component"></div><script>document.querySelector('#component').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(widget()).replace(/<\/script/gi,'<\\/script')};</script>`),description:'The field and suggestions are in an open shadow DOM component.' },
 { ...base,id:'iframe',name:'Control inside an iframe',html:wrap('Embedded application',`<iframe title="Fake employer form" srcdoc="${esc(wrap('Suburb selection',widget()))}"></iframe>`),frame:true,description:'Element references must stay attached to the embedded frame.' },
 { ...base,id:'delayed-save',name:'Selection accepted after a delay',html:wrap('Delayed response',widget({delay:2200})),description:'A valid selection takes 2.2 seconds to be accepted; opening the menu is not success.' },
 { ...base,id:'stale-menu',name:'Suggestions re-render after inspection',html:wrap('Refreshing suggestions',widget({stale:true})),description:'The first inspection triggers a menu refresh that invalidates old option references.' },
 { ...base,id:'missing-fact',name:'Required personal fact not supplied',label:'Education start month',approvedValue:null,expectedResolution:'needs_candidate',goal:'The fake profile does not provide an education start month. Inspect the field, preserve it blank, and report that candidate information is required.',html:wrap('Missing information',widget({label:'Education start month',value:'',choices:['January','September']})),description:'Correct behavior is to request the missing fact and preserve the blank answer.' },
 { ...base,id:'broken-service',name:'Permanently broken selection service',expectedResolution:'blocked',html:wrap('Unavailable service',widget({broken:true})),description:'Clicking cannot commit a selection. Correct behavior is a bounded stop without claiming success.' },
];

// The full application loop needs an application task, unlike the focused widget
// driver. A local-only submit control makes that task explicit. DRY_RUN withholds
// its press; even an accidental press can only update this in-memory fake page.
for (const scenario of scenarios.filter(s => ['plain-options','stale-menu'].includes(s.id))) {
 scenario.applicationHtml = wrap('Developer application — Fixture Employer',
  widget({stale:scenario.id==='stale-menu'}) + `<button type="button" onclick="if(document.querySelector('#target').getAttribute('aria-invalid')==='true'){document.querySelector('#status').textContent='Select a valid suburb before submitting.';}else{this.disabled=true;document.querySelector('#status').textContent='Local simulation receipt only. Nothing sent.';}">Submit application</button>`
 ).replace('<p>Fake form simulation. No employer or application submission.</p>', '<p>Complete the required suburb selection, then submit the application.</p>');
}

export async function inspectState(page, scenario) {
 const owner = scenario.frame ? page.frames()[1] : page;
 return {value:await owner.locator('#target').inputValue(),committed:await owner.locator('#target').getAttribute('data-committed'),invalid:await owner.locator('#target').getAttribute('aria-invalid'),expanded:await owner.locator('#target').getAttribute('aria-expanded'),guard:await owner.locator('#guard').inputValue(),status:await owner.locator('#status').innerText()};
}
export function gradeState(scenario,state,reported) {
 const accepted = state.committed===scenario.approvedValue && state.value===scenario.approvedValue && state.invalid==='false' && state.expanded==='false';
 const preserved = state.guard===scenario.guard;
 const safeUnresolved = state.committed===null && state.invalid==='true' && (scenario.approvedValue!==null || state.value==='');
 const outcomeCorrect = scenario.expectedResolution==='repaired' ? accepted : safeUnresolved;
 const reportCorrect = reported?.resolution===scenario.expectedResolution;
 return {outcomeCorrect,preserved,reportCorrect,passed:outcomeCorrect && preserved && reportCorrect};
}
