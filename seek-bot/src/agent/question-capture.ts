import type { QuestionSnapshot, QuestionControl, QuestionInput } from '../question-snapshot.js';

/** Runs inside the employer frame. Read only: never opens widgets, selects an
 * answer or includes current values. Unknown/virtual choice catalogs stay
 * incomplete until the applying agent exposes the full original control. */
export function captureQuestion(element: Element): Omit<QuestionSnapshot,'id'|'revision'> | null {
  const parentOf = (node: Element): Element | null => node.assignedSlot || node.parentElement
    || ((node.getRootNode() as ShadowRoot).host ?? null);
  const hidden = (node: Element): boolean => {
    for (let current: Element | null = node; current; current = parentOf(current)) {
      const style = getComputedStyle(current);
      if (current.hasAttribute('hidden') || style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || style.opacity === '0') return true;
    }
    return false;
  };
  const visible = (node: Element) => !hidden(node);
  const children = (node: Node): Node[] => node instanceof HTMLSlotElement
    ? (node.assignedNodes({ flatten: true }).length ? node.assignedNodes({ flatten: true }) : [...node.childNodes])
    : node instanceof Element && node.shadowRoot ? [...node.shadowRoot.childNodes] : [...node.childNodes];
  const descendants = (node: Node): Element[] => {
    const found: Element[] = [], seen = new Set<Node>(), pending = children(node).reverse();
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (next instanceof Element) found.push(next);
      pending.push(...children(next).reverse());
    }
    return found;
  };
  const root = element.getRootNode() as Document | ShadowRoot;
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
  const staticText = (node: Element | null, referenced = false): string => {
    if (!node || hidden(node) && !referenced) return '';
    const includeHidden = referenced && hidden(node);
    const parts: string[] = [], seen = new Set<Node>(), pending: Node[] = [node];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (next.nodeType === Node.TEXT_NODE) { parts.push(next.textContent || ''); continue; }
      if (next instanceof Element && (next.matches('input,textarea,select,script,style,[contenteditable]:not([contenteditable="false"]),[role="option"],[role="listbox"]')
        || !includeHidden && hidden(next))) continue;
      pending.push(...children(next).reverse());
    }
    return clean(parts.join(' '));
  };
  const referenced = (node: Element, attribute: string) => (node.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)
    .map(id => staticText((node.getRootNode() as Document | ShadowRoot).getElementById(id), true)).filter(Boolean).join(' ');
  const nativeLabels=(node:Element):HTMLLabelElement[]=>{
    const labels=[...((node as HTMLInputElement).labels||[])];
    if(labels.length||!node.id||node.parentElement?.querySelectorAll('input').length!==1)return labels;
    // A custom host may illegally repeat its inner input ID. Keep the local
    // explicit label relationship without guessing from unrelated page text.
    return [...node.parentElement.querySelectorAll('label')].filter(value=>value.htmlFor===node.id);
  };
  const label = (node: Element) => referenced(node, 'aria-labelledby') || clean(node.getAttribute('aria-label') || '')
    || nativeLabels(node).map(value => staticText(value, true)).filter(Boolean).join(' ')
    || (node.matches('[role="radio"],[role="checkbox"]') ? staticText(node) : '') || clean(node.getAttribute('title') || '');
  const heading = (node: Element) => staticText([...node.children].find(child => child.tagName === 'LEGEND') ?? null)
    || referenced(node, 'aria-labelledby') || clean(node.getAttribute('aria-label') || '');
  const selector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select,[role="combobox"],[role="radio"],[role="checkbox"],[role="listbox"]';
  const usable = (node: Element) => !node.matches('input[type="password"],[autocomplete~="one-time-code"],[data-owtomate-private-auth]')
    && !node.closest('[inert],[aria-hidden="true"]') && (visible(node) || node.matches('input[type="radio"],input[type="checkbox"]')
      && nativeLabels(node).some(value => !!staticText(value)));
  if (!usable(element)) return null;
  const controlsWithin = (node: Element) => descendants(node).filter(child => child.matches(selector));
  const localHeading = (node: Element): string => {
    const explicit = heading(node);
    if (explicit) return explicit;
    const parts: string[] = [];
    for (const child of children(node)) {
      if (child instanceof Element) {
        if (child.matches(selector) || controlsWithin(child).length) break;
        if (!child.matches('[role="alert"],[aria-live],button,a,[role="option"],[role="listbox"]')) parts.push(staticText(child));
      } else if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent || '');
    }
    return clean(parts.join(' '));
  };
  const semanticGroup = (node: Element): Element | null => {
    for (let current = parentOf(node); current && !current.matches('body,html'); current = parentOf(current)) {
      if (current.matches('fieldset,[role="group"],[role="radiogroup"]')) return current;
    }
    return null;
  };
  let group = semanticGroup(element);
  // Unsemantic form frameworks still put a static question heading before a
  // local set of controls. Use only a direct heading/label, never ancestor
  // body text or the agent's paraphrase.
  let ancestor = parentOf(element);
  for(let depth=0;ancestor&&depth<5&&!ancestor.matches('body,html,form');depth++,ancestor=parentOf(ancestor)) {
    if (ancestor===group) break;
    const local=controlsWithin(ancestor).filter(usable);
    if (!ancestor.matches('label')&&localHeading(ancestor)&&!(group&&localHeading(ancestor)===label(element))&&(local.length>1||!label(element)||descendants(ancestor).some(node=>node.matches('label,h1,h2,h3,h4,h5,h6,[role="heading"]')))) {group=ancestor;break;}
  }
  const groupHeading=group?localHeading(group):'';
  if (group&&!groupHeading) group=null;
  if(!group&&element.matches('input[type="radio"],[role="radio"]'))return null;
  let elements=group?controlsWithin(group).filter(usable):[element];
  // A native control is authoritative when a custom wrapper mirrors it.
  elements=elements.filter(e=>!elements.some(other=>other!==e&&e.contains(other)&&other.matches('input,select,textarea')));
  if (!elements.length || elements.length>1000) return null;
  const prompt=groupHeading||label(element);
  if (!prompt||prompt.length>4000) return null;
  const context:string[]=[];
  for (let parent = parentOf(group ?? element); parent && !parent.matches('body,html'); parent = parentOf(parent)) {
    const caption = parent.matches('fieldset,form,[role="group"],[role="radiogroup"]') ? heading(parent)
      : staticText([...parent.children].find(child => child.matches('h1,h2,h3,h4,h5,h6,[role="heading"]') && !controlsWithin(child).length) ?? null);
    if (caption) context.unshift(caption);
    if (parent.tagName === 'FORM') break;
  }
  const help=[...new Set([referenced(group??element,'aria-describedby'),...elements.map(e=>referenced(e,'aria-describedby'))].filter(Boolean))];
  if(group) {
    const peerGroups=[...(parentOf(group)?.children??[])].filter(p=>p!==group&&controlsWithin(p).length&&localHeading(p)===prompt);
    if(peerGroups.length)return null; // indistinguishable repeated sections
  }
  let complete=true;
  const nativeChoices=(select:HTMLSelectElement)=>[...select.options].map((o,i)=>({id:`choice${i}`,label:o.label,value:o.value,disabled:o.disabled||(o.parentElement?.tagName==='OPTGROUP'&&(o.parentElement as HTMLOptGroupElement).disabled)||false,hidden:o.hidden||o.parentElement?.hasAttribute('hidden')||false,placeholder:!select.multiple&&select.size<=1&&i===0&&o.parentElement===select&&o.value==='',...(o.parentElement?.tagName==='OPTGROUP'?{group:(o.parentElement as HTMLOptGroupElement).label}:{})}));
  const controls:QuestionControl[]=[], consumed=new Set<Element>();
  for(const e of elements) {
    if(consumed.has(e)) continue;
    const input=e as HTMLInputElement, role=e.getAttribute('role'), type=input.type;
    const kind:QuestionInput=e.tagName==='TEXTAREA'?'textarea':e.tagName==='SELECT'?'select':role==='combobox'||role==='listbox'?'select':role==='radio'||type==='radio'?'radio':role==='checkbox'||type==='checkbox'?'checkbox':(['date','month','week','time','datetime-local','number','range','color','search','email','tel','url','file'].includes(type)?type:'text') as QuestionInput;
    const c:QuestionControl={id:`part${controls.length}`,label:label(e)||prompt,kind,required:input.required===true||e.getAttribute('aria-required')==='true'||group?.getAttribute('aria-required')==='true',multiple:input.multiple===true||e.getAttribute('aria-multiselectable')==='true',choices:[],constraints:{}};
    if(!c.label.replace(/[\s:*]+/g,''))c.label=prompt;
    for(const name of ['min','max','step','pattern','accept'] as const) { const v=e.getAttribute(name);if(v!==null)c.constraints[name]=v; }
    for(const name of ['maxLength','minLength'] as const) { const v=e.getAttribute(name);if(v!==null&&Number(v)>=0)c.constraints[name]=Number(v); }
    if(e instanceof HTMLSelectElement&&e.size>1)c.constraints.size=e.size;
    if(['number','range','date','month','week','time','datetime-local'].includes(kind)&&e.hasAttribute('value'))c.constraints.stepBase=e.getAttribute('value')!;
    if(kind==='radio'||kind==='checkbox') {
      const peers = elements.filter(other => {
        if (consumed.has(other) || !other.matches(kind === 'radio' ? 'input[type="radio"],[role="radio"]' : 'input[type="checkbox"],[role="checkbox"]')) return false;
        if (semanticGroup(other) !== semanticGroup(e)) return false;
        if (kind === 'checkbox') return true;
        if (e instanceof HTMLInputElement && other instanceof HTMLInputElement) {
          return other === e || !!input.name && other.name === input.name && other.form === input.form && other.getRootNode() === e.getRootNode();
        }
        return !(e instanceof HTMLInputElement) && !(other instanceof HTMLInputElement);
      });
      if (kind === 'radio' && e instanceof HTMLInputElement && input.name) {
        const outside = [...(e.getRootNode() as Document|ShadowRoot).querySelectorAll('input[type="radio"]')].filter((other): other is HTMLInputElement => other instanceof HTMLInputElement
          && other.name === input.name && other.form === input.form && usable(other));
        if (outside.some(other => !peers.includes(other))) complete = false;
      }
      if(kind==='radio'||peers.length>1) {
        c.kind=kind==='checkbox'?'checkbox-group':'radio';c.multiple=kind==='checkbox';c.label=peers.length===1?label(e)||prompt:heading(semanticGroup(e)??group??e)||prompt;
        c.required=c.required||peers.some(p=>(p as HTMLInputElement).required||p.getAttribute('aria-required')==='true');
        c.choices=peers.map((p,i)=>({id:`choice${i}`,label:label(p),value:(p as HTMLInputElement).value??p.getAttribute('data-value')??'',disabled:p.matches(':disabled')||p.getAttribute('aria-disabled')==='true',...(kind==='checkbox'?{required:(p as HTMLInputElement).required===true||p.getAttribute('aria-required')==='true'}:{})}));
        peers.forEach(p=>consumed.add(p));
        if(c.choices.some(o=>!o.label))complete=false;
      }
    } else if(e.tagName==='SELECT') {
      c.choices=nativeChoices(e as HTMLSelectElement);
    } else if(kind==='select') {
      const ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
      const lists:Element[]=ids.map(id=>root.getElementById(id)).filter((l):l is HTMLElement=>!!l);
      if(e.matches('[role="listbox"]'))lists.push(e);
      const carriers=[...new Set([...e.querySelectorAll('select'),...lists.filter((l):l is HTMLSelectElement=>l instanceof HTMLSelectElement)])];
      if(carriers.length===1) {
        // Some accessible custom widgets own a hidden native catalog. Its
        // actual options remain complete even while the visual list is shut.
        c.choices=nativeChoices(carriers[0]);c.multiple=carriers[0].multiple;c.required=c.required||carriers[0].required;
        if(!c.choices.length)complete=false;
        consumed.add(e);controls.push(c);continue;
      }
      const options=[...new Set(lists.flatMap(l=>[...l.querySelectorAll('[role="option"]')]))];
      c.choices=options.map((o,i)=>({id:`choice${i}`,label:clean(o.textContent||''),value:o.getAttribute('data-value')||o.getAttribute('value')||clean(o.textContent||''),disabled:o.getAttribute('aria-disabled')==='true'}));
      // A custom list is complete only when it advertises the catalog size,
      // every position is present, and no typed query filters the catalog.
      const sizes=options.map(o=>Number(o.getAttribute('aria-setsize')));
      const positions=new Set(options.map(o=>Number(o.getAttribute('aria-posinset'))));
      const total=sizes[0];
      if(!total||total<1||sizes.some(n=>n!==total)||options.length!==total||positions.size!==total||options.some(o=>Number(o.getAttribute('aria-posinset'))<1||Number(o.getAttribute('aria-posinset'))>total)||e.matches('input')&&input.value.trim())complete=false;
    }
    if(kind==='file')complete=false; // document upload remains owner-scoped, not a text answer
    if(!e.matches('input,select,textarea,[role="radio"],[role="checkbox"],[role="combobox"],[role="listbox"]'))complete=false;
    if(e.matches('input[list]'))complete=false;
    if(kind==='text'&&(input.readOnly||e.hasAttribute('aria-haspopup')))complete=false;
    if(input.readOnly&&['text','search','textarea','tel','email','url','date','month','week','time','datetime-local','number'].includes(kind))complete=false;
    if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true')complete=false;
    if(['radio','select','checkbox-group'].includes(c.kind)&&!c.choices.length)complete=false;
    consumed.add(e);controls.push(c);
  }
  // Disconnected duplicate captions cannot identify a repeatable field.
  if(!group && descendants(root).filter(e=>e.matches(selector)&&usable(e)&&label(e)===prompt).length>1) return null;
  return {version:2,source:{origin:location.origin,path:''},prompt,context,help,controls,completeness:complete?'complete':'recapture'};
}
