// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ship is one record of her own scene of the one continuum (js/vessel-continuum.js), drawn by the one view of her
// material whole or holed. Marked, her record is flagged DAMAGED: the cut draws her clusters alone and her material masks
// what shot has taken away; a repair clears the flag. No other program draws her.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
const port=process.env.DAMAGED_HULL_TEST_PORT||8131,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Damaged hull server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--use-webgpu-adapter=swiftshader']});
});
after(async()=>{await browser?.close();server?.kill();});

function instrument(){
  const seen=window.drawnPipelines=[];window.gpuErrors=[];
  const setPipeline=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){seen.push(pipeline.label);return setPipeline.call(this,pipeline);};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
}
// The scene pass's programs a player's ship could be drawn by: the one view of her material, and the old ship cut's
// programs, which must never come back.
const VIEW=['vesselContinuum view'];
const PLAYER_VESSEL=[...VIEW,'vessel clusters','vessel far bodies','vessel splats','damaged vessel surviving surface','damaged vessel'];
// What the next frames draw her by, and whether her record is flagged DAMAGED.
const drawnNext=page=>page.evaluate(async(programs)=>{
  // Two frames, so the one being encoded when we ask cannot be mistaken for the next.
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  drawnPipelines.length=0;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  return {programs:[...new Set(drawnPipelines)].filter(label=>programs.includes(label)),damaged:oceanFleet.vessels[0].continuum.damaged};
},PLAYER_VESSEL);

test('a ship is flagged DAMAGED when marked, and clear again when repaired, drawn by one view throughout',{timeout:240000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${origin}/?ship=nina&view=ship&follower=0&clouds=0&w=320&h=240`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:180000,polling:200});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    assert.deepEqual(await drawnNext(page),{programs:VIEW,damaged:false},'a whole ship is drawn by her view, unflagged');
    await page.evaluate(async()=>{
      const {addHullHole}=await import('/js/hull-holes.js');
      addHullHole(oceanFleet.vessels[0].boat.damage,{design:[1.7,.2,1],local:[3.1,.2,1],radius:.2,side:1,compartment:'midStarboard'});
    });
    assert.deepEqual(await drawnNext(page),{programs:VIEW,damaged:true},'a holed ship is flagged DAMAGED, drawn by the same view');
    await page.evaluate(async()=>{
      const {clearHullHoles}=await import('/js/hull-holes.js');
      clearHullHoles(oceanFleet.vessels[0].boat.damage);
    });
    assert.deepEqual(await drawnNext(page),{programs:VIEW,damaged:false},'a repaired ship goes back');
    await page.evaluate(()=>{
      const damage=oceanFleet.vessels[0].boat.damage;
      damage.craters=[{x:1.7,y:.2,z:1,radius:.1,depth:.3,hits:1}];damage.cratersRevision=(damage.cratersRevision??0)+1;
    });
    assert.deepEqual(await drawnNext(page),{programs:VIEW,damaged:true},'a crater also marks her');
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});
