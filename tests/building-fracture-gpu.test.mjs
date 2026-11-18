// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A live port must take fire without errors: a building shot down stands as its pieces in the one continuum, and only
// its pieces' flight records are ever written, never a vertex.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
const port=process.env.BUILDING_FRACTURE_TEST_PORT||8139,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Building fracture server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--use-webgpu-adapter=swiftshader']});
});
after(async()=>{await browser?.close();server?.kill();});

function instrument(){
  window.gpuErrors=[];window.flightWrites=0;window.struckAtlases=0;window.buildingWrites=[];
  const make=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(descriptor){if(descriptor?.label==='struck buildings continuum atlas')window.struckAtlases++;return make.call(this,descriptor);};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,...rest){if(buffer.label==='struck buildings shard flights')window.flightWrites++;if(/vertices/.test(buffer.label||'')&&/port|fracture|struck/.test(buffer.label||''))window.buildingWrites.push(buffer.label);return write.call(this,buffer,...rest);};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
}

test('a live port pays nothing until hit, sends flights while pieces fall, then stops, and no hit writes a vertex',{timeout:560000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${origin}/?region=lisbon&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&year=1650&boatSpeed=0`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
    await frames(3);
    assert.equal(await page.evaluate(()=>struckAtlases),0,'a port under no fire costs nothing');
    const before=await page.evaluate(()=>buildingWrites.length);
    const hit=await page.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const port=oceanFleet.terrain.port,building=port.instances.find(i=>i.prefabId==='torreon_atalaya_farol');
      if(!building)return {missing:true};
      const half=(building.depth??building.length)*.5,cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      for(let i=0;i<6;i++){
        const x=(i-3)*1.5,z=half,y=3+i%3;
        const at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[sin,0,cos],velocity:[-sin*400,0,-cos*400],mass:14.5,energy:900000,ammo:'round'});
      }
      window.fractureTarget=building;
      return {};
    });
    assert.ok(!hit.missing,'Lisbon has its sea tower');
    await page.waitForFunction(()=>(fractureTarget.damageState.fracture?.brokenCount??0)>0,undefined,{timeout:60000,polling:100});
    const broken=await page.evaluate(()=>fractureTarget.damageState.fracture.brokenCount);
    assert.ok(broken>=4,`the tower loses blocks (${broken})`);
    await frames(3);
    assert.ok(await page.evaluate(()=>struckAtlases)>0,'it stands as its pieces in the continuum');
    assert.ok(await page.evaluate(()=>flightWrites)>0,'its pieces\' flights are sent');
    await page.waitForFunction(()=>fractureTarget.damageState.fracture.flying.size===0,undefined,{timeout:60000,polling:200});
    await frames(3);
    await page.evaluate(()=>{flightWrites=0;});
    await frames(5);
    assert.equal(await page.evaluate(()=>flightWrites),0,'once everything has landed nothing is sent');
    const writes=await page.evaluate(n=>buildingWrites.slice(n),before);
    assert.deepEqual(writes,[],'no hit writes a vertex');
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});

test('a share link brings a ruin back settled, and a town rebuilds it',{timeout:560000},async()=>{
  const scene=`${origin}/?region=lisbon&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&year=1650&boatSpeed=0`;
  const ready=async page=>{
    await page.addInitScript(instrument);
    return page;
  };
  const start=async(page,url)=>{
    await page.goto(url);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
  };
  const first=await ready(await browser.newPage({viewport:{width:320,height:240}}));
  let saved;
  try{
    await start(first,scene);
    saved=await first.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const {encodeGameStateParam}=await import('/js/sharing.js');
      const port=oceanFleet.terrain.port,building=port.instances.find(i=>i.prefabId==='torreon_atalaya_farol');
      const half=(building.depth??building.length)*.5,cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      for(let i=0;i<4;i++){
        const x=(i-1.5)*1.5,z=half,y=2+i%3;
        const at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[sin,0,cos],velocity:[-sin*300,0,-cos*300],mass:5.4,energy:240000,ammo:'round'});
      }
      window.fractureTarget=building;
      const frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      while(!(fractureTarget.damageState.fracture?.brokenCount>0))await frames(5);
      while(fractureTarget.damageState.fracture.flying.size)await frames(5);
      const state=building.damageState.fracture,poses=[];
      const {evaluateShardFlight}=await import('/js/ship-fracture.js');
      for(let s=1;s<state.broken.length;s++)if(state.broken[s])poses.push([s,...evaluateShardFlight(state.records.subarray(s*16,s*16+16),1e6,state.fracture.shards[s].centroid,[1,1,1])]);
      return {link:encodeGameStateParam({v:1,portDamage:oceanFleet.portDamage.forLink(port)}),broken:state.brokenCount,integrity:building.damageState.integrity,hits:building.damageState.hits,poses};
    });
    assert.ok(saved.broken>0,'the tower lost blocks');
    assert.ok(saved.link.length<16384,'the link is one a browser and decodeGameStateParam will take');
  }finally{await first.close();}
  const second=await ready(await browser.newPage({viewport:{width:320,height:240}}));
  try{
    await start(second,`${scene}&state=${saved.link}`);
    const back=await second.evaluate(async()=>{
      const {evaluateShardFlight}=await import('/js/ship-fracture.js');
      const building=oceanFleet.terrain.port.instances.find(i=>i.prefabId==='torreon_atalaya_farol'),d=building.damageState,state=d.fracture;
      const poses=[];
      for(let s=1;s<state.broken.length;s++)if(state.broken[s])poses.push([s,...evaluateShardFlight(state.records.subarray(s*16,s*16+16),1e6,state.fracture.shards[s].centroid,[1,1,1])]);
      window.fractureTarget=building;
      return {broken:state.brokenCount,flying:state.flying.size,integrity:d.integrity,hits:d.hits,replay:d.replayLog??null,poses,others:oceanFleet.terrain.port.instances.filter(i=>i.damageState?.fracture&&i!==building).length};
    });
    assert.equal(back.broken,saved.broken,'the same pieces are gone');
    assert.equal(back.flying,0,'and nothing falls');
    assert.equal(back.hits,saved.hits);
    assert.ok(Math.abs(back.integrity-saved.integrity)<1e-3);
    assert.equal(back.replay,null);
    for(const [i,row] of back.poses.entries()){
      assert.equal(row[0],saved.poses[i][0]);
      for(let c=1;c<4;c++)assert.ok(Math.abs(row[c]-saved.poses[i][c])<1e-2,`piece ${row[0]} lies where it lay: ${row} ${saved.poses[i]}`);
    }
    const frames=n=>second.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
    await frames(10);
    assert.equal(await second.evaluate(()=>{const n=struckAtlases;flightWrites=0;return n;})>0,true,'it stands as its pieces in the continuum');
    await frames(5);
    assert.equal(await second.evaluate(()=>flightWrites),0,'and nothing more is sent');
    // A long time passes with no shot fired.
    const rebuilt=await second.evaluate(async()=>{
      const building=fractureTarget;
      building.damageState.lastHitDateMs=Date.UTC(1650,0,1);
      oceanFleet.portDamage.setClock(()=>Date.UTC(1652,0,1));
      for(let i=0;i<300&&building.damageState.hits;i++)await new Promise(requestAnimationFrame);
      return {hits:building.damageState.hits,state:building.damageState.state,fracture:building.damageState.fracture??null,saved:oceanFleet.portDamage.forLink(oceanFleet.terrain.port)??null};
    });
    assert.equal(rebuilt.hits,0,'the town has rebuilt it');
    assert.equal(rebuilt.state,'intact');
    assert.equal(rebuilt.fracture,null);
    assert.equal(rebuilt.saved,null,'nothing is saved of it');
    await frames(3);
    assert.deepEqual(await second.evaluate(()=>gpuErrors),[]);
  }finally{await second.close();}
});

test('the career save keeps a ruin, and continuing brings it back settled',{timeout:560000},async()=>{
  const scene=`${origin}/?region=lisbon&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&year=1650&boatSpeed=0&voyage=1&voyageMode=easy`;
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    const start=async url=>{
      await page.goto(url);
      await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
      assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    };
    await start(scene);
    const before=await page.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const building=oceanFleet.terrain.port.instances.find(i=>i.prefabId==='torreon_atalaya_farol');
      const half=(building.depth??building.length)*.5,cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      for(let i=0;i<4;i++){
        const x=(i-1.5)*1.5,z=half,y=2+i%3;
        const at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[sin,0,cos],velocity:[-sin*300,0,-cos*300],mass:5.4,energy:240000,ammo:'round'});
      }
      const frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      while(!(building.damageState.fracture?.brokenCount>0))await frames(5);
      while(building.damageState.fracture.flying.size)await frames(5);
      oceanVoyage.saveNow();
      const save=JSON.parse(localStorage.getItem('waterworld.career.v1'));
      return {broken:building.damageState.fracture.brokenCount,lastHit:building.damageState.lastHitDateMs,voyageDate:oceanVoyage.voyage?.dateMs??null,ports:Object.keys(save.portDamage??{}),buildings:Object.values(save.portDamage??{}).flatMap(p=>Object.keys(p)).length,key:building.id};
    });
    assert.ok(before.broken>0,'the tower lost blocks');
    assert.ok(before.ports.length>=1&&before.buildings>=1,`the career save holds its damage (${JSON.stringify(before)})`);
    assert.ok(Number.isFinite(before.lastHit),'dated in the game\'s calendar, for the town to rebuild from');
    await start(`${scene}&continue=1`);
    const back=await page.evaluate(()=>{
      const building=oceanFleet.terrain.port.instances.find(i=>i.prefabId==='torreon_atalaya_farol'),state=building.damageState?.fracture;
      return {broken:state?.brokenCount??0,flying:state?.flying.size??-1,hits:building.damageState?.hits??0};
    });
    assert.equal(back.broken,before.broken,'continuing brings the same pieces down');
    assert.equal(back.flying,0,'and nothing falls');
    assert.ok(back.hits>0);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});

test('in the running game a soldier comes down with his wall, and the others keep their posts',{timeout:560000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${origin}/?region=lisbon&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&year=1650&boatSpeed=0`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    const result=await page.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const port=oceanFleet.terrain.port,frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      const building=port.instances.find(i=>i.prefabId==='curtain_wall_and_gate');
      if(!building||!port.garrison)return {missing:!building?'wall':'garrison'};
      const soldiers=building.garrisonSoldiers??[];
      const doomed=soldiers[0],before=doomed?.baseLy;
      if(!doomed)return {missing:'soldier'};
      const cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      // Square onto both faces of the wall, under him.
      for(const side of [1,-1])for(let i=-2;i<=2;i++){
        const x=side*building.width*.5,z=doomed.lz+i*1.2,y=2+Math.abs(i)%3;
        const at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[side*cos,0,-side*sin],velocity:[-side*cos*320,0,side*sin*320],mass:14.5,energy:740000,ammo:'round'});
      }
      while(!(building.damageState.fracture?.brokenCount>0))await frames(5);
      await frames(3);
      const started=doomed.garrisonFall?1:0;
      for(let i=0;i<400&&doomed.garrisonFall;i++)await frames(1);
      await frames(30);
      return {broken:building.damageState.fracture.brokenCount,before,after:doomed.baseLy,state:doomed.casualtyState,started,visible:doomed.visible,standing:soldiers.filter(s=>s.casualtyState!=='fallen').length,total:soldiers.length,ground:oceanFleet.terrain.height(doomed.position[0],doomed.position[2]),y:doomed.position[1],role:doomed.role};
    });
    assert.deepEqual(result.missing,undefined,'Lisbon has a garrisoned curtain wall');
    assert.ok(result.broken>0);
    assert.equal(result.state,'fallen',`he came down (${JSON.stringify(result)})`);
    assert.ok(result.after<result.before-1,`to the foot of the wall (${result.before} to ${result.after})`);
    assert.ok(Math.abs(result.y-result.ground)<4,`he is on the ground, not in the air (${result.y} over ${result.ground})`);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});
