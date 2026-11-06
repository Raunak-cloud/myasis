/** Bounded professional role labels, never entire prompts or contact details. */
export function professionalRoleTerms(raw:string):string[]{
  return [...new Set(raw.split(/[,;\n]/).map(v=>v.trim()).filter(v=>v.length>=3&&v.length<=70&&/^[\p{L}+#.&\s/-]+$/u.test(v)))].slice(0,24);
}

export function savedSearchRoles(keywords:string[],instructions:string):string[]{
  const line=instructions.split(/\r?\n/).find(v=>/^\s*(?:only\s+apply\s+(?:(?:for|to)\s+)?|apply\s+(?:only\s+)?for\s+|(?:target\s+roles?|roles?\s+to\s+apply\s+for)\s*:)\S?/i.test(v));
  if(!line)return [...keywords];
  const roles=line.replace(/^\s*(?:only\s+apply\s+(?:(?:for|to)\s+)?|apply\s+(?:only\s+)?for\s+|(?:target\s+roles?|roles?\s+to\s+apply\s+for)\s*:)\s*/i,'');
  const roleWords=/\b(?:analyst|developer|engineer|walker|stocktaker|consultant|manager|officer|lead)\b/i;
  const terms=roles.split(/[,;]/).flatMap(term=>{const parts=term.split(/\s+and\s+/i);return parts.length>1&&parts.every(part=>roleWords.test(part))?parts:[term];});
  return [...new Set([...keywords,...professionalRoleTerms(terms.join(','))])].slice(0,24);
}

/** Only spelling/function equivalents. This is a shortlist, never AI approval. */
export function equivalentRole(requested:string,title:string):boolean{
  const groups=[/\b(?:dog|pet)[\s-]*walk(?:er|ing)?s?\b/i,/\bstock[\s-]*tak(?:er|ing|e)s?\b/i,/\bfull[\s-]*stack\s+(?:software\s+)?(?:developer|engineer)\b/i,/\b(?:ai|artificial\s+intelligence|llm)\s+(?:software\s+)?(?:developer|engineer)\b/i];
  return groups.some(pattern=>pattern.test(requested)&&pattern.test(title));
}
