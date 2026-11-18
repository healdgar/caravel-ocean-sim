// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A live port must take fire without errors: a building of the city shot down stands as its pieces in the one
// continuum, and only its pieces' flight records are ever written, never a vertex.
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
  // The town house of the plan nearest the port, shot as a ball plunges into it from off its front: the building the
  // line meets joins the port at the first ball (js/city-targets.js). No building of the city is the port's till then.
  window.strikeCity=async({shots,mass,speed,energy})=>{
    const {applyBuildingImpactDamage,sweepBuildingSegment}=await import('/js/gunnery-control.js');
    const {CITY_BUILDING_TYPES,CITY_TYPED_FLOATS:F,cityTypeTarget}=await import('/js/old-world-buildings.js');
    const terrain=oceanFleet.terrain,{typed,typedTypes,typedCount}=oceanLand.pack.city,centre=terrain.port.center;
    let house=-1,nearest=Infinity;
    for(let i=0;i<typedCount;i++){
      if(cityTypeTarget(typedTypes[i]).prefabId!=='city_house'||CITY_BUILDING_TYPES[typedTypes[i]].height<6)continue;
      const d=Math.hypot(typed[i*F]-centre.x,typed[i*F+2]-centre.z);
      if(d<nearest){nearest=d;house=i;}
    }
    if(house<0)return null;
    const o=house*F,H=CITY_BUILDING_TYPES[typedTypes[house]].height,sin=Math.sin(typed[o+3]),cos=Math.cos(typed[o+3]);
    const from=[typed[o]+sin*30,typed[o+1]+H*.5+52,typed[o+2]+cos*30],to=[typed[o],typed[o+1]+H*.3,typed[o+2]];
    const span=Math.hypot(to[0]-from[0],to[1]-from[1],to[2]-from[2]),velocity=to.map((v,k)=>(v-from[k])/span*speed);
    const aimed=terrain.sweepCity(from,to,.08,{previewOnly:true,exact:true},sweepBuildingSegment);
    if(!aimed)return null;
    for(let n=0;n<shots;n++){
      const hit=terrain.sweepCity(from,to,.08,null,sweepBuildingSegment);
      if(hit)applyBuildingImpactDamage(hit.building,{...hit,mass,ammo:'round',velocity,energy});
      for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);
    }
    return aimed.building;
  };
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
      const building=await strikeCity({shots:6,mass:14.5,speed:400,energy:900000});
      if(!building)return {missing:true};
      window.fractureTarget=building;
      return {};
    });
    assert.ok(!hit.missing,'the shot meets a building of the city');
    await page.waitForFunction(()=>(fractureTarget.damageState.fracture?.brokenCount??0)>0,undefined,{timeout:60000,polling:100});
    const broken=await page.evaluate(()=>fractureTarget.damageState.fracture.brokenCount);
    assert.ok(broken>=4,`the house loses blocks (${broken})`);
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
      const {encodeGameStateParam}=await import('/js/sharing.js');
      const port=oceanFleet.terrain.port,building=await strikeCity({shots:4,mass:5.4,speed:300,energy:240000});
      window.fractureTarget=building;
      const frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      while(!(fractureTarget.damageState.fracture?.brokenCount>0))await frames(5);
      while(fractureTarget.damageState.fracture.flying.size)await frames(5);
      const state=building.damageState.fracture,poses=[];
      const {evaluateShardFlight}=await import('/js/ship-fracture.js');
      for(let s=1;s<state.broken.length;s++)if(state.broken[s])poses.push([s,...evaluateShardFlight(state.records.subarray(s*16,s*16+16),1e6,state.fracture.shards[s].centroid,[1,1,1])]);
      return {id:building.id,link:encodeGameStateParam({v:1,portDamage:oceanFleet.portDamage.forLink(port)}),broken:state.brokenCount,integrity:building.damageState.integrity,hits:building.damageState.hits,poses};
    });
    assert.match(saved.id,/^city_\d+$/);
    assert.ok(saved.broken>0,'the house lost blocks');
    assert.ok(saved.link.length<16384,'the link is one a browser and decodeGameStateParam will take');
  }finally{await first.close();}
  const second=await ready(await browser.newPage({viewport:{width:320,height:240}}));
  try{
    await start(second,`${scene}&state=${saved.link}`);
    const back=await second.evaluate(async id=>{
      const {evaluateShardFlight}=await import('/js/ship-fracture.js');
      const building=oceanFleet.terrain.port.instances.find(i=>i.id===id);
      if(!building)return null;
      const d=building.damageState,state=d.fracture,poses=[];
      for(let s=1;s<state.broken.length;s++)if(state.broken[s])poses.push([s,...evaluateShardFlight(state.records.subarray(s*16,s*16+16),1e6,state.fracture.shards[s].centroid,[1,1,1])]);
      window.fractureTarget=building;
      return {broken:state.brokenCount,flying:state.flying.size,integrity:d.integrity,hits:d.hits,replay:d.replayLog??null,poses};
    },saved.id);
    assert.ok(back,'the link found its house');
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
      const building=await strikeCity({shots:4,mass:5.4,speed:300,energy:240000});
      const frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      while(!(building.damageState.fracture?.brokenCount>0))await frames(5);
      while(building.damageState.fracture.flying.size)await frames(5);
      oceanVoyage.saveNow();
      const save=JSON.parse(localStorage.getItem('waterworld.career.v1'));
      return {broken:building.damageState.fracture.brokenCount,lastHit:building.damageState.lastHitDateMs,voyageDate:oceanVoyage.voyage?.dateMs??null,ports:Object.keys(save.portDamage??{}),buildings:Object.values(save.portDamage??{}).flatMap(p=>Object.keys(p)).length,key:building.id};
    });
    assert.ok(before.broken>0,'the house lost blocks');
    assert.ok(before.ports.length>=1&&before.buildings>=1,`the career save holds its damage (${JSON.stringify(before)})`);
    assert.ok(Number.isFinite(before.lastHit),'dated in the game\'s calendar, for the town to rebuild from');
    await start(`${scene}&continue=1`);
    const back=await page.evaluate(key=>{
      const building=oceanFleet.terrain.port.instances.find(i=>i.id===key),state=building?.damageState?.fracture;
      return {broken:state?.brokenCount??0,flying:state?.flying.size??-1,hits:building?.damageState?.hits??0};
    },before.key);
    assert.equal(back.broken,before.broken,'continuing brings the same pieces down');
    assert.equal(back.flying,0,'and nothing falls');
    assert.ok(back.hits>0);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});
