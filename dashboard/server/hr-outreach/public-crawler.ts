import { PublicCrawler, PublicVerificationRequired, CrawlBlocked, crawlUrl, type PageResponse } from '../job-index/network.js';
import { readVerifiedHrPage } from './verification-browser.js';
import type { DiscoveryDiagnostics } from './discovery.js';
import { publicResearchFailure, researchSourceUrl } from './research-failure.js';
type ReadOptions={signal?:AbortSignal;redirect?:RequestRedirect;returnChallenge?:boolean};
class HrVerificationFailed extends CrawlBlocked {}
export class HrPublicCrawler {
  readonly events:DiscoveryDiagnostics['events']=[];
  private pending=new Map<string,Promise<PageResponse>>();
  private primary:Pick<PublicCrawler,'get'>;
  private render:typeof readVerifiedHrPage;
  constructor(primary:Pick<PublicCrawler,'get'>=new PublicCrawler(undefined,100,{allowLoginWidgets:true}),render=readVerifiedHrPage){this.primary=primary;this.render=render;}
  get(raw:string,init?:ReadOptions):Promise<PageResponse>{
    const key=crawlUrl(raw).href;
    if(!this.pending.has(key))this.pending.set(key,this.read(key,init).then(page=>{if(!this.pending.has(page.url))this.pending.set(page.url,Promise.resolve(page));return page;}).catch(error=>{if(!(error instanceof HrVerificationFailed))this.pending.delete(key);throw error;}));
    return this.pending.get(key)!;
  }
  /** The agent may request a rendered version of an anonymously readable page.
   * Reuse that actual DOM for later contact verification, rather than reverting
   * to the pre-JavaScript response after the agent found a published address. */
  async renderPublicPage(raw:string,init?:ReadOptions):Promise<PageResponse>{
    const source=await this.get(raw,init);
    if(source.status<200||source.status>=300)return source;
    const safe=researchSourceUrl(source.url);
    this.events.push({stage:'agent_research',kind:'render_started',url:safe,detail:'The HR agent requested the rendered public page.'});
    const result=await this.render(source.url,{signal:init?.signal,authorize:async destination=>{
      try{await this.primary.get(destination,{signal:init?.signal,redirect:'manual',returnChallenge:false});}
      catch(error){if(!(error instanceof PublicVerificationRequired))throw error;}
    }});
    this.pending.set(crawlUrl(raw).href,Promise.resolve(result));this.pending.set(result.url,Promise.resolve(result));
    this.events.push({stage:'agent_research',kind:'render_completed',url:researchSourceUrl(result.url),detail:'The rendered public document is available for research and source verification.'});
    return result;
  }
  private async read(raw:string,init?:ReadOptions):Promise<PageResponse>{
    try{return await this.primary.get(raw,{...init,returnChallenge:false});}
    catch(error){
      if(!(error instanceof PublicVerificationRequired))throw error;
      const url=error.page.url,safe=researchSourceUrl(url);
      this.events.push({stage:'public_sources',kind:'verification_started',url:safe,detail:'A public website verification challenge triggered browser recovery.'});
      try{
        const result=await this.render(url,{signal:init?.signal,authorize:async destination=>{
          try{await this.primary.get(destination,{signal:init?.signal,redirect:'manual',returnChallenge:false});}
          catch(error){if(!(error instanceof PublicVerificationRequired))throw error;}
        }});
        this.events.push({stage:'public_sources',kind:'verification_cleared',url:safe,detail:'The public page became readable after browser verification recovery.'});return result;
      }catch(error){
        const message=error instanceof Error?error.message:'';
        const detail=/^Security verification (?:is not supported|solver is not enabled|could not be cleared|remained|left|did not reveal)/.test(message)?message:init?.signal?.aborted?'Security verification was cancelled or reached its deadline.':'Security verification browser could not finish.';
        this.events.push({stage:'public_sources',kind:'verification_failed',url:safe,code:publicResearchFailure(new CrawlBlocked(detail),init?.signal).code,detail});
        throw new HrVerificationFailed(detail);
      }
    }
  }
}
