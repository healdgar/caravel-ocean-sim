import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

// The townsfolk are placed by a compute shader from packed walkers, packed routes and the frame's clock. The sound
// of their feet is worked out in JavaScript from the same three (townWalkerStride in js/audio.js). This reads back
// where the GPU put the people of Lisbon and checks that the listener's reckoning puts them in the same places.

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const instrument=()=>{
  window.townSent={};window.townBuffers={};
  const kept=label=>/^townsfolk (draws|bodies)$/.test(label)?label:/^frame ubo \(/.test(label)?'frame':null;
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){
    const name=kept(d.label||''),buffer=createBuffer.call(this,name?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);
    if(name)townBuffers[name]=buffer;
    return buffer;
  };
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.townDevice=await request.apply(this,a);};
  // The walkers and their routes are sent once, when the town is laid out.
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...rest){
    if(buffer.label==='townsfolk walkers'||buffer.label==='townsfolk routes')townSent[buffer.label]=new Float32Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
    return write.call(this,buffer,offset,data,...rest);
  };
};

// Where the GPU last put each person it drew, and where the listener's reckoning puts every walker at that frame's
// clock and at the clock a second later.
const compare=page=>page.evaluate(async()=>{
  await new Promise(requestAnimationFrame);
  const device=townDevice,sources=[townBuffers['townsfolk bodies'],townBuffers['townsfolk draws'],townBuffers.frame];
  const reads=sources.map(b=>device.createBuffer({size:b.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
  const encoder=device.createCommandEncoder();
  sources.forEach((b,i)=>encoder.copyBufferToBuffer(b,0,reads[i],0,b.size));
  device.queue.submit([encoder.finish()]);
  await Promise.all(reads.map(b=>b.mapAsync(GPUMapMode.READ)));
  const [bodyBytes,drawBytes,frameBytes]=reads.map(b=>{const bytes=b.getMappedRange().slice(0);b.unmap();b.destroy();return bytes;});
  const bodies=new Float32Array(bodyBytes),draws=new Uint32Array(drawBytes),frame=new Float32Array(frameBytes);
  const {townWalkerStride}=await import('/js/audio.js');
  // Past the drawn buckets lie the shadow casters, who include people just out of sight.
  const {TOWNSFOLK_BUCKETS,TOWNSFOLK_SHADOW_BUCKET}=await import('/js/wgsl/townsfolk.js');
  const streets={walkers:townSent['townsfolk walkers'],samples:townSent['townsfolk routes']};
  const people=streets.walkers.length/12,clock=frame[19],sunY=frame[33];
  const reckon=at=>{
    const list=[];
    for(let i=0;i<people;i++){const stride=townWalkerStride(streets,i,at,sunY);if(stride)list.push([stride.position.x,stride.position.y,stride.position.z]);}
    return list;
  };
  const now=reckon(clock),later=reckon(clock+1);
  const span=bodies.length/8/TOWNSFOLK_BUCKETS,drawn=[];
  for(let b=0;b<TOWNSFOLK_SHADOW_BUCKET;b++)for(let slot=0;slot<draws[b*5+1];slot++){const at=(b*span+slot)*8;drawn.push([bodies[at],bodies[at+1],bodies[at+2]]);}
  const worst=list=>{
    let far=0;
    for(const body of drawn){
      let near=Infinity;
      for(const p of list)near=Math.min(near,Math.hypot(p[0]-body[0],p[1]-body[1],p[2]-body[2]));
      far=Math.max(far,near);
    }
    return far;
  };
  return {clock,sunY,people,abroad:now.length,drawn:drawn.length,worst:worst(now),worstASecondOff:worst(later)};
});

test('the listener reckons each of the townsfolk to be where the GPU draws them',{timeout:300000},async t=>{
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',cam:'5,70,-5760,0,-14'}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  try{
    await page.goto(url.toString());
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
    await page.waitForTimeout(5000);
    const first=await compare(page);
    t.diagnostic(JSON.stringify(first));
    assert.ok(first.people>100&&first.drawn>40,`too few people to judge by: ${JSON.stringify(first)}`);
    assert.ok(first.sunY>.3,'it is day, so they are out');
    assert.ok(first.abroad>=first.drawn,'no one is drawn whom the listener takes to be indoors');
    assert.ok(first.worst<.02,`someone is drawn ${first.worst.toFixed(3)} m from where any walker is reckoned to be: ${JSON.stringify(first)}`);
    // The agreement is in the clock, not in people standing still: a second out, they are somewhere else.
    assert.ok(first.worstASecondOff>.3,JSON.stringify(first));
    await page.waitForTimeout(3000);
    const second=await compare(page);
    assert.ok(second.clock>first.clock+1,'the clock runs');
    assert.ok(second.drawn>40&&second.worst<.02,`and they still agree: ${JSON.stringify(second)}`);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
