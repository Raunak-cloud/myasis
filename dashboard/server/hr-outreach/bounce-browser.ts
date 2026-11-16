import type { HrBrowserPage } from '../../../seek-bot/src/hr-email-browser.js';
import { openHrGmail, hrMailReference, validateHrMail, type BrowserHrMail } from '../../../seek-bot/src/hr-email-browser.js';
import { assertBrowserOperationActive } from '../../../seek-bot/src/browser-deadline.js';
import { GmailServiceError } from '../../../seek-bot/src/gmail-mcp-service.js';

export interface HrRawMailboxMessage { id:string;threadId?:string;raw:string;receivedAt?:string;labelIds?:string[] }
export interface BounceBrowserOptions { sentAt:string;threadId?:string;signal?:AbortSignal }

/** A mailbox read only. Expand collapsed messages and use Gmail's own Show
 * original view, never instructions or action controls inside message bodies. */
export async function readHrBounceMessagesOnPage(page:HrBrowserPage,mail:BrowserHrMail,account:string,options:BounceBrowserOptions):Promise<HrRawMailboxMessage[]> {
  validateHrMail(mail);
  if(!Number.isFinite(Date.parse(options.sentAt)))throw new GmailServiceError('unapproved','The HR email has no recorded send time.');
  const messages:HrRawMailboxMessage[]=[],threads=new Set<string>(),sentThreads=new Set<string>();
  const after=Math.floor((Date.parse(options.sentAt)-5*60_000)/1000);
  const queries=[`in:sent after:${after} "${hrMailReference(mail.id)}"`,`in:anywhere after:${after} {from:postmaster from:mailer-daemon} "${mail.to}"`];
  if(options.threadId&&/^[\w-]{1,100}$/.test(options.threadId))threads.add(options.threadId);
  for(const query of queries){
    options.signal?.throwIfAborted();assertBrowserOperationActive();
    await openHrGmail(page,account,`#search/${encodeURIComponent(query)}`);
    const result=await page.waitForFunction(expected=>{
      const main=document.querySelector('[role="main"]'),search=document.querySelector('input[aria-label="Search mail"]') as HTMLInputElement|null;
      if(!main||search&&search.value.trim()!==expected)return false;
      const ids=[...new Set([...main.querySelectorAll('[data-legacy-thread-id],[data-thread-id]')].map(node=>node.getAttribute('data-legacy-thread-id')||node.getAttribute('data-thread-id')).filter(id=>id&&/^[\w-]{1,100}$/.test(id)))];
      return ids.length?ids.slice(0,4):main.querySelector('[role="grid"]')&&/no conversations found|no results found|no conversations match|no messages matched your search/i.test((main as HTMLElement).innerText||'')?[]:false;
    },query,{timeout:15_000});
    try{for(const id of await result.jsonValue() as string[]){threads.add(id);if(query.startsWith('in:sent '))sentThreads.add(id);}}finally{await result.dispose();}
    if(threads.size>=4)break;
  }
  for(const threadId of [...threads].slice(0,4)){
    options.signal?.throwIfAborted();assertBrowserOperationActive();
    await openHrGmail(page,account,`#all/${threadId}`);
    await page.locator('[role="main"] h2').first().waitFor({timeout:10_000});
    await page.locator('[role="main"] [data-message-id]').first().waitFor({state:'attached',timeout:10_000});
    const expand=page.getByRole('button',{name:/^Expand all$/i});
    if(await expand.isVisible())await expand.click({timeout:5_000});
    await page.waitForFunction(({sender,reference})=>{
      const nodes=[...document.querySelectorAll('[role="main"] [data-message-id]')];
      const own=nodes.filter(node=>node.querySelector('[email]')?.getAttribute('email')?.toLowerCase()===sender.toLowerCase());
      return own.length?own.some(node=>{const body=node.querySelector('.a3s') as HTMLElement|null;return body&&body.getClientRects().length>0&&getComputedStyle(body).visibility!=='hidden'&&body.innerText.includes(reference);})
        :nodes.length>0&&nodes.every(node=>!!node.querySelector('[aria-label="More message options"],[aria-label="More"],[data-tooltip="More"]'));
    },{sender:account,reference:hrMailReference(mail.id)},{timeout:10_000});
    const nodes=page.locator('[role="main"] [data-message-id]'),count=Math.min(await nodes.count(),8);
    for(let index=0;index<count&&messages.length<12;index++){
      options.signal?.throwIfAborted();assertBrowserOperationActive();
      const node=nodes.nth(index),id=await node.getAttribute('data-legacy-message-id')||await node.getAttribute('data-message-id');
      if(!id||id.length>200||messages.some(message=>message.id===id))continue;
      const more=node.locator('[role="button"][aria-label="More message options"]:not(.a3s *),[role="button"][aria-label="More"]:not(.a3s *),button[aria-label="More message options"]:not(.a3s *),button[aria-label="More"]:not(.a3s *),[role="button"][data-tooltip="More"]:not(.a3s *)').first();
      await more.waitFor({state:'visible',timeout:10_000}).catch(()=>{throw new GmailServiceError('unavailable','Gmail has not exposed every message header for delivery checking.');});
      await more.click({timeout:5_000});
      const original=page.locator('[role="menu"]:visible [role="menuitem"]:visible:not(.a3s *)').filter({hasText:/^\s*Show original\s*$/i});
      const [popup]=await Promise.all([page.context().waitForEvent('page',{timeout:10_000}),original.click({timeout:5_000})]);
      try{
        await popup.waitForLoadState('domcontentloaded',{timeout:15_000});
        if(new URL(popup.url()).hostname!=='mail.google.com')throw new GmailServiceError('unapproved','The original-message view left Gmail.');
        await popup.locator('pre,textarea,#raw_message_text,#raw-message').first().waitFor({state:'attached',timeout:10_000});
        const raw=await popup.evaluate(()=>{
          for(const node of document.querySelectorAll('pre,textarea,#raw_message_text,#raw-message')){
            const text=node instanceof HTMLTextAreaElement?node.value:node.textContent||'';
            if(text.length<=2_000_000&&/^(?:Delivered-To|Received|MIME-Version|From|Return-Path|Date):/mi.test(text)&&/\r?\n\r?\n/.test(text))return text;
          }
          return null;
        });
        if(!raw)throw new GmailServiceError('unavailable','Gmail did not expose the original message for delivery checking.');
        const ownSender=(await node.locator('[email]').first().getAttribute('email'))?.toLowerCase()===account.toLowerCase();
        messages.push({id,threadId,raw,...(sentThreads.has(threadId)&&ownSender?{labelIds:['SENT']}: {})});
      }finally{await popup.close().catch(()=>{});}
    }
  }
  return messages;
}
