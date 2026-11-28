// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Past its lists, the one cut yields by a plan, nearest first (js/wgsl/continuum-cut.js continuumReset), never by the
// order the GPU reaches its instances in. A row of bodies at rising distances, their view lists given less room than
// they ask: frame after frame each is cut alike, and alike whether the records stand near-first or far-first. Round
// shot, whose cut coarsens, yields to coarser cuts with every one still drawn; a jetty, whose cut cannot (its timbers
// are its shards, and no cluster spans two), keeps its nearest whole and lists none of the farthest.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

test('past its lists the cut yields nearest first, the same every frame and whatever order its records stand in',{timeout:240000},async t=>{
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.route('**/__continuum_plan',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto(`${base}__continuum_plan`);
  const result=await page.evaluate(async()=>{
    const {requestContinuumAtlas,requestContinuumPrograms,createContinuumScene}=await import('/js/continuum-scene.js');
    const {PROP_CONTINUUM_TYPES,PROP_CONTINUUM_SHOT,loadPropContinuum}=await import('/js/prop-continuum.js');
    const {CONTINUUM_TYPE:T,CONTINUUM_HEADER:H,CONTINUUM_TYPE_WORDS,CONTINUUM_KIND,continuumRoom}=await import('/js/continuum-format.js');
    const {CONTINUUM_STEP_WORDS,setContinuumPixelError,continuumPixelError}=await import('/js/continuum-core.js');
    const device=await (await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>`${m.lineNum}:${m.message}`).join('\n'));return module;};
    // The pack's own words: the uploaded atlas keeps only its header and types on the CPU.
    const pack=await loadPropContinuum(),atlas=await requestContinuumAtlas(device,'prop',async()=>pack);
    const programs=await requestContinuumPrograms({device,shader,shadowFormat:'depth32float'});
    const B=GPUBufferUsage,make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
    // A camera 5 m up looking down +z: clip = (x, y, 0.1, z), a focal length of 1000 px.
    const frame=new Float32Array(96);
    frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,5,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
    const frameUBO=make(frame,B.UNIFORM),shadowUBO=make(new Float32Array(28),B.UNIFORM);
    const words=pack.words,f32=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
    const field=(type,f)=>words[words[H.typesAt]+type*CONTINUUM_TYPE_WORDS+f];
    const pixels=3,before=continuumPixelError(),N=24;
    setContinuumPixelError(pixels);
    const subject=async(type,share)=>{
      // From past its own reach to where its far body would begin at 3 px: each is its clusters alone.
      const start=f32(words[field(type,T.steps)+field(type,T.farFirst)*CONTINUUM_STEP_WORDS+1])*1000/pixels;
      const reach=f32(field(type,T.sphere+3)),near=reach+4,far=0.8*start,away=Array.from({length:N},(_,k)=>near*(far/near)**(k/(N-1)));
      const counts=PROP_CONTINUUM_TYPES.map(()=>0);counts[type]=N;
      const full=continuumRoom(atlas.types,counts);
      // Each frame's view clusters, by the rank of the body's distance: `order` stands rank k at record order[k].
      const run=async(room,order,frames)=>{
        const scene=createContinuumScene({device,atlas,programs,capacity:full.capacity,room,frame:frameUBO,shadowUniform:shadowUBO,samples:4,label:'test plan'});
        scene.setShadows(false);
        order.forEach((index,k)=>scene.place(index,{position:[k%2?3:-3,0,away[k]],scale:1,type,kind:CONTINUUM_KIND.RIGID,flags:0,pose:0,reach:0,seed:k+1}));
        scene.send(0,N);scene.setCount(N);
        const rank=new Map(order.map((index,k)=>[index,k])),out=[];
        for(let f=0;f<frames;f++){
          const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
          scene.encode(pass);pass.end();
          const readDraws=device.createBuffer({size:scene.draws.size,usage:B.MAP_READ|B.COPY_DST}),readList=device.createBuffer({size:scene.list.size,usage:B.MAP_READ|B.COPY_DST});
          encoder.copyBufferToBuffer(scene.draws,0,readDraws,0,scene.draws.size);encoder.copyBufferToBuffer(scene.list,0,readList,0,scene.list.size);
          device.queue.submit([encoder.finish()]);
          await Promise.all([readDraws.mapAsync(GPUMapMode.READ),readList.mapAsync(GPUMapMode.READ)]);
          const draws=new Uint32Array(readDraws.getMappedRange().slice(0)),list=new Uint32Array(readList.getMappedRange().slice(0));
          readDraws.unmap();readList.unmap();readDraws.destroy();readList.destroy();
          const cut=Array.from({length:N},()=>[]),used=[];
          for(const l of [0,1]){
            const [at]=scene.lists[l],n=draws[l*4+1];used.push(n);
            for(let e=0;e<n;e++){const instance=list[(at+e)*2],item=list[(at+e)*2+1];if(item>>>28===1&&rank.has(instance))cut[rank.get(instance)].push(item&0x0fffffff);}
          }
          out.push({cut:cut.map(c=>c.sort((a,b)=>a-b).join(',')),sizes:cut.map(c=>c.length),used});
        }
        scene.destroy();
        return out;
      };
      const nearFirst=Array.from({length:N},(_,k)=>k),farFirst=nearFirst.map(k=>N-1-k);
      // Room for all it asks: every body's finest cut. Then room for `share` of that, in both view lists.
      const finest=(await run(full.room,nearFirst,2)).at(-1);
      const room=full.room.map((n,l)=>l<2?Math.max(1,Math.ceil(finest.used[l]*share)):n);
      return {away,room:room.slice(0,2),finest,nearFirst:await run(room,nearFirst,5),farFirst:await run(room,farFirst,5)};
    };
    const shot=await subject(PROP_CONTINUUM_SHOT,0.7),jetty=await subject(1,0.55);
    setContinuumPixelError(before);
    await device.queue.onSubmittedWorkDone();
    device.destroy();
    return {errors,shot,jetty};
  });
  assert.deepEqual(result.errors,[]);
  for(const [name,{away,room,finest,nearFirst,farFirst}] of Object.entries({shot:result.shot,jetty:result.jetty})){
    t.diagnostic(JSON.stringify({name,away:away.map(d=>+d.toFixed(1)),room,finest:finest.sizes,nearFirst:nearFirst.map(f=>f.sizes),farFirst:farFirst.map(f=>f.sizes)}));
    assert.ok(finest.sizes.every(n=>n>0),`with room, every ${name} is listed as its clusters`);
    // From the second frame each is cut by the plan the frame before made: the same every frame, and the same
    // whichever order the GPU reached the records in.
    for(const run of [nearFirst,farFirst])for(let f=2;f<run.length;f++)assert.deepEqual(run[f].cut,run[1].cut,`${name}: frame ${f} is cut as frame 1 was`);
    const last=nearFirst.at(-1);
    assert.deepEqual(farFirst.at(-1).cut,last.cut,`${name}: far-first records are cut as near-first ones are`);
    // Within the room, with less listed than with room for all; the nearest at its finest.
    for(const l of [0,1])assert.ok(last.used[l]<=room[l],`${name}: list ${l} holds ${last.used[l]} of ${room[l]}`);
    assert.ok(last.used[0]+last.used[1]<finest.used[0]+finest.used[1],`${name}: it yields`);
    assert.equal(last.cut[0],finest.cut[0],`the nearest ${name} keeps its finest cut`);
    // Nearest first: as with room for all, none farther is listed with more clusters than one nearer.
    assert.ok(finest.sizes.every((n,k)=>!k||n<=finest.sizes[k-1]),`${name}: with room, nearer bodies take more clusters`);
    assert.ok(last.sizes.every((n,k)=>!k||n<=last.sizes[k-1]),`${name}: none farther is cut finer than one nearer: ${JSON.stringify(last.sizes)}`);
  }
  // Shot coarsens: every ball still drawn, the farther coarser. A jetty cannot: its nearest drawn whole, the rest not.
  assert.ok(result.shot.nearFirst.at(-1).sizes.every(n=>n>0),'every ball is still drawn');
  const jetty=result.jetty.nearFirst.at(-1),drawn=jetty.sizes.findIndex(n=>n===0);
  assert.ok(drawn>0&&jetty.sizes.slice(drawn).every(n=>n===0),`the nearest jetties are drawn and the farthest not: ${JSON.stringify(jetty.sizes)}`);
  assert.ok(jetty.cut.slice(0,drawn).every((cut,k)=>cut===result.jetty.finest.cut[k]),'each jetty drawn is drawn whole');
});
