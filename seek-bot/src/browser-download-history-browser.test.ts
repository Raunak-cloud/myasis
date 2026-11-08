/** Real persistent Chrome and local dummy downloads only. No candidate data. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createServer as createPortServer} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {BrowserContext} from 'patchright';

test('reused production browser survives repeated saved-document downloads and retains session/draft data',{skip:process.platform!=='linux',timeout:90000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'owtomate-browser-download-'));
  const payload=Buffer.from('Fictional supporting document.\n'.repeat(4096));
  const server=createServer((request,response)=>{
    if(request.url==='/file')response.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename="Fixture.docx"'}).end(payload);
    else response.writeHead(200,{'Content-Type':'text/html'}).end(`<main><label>Name<input id=name oninput="localStorage.setItem('saved-answer',this.value)"></label><a id=document href=/file>Saved cover letter.docx</a><button id=next onclick="document.querySelector('main').dataset.next='yes'">Continue application</button></main><script>document.querySelector('#name').value=localStorage.getItem('saved-answer')||''</script>`);
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const portServer=createPortServer();await new Promise<void>(done=>portServer.listen(0,'127.0.0.1',done));
  const port=(portServer.address() as import('node:net').AddressInfo).port;await new Promise<void>(done=>portServer.close(()=>done()));
  Object.assign(process.env,{DATA_DIR:root,CHROME_PROFILE_DIR:join(root,'chrome'),CHROME_PATH:process.env.CHROME_PATH||'/usr/bin/google-chrome-stable',
    CDP_PORT:String(port),BROWSER_CONNECT_CDP:'false',HEADLESS:process.env.DOWNLOAD_REPAIR_HEADED==='true'?'false':'true',BACKGROUND:'true',COST_TRACKING:'false'});
  const {launchBrowser,closeBrowser}=await import('./browser.js');
  let context:BrowserContext|undefined;
  try{
    for(let run=0;run<4;run++){
      context=await launchBrowser();const page=context.pages()[0]||await context.newPage();await page.goto(url);
      if(run===0){
        await context.addCookies([{name:'dummy-session',value:'retained-login',url,expires:Math.floor(Date.now()/1000)+86400}]);
        await page.locator('#name').fill('Retained fictional candidate');
      }
      assert.equal(await page.locator('#name').inputValue(),'Retained fictional candidate');
      assert.ok((await context.cookies()).some(cookie=>cookie.name==='dummy-session'&&cookie.value==='retained-login'));
      const pending=page.waitForEvent('download',{timeout:10000});await page.locator('#document').click();const download=await pending;
      const file=join(root,`download-${run}.docx`);await download.saveAs(file);assert.deepEqual(readFileSync(file),payload);
      await page.locator('#next').click();assert.equal(await page.locator('main').getAttribute('data-next'),'yes');
      assert.equal(context.browser()!.isConnected(),true);await closeBrowser(context);context=undefined;
    }
    const db=new DatabaseSync(join(root,'chrome','Default','History'),{readOnly:true});
    try{assert.ok(Number(db.prepare('SELECT count(*) AS n FROM urls').get()!.n)>0);}finally{db.close();}
    assert.deepEqual(readFileSync(join(root,'download-0.docx')),payload,'the actual first downloaded document is retained');
  }finally{await context?.close().catch(()=>{});await new Promise<void>(done=>server.close(()=>done()));rmSync(root,{recursive:true,force:true});}
});
