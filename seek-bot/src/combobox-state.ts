/** Shared, read-only browser callback. Query text is not a React/Ant select's
 * committed answer. Both canonical observation and action readback use this
 * reader so the applying agent and recovery reviewer see the same selection.
 * Keep self-contained: Patchright serializes this function into the frame. */
export function readComboboxStates(targets: Element | Element[]) {
  const nodes=Array.isArray(targets)?targets:[targets];
  return nodes.flatMap((node,match_index)=>{
    if(node.getAttribute('role')!=='combobox'||node.hasAttribute('data-owtomate-private-auth')||(node as HTMLInputElement).type==='password')return [];
    const scope=node.getRootNode() as Document|ShadowRoot;
    const ids=(node.getAttribute('aria-controls')||node.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
    const menus=ids.map(id=>scope.getElementById(id)).filter((menu):menu is HTMLElement=>Boolean(menu&&menu.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})));
    const options=menus.flatMap(menu=>[...menu.querySelectorAll('[role="option"]')].filter(option=>option.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})).map(option=>((option as HTMLElement).innerText||option.textContent||'').trim()));
    let searchOnly=/react-select-/.test(ids.join(' ')+' '+(node.getAttribute('aria-describedby')||'')+' '+(node.getAttribute('aria-labelledby')||''));
    let committedValue=node.getAttribute('aria-valuetext')?.trim()||'';
    for(let parent=node.parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++){
      if(parent.querySelectorAll('[role="combobox"]').length!==1)break;
      if(/select__input-container|select__value-container|ant-select/.test(parent.getAttribute('class')||''))searchOnly=true;
      // Library value slots, not a label, placeholder, query, help text or
      // an option merely highlighted in an open menu.
      const chosen=[...parent.querySelectorAll('[class*="single-value"],[class*="singleValue"],[class*="multi-value__label"],[class*="multiValueLabel"],.ant-select-selection-item')]
        .filter(element=>!element.closest('[role="listbox"],[role="option"]')&&element.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}));
      if(!committedValue&&chosen.length)committedValue=chosen.map(element=>((element as HTMLElement).innerText||element.textContent||'').trim()).filter(Boolean).join(', ');
      if(committedValue)break;
    }
    if(!searchOnly&&!committedValue)return [];
    const searchValue=searchOnly?(node as HTMLInputElement).value||'':'';
    return [{match_index,ref:node.getAttribute('data-field-id'),controlIdentity:node.getAttribute('data-field-identity'),
      committedValue,searchValue,selectionState:committedValue?'selected' as const:searchValue?'searching' as const:'empty' as const,
      searchOnly,options,optionStatusText:menus.map(menu=>menu.innerText.trim()).join('\n').slice(0,600)}];
  });
}
