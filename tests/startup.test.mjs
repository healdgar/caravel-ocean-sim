// Copyright (c) 2026 Six Cailloux, LLC. MIT.
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

test('mobile loading feedback paints before a delayed main module and respects reduced motion',{timeout:120000},async()=>{
  const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});let release;
  const gate=new Promise(resolve=>release=resolve);
  try{
    await page.route('**/js/main.js',async route=>{await gate;await route.continue();});
    const navigation=page.goto(origin+'/?follower=0',{waitUntil:'domcontentloaded'});
    await page.locator('#ocean-startup-stage').waitFor({state:'visible'});
    assert.match(await page.locator('#ocean-startup-stage').innerText(),/Loading/);
    assert.equal(await page.locator('#ocean-startup-retry').isVisible(),false);
    const layout=await page.evaluate(()=>{
      const box=document.querySelector('.ocean-startup-card').getBoundingClientRect();
      return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:innerWidth,height:innerHeight,
        animation:getComputedStyle(document.querySelector('.ocean-startup-bar span')).animationName};
    });
    assert.ok(layout.left>=0&&layout.right<=layout.width&&layout.top>=0&&layout.bottom<=layout.height);
    assert.equal(layout.animation,'none');
    await page.screenshot({path:new URL('../shots/startup-mobile-loading.png',import.meta.url).pathname});
    release();await navigation;await page.waitForFunction(()=>window.oceanStartup.state==='ready');
    assert.equal(await page.locator('#ocean-startup').isVisible(),false);
  }finally{release?.();await page.close();}
});

test('startup waits for the first canvas GPU work rather than the end of initialization',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.addInitScript(()=>{
      let canvas=false,held=false;window.releaseStartupFrame=null;
      const texture=GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture=function(...args){canvas=true;return texture.apply(this,args);};
      const done=GPUQueue.prototype.onSubmittedWorkDone;
      GPUQueue.prototype.onSubmittedWorkDone=function(...args){
        const result=done.apply(this,args);if(!canvas||held)return result;held=true;
        return result.then(()=>new Promise(resolve=>window.releaseStartupFrame=resolve));
      };
    });
    await page.goto(origin+'/?follower=0');await page.waitForFunction(()=>typeof window.releaseStartupFrame==='function');
    assert.equal(await page.locator('#ocean-startup').getAttribute('data-state'),'loading');
    assert.equal(await page.locator('#ocean-startup').isVisible(),true);
    await page.evaluate(()=>window.releaseStartupFrame());
    await page.waitForFunction(()=>window.oceanStartup.state==='ready');
    assert.equal(await page.locator('#ocean-startup').isVisible(),false);
    assert.equal(await page.locator('#err').textContent(),'');
  }finally{await page.close();}
});

test('a missing graphics API shows a sticky failure and a usable retry',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.addInitScript(()=>Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true}));
    await page.goto(origin);await page.waitForFunction(()=>window.oceanStartup.state==='failed');
    assert.equal(await page.locator('#ocean-startup').isVisible(),true);
    assert.match(await page.locator('#ocean-startup-stage').innerText(),/WebGPU/);
    assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).isEnabled(),true);
    await page.evaluate(()=>{window.oceanStartup.stage('fake','Ignored');window.oceanStartup.ready();});
    assert.equal(await page.locator('#ocean-startup').getAttribute('data-state'),'failed');
    const nextLoad=page.waitForEvent('load');await page.getByRole('button',{name:'Retry',exact:true}).click();await nextLoad;
    await page.waitForFunction(()=>window.oceanStartup.state==='failed');
  }finally{await page.close();}
});

test('module and required asset failures remain visible instead of leaving a black canvas',{timeout:120000},async()=>{
  for(const broken of ['**/js/main.js','**/assets/wildlife/whale.glb']){
    const page=await browser.newPage();
    try{
      await page.route(broken,route=>route.abort('failed'));await page.goto(origin);
      await page.waitForFunction(()=>window.oceanStartup.state==='failed');
      assert.equal(await page.locator('#ocean-startup').isVisible(),true);
      assert.equal(await page.locator('#ocean-startup-retry').isVisible(),true);
      assert.ok((await page.locator('#ocean-startup-stage').innerText()).length>12);
    }finally{await page.close();}
  }
});

test('Pages fetches exact versioned assets, defers audio until enabled and remains playable',{timeout:120000},async()=>{
  const page=await browser.newPage(),requests=[],failures=[],errors=[];
  page.on('request',r=>requests.push(r.url()));page.on('requestfailed',r=>failures.push(r.url()));page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(origin+'/docs/index.html?follower=0');await page.waitForFunction(()=>window.oceanStartup.state==='ready');
    assert.equal(requests.filter(url=>url.includes('/assets/audio/')).length,0,'muted audio is not part of startup transfer');
    assert.ok(requests.some(url=>/whale\.[a-f0-9]{16}\.glb$/.test(url)));
    for(const part of ['whale','sailor','sailor-female','caravel-oak-albedo'])
      assert.equal(requests.filter(url=>new RegExp('/'+part+'\\.[a-f0-9]{16}\\.').test(url)).length,1,'preloaded asset is transferred once: '+part);
    await page.getByRole('button',{name:'Sea settings',exact:true}).click();await page.locator('#sound-toggle').click();
    await page.waitForFunction(()=>document.querySelector('#sound-status')?.textContent.includes('Sound follows'));
    assert.ok(requests.some(url=>/\/assets\/audio\/.*\.[a-f0-9]{16}\.mp3$/.test(url)));
    assert.deepEqual(failures,[]);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('both downloadable ocean pages start offline without HTTP assets',{timeout:120000},async()=>{
  for(const file of ['ocean.html','ocean.min.html']){
    const page=await browser.newPage(),external=[];
    try{
      await page.route(/^https?:/,route=>{external.push(route.request().url());return route.abort();});
      await page.goto(new URL('../'+file,import.meta.url).href+'?follower=0');
      await page.waitForFunction(()=>window.oceanStartup.state==='ready');
      assert.equal(await page.locator('#ocean-startup').isVisible(),false);assert.deepEqual(external,[]);
      assert.equal(await page.locator('#err').textContent(),'');
    }finally{await page.close();}
  }
});
