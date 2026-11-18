// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Port props and round shot on the one continuum (AGENTS.md rule 3): a jetty cut on the GPU at the scene's pixel
// error, near as clusters, across the handoff band and beyond as its far body, then a splat; broken, as its shards'
// own clusters at every distance, a flying shard carried and a sunk one gone; its shadow a coarse cut of the same.
// And in Lisbon, the game's own lists read back: props and shot drawn by nothing but the continuum's indirect draws,
// nothing sent while nothing changes, a shot's damage sent once, and debris on the simulation's clock.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {CITY_CONTINUUM_BROKEN,CITY_CONTINUUM_GONE} from '../js/wgsl/city-continuum.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

test('a jetty and a ball through the prop continuum: clusters, handoff, far body, splat; broken, its shards alone',{timeout:240000},async t=>{
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.route('**/__prop_continuum',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto(`${base}__prop_continuum`);
  const result=await page.evaluate(async()=>{
    const {requestPropContinuumAtlas,requestPropContinuumPipelines,createPropContinuumScene}=await import('/js/prop-continuum-draw.js');
    const {PROP_CONTINUUM_TYPE:T,PROP_CONTINUUM_SHOT}=await import('/js/prop-continuum.js');
    const {CITY_CONTINUUM_HEADER:H,CITY_CONTINUUM_TYPE_WORDS,CITY_CONTINUUM_STEP_WORDS,CITY_CONTINUUM_CLUSTER_WORDS}=await import('/js/city-continuum.js');
    const {CITY_CONTINUUM_BROKEN:PROP_CONTINUUM_BROKEN,CITY_CONTINUUM_GONE:PROP_CONTINUUM_GONE}=await import('/js/wgsl/city-continuum.js');
    const {setContinuumPixelError}=await import('/js/continuum-core.js');
    const device=await (await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>`${m.lineNum}:${m.message}`).join('\n'));return module;};
    const atlas=await requestPropContinuumAtlas(device);
    // The view's and the shadow map's pipelines are built with the cut's: every program compiles.
    const pipelines=await requestPropContinuumPipelines({device,shader,format:'rgba16float',samples:4,shadowFormat:'depth32float'});
    const B=GPUBufferUsage,make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
    // A camera 5 m up looking down +z: clip = (x, y, 0.1, z), a focal length of 1000 px; the frame clock at 0 s.
    const frame=new Float32Array(96);
    frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,5,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
    const frameUBO=make(frame,B.UNIFORM);
    // A shadow map 40 m across, 5 cm a texel, centred where the instance stands.
    const shadowAt=away=>{const s=new Float32Array(28);s[0]=0.05;s[5]=0.05;s[10]=0.01;s[14]=0.5;s[15]=1;s.set([0,0,away,0],16);s.set([0,1,0,0],20);s.set([0.05,0.05,1,0],24);return make(s,B.UNIFORM);};
    const words=atlas.words,f32=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
    const field=(type,f)=>words[words[H.typesAt]+type*CITY_CONTINUUM_TYPE_WORDS+f];
    const stepError=(type,s)=>f32(words[field(type,T.steps)+s*CITY_CONTINUUM_STEP_WORDS+1]);
    const partOf=c=>words[words[H.clustersAt]+c*CITY_CONTINUUM_CLUSTER_WORDS+15]>>>16;
    const typeOf=type=>({farFirst:field(type,T.farFirst),clusterFirst:field(type,T.clusterFirst),clusterCount:field(type,T.clusterCount),rx:f32(field(type,T.splatRx)),ry:f32(field(type,T.splatRy)),handoff:stepError(type,field(type,T.farFirst))});
    const JETTY=1,jetty=typeOf(JETTY),shot=typeOf(PROP_CONTINUUM_SHOT);
    // The jetty's shards as js/ship-fracture.js lays them out, all standing; one in flight, risen 5 m in 10 s, and one
    // in flight but sunk out of sight. The block's clock read zero 10 s before the frame's.
    const shards=new Set();for(let c=jetty.clusterFirst;c<jetty.clusterFirst+jetty.clusterCount;c++)shards.add(partOf(c));
    const count=Math.max(...shards)+1,records=new Float32Array(4+count*16);
    records[0]=590;
    for(let s=0;s<count;s++)records.set([0,0,0,0, 0,0,0,1000, 0,0,0,-1, 0,0,0,-2],4+s*16);
    const risen=[...shards][0],sunk=[...shards][1];
    records.set([0,0,0,0, 0,0.5,0,1000, 0,0,0,-1, 0,0,0,-1],4+risen*16);
    records.set([0,0,0,0, 0,0,0,1000, 0,0,0,0, 0,0,0,-1],4+sunk*16);
    const shardBuffer=make(records,B.STORAGE);
    const run=async({type=JETTY,away,y=0,pixels=3,flags=0,scale=1,seed=1,shadows=false,reach=0})=>{
      setContinuumPixelError(pixels);
      const counts=[0,0,0,0];counts[type]=1;
      const scene=createPropContinuumScene({device,atlas,pipelines,counts,shards:flags&PROP_CONTINUUM_BROKEN?shardBuffer:null,frame:frameUBO,shadowUniform:shadowAt(away),samples:4,label:'test prop'});
      scene.setShadows(shadows);
      scene.place(0,{x:0,y,z:away,scale:[scale,scale,scale],type,flags,records:0,reach,seed});
      scene.send(0,1);scene.setCount(1);
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      scene.encode(pass);pass.end();
      const readDraws=device.createBuffer({size:scene.draws.size,usage:B.MAP_READ|B.COPY_DST}),readList=device.createBuffer({size:scene.list.size,usage:B.MAP_READ|B.COPY_DST});
      encoder.copyBufferToBuffer(scene.draws,0,readDraws,0,scene.draws.size);encoder.copyBufferToBuffer(scene.list,0,readList,0,scene.list.size);
      device.queue.submit([encoder.finish()]);
      await Promise.all([readDraws.mapAsync(GPUMapMode.READ),readList.mapAsync(GPUMapMode.READ)]);
      const draws=Array.from(new Uint32Array(readDraws.getMappedRange())),list=new Uint32Array(readList.getMappedRange().slice(0));
      readDraws.unmap();readList.unmap();
      const entries=index=>{const [at]=scene.lists[index],n=draws[index*4+1],out=[];for(let k=0;k<n;k++)out.push({instance:list[(at+k)*2],what:list[(at+k)*2+1]>>>28,item:list[(at+k)*2+1]&0x0fffffff});return out;};
      const clusters=[...entries(0),...entries(1)];
      const out={clusters:clusters.map(e=>e.item),parts:[...new Set(clusters.map(e=>partOf(e.item)))],whats:[...new Set([0,1,2,3,4,5].flatMap(i=>entries(i).map(e=>`${i}:${e.what}`)))],
        far:entries(2).length,splat:entries(3).length,shadowFar:entries(4).length,shadowClusters:entries(5).length,
        vertices:[0,1,2,3,4,5].map(i=>draws[i*4]),share:list[0]&255,splatShare:(list[0]>>8)&255,step:list[1]&65535,shadowStep:list[1]>>>16};
      scene.destroy();
      return out;
    };
    const start=jetty.handoff*1000/3,splatAt=2*Math.max(jetty.rx,jetty.ry)*1000/2.5;
    const cases={
      // Near, the whole jetty is in view; farther, its far body alone, short of where its splat begins.
      near:await run({away:25}),band:await run({away:start*1.15}),far:await run({away:start*2}),farther:await run({away:start*3.5}),splat:await run({away:splatAt}),
      gone:await run({away:25,flags:PROP_CONTINUUM_GONE}),
      broken:await run({away:25,flags:PROP_CONTINUUM_BROKEN,reach:8}),brokenFar:await run({away:start*2,flags:PROP_CONTINUUM_BROKEN,reach:8}),
      shadow:await run({away:25,shadows:true}),brokenShadow:await run({away:25,flags:PROP_CONTINUUM_BROKEN,reach:8,shadows:true}),
      // A 16-pound ball, 7.3 cm in radius, at the eye's height: at 2 m its sphere, at 70 m two pixels across, its splat.
      ball:await run({type:PROP_CONTINUUM_SHOT,away:2,y:5,scale:0.073}),ballFar:await run({type:PROP_CONTINUUM_SHOT,away:70,y:5,scale:0.073}),
    };
    setContinuumPixelError(3);
    await device.queue.onSubmittedWorkDone();
    return {errors,jetty,shot,start,splatAt,risen,sunk,shards:[...shards],cases};
  });
  t.diagnostic(JSON.stringify({jetty:result.jetty,start:result.start,splatAt:result.splatAt,summary:Object.fromEntries(Object.entries(result.cases).map(([k,c])=>[k,{clusters:c.clusters.length,far:c.far,splat:c.splat,shadowFar:c.shadowFar,shadowClusters:c.shadowClusters,share:c.share,splatShare:c.splatShare,step:c.step}]))}));
  assert.deepEqual(result.errors,[]);
  const {jetty,shot,cases}=result;
  assert.deepEqual(cases.near.vertices,[384,96,96,3,96,384],'each list draws its fixed instance');
  const inType=(type,c)=>c>=type.clusterFirst&&c<type.clusterFirst+type.clusterCount;
  // Near: its clusters, every shard of it there, and nothing else.
  assert.ok(cases.near.clusters.length>0&&cases.near.clusters.every(c=>inType(jetty,c)),'near, the jetty is its clusters');
  assert.deepEqual([cases.near.far,cases.near.splat,cases.near.share],[0,0,0]);
  assert.equal(cases.near.parts.length,result.shards.length,'every shard has its cut');
  // In the band, clusters and far body share the pixel; beyond, the far body alone, collapsing; then the splat.
  assert.ok(cases.band.clusters.length>0&&cases.band.far>0&&cases.band.share>0&&cases.band.share<255,'in the band, both');
  assert.ok(cases.band.step>=jetty.farFirst,'the far body never draws finer than its first step');
  assert.deepEqual([cases.far.clusters.length,cases.far.splat,cases.far.share],[0,0,255]);
  assert.ok(cases.far.far>0&&cases.farther.far>0&&cases.farther.step>cases.far.step,`collapses with distance (${cases.far.step} → ${cases.farther.step})`);
  assert.deepEqual([cases.splat.clusters.length,cases.splat.far,cases.splat.splat,cases.splat.splatShare],[0,0,1,255],'a jetty 2.5 px across is its splat');
  for(const c of Object.values(cases))for(const w of c.whats)assert.ok(['0:1','1:1','2:2','3:3','4:2','5:1'].includes(w),`entry ${w} in the right list`);
  // Gone with its pier: nothing at all.
  assert.deepEqual([cases.gone.clusters.length,cases.gone.far,cases.gone.splat],[0,0,0]);
  // Broken: its shards' own clusters, the flying one among them and the sunk one not, near and far; never a far body
  // or a splat that would span its shards.
  assert.ok(cases.broken.parts.includes(result.risen),'the shard in flight is drawn');
  assert.ok(!cases.broken.parts.includes(result.sunk),'the sunk shard is not');
  assert.equal(cases.broken.parts.length,result.shards.length-1);
  assert.ok(cases.brokenFar.clusters.length>0,'broken and far, still its clusters');
  assert.ok(cases.brokenFar.clusters.length<cases.broken.clusters.length,'cut coarser with distance');
  assert.deepEqual([cases.broken.far,cases.broken.splat,cases.brokenFar.far,cases.brokenFar.splat,cases.brokenFar.share],[0,0,0,0,0]);
  // Shadows: a whole jetty's far body at a step the map's texels allow; a broken one's shard clusters.
  assert.ok(cases.shadow.shadowFar>0&&cases.shadow.shadowClusters===0&&cases.shadow.shadowStep>=jetty.farFirst,'whole, its shadow is its far body');
  assert.ok(cases.brokenShadow.shadowClusters>0&&cases.brokenShadow.shadowFar===0,'broken, its shadow is its shards');
  // Round shot: close, the sphere's clusters; far, its splat.
  assert.ok(cases.ball.clusters.length>0&&cases.ball.clusters.every(c=>inType(shot,c)),'a ball close to is its sphere');
  assert.deepEqual([cases.ballFar.clusters.length,cases.ballFar.far,cases.ballFar.splat],[0,0,1],'a ball far off is its splat');
});

// Every draw in a render pass, by its pipeline and kind; every buffer and bind group made with a prop or shot label;
// every upload to one.
const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap();window.propDrawCalls=[];window.propCapture=false;window.propErrors=[];
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  for(const kind of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect']){
    const call=pass[kind];pass[kind]=function(...a){if(window.propCapture)propDrawCalls.push({label:pipelines.get(this),kind});return call.apply(this,a);};
  }
  const mine=label=>/^(props?|shot)\b/.test(label||'');
  window.propBuffers={};window.propMade=0;
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){
    const buffer=createBuffer.call(this,mine(d.label)&&!(d.usage&(GPUBufferUsage.MAP_READ|GPUBufferUsage.MAP_WRITE))?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);
    if(mine(d.label)){propBuffers[d.label]=buffer;propMade++;}
    return buffer;
  };
  const createBindGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(d){if(mine(d.label))propMade++;return createBindGroup.call(this,d);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){const device=await request.apply(this,a);device.addEventListener('uncapturederror',e=>propErrors.push(e.error.message));return window.propDevice=device;};
  window.propUploads=[];const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,...rest){if(window.propCapture&&mine(b.label))propUploads.push(b.label);return write.call(this,b,...rest);};
  const copy=async buffer=>{
    const read=propDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=propDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);propDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();
    return bytes;
  };
  window.propRead=label=>copy(propBuffers[label]);
  // A scene's cut as the last frame left it: each list's entries, and each instance's state.
  window.propCut=async name=>{
    const scene=oceanProps.continuum[name];if(!scene)return null;
    const draws=new Uint32Array(await copy(scene.draws)),list=new Uint32Array(await copy(scene.list));
    const lists=scene.lists.map(([at],i)=>{const out=[];for(let k=0;k<draws[i*4+1];k++)out.push({instance:list[(at+k)*2],what:list[(at+k)*2+1]>>>28,item:list[(at+k)*2+1]&0x0fffffff});return out;});
    return {count:scene.count,lists,shares:Array.from({length:scene.count},(_,i)=>list[i*4]&255)};
  };
  window.propFrames=async count=>{for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);};
};
// Two frames' draws and uploads.
const watch=page=>page.evaluate(async()=>{
  propDrawCalls.length=0;propUploads.length=0;propCapture=true;
  await propFrames(2);propCapture=false;
  return {calls:[...propDrawCalls],uploads:[...propUploads]};
});
async function open(cam){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',cam,sunElev:50,clouds:0}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  await page.waitForFunction(()=>window.oceanProps?.continuum?.props?.count>0,null,{timeout:60000,polling:100});
  await page.evaluate(()=>propFrames(4));
  return {page,errors};
}
const CAM='5,70,-5760,0,-14';
// One round shot into a prop, as the guns deliver it: a cleat on a pier, or a jetty the view's lists hold. Returns
// what was sent to the GPU in the two frames after.
const strike=(page,which)=>page.evaluate(async which=>{
  const {applyJettyImpactDamage,jettyLocalToWorld}=await import('/js/port-props.js');
  const {port,placed,models}=oceanProps;
  const seen=new Set((await propCut('props')).lists.slice(0,4).flat().map(e=>e.instance));
  const prop=which==='cleat'?placed.find(p=>p.model===0&&p.owner>=0):placed.find((p,i)=>p.model>0&&seen.has(i))??placed.find(p=>p.model>0);
  const model=models[prop.model],state=prop.fracture;
  const shard=state.shards.find(s=>s.tier===2&&state.alive[s.id])??state.shards.find(s=>state.alive[s.id]);
  const worldHit=jettyLocalToWorld(prop,shard.center[0],shard.center[1],shard.center[2],model);
  propUploads.length=0;propCapture=true;
  const report=applyJettyImpactDamage(prop,{shardId:shard.id,localPosition:[...shard.center],position:worldHit,surfacePosition:worldHit,velocity:[320,-10,0],mass:10.9,energy:550000,ammo:'round'},{port,terrain:oceanFleet.terrain});
  await propFrames(2);propCapture=false;
  window.struckProp=prop;
  return {index:placed.indexOf(prop),model:prop.model,owner:prop.owner,shards:state.shards.length,released:report?.releasedShards.length??0,aliveCount:state.aliveCount,flying:state.flight.flying.size,radius:model.radius,uploads:[...propUploads]};
},which);
// A prop as the GPU holds it: its flags and extra reach, and its block of the shared shard records.
const held=(page,index)=>page.evaluate(async index=>{
  const words=await propRead('props continuum instances'),floats=new Float32Array(words),ints=new Uint32Array(words),at=index*12;
  const records=new Float32Array(await propRead('prop shard records')),block=ints[at+9]*4,state=oceanProps.placed[index].fracture;
  const mine=[...records.subarray(block+4,block+4+state.flight.records.length)],theirs=[...state.flight.records];
  return {type:ints[at+8]&0xffff,flags:ints[at+8]&~0xffff,reach:floats[at+10],clockZero:records[block],same:mine.every((v,i)=>v===theirs[i])};
},index);
// Where each of an instance's entries is: [list, what] pairs, and the parts of its clusters.
const entriesOf=(cut,instance)=>cut.lists.flatMap((list,i)=>list.filter(e=>e.instance===instance).map(e=>[i,e.what]));

test('props and shot are cut on the GPU and drawn by nothing but the continuum, with nothing sent while nothing changes',{timeout:300000},async t=>{
  const {page,errors}=await open(CAM);
  t.after(()=>page.close());
  const placed=await page.evaluate(()=>oceanProps.placed.length);
  assert.ok(placed>10,`${placed} placed`);
  const frame=await watch(page),cut=await page.evaluate(()=>propCut('props'));
  assert.equal(cut.count,placed,'every prop placed is an instance of the cut');
  const view=cut.lists.slice(0,4).reduce((n,list)=>n+list.length,0);
  assert.ok(view>0,'the cut lists what the view draws');
  assert.ok(cut.lists.every(list=>list.every(e=>e.instance<placed)));
  // The props are drawn by the continuum's two pipelines, each list by one indirect draw, and by nothing else.
  const ours=c=>/^(props?|shot)\b|ball/i.test(c.label??'');
  const theirs=frame.calls.filter(ours);
  assert.ok(theirs.some(c=>c.label==='prop continuum')&&theirs.some(c=>c.label==='prop continuum shadow'),JSON.stringify(theirs));
  assert.ok(theirs.every(c=>/^prop continuum( shadow)?$/.test(c.label)&&c.kind==='drawIndirect'),JSON.stringify([...new Set(theirs.map(c=>c.label+' '+c.kind))]));
  assert.deepEqual(frame.uploads,[],'no per-frame uploads');
  // Balls about the eye, as the gunnery effects place them each update: cut and drawn the same way, and counted.
  await page.evaluate(()=>{
    const balls=new Float32Array(48),seeds=new Uint32Array(12);
    for(let k=0;k<12;k++){const a=k*Math.PI/6;balls.set([5+15*Math.sin(a),66.3,-5760+15*Math.cos(a),0.15],k*4);seeds[k]=k+1;}
    const place=oceanProps.shot.place;oceanProps.shot.place=()=>place(balls,seeds,12);
  });
  await page.evaluate(()=>propFrames(24));
  const fired=await watch(page),shot=await page.evaluate(()=>propCut('shot'));
  assert.equal(shot.count,12);
  assert.ok(shot.lists.slice(0,4).some(list=>list.length>0),'the balls in view are listed');
  const balls=fired.calls.filter(ours);
  assert.ok(balls.every(c=>/^prop continuum( shadow)?$/.test(c.label)&&c.kind==='drawIndirect'));
  assert.ok(balls.filter(c=>c.label==='prop continuum').length>=8,'props and shot, four lists each');
  assert.deepEqual([...new Set(fired.uploads)],['shot continuum instances'],'only the balls are sent, as they move');
  const census=await page.evaluate(async()=>{await propFrames(40);return window.oceanContinuumCensus?.latest?.families??null;});
  assert.ok(census?.props>0&&census?.shot>0,`the census counts both: ${JSON.stringify(census)}`);
  assert.deepEqual(await page.evaluate(()=>propErrors),[]);assert.deepEqual(errors,[]);
});

test('a shot breaks a jetty where it stands: drawn as its shards, its flights in the one shared buffer, and nothing sent once its timber has settled',{timeout:300000},async t=>{
  const {page,errors}=await open(CAM);
  t.after(()=>page.close());
  const made=await page.evaluate(()=>propMade);
  const hit=await strike(page,'jetty');
  assert.ok(hit.released>0,`the shot released ${hit.released} shards`);
  assert.deepEqual([...new Set(hit.uploads)].sort(),['prop shard records','props continuum instances'],'the hit sends that prop\'s flights and its instance, and nothing else');
  await page.evaluate(()=>propFrames(2));
  const gpu=await held(page,hit.index),cut=await page.evaluate(()=>propCut('props'));
  assert.equal(gpu.type,hit.model);
  assert.equal(gpu.flags,CITY_CONTINUUM_BROKEN,'broken');
  assert.ok(gpu.same,'the GPU holds the flights the game computed');
  assert.ok(gpu.reach>0,`its reach grows to take in what is in the air: ${gpu.reach} m`);
  assert.ok(gpu.clockZero>=0&&gpu.clockZero<600,`its clock is set against the frame's: ${gpu.clockZero}`);
  const listed=entriesOf(cut,hit.index);
  assert.ok(listed.length>0,'the broken jetty is still cut');
  assert.ok(listed.every(([list,what])=>what===1&&(list<2||list===5)),`as its shards' clusters alone: ${JSON.stringify(listed)}`);
  assert.equal(cut.shares[hit.index],0,'and never handed to a far body');

  await page.waitForFunction(()=>struckProp.fracture.flight.flying.size===0,null,{timeout:60000,polling:100});
  await page.evaluate(()=>propFrames(3));
  const settled=await watch(page),rest=await held(page,hit.index),after=await page.evaluate(()=>propCut('props'));
  assert.deepEqual(settled.uploads,[],'nothing is sent once it has settled');
  assert.ok(entriesOf(after,hit.index).length>0,'what is left of it still stands and is drawn');
  assert.ok(rest.same,'the GPU holds where each shard stopped');
  assert.equal(await page.evaluate(()=>propMade),made,'a hit makes no buffer and no bind group');
  assert.deepEqual(await page.evaluate(()=>propErrors),[]);
  assert.deepEqual(errors,[]);
});

test('debris keeps the simulation\'s time: paused it hangs in the air, and running it falls by the clock, not by the frame',{timeout:300000},async t=>{
  const {page}=await open(CAM);
  t.after(()=>page.close());
  await page.evaluate(()=>document.getElementById('pause-toggle').click());
  assert.equal(await page.evaluate(()=>document.getElementById('pause-toggle').getAttribute('aria-pressed')),'true','paused');
  const hit=await strike(page,'jetty');
  assert.ok(hit.released>0&&hit.flying>0);
  const hung=await page.evaluate(async()=>{const from=struckProp.fracture.now;await propFrames(30);return struckProp.fracture.now-from;});
  assert.equal(hung,0,'no time passes for debris while the simulation is paused');
  const ran=await page.evaluate(async()=>{
    document.getElementById('pause-toggle').click();
    await propFrames(2);
    // The simulation's own step: the time between frames, and never more than a tenth of a second.
    const from=struckProp.fracture.now;let last=await new Promise(requestAnimationFrame),expected=0;
    for(let i=0;i<45;i++){const now=await new Promise(requestAnimationFrame);expected+=Math.min(0.1,(now-last)/1000);last=now;}
    return {advanced:struckProp.fracture.now-from,expected};
  });
  assert.ok(Math.abs(ran.advanced-ran.expected)<0.12,`debris clock advanced ${ran.advanced.toFixed(3)} s over ${ran.expected.toFixed(3)} s of simulation`);
});

test('a ruined pier takes its cleats with it, a broken one too',{timeout:300000},async t=>{
  const {page}=await open(CAM);
  t.after(()=>page.close());
  const hit=await strike(page,'cleat');
  assert.ok(hit.released>0&&hit.owner>=0,`a cleat on a pier, ${hit.released} shards off`);
  await page.evaluate(()=>propFrames(4));
  const broken=await held(page,hit.index);
  assert.equal(broken.flags,CITY_CONTINUUM_BROKEN,'broken, it is still drawn on its pier');
  // The game's own damage state is what the renderer watches.
  await page.evaluate(()=>{const {port,placed}=oceanProps;for(const owner of new Set(placed.filter(p=>p.owner>=0).map(p=>p.owner)))(port.instances[owner].damageState??={}).state='ruined';});
  // Owners are asked every 30 frames, so wait in frames: a loaded machine may not draw 30 in a second.
  await page.evaluate(()=>propFrames(45));
  const cleats=await page.evaluate(()=>oceanProps.placed.map((p,i)=>p.model===0&&p.owner>=0?i:-1).filter(i=>i>=0));
  const cut=await page.evaluate(()=>propCut('props'));
  assert.ok(cleats.length>0);
  for(const index of cleats)assert.deepEqual(entriesOf(cut,index),[],`cleat ${index} is listed nowhere`);
  assert.equal((await held(page,hit.index)).flags&CITY_CONTINUUM_GONE,CITY_CONTINUUM_GONE,'the broken one is gone with its pier');
});
