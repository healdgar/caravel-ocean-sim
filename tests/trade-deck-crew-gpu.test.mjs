// The hands aboard passing vessels in the game itself: placed on the GPU from each vessel's pose, and cut and drawn
// through the people continuum (js/trade-vessels.js on js/crew-continuum-draw.js).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {CREW_CONTINUUM_LISTS} from '../js/wgsl/crew-continuum.js';
import {DECK_CREW_DISPATCH_WORDS,DECK_CREW_FALLBACK_AT,DECK_CREW_FALLBACK_WORDS,deckCrewBodyFor} from '../js/trade-vessels.js';

// The bodies' streams are published, not committed: a checkout without them draws the old bodies.
const baked=[deckCrewBodyFor('crew',false),deckCrewBodyFor('captain',false)].every(id=>fs.existsSync(new URL(`../assets/crew/continuum/${id}/vertices.bin.gz`,import.meta.url)));
let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const instrument=()=>{
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.deckDevice??=await request.apply(this,a);};
};
async function open(query){
  // Lisbon in 1550 is a founded port: its board sends vessels in and out, each with its company.
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1550);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',census:'1',...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());if(/Trade deck crews|trade-vessels deck crew|Crew continuum/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  return {page,errors};
}
// Who the placing pass kept for each body, and how many instances each of the continuum's lists drew, over a frame.
const shown=page=>page.evaluate(async({lists,dispatchWords,fallbackAt,fallbackWords})=>{
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  const device=window.deckDevice,ships=window.oceanTradeVessels,deck=ships.deckCrew;
  const read=async(buffer,bytes)=>{
    const copy=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,copy,0,bytes);device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ);const words=new Uint32Array(copy.getMappedRange().slice(0));copy.destroy();return words;
  };
  const counts=deck?await read(deck.counts,deck.counts.size):null;
  const bodies=(deck?.bodies??[]).map((body,b)=>({...body,kept:counts[b*dispatchWords],old:counts[fallbackAt+b*fallbackWords+1]}));
  const drawn=Object.fromEntries(lists.map(name=>[name,0]));
  for(const {buffer,records} of ships.peopleDraws()){
    const words=await read(buffer,records*16);
    lists.forEach((name,i)=>{drawn[name]+=words[i*4+1];});
  }
  return {aboard:ships.deckCrewCount,bodies,drawn,census:window.oceanContinuumCensus?.latest?.families??null};
},{lists:CREW_CONTINUUM_LISTS,dispatchWords:DECK_CREW_DISPATCH_WORDS,fallbackAt:DECK_CREW_FALLBACK_AT,fallbackWords:DECK_CREW_FALLBACK_WORDS});

test('hands aboard passing vessels are placed on the GPU and cut and drawn through the continuum',{skip:!baked&&'continuum bodies not baked here',timeout:600000},async()=>{
  // First where the vessels lie, then an eye on the nearest with anyone aboard, from a little off its beam.
  const first=await open({cam:'84,23,-5878,-44,-4'});
  let target;
  try{
    await first.page.waitForFunction(()=>window.oceanTradeVessels?.locate?.().some(v=>v.deckPeople?.length),null,{timeout:240000,polling:500});
    target=await first.page.evaluate(()=>{
      const all=window.oceanTradeVessels.locate().filter(v=>v.deckPeople?.length);
      all.sort((a,b)=>(a.phase==='dock'?0:1)-(b.phase==='dock'?0:1)||a.speed-b.speed);
      return all[0];
    });
    assert.deepEqual(first.errors,[]);
  }finally{await first.page.close();}
  assert.ok(target,'a vessel with hands aboard');
  const off=[Math.cos(target.yaw)*28,Math.sin(target.yaw)*28];
  const eye=[target.worldX+off[0],(target.y??0)+9,target.worldZ+off[1]];
  const dx=target.worldX-eye[0],dz=target.worldZ-eye[2];
  const yaw=Math.atan2(dx,-dz)*180/Math.PI,pitch=Math.atan2(-7,Math.hypot(dx,dz))*180/Math.PI;
  const {page,errors}=await open({cam:`${eye[0].toFixed(1)},${eye[1].toFixed(1)},${eye[2].toFixed(1)},${yaw.toFixed(2)},${pitch.toFixed(2)}`});
  try{
    await page.waitForFunction(()=>window.oceanTradeVessels?.deckCrew?.bodies?.some(b=>b.continuum),null,{timeout:120000,polling:500});
    await page.waitForTimeout(4000);
    const seen=await shown(page);
    console.log('deck crew',JSON.stringify({target:{id:target.id,kind:target.kind,phase:target.phase},...seen}));
    assert.ok(seen.aboard>0,'souls stand at the stations');
    const kept=seen.bodies.reduce((n,b)=>n+b.kept,0);
    assert.ok(kept>0,`no one placed: ${JSON.stringify(seen.bodies)}`);
    for(const body of seen.bodies)assert.ok(body.kept<=body.capacity,`${body.id} keeps no more than its room`);
    assert.ok(seen.drawn.clusters+seen.drawn.chain+seen.drawn.splat>0,`drawn: ${JSON.stringify(seen.drawn)}`);
    assert.equal(seen.drawn.clustersCut+seen.drawn.chainCut,0,'no one aboard is cut away');
    if(seen.census)assert.ok(seen.census.people>0,`the census counts them as people: ${JSON.stringify(seen.census)}`);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
