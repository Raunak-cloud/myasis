import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import { crawlUrl, CrawlBlocked, type PageResponse } from '../job-index/network.js';
import { assertExternalNavigationUrl } from '../../../seek-bot/src/external-url.js';
import { detectChallenge, hasCaptchaSurface } from '../../../seek-bot/src/captcha/detect.js';
import { browserDeadline, browserOperationSignal, browserCleanup, browserDelay } from '../../../seek-bot/src/browser-deadline.js';
const {chromium}=createRequire(import.meta.url)('../../../seek-bot/node_modules/patchright') as typeof import('../../../seek-bot/node_modules/patchright/index.js');
export interface VerificationBrowserOptions {
  signal?:AbortSignal;
  authorize:(url:string)=>Promise<void>;
  launch?:typeof chromium.launch;
  validate?:(url:string)=>Promise<unknown>;
  solve?:(page:import('../../../seek-bot/node_modules/patchright/index.js').Page)=>Promise<string>;
  timeoutMs?:number;
}
/** Isolated, disposable public browser. No user profile, mail, form submissions or downloads. */
export async function readVerifiedHrPage(raw:string,options:VerificationBrowserOptions):Promise<PageResponse>{
  const destination=crawlUrl(raw);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined,detach=()=>{};
  const validate=options.validate??(async(url:string)=>{crawlUrl(url);await assertExternalNavigationUrl(url,undefined,true);});
  try{return await browserDeadline('HR public website verification',options.timeoutMs??120_000,async()=>{
    const signal=browserOperationSignal(120_000);await validate(destination.href);signal.throwIfAborted();
    browser=await(options.launch??chromium.launch.bind(chromium))({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome-stable'),headless:true,args:['--no-sandbox'],timeout:30_000});
    const close=()=>{void browser?.close().catch(()=>{});};signal.addEventListener('abort',close,{once:true});detach=()=>signal.removeEventListener('abort',close);if(signal.aborted){close();signal.throwIfAborted();}
    const context=await browser.newContext({acceptDownloads:false,serviceWorkers:'block'});
    const allowed=new Set([destination.href]);
    await context.route('**/*',async route=>{
      try{
        signal.throwIfAborted();const request=route.request(),url=new URL(request.url());await validate(url.href);
        const challengeHost=/(^|\.)(?:challenges\.cloudflare\.com|google\.com|recaptcha\.net|awswaf\.com)$/.test(url.hostname);
        const challengePath=url.origin===destination.origin&&/^\/cdn-cgi\/challenge-platform\//.test(url.pathname);
        if(!['GET','HEAD'].includes(request.method())&&!(request.method()==='POST'&&!request.isNavigationRequest()&&(challengeHost||challengePath)))return await route.abort('blockedbyclient');
        if(request.isNavigationRequest()&&request.frame()===context.pages()[0]?.mainFrame()){
          crawlUrl(url.href);if(url.origin!==destination.origin)return await route.abort('blockedbyclient');
          if(!allowed.has(url.href)){await options.authorize(url.href);allowed.add(url.href);}
        }
        return await route.fallback();
      }catch{await route.abort('blockedbyclient').catch(()=>{});}
    });
    const page=await context.newPage();page.setDefaultTimeout(30_000);
    await page.goto(destination.href,{waitUntil:'domcontentloaded',timeout:30_000});
    if(await hasCaptchaSurface(page)){
      // A short self-clear wait avoids purchasing a token for automatic checks.
      for(let i=0;i<6&&await hasCaptchaSurface(page);i++)await browserDelay(500);
      if(await hasCaptchaSurface(page)){
        const challenge=await detectChallenge(page);
        if(!challenge)throw new CrawlBlocked('Security verification is not supported by the configured solver.');
        // Existing bot runtime is loaded only for an actual supported challenge.
        const solver=options.solve?null:await import(new URL('../../../seek-bot/src/captcha.ts',import.meta.url).href);
        if(solver&&!solver.captchaEnabled())throw new CrawlBlocked('Security verification solver is not enabled.');
        if(await(options.solve??solver.handleCaptchaWithCapMonster)(page)!=='solved')throw new CrawlBlocked('Security verification could not be cleared by CapMonster.');
        for(let i=0;i<20&&await hasCaptchaSurface(page);i++)await browserDelay(500);
        if(await hasCaptchaSurface(page))throw new CrawlBlocked('Security verification remained after the CapMonster attempt.');
      }
    }
    signal.throwIfAborted();await page.waitForLoadState('domcontentloaded',{timeout:30_000});
    const final=crawlUrl(page.url());await validate(final.href);if(final.origin!==destination.origin)throw new CrawlBlocked('Security verification left the requested employer website.');
    const text=await page.content();if(Buffer.byteLength(text)>3_000_000)throw new CrawlBlocked('Verified public page exceeds the size limit.');
    const document=parseHTML(text).document;
    if(document.querySelector('input[type="password"]'))throw new CrawlBlocked('Sign-in page excluded.');
    const visible=(document.body?.textContent??'').replace(/\s+/g,' ');
    if(!visible.trim()||/access denied|verify (?:that )?you are human|please (?:complete|solve) (?:the )?(?:captcha|security check)/i.test(visible))throw new CrawlBlocked('Security verification did not reveal the requested public page.');
    const source=new URL(final.href);for(const name of [...source.searchParams.keys()])if(/^__?cf_chl_/i.test(name))source.searchParams.delete(name);
    return{url:source.href,status:200,type:'text/html',text,retryAfter:null};
  },options.signal);}finally{detach();if(browser)await browserCleanup('Close HR public verification browser',()=>browser!.close());}
}
