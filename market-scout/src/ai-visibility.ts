import { detectWall, dismissConsent, withPage } from './browser/session.js';

export interface VisibilityInput { provider:'ChatGPT'|'Perplexity'; prompts:string[]; country:string }
export async function checkAIVisibility(input:VisibilityInput) {
  if(!['ChatGPT','Perplexity'].includes(input.provider) || !Array.isArray(input.prompts) || input.prompts.length<1 || input.prompts.length>3 || input.prompts.some(p=>typeof p!=='string' || p.length<10 || p.length>500)) throw new Error('Choose a supported provider and one to three short prompts.');
  const observations:Array<Record<string,unknown>>=[];
  await withPage(async page=>{
    for(const prompt of input.prompts) {
      const base={provider:input.provider,prompt,country:input.country,observedAt:new Date().toISOString(),method:'browser',answer:'',citations:[] as string[],responseUrl:null as string|null,model:'Model not exposed by browser',note:''};
      try {
        const response=await page.goto(input.provider==='ChatGPT'?'https://chatgpt.com/':'https://www.perplexity.ai/',{waitUntil:'domcontentloaded',timeout:25_000});
        await dismissConsent(page);
        const wall=await detectWall(page);if(wall || (response?.status() || 200)>=400) throw new Error('blocked');
        const editor=page.locator(input.provider==='ChatGPT'?'#prompt-textarea':'textarea, [contenteditable="true"][role="textbox"]').first();
        if(!await editor.isVisible().catch(()=>false)) {observations.push({...base,status:'unavailable',note:'The public browser interface did not offer an accessible prompt input.'});break;}
        await editor.fill(prompt);await editor.press('Enter');
        const answerSelector=input.provider==='ChatGPT'?'[data-message-author-role="assistant"]':'.prose';
        let previous='',stable=0,answer='',citations:string[]=[];
        for(let i=0;i<30;i++) {
          await page.waitForTimeout(2000);
          const wall=await detectWall(page);if(wall) throw new Error('blocked');
          const content=await page.locator(answerSelector).last().evaluate(node=>({text:(node as HTMLElement).innerText || '',links:Array.from(node.querySelectorAll('a[href]')).map(a=>(a as HTMLAnchorElement).href)})).catch(()=>({text:'',links:[] as string[]}));
          const generating=await page.getByRole('button',{name:/stop (generating|response)/i}).isVisible().catch(()=>false);
          const completedControl=await page.locator(input.provider==='ChatGPT'?'[data-testid="copy-turn-action-button"]':'button[aria-label*="Copy" i]').last().isVisible().catch(()=>false);
          answer=content.text.trim();citations=content.links.filter(u=>/^https:\/\//.test(u));
          stable=answer===previous && answer.length>=100 && !generating && completedControl?stable+1:0;previous=answer;
          if(stable>=3) break;
        }
        if(stable<3 || answer.length<100 || answer.length>30_000 || /sign in to continue|limit reached|something went wrong|unable to (?:answer|respond)/i.test(answer)) {observations.push({...base,status:'unavailable',note:'A complete stable answer within the capture limit could not be obtained. This is not a negative visibility result.'});continue;}
        observations.push({...base,status:'complete',answer,citations:[...new Set(citations)].slice(0,60),responseUrl:page.url(),note:'Sampled from a logged-out browser. Model, search mode and geographic personalization are not verified. Recommendations require a checked exact quote.'});
      } catch {
        observations.push({...base,status:'blocked',note:'Provider access was blocked or unavailable. No login or challenge was bypassed; visibility is unknown.'});break;
      }
    }
  });
  return observations;
}
