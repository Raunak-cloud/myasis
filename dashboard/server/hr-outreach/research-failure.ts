import { CrawlBlocked, CrawlDeferred, crawlUrl } from '../job-index/network.js';

export class PublicSearchResponseError extends Error {
  readonly status:number;
  readonly reason?:'query_policy';
  constructor(status:number,reason?:'query_policy'){super(status>=500?'Public contact search is temporarily unavailable.':'Public contact search request did not complete.');this.status=status;this.reason=reason;}
}
export class PublicSearchPayloadError extends Error {constructor(){super('The search provider did not return a usable result list.');}}

export class PublicSourceResponseError extends Error {
  readonly contentType:string;
  readonly status:number;
  constructor(status:number,contentType:string){
    super(`Public source returned HTTP ${status}.`);
    this.status=status;
    this.contentType=contentType.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9.+/-]/g,'').slice(0,80);
  }
}

export function researchSourceUrl(raw:string|undefined):string|undefined{
  try{if(raw){const url=crawlUrl(raw);return `${url.origin}${url.pathname}`.slice(0,500);}}catch{ /* Do not retain invalid URLs or query data. */ }
}

/** Controlled diagnostics only: never persist provider payloads or stacks. */
export function publicResearchFailure(error:unknown, signal?:AbortSignal):{code:string;detail:string}{
  const message=error instanceof Error?error.message:'';
  if(signal?.aborted)return{code:'deadline_exceeded',detail:'Public research was cancelled or reached its deadline.'};
  if(error instanceof PublicSearchPayloadError)return{code:'search_response_invalid',detail:'The public search service did not return a usable result list. This is not proof that no hiring contacts exist.'};
  if(error instanceof PublicSearchResponseError)return error.reason==='query_policy'
    ?{code:'search_query_restricted',detail:'The search provider does not allow this query pattern on the current account plan. Choose another allowed plain-language query instead of repeating the rejected pattern. This does not establish that no hiring contact exists.'}
    :error.status===400||error.status===422
    ?{code:'search_request_rejected',detail:`The public search service rejected this request with HTTP ${error.status}. Check the query or request inputs; this is not a company website failure.`}
    :error.status===401||error.status===403?{code:'search_access_denied',detail:`The public search service refused API access with HTTP ${error.status}. Check its account credentials or permissions; this is not proof that no hiring contacts exist.`}
    :error.status===402
    ?{code:'search_payment_required',detail:'The public search service refused this request with HTTP 402. Its account access or credit needs attention; this is not a company website failure.'}
    :error.status===429?{code:'search_rate_limited',detail:'The public search service is rate limiting requests (HTTP 429). Use evidence already gathered or report research incomplete.'}
    :{code:'search_service_unavailable',detail:`The public search service returned HTTP ${error.status}. This is not a company website failure.`};
  if(error instanceof PublicSourceResponseError)return error.status===404||error.status===410
    ?{code:'http_not_found',detail:`This public page returned HTTP ${error.status}. Follow a published link or another source.`}
    :error.status>=200&&error.status<300?{code:'unsupported_source_type',detail:`This response is ${error.contentType||'an unknown content type'}, not a readable HTML or text page.`}
    :{code:'source_http_error',detail:`This public page returned HTTP ${error.status}.`};
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
