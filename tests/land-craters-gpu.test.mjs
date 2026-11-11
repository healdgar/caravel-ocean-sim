import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

// A level pasture a mile outside the town's walls, and a beach well away from it. The beach is a mark to search from: the shore moves
// whenever the coast is cut again, so the test finds ground a hand above the tideline near it, where a pit goes below.
const FIELD={region:'lisbon',x:1570,z:-7379},BEACH={region:'lisbon',x:-2198.2,z:-5369.8};
const SIZE=[960,540];

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

async function open(spot,params={}){
  const url=coastalRegionStageURL(base,spot.region,'dock','clear',1650);
  for(const [k,v] of Object.entries({w:SIZE[0],h:SIZE[1],polygons:'fixed',view:'free',sunElev:40,clouds:0,...params}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:SIZE[0],height:SIZE[1]}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  try{
    await page.goto(url.toString());
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:240000,polling:200});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  }catch(error){await page.close();throw error;}
  await page.addStyleTag({content:'*{visibility:hidden!important}canvas{visibility:visible!important}'});
  return {page,errors};
}
// The nearest level ground to a mark that stands a hand above the tide.
async function tidelineNear(spot,reach=120){
  const {page}=await open(spot);
  const found=await page.evaluate(([x,z,reach])=>{
    const terrain=window.oceanFleet.terrain,ground=(px,pz)=>terrain.groundSample(px,pz);
    let best=null;
    for(let dz=-reach;dz<=reach;dz+=2)for(let dx=-reach;dx<=reach;dx+=2){
      const d=Math.hypot(dx,dz),h=ground(x+dx,z+dz);
      if(!(h>.15&&h<.35)||(best&&d>=best.d))continue;
      // Level for three metres round, so the whole pit is on the beach.
      if([[3,0],[-3,0],[0,3],[0,-3]].every(([ox,oz])=>Math.abs(ground(x+dx+ox,z+dz+oz)-h)<.2))best={x:x+dx,z:z+dz,d};
    }
    return best;
  },[spot.x,spot.z,reach]);
  await page.close();
  assert.ok(found,`there is level beach a hand above the tide within ${reach} m of the mark`);
  return {...spot,x:found.x,z:found.z};
}
async function aimedFrom(spot,offset){
  const {page}=await open(spot);
  const [h,under]=await page.evaluate(([x,z,dx,dz])=>[window.oceanFleet.terrain.groundSample(x,z),window.oceanFleet.terrain.groundSample(x+dx,z+dz)],[spot.x,spot.z,offset[0],offset[2]]);
  await page.close();
  const from=[spot.x+offset[0],Math.max(h,under)+offset[1],spot.z+offset[2]];
  const dx=spot.x-from[0],dy=h-from[1],dz=spot.z-from[2];
  return [...from,Math.atan2(dx,-dz)*180/Math.PI,Math.atan2(dy,Math.hypot(dx,dz))*180/Math.PI].map(v=>+v.toFixed(4)).join(',');
}
const firedAndLanded=async(page,count)=>{
  const start=await page.evaluate(()=>[window.oceanFreeCannon.state.guns[0].roundsFired,window.oceanFleet.terrain.landImpacts?.length??0]);
  await page.keyboard.down('f');
  await page.waitForFunction(n=>window.oceanFreeCannon.state.guns[0].roundsFired>=n,start[0]+count,{timeout:120000,polling:30});
  await page.keyboard.up('f');
  await page.waitForFunction(n=>(window.oceanFleet.terrain.landImpacts?.length??0)>=n,start[1]+count,{timeout:30000,polling:50});
};
// Mean light of each block of the picture.
async function blocks(page){
  const data=(await page.screenshot()).toString('base64');
  return page.evaluate(async b64=>{
    const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    const {data}=context.getImageData(0,0,bitmap.width,bitmap.height),size=16,cols=Math.floor(bitmap.width/size),rows=Math.floor(bitmap.height/size),out=[];
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
      let sum=0;
      for(let y=j*size;y<(j+1)*size;y++)for(let x=i*size;x<(i+1)*size;x++){const at=(y*bitmap.width+x)*4;sum+=.2126*data[at]+.7152*data[at+1]+.0722*data[at+2];}
      out.push(sum/(size*size));
    }
    return {cols,rows,light:out};
  },data);
}
const compare=(a,b)=>{
  let darkest=1,changed=0;
  a.light.forEach((value,index)=>{
    const ratio=b.light[index]/Math.max(value,1);
    if(ratio<darkest)darkest=ratio;
    if(Math.abs(ratio-1)>.08)changed++;
  });
  return {darkest,changed:changed/a.light.length};
};
const CLEAR_MS=7000;

test('a ball on the ground leaves a pit with a rim, the land around it is as it was, and more shot makes it bigger',async()=>{
  const cam=await aimedFrom(FIELD,[16,5.5,12]);
  const {page,errors}=await open(FIELD,{cam});
  let untouched,grown,link;
  try{
    await page.waitForTimeout(2000);
    untouched=await blocks(page);
    await firedAndLanded(page,1);
    await page.waitForTimeout(CLEAR_MS);
    const once=compare(untouched,await blocks(page));
    assert.ok(once.darkest<.6,`a dark pit in the picture: its darkest block has ${once.darkest} of the light it had`);
    assert.ok(once.changed>.002&&once.changed<.05,`and only there, not a stain on the whole field: ${once.changed} of the picture changed`);
    const land=await page.evaluate(async()=>{
      const terrain=window.oceanFleet.terrain,{x,z}=terrain.landImpacts[0].position.reduce((p,v,i)=>i===0?{...p,x:v}:i===2?{...p,z:v}:p,{});
      const craters=terrain.craters;
      if(!craters)return {x,z,heightHere:terrain.height(x,z)};
      await craters.ready;
      for(let i=0;i<30&&!craters.stats.tiles;i++)await new Promise(requestAnimationFrame);
      const c=craters.ledger.records[0],probes={};
      for(const distance of [0,.4,.8,1,1.2,1.4,2,3,8])probes[distance]=await Promise.all([[1,0],[-1,0],[0,1],[0,-1]].map(([u,v])=>craters.probe(c.x+u*distance,c.z+v*distance)));
      return {x,z,c,probes,stats:{...craters.stats},heightHere:terrain.height(x,z),groundHere:terrain.groundSample(x,z)};
    });
    assert.ok(land.probes,'the ground has craters');
    const across=(distance,field)=>land.probes[distance].filter(Boolean).map(p=>p[field]);
    const floor=Math.min(...across(0,'height'));
    assert.ok(floor<-.4&&floor>-.75,`a pit deep enough to stand in to the knee: ${floor}`);
    const rim=Math.max(...[1,1.2,1.4].flatMap(d=>across(d,'height')));
    assert.ok(rim>.07&&rim<.4,`with a rim thrown up around it: ${rim}`);
    for(const p of land.probes[8])assert.ok(!p||(p.height===0&&p.cover===0),'and nothing eight metres off');
    assert.ok(Math.max(...across(0,'soil'))>.9,'turned-over earth in the bowl');
    assert.ok(Math.max(...across(2,'soil'))>.03,'and thrown out past the rim');
    assert.ok(land.stats.tiles<=9,`a crater costs few tiles: ${land.stats.tiles}`);
    // Height queries know nothing of it, so shot, walkers and hulls go on as they were.
    const queries=await page.evaluate(({x,z})=>{
      const t=window.oceanFleet.terrain,boat={x:x+1,z:z+1,heading:0,hydrodynamics:{draft:2}};
      return {height:t.height(x,z),ground:t.groundSample(x,z),moved:t.constrain(boat,x,z)};
    },land);
    assert.equal(queries.height,land.heightHere);
    assert.ok(Math.abs(land.groundHere-land.probes[0][0].groundY)<.5,'the tile sits on the land the queries report');
    // More shot on the same place: one crater, deeper and wider.
    await firedAndLanded(page,4);
    await page.waitForTimeout(CLEAR_MS);
    grown=await page.evaluate(async()=>{
      const craters=window.oceanFleet.terrain.craters,c=[...craters.ledger.records].sort((a,b)=>b.energyJ-a.energyJ)[0],probe=await craters.probe(c.x,c.z);
      return {energyJ:c.energyJ,floor:probe.height,count:craters.ledger.records.length,saved:window.oceanFleet.portDamage.snapshot(window.oceanFleet.terrain.ports)?.['@ground']?.lisbon};
    });
    assert.ok(grown.energyJ>land.c.energyJ*3,`the hits went into one crater: ${grown.count} craters, the largest ${grown.energyJ} J`);
    assert.ok(grown.floor<floor*1.25,`and it is deeper: ${floor} to ${grown.floor}`);
    assert.ok(grown.saved?.length>=6,'the career save has it');
    assert.deepEqual(errors,[]);
    // The share link brings it back, drawn, before a shot is fired.
    link=await page.evaluate(async()=>{
      const {encodeGameStateParam}=await import('/js/sharing.js');
      return encodeGameStateParam({v:1,portDamage:window.oceanFleet.portDamage.forLink(window.oceanFleet.terrain.port)});
    });
    assert.ok(link.length<16384,`${link.length} characters`);
  }finally{await page.close();}
  const again=await open(FIELD,{cam,state:link});
  try{
    await again.page.waitForFunction(()=>window.oceanFleet.terrain?.craters?.stats.tiles>0,null,{timeout:60000,polling:100});
    await again.page.waitForTimeout(1500);
    const back=await again.page.evaluate(async()=>{
      const craters=window.oceanFleet.terrain.craters,c=[...craters.ledger.records].sort((a,b)=>b.energyJ-a.energyJ)[0];
      return {count:craters.ledger.records.length,energyJ:c.energyJ,floor:(await craters.probe(c.x,c.z)).height};
    });
    assert.equal(back.count,grown.count);
    assert.ok(Math.abs(back.energyJ-grown.energyJ)<1000);
    assert.ok(Math.abs(back.floor-grown.floor)<.02,`the same pit: ${grown.floor} and ${back.floor}`);
    assert.ok(compare(untouched,await blocks(again.page)).darkest<.6,'and in the picture');
    assert.deepEqual(again.errors,[]);
  }finally{await again.page.close();}
});

test('on a beach the pit is sand, shallower and wider, and stands full where it goes below the tide',async()=>{
  const beach=await tidelineNear(BEACH),cam=await aimedFrom(beach,[16,5.5,12]);
  const {page,errors}=await open(beach,{cam});
  try{
    await page.waitForTimeout(1500);
    await firedAndLanded(page,1);
    const info=await page.evaluate(async()=>{
      const terrain=window.oceanFleet.terrain,craters=terrain.craters;
      await craters.ready;
      for(let i=0;i<30&&!craters.stats.tiles;i++)await new Promise(requestAnimationFrame);
      const c=craters.ledger.records[0],floor=await craters.probe(c.x,c.z);
      return {sand:c.sand,floor:floor.height,groundY:floor.groundY};
    });
    assert.ok(info.groundY>.05&&info.groundY<.5,`the beach here is just above the tide: ${info.groundY}`);
    assert.ok(info.sand>.5,`this ground is sand: ${info.sand}`);
    assert.ok(info.floor<-.2&&info.floor>-.5,`shallower than in turf: ${info.floor}`);
    assert.ok(info.groundY+info.floor<0,'its floor is below the sea, on this low beach');
    await page.waitForTimeout(800);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
