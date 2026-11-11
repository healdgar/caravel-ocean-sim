// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A program asked for late is a program compiled late: on Direct3D each takes seconds, and a subsystem that waits
// for the one before it to finish before it asks adds its whole compile to the load. So the ships, their crews, the
// port's people, the weather and the sea's effects all ask in one wave as the device comes up, and what is left to
// ask afterwards is only what cannot be known sooner: the forest's own packs, the props, and a ship met later.
// This loads the opening scene as a visitor gets it and counts who asked after the ship and crew were ready.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

function record(){
  if(typeof GPUDevice==='undefined')return;
  const asked=window.__asked=[];
  for(const name of ['createRenderPipelineAsync','createComputePipelineAsync','createRenderPipeline','createComputePipeline']){
    const make=GPUDevice.prototype[name];
    GPUDevice.prototype[name]=function(descriptor){asked.push([descriptor.label||'',performance.now()]);return make.call(this,descriptor);};
  }
}

test('the opening scene asks for its programs in one wave, not subsystem by subsystem',{timeout:600000},async()=>{
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.addInitScript(record);
    await page.goto(`${base}?ship=victory&w=960&h=540`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:500000,polling:250});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
    const {asked,marks}=await page.evaluate(()=>({asked:window.__asked,marks:Object.fromEntries(performance.getEntriesByType('mark').filter(mark=>mark.name.startsWith('ocean-startup-')).map(mark=>[mark.name.slice(14),mark.startTime]))}));
    assert.deepEqual(errors,[]);
    assert.ok(marks['ship-crew']>0&&marks.ready>marks['ship-crew'],`the stages were marked: ${JSON.stringify(marks)}`);
    const loading=asked.filter(([,at])=>at<=marks.ready),late=loading.filter(([,at])=>at>marks['ship-crew']);
    const names=[...new Set(late.map(([label])=>label))].join(', ');
    assert.ok(loading.length>=100,`${loading.length} programs asked for while loading`);
    // Before the wave, about a hundred asked after this point, in some twenty-five turns. The forest, the props and
    // a second ship still do, and are some two dozen.
    assert.ok(late.length<=40,`${late.length} of ${loading.length} programs were asked for after the ship and crew were ready: ${names}`);
    // And none of those is a program the opening wave is there to ask for.
    const waved=/^(crew|townsfolk|rain|weather|anchor|hull flood|underwater|deck water|crest spray|ship colou?rs|gunnery|cannon|dolphin)/i;
    assert.deepEqual(late.map(([label])=>label).filter(label=>waved.test(label)),[]);
  }finally{await page.close();}
});
