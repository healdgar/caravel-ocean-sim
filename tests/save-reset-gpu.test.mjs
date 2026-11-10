// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// What erases a saved career, and what must not: checked in the real page with a real save in storage.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
    :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

const CAREER_KEY='waterworld.career.v1',VOYAGE_KEY='waterworld.voyage.v1';
const ready=page=>page.waitForFunction(()=>window.oceanStartup?.state==='ready',null,{timeout:180000});
// A save left by another tab: this page neither owns it nor asked to continue it.
async function pageWithForeignSave(path){
  const context=await browser.newContext({viewport:{width:640,height:400}});
  await context.addInitScript(([career,voyage])=>{
    if(sessionStorage.getItem('seeded'))return;
    sessionStorage.setItem('seeded','1');
    localStorage.setItem(career,JSON.stringify({version:1,marker:'kept',voyage:{dateMs:-13253932800000}}));
    localStorage.setItem(voyage,JSON.stringify({marker:'kept'}));
  },[CAREER_KEY,VOYAGE_KEY]);
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+path);await ready(page);
  return {context,page,errors};
}
const saved=page=>page.evaluate(([career,voyage])=>({career:localStorage.getItem(career),voyage:localStorage.getItem(voyage),search:location.search}),[CAREER_KEY,VOYAGE_KEY]);

test('newVoyage=1 starts afresh without erasing the save, and does not survive a reload',{timeout:420000},async()=>{
  const {context,page,errors}=await pageWithForeignSave('/?newVoyage=1');
  try{
    const first=await saved(page);
    assert.match(first.career??'',/"marker":"kept"/,'the career another tab saved is still there');
    assert.match(first.voyage??'',/"marker":"kept"/,'so is its voyage');
    assert.doesNotMatch(first.search,/newVoyage/,'the one-shot parameter has left the address bar');
    await page.reload();await ready(page);
    const second=await saved(page);
    assert.match(second.career??'',/"marker":"kept"/,'a reload erases nothing either');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('reset=1 erases the save once, and a reload does not erase what was saved since',{timeout:420000},async()=>{
  const {context,page,errors}=await pageWithForeignSave('/?reset=1');
  try{
    const first=await saved(page);
    assert.doesNotMatch(first.career??'',/"marker":"kept"/,'reset removes the old career');
    assert.equal(first.voyage,null,'and the old voyage');
    assert.doesNotMatch(first.search,/reset/,'the one-shot parameter has left the address bar');
    await page.evaluate(([career])=>localStorage.setItem(career,JSON.stringify({version:1,marker:'since',voyage:null})),[CAREER_KEY]);
    await page.reload();await ready(page);
    assert.match((await saved(page)).career??'',/"marker":"since"/,'what was saved after the reset survives the reload');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
