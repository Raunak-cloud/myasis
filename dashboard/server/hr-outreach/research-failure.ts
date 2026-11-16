import { CrawlBlocked, CrawlDeferred, crawlUrl } from '../job-index/network.js';

export function researchSourceUrl(raw:string|undefined):string|undefined{
  try{if(raw){const url=crawlUrl(raw);return `${url.origin}${url.pathname}`.slice(0,500);}}catch{ /* Do not retain invalid URLs or query data. */ }
}

/** Controlled diagnostics only: never persist provider payloads or stacks. */
export function publicResearchFailure(error:unknown, signal?:AbortSignal):{code:string;detail:string}{
  const message=error instanceof Error?error.message:'';
  if(signal?.aborted)return{code:'deadline_exceeded',detail:'Public research was cancelled or reached its deadline.'};
  if(/^Security verification is not supported/.test(message))return{code:'verification_unsupported',detail:'This website verification type is not supported by the configured solver.'};
  if(/^Security verification solver is not enabled/.test(message))return{code:'verification_disabled',detail:'Website verification could not run because the solver is not enabled.'};
  if(/^Security verification/.test(message))return{code:'verification_failed',detail:'Website verification did not reveal the requested public page.'};
  if(error instanceof CrawlBlocked){
    if(/robots|host refuses crawler access/i.test(message))return{code:'robots_denied',detail:'The website refuses this public crawler request through its robots policy or robots endpoint.'};
    if(/private|non-public|public internet|account and application|sign-in/i.test(message))return{code:'public_source_policy',detail:'This destination is outside the allowed public research pages.'};
    return{code:'access_denied',detail:'The website refused automated access to this public source.'};
  }
  if(error instanceof CrawlDeferred)return{code:'source_deferred',detail:'The public source requires a later request or its request allowance was reached.'};
  if(/^(?:Search|Page) budget used\./.test(message))return{code:'research_limit',detail:message.startsWith('Search')?'The additional research search allowance was used.':'The additional research page-read allowance was used.'};
  if(/^(?:Supply a |Use source URLs observed|Use an observed employer website|Use one of the listed public research tools)/.test(message)||error instanceof SyntaxError)return{code:'invalid_tool_arguments',detail:'The agent supplied invalid or incomplete research tool arguments.'};
  if(/^This source is not/.test(message))return{code:'unreadable_source',detail:'The source did not return a readable public text page.'};
  if((error as {name?:string})?.name==='TimeoutError'||/timed?\s*out|timeout/i.test(message))return{code:'request_timeout',detail:'The public research request timed out.'};
  if(['ENOTFOUND','EAI_AGAIN','EAI_FAIL'].includes((error as {code?:string})?.code??''))return{code:'dns_failure',detail:'The public source address could not be resolved.'};
  return{code:'request_failed',detail:'The public research request failed without a recognised safe error category.'};
}
