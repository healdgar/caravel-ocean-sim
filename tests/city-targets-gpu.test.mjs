// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A house of Lisbon under fire, on the actual GPU: the ball stops at it, it breaks up as a port's own building
// does, its block and its instance give way to its pieces, a save brings the ruin back, and the town rebuilds it.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

let server,browser;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});

// Over the roofs a little north of the quay, looking down into the town.
const EYE=[-70,34,-6250],PITCH=-24;
function instrument(){
  const r=window.cityAudit={errors:[],ruins:0,frames:0,writes:[]};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
  const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,...rest){if(/^city (blocks|buildings groups|struck buildings)$/.test(buffer.label||''))r.writes.push(buffer.label);return write.call(this,buffer,...rest);};
  const pass=GPURenderPassEncoder.prototype,set=pass.setPipeline,draw=pass.drawIndexed,current=new WeakMap();
  pass.setPipeline=function(p){current.set(this,p.label);return set.call(this,p);};
  pass.drawIndexed=function(...args){if(current.get(this)==='city ruins')r.ruins++;return draw.apply(this,args);};
  const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return texture.apply(this,args);};
}
const open=async(state=null)=>{
  const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(instrument);
  const url=coastalRegionStageURL('http://127.0.0.1:'+server.address().port+'/','lisbon','dock','clear',1650);
  for(const [key,value] of Object.entries({w:640,h:360,view:'free',prow:'0',cam:`${EYE.join(',')},0,${PITCH}`,realDEM:'off',clouds:'0',follower:'0',...(state?{state}:{})}))url.searchParams.set(key,value);
  await page.goto(url.toString());
  await page.waitForFunction(()=>oceanStartup.state==='ready'||oceanStartup.state==='failed',undefined,{timeout:240000,polling:200});
  assert.equal(await page.evaluate(()=>oceanStartup.state),'ready',await page.evaluate(()=>document.querySelector('#err')?.textContent));
  return {page,errors};
};
const frames=(page,n)=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
// The middle of the picture, clear of the panels, as numbers.
const middle=async page=>{
  const picture=(await page.screenshot({clip:{x:200,y:90,width:240,height:180}})).toString('base64');
  return page.evaluate(async data=>{
    const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+data)).blob()),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
    context.drawImage(bitmap,0,0);return Array.from(context.getImageData(0,0,bitmap.width,bitmap.height).data);
  },picture);
};
const changed=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>24)n++;return n/(a.length/4);};

test('a house of the city takes shot, breaks up, comes back a ruin from a save, and is rebuilt',{timeout:900000},async t=>{
  const first=await open();let saved;
  try{
    const {page}=first;
    await frames(page,30);
    const whole=await middle(page);
    const before=await page.evaluate(()=>({ruins:cityAudit.ruins,writes:cityAudit.writes.length,city:oceanFleet.terrain.port.instances.filter(i=>i.city).length,targets:oceanFleet.terrain.cityTargets?.count??0}));
    assert.ok(before.targets>5000,`${before.targets} buildings of the plan are targets`);
    assert.equal(before.city,0,'none is a building of the port until struck');
    assert.equal(before.ruins,0);
    // What stands in the middle of the picture, and four balls into it along the line of sight.
    const struck=await page.evaluate(async({eye,pitch})=>{
      const {applyBuildingImpactDamage,sweepBuildingSegment}=await import('/js/gunnery-control.js'),terrain=oceanFleet.terrain,port=terrain.port;
      const a=pitch*Math.PI/180,d=[0,Math.sin(a),-Math.cos(a)],to=[eye[0]+d[0]*400,eye[1]+d[1]*400,eye[2]+d[2]*400];
      const aimed=terrain.sweepCity(eye,to,.08,{previewOnly:true,exact:true},sweepBuildingSegment);
      if(!aimed)return null;
      const untouched=port.instances.length;
      let hits=0,through=0;
      for(let n=0;n<4;n++){
        const hit=terrain.sweepCity(eye,to,.08,null,sweepBuildingSegment);
        if(!hit){through++;continue;}
        applyBuildingImpactDamage(hit.building,{...hit,mass:10.9,ammo:'round',velocity:d.map(v=>v*420),energy:961000});hits++;
        for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);
      }
      const building=aimed.building;window.cityStruck=building;
      for(let i=0;i<600&&!(building.damageState?.fracture?.brokenCount>0);i++)await new Promise(requestAnimationFrame);
      for(let i=0;i<1200&&building.damageState.fracture.flying.size;i++)await new Promise(requestAnimationFrame);
      const {encodeGameStateParam}=await import('/js/sharing.js');
      return {id:building.id,prefabId:building.prefabId,index:building.city.index,untouched,buildings:port.instances.length,inPort:port.instances.includes(building),hits,through,
        distance:Math.hypot(building.x-eye[0],building.z-eye[2]),broken:building.damageState.fracture.brokenCount,shards:building.damageState.fracture.fracture.shards.length,
        state:building.damageState.state,flying:building.damageState.fracture.flying.size,link:encodeGameStateParam({v:1,portDamage:oceanFleet.portDamage.forLink(port)}),
        ground:terrain.groundSample(building.x,building.z),floor:building.y};
    },{eye:EYE,pitch:PITCH});
    assert.ok(struck,'the line of sight meets a building of the city');
    t.diagnostic(JSON.stringify({...struck,link:struck.link.length}));
    assert.match(struck.id,/^city_\d+$/);
    assert.ok(struck.hits>=1&&struck.inPort&&struck.buildings>struck.untouched,'it is a building of the port now');
    assert.ok(struck.broken>5&&struck.broken<struck.shards,`${struck.broken} of ${struck.shards} pieces left it`);
    assert.equal(struck.flying,0);
    // Its pieces are drawn every frame by their own pipeline, and nothing is uploaded once they have settled. In a
    // close-built town the shot that went on through its breach struck the houses behind, each of which is left out
    // of the city's own drawing in its turn: wait until the last of them has been.
    await page.evaluate(async()=>{
      for(let quiet=0,seen=cityAudit.writes.length,i=0;quiet<90&&i<2400;i++){
        await new Promise(requestAnimationFrame);
        if(cityAudit.writes.length===seen)quiet++;else{quiet=0;seen=cityAudit.writes.length;}
      }
    });
    await frames(page,10);
    const settled=await page.evaluate(()=>({ruins:cityAudit.ruins,frames:cityAudit.frames,writes:cityAudit.writes.slice()}));
    await frames(page,30);
    const later=await page.evaluate(()=>({ruins:cityAudit.ruins,frames:cityAudit.frames,writes:cityAudit.writes.length,errors:cityAudit.errors}));
    assert.ok(later.ruins-settled.ruins>=later.frames-settled.frames,`${later.ruins-settled.ruins} ruin draws in ${later.frames-settled.frames} frames`);
    assert.ok(settled.writes.includes('city blocks')&&settled.writes.includes('city buildings groups')&&settled.writes.includes('city struck buildings'),`its block and its instance were left out: ${settled.writes}`);
    assert.equal(later.writes,settled.writes.length,'a settled ruin is sent nothing');
    assert.deepEqual(later.errors,[]);assert.deepEqual(first.errors,[]);
    // And it looks struck.
    const ruined=await middle(page),difference=changed(whole,ruined);
    t.diagnostic(`the strike changed ${(difference*100).toFixed(1)}% of the middle of the picture`);
    assert.ok(difference>.004,`the picture hardly changed: ${(difference*100).toFixed(2)}%`);
    saved=struck;
  }finally{await first.page.close();}

  // A link made then, opened afresh: the same house is down before the town is first seen.
  const second=await open(saved.link);
  try{
    const {page}=second;
    await frames(page,20);
    const back=await page.evaluate(id=>{
      const building=oceanFleet.terrain.port.instances.find(i=>i.id===id);window.cityStruck=building;
      return building?{broken:building.damageState?.fracture?.brokenCount??0,flying:building.damageState?.fracture?.flying.size??-1,hits:building.damageState?.hits,replay:building.damageState?.replayLog??null,ruins:cityAudit.ruins,writes:cityAudit.writes.slice()}:null;
    },saved.id);
    assert.ok(back,'the record found its house');
    assert.equal(back.broken,saved.broken,'the same pieces are gone');
    assert.equal(back.flying,0);assert.equal(back.replay,null);
    assert.ok(back.ruins>0&&back.writes.includes('city blocks'),'and it is drawn as the ruin, not as its block');
    // A long time passes with no shot fired: the town has it standing again, drawn as it was at first.
    const rebuilt=await page.evaluate(async()=>{
      const building=cityStruck;
      building.damageState.lastHitDateMs=Date.UTC(1650,0,1);
      oceanFleet.portDamage.setClock(()=>Date.UTC(1652,0,1));
      for(let i=0;i<400&&building.damageState.hits;i++)await new Promise(requestAnimationFrame);
      for(let i=0;i<5;i++)await new Promise(requestAnimationFrame);
      const from=cityAudit.ruins;
      for(let i=0;i<10;i++)await new Promise(requestAnimationFrame);
      return {hits:building.damageState.hits,state:building.damageState.state,fracture:building.damageState.fracture??null,saved:oceanFleet.portDamage.forLink(oceanFleet.terrain.port)??null,ruins:cityAudit.ruins-from,errors:cityAudit.errors};
    });
    assert.equal(rebuilt.hits,0,'the town has rebuilt it');
    assert.equal(rebuilt.state,'intact');assert.equal(rebuilt.fracture,null);
    assert.equal(rebuilt.saved,null,'nothing is saved of it');
    assert.equal(rebuilt.ruins,0,'and no ruin is drawn');
    assert.deepEqual(rebuilt.errors,[]);assert.deepEqual(second.errors,[]);
  }finally{await second.page.close();}
});
