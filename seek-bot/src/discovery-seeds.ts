import type { JobListing } from './types.js';

/** Operator-supplied search cards are leads, never approvals or user fit overrides.
 * Exact SEEK identities keep arbitrary URLs and caller-provided fit evidence out. */
export function discoverySeeds(input: unknown): JobListing[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 50) throw new Error('Provide at most 50 SEEK discovery leads.');
  const seen=new Set<string>();
  return input.flatMap(value=>{
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SEEK discovery lead.');
    const {id,title,company}=value as Record<string,unknown>;
    if (typeof id!=='string'||!/^\d{6,12}$/.test(id)||typeof title!=='string'||!title.trim()||title.length>250
      ||typeof company!=='string'||!company.trim()||company.length>250) throw new Error('Each discovery lead needs a SEEK job ID, title and company.');
    if(seen.has(id))return [];
    seen.add(id);
    return [{id,title:title.trim(),company:company.trim(),location:'',platform:'seek',source:'search',url:`https://www.seek.com.au/job/${id}`}];
  });
}
