// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Nine distinct production vessels; root alone runs native GPU qualification.
// Small viewport is deliberate. This fixture makes no FPS/device claim.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const nineModels=['nina','pinta','santa-maria','victory','oseberg','lusoria','taino-canoe','flying-cloud','gipsy-moth-iv'];
const nineCompanies=[12,12,12,12,32,26,30,12,1],nineCodes=[0,2,3,1,4,5,6,7,8],nineMasts=[3,3,3,3,1,1,0,3,2],nineGuns=[4,4,4,104,0,0,0,0,0];
let nineServer,nineBrowser,nineOrigin;
before(async()=>{
  nineServer=createDevServer();nineServer.listen(0,'127.0.0.1');await once(nineServer,'listening');nineOrigin='http://127.0.0.1:'+nineServer.address().port;
  nineBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await nineBrowser?.close();if(nineServer)await new Promise(resolve=>nineServer.close(resolve));});

function instrumentNineFleet(){
  const r=window.nineFleetGPU={callback:null,now:null,device:null,errors:[],lost:null,buffers:[],textures:[],views:new WeakMap(),groups:new WeakMap(),passes:new WeakMap(),draws:{},compute:{},target:null};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));d.lost.then(v=>r.lost=v.message);return d;};
  const buffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(desc){const b=buffer.call(this,/ geometry$| hull$/.test(desc.label||'')?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);r.buffers.push(b);return b;};
  const texture=GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture=function(desc){const t=texture.call(this,desc);r.textures.push(t);return t;};
  const view=GPUTexture.prototype.createView;
  GPUTexture.prototype.createView=function(desc={}){const v=view.call(this,desc);r.views.set(v,{texture:this,layer:desc.baseArrayLayer??0,count:desc.arrayLayerCount??this.depthOrArrayLayers});return v;};
  const group=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(desc){const g=group.call(this,desc);r.groups.set(g,desc.entries);return g;};
  const render=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){r.passes.set(this,pipeline.label);return render.call(this,pipeline);};
  const draw=GPURenderPassEncoder.prototype.drawIndexed;
  GPURenderPassEncoder.prototype.drawIndexed=function(indices,instances=1,...args){const key=r.passes.get(this);r.draws[key]??={calls:0,indices:0,instances:0};r.draws[key].calls++;r.draws[key].indices+=indices*instances;r.draws[key].instances+=instances;return draw.call(this,indices,instances,...args);};
  const compute=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){r.compute[pipeline.label]=(r.compute[pipeline.label]||0)+1;return compute.call(this,pipeline);};
  const configs=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configs.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){const desc=configs.get(this),w=this.canvas.width,h=this.canvas.height;if(!r.target||r.target.width!==w||r.target.height!==h){r.target?.destroy();r.target=desc.device.createTexture({size:[w,h],format:desc.format,usage:(desc.usage??GPUTextureUsage.RENDER_ATTACHMENT)|GPUTextureUsage.COPY_SRC});}return r.target;};
  r.read=async(b,offset=0,size=b.size)=>{const copy=r.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=r.device.createCommandEncoder();e.copyBufferToBuffer(b,offset,copy,0,size);r.device.queue.submit([e.finish()]);await copy.mapAsync(GPUMapMode.READ);const data=Array.from(new Float32Array(copy.getMappedRange()));copy.unmap();copy.destroy();return data;};
  r.hash=async(array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',array.buffer.slice(array.byteOffset,array.byteOffset+array.byteLength)))).map(v=>v.toString(16).padStart(2,'0')).join('');
  r.image=async()=>{const t=r.target,row=Math.ceil(t.width*4/256)*256,b=r.device.createBuffer({size:row*t.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=r.device.createCommandEncoder();e.copyTextureToBuffer({texture:t},{buffer:b,bytesPerRow:row},[t.width,t.height]);r.device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(b.getMappedRange());let visible=0;for(let y=0;y<t.height;y++)for(let x=0;x<t.width;x++){const at=y*row+x*4;if(Math.max(bytes[at],bytes[at+1],bytes[at+2])>2)visible++;}b.unmap();b.destroy();return {visible,pixels:t.width*t.height};};
}
async function nineStep(page,dt=.05){
  const result=await page.evaluate(async dt=>{const r=nineFleetGPU,f=r.callback;if(typeof f!=='function')throw Error('No production fleet RAF');r.callback=null;r.draws={};r.compute={};r.now=(r.now??performance.now())+dt*1000;f(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));return {errors:r.errors,lost:r.lost,draws:r.draws,compute:r.compute};},dt);
  assert.deepEqual(result.errors,[]);assert.equal(result.lost,null);return result;
}
async function nineSnapshot(page){
  return page.evaluate(async()=>{
    const r=nineFleetGPU,f=oceanFleet,vessels=f.vessels,unique=items=>new Set(items).size;
    const rows=[];
    for(const [index,v]of vessels.entries()){
      const b=v.boat,m=v.asset.model;let sample=0;
      for(let i=0;i<v.mesh.length;i+=9)if([9,13,16,17].includes(Math.floor(v.mesh[i+6]))){sample=i;break;}
      const vertex=await r.read(v.vertexBuffer,sample*4,36),hull=await r.read(v.hullUBO);
      const shadow=(r.groups.get(v.lighting)??[]).filter(e=>[1,3,4].includes(e.binding)).map(e=>r.views.get(e.resource)).map(v=>({layer:v?.layer,count:v?.count,total:v?.texture.depthOrArrayLayers}));
      rows.push({id:v.id,model:m.id,code:m.modelCode,vertices:v.mesh.length/9,indices:v.asset.indices.length,source:await r.hash(v.asset.vertices),mesh:await r.hash(v.mesh),cpuPose:typeof v.asset.pose==='function',gpuPose:!!v.pose,
        upload:vertex.every((n,i)=>Object.is(n,v.mesh[sample+i])),hullCode:hull[23],hullBeam:hull[12],hullLength:hull[13],length:b.length,beam:b.beam,runtimeLength:m.runtime.length,runtimeBeam:m.runtime.beam,
        crew:v.crew?.state.crew.length??0,crewFinite:v.crew?.state.crew.every(s=>s.transform.every(Number.isFinite))??false,meshFinite:v.mesh.every(Number.isFinite),bodyFinite:[b.x,b.z,b.heading,b.heave,b.pitch,b.roll,b.surgeVelocity??0,b.hydrodynamics.mass,b.hydrodynamics.draft].every(Number.isFinite),
        propulsion:b.propulsion,rowing:!!v.rowingWater,rowingAlias:!v.rowingWater||b.rowingWater===v.rowingWater,rowingEffort:b.rowingEffort??0,rowingPhase:b.rowingState?.phase??null,water:v.rowingWater?.state??null,waterSample:v.rowingWater?.sample(b.x,b.z)??null,seaTime:v.probe.state.time,
        masts:m.rig.masts.length,controls:[...new Set(m.rig.sails.map(s=>s.controlGroup))].sort(),sails:m.rig.sails.length,guns:v.gunnery.state.guns.length,anchor:v.anchor.installed!==false,anchorPhase:v.anchor.phase,shadow,layer:index});
    }
    return {rows,active:vessels.length,assets:f.renderAssets.size,config:f.config.length,wake:{count:f.wakes.count,layers:f.wakes.textures.map(t=>t.depthOrArrayLayers)},
      unique:{boat:unique(vessels.map(v=>v.boat)),vertex:unique(vessels.map(v=>v.vertexBuffer)),mesh:unique(vessels.map(v=>v.mesh)),hull:unique(vessels.map(v=>v.hullUBO)),crew:unique(vessels.map(v=>v.crew?.state)),sails:unique(vessels.map(v=>v.boat.sailState)),guns:unique(vessels.map(v=>v.gunnery.state)),anchor:unique(vessels.map(v=>v.anchor)),wetness:unique(vessels.map(v=>v.wetness.state)),wake:unique(vessels.map(v=>v.interaction)),shadow:unique(vessels.map(v=>v.shadows.uniform)),probe:unique(vessels.map(v=>v.probe.output)),rowing:unique(vessels.filter(v=>v.rowingWater).map(v=>v.rowingWater))},
      sharedCrew:{vertices:r.buffers.filter(b=>b.label==='crew vertices').length,indices:r.buffers.filter(b=>b.label==='crew indices').length,joints:r.buffers.filter(b=>b.label==='crew joints').length,actors:r.buffers.filter(b=>b.label==='crew transforms').length},startup:window.oceanStartup.state,image:await r.image(),errors:r.errors,lost:r.lost};
  });
}

for(const path of ['/', '/docs/index.html'])test(`${path} nine distinct real models share one ocean with their own companies, propulsion, equipment and live GPU state`,{timeout:600000},async()=>{
  const page=await nineBrowser.newPage({viewport:{width:640,height:480}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/init failed|GPU error:|Shader compile error/i.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrumentNineFleet);
  const query=new URLSearchParams({ship:nineModels[0],fleet:nineModels.slice(1).join(','),view:'ship',boatHeading:'90',boatX:'0',boatZ:'0',boatSpeed:'0',propulsion:'sail',sunElev:'35',clouds:'0',windSpeed:'7',windDir:'118',swellHs:'.35',w:'160',h:'108'});
  try{
    await page.goto(nineOrigin+path+'?'+query);await page.waitForFunction(()=>nineFleetGPU.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:300000});
    assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));assert.ok(await page.evaluate(()=>!!window.oceanFleet));
    await page.getByRole('button',{name:'Camera views',exact:true}).click();await page.getByRole('button',{name:'View fleet',exact:true}).click();
    let frame;for(let i=0;i<8;i++)frame=await nineStep(page);const s=await nineSnapshot(page);
    assert.equal(s.startup,'ready');assert.equal(s.active,9);assert.equal(s.assets,9);assert.equal(s.config,8);assert.deepEqual(s.rows.map(v=>v.model),nineModels);assert.deepEqual(s.rows.map(v=>v.code),nineCodes);
    assert.deepEqual(s.rows.map(v=>v.crew),nineCompanies);assert.equal(frame.draws.crew.instances,149,'actual crew GPU batches contain the nine real companies');assert.deepEqual(s.sharedCrew,{vertices:2,indices:2,joints:18,actors:18});
    assert.deepEqual(s.rows.map(v=>v.masts),nineMasts);assert.deepEqual(s.rows.map(v=>v.guns),nineGuns);assert.deepEqual(s.rows.map(v=>v.anchor),nineModels.map(id=>id!=='taino-canoe'));
    assert.deepEqual(s.wake,{count:9,layers:[9,9]});for(const [kind,count]of Object.entries(s.unique))assert.equal(count,kind==='rowing'?3:9,'separate mutable '+kind+' state');
    assert.equal(new Set(s.rows.map(v=>v.source)).size,9,'each requested class has its actual distinct immutable mesh');
    assert.equal(frame.compute['fft rows'],1);assert.equal(frame.compute['fft cols'],1);assert.equal(frame.compute['rowing actual water field'],3,'only the three real human-powered hulls own blade fields');
    for(const [i,v]of s.rows.entries()){
      assert.ok(v.vertices>1000&&v.indices>3000&&v.meshFinite&&v.bodyFinite&&v.crewFinite);assert.ok(v.upload);assert.equal(v.hullCode,nineCodes[i]);assert.ok(Math.abs(v.hullBeam-v.beam)<1e-5&&Math.abs(v.hullLength-v.length)<1e-5);
      assert.equal(v.length,v.runtimeLength);assert.equal(v.beam,v.runtimeBeam);assert.equal(v.propulsion,'sail');assert.ok(v.seaTime>=0);assert.ok(frame.draws[v.model+' vessel']?.indices>3000,'actual requested vessel pipeline draws '+v.model);
      assert.equal(v.shadow.length,3);assert.ok(v.shadow.every(t=>t.layer===i&&t.count===1&&t.total===9),'actual shadow-array layers remain model-instance specific');
      assert.equal(v.gpuPose,v.model==='victory');if(v.cpuPose)assert.notEqual(v.mesh,v.source,'actual sewn canvas/oars receive live CPU poses');
      const row=['oseberg','lusoria','taino-canoe'].includes(v.model);assert.equal(v.rowing,row);assert.ok(v.rowingAlias);
      if(row){assert.ok(v.water&&v.waterSample);assert.equal(v.water.modelId,v.model);assert.ok([v.waterSample.height,...v.waterSample.velocity].every(Number.isFinite));assert.ok(v.rowingEffort>0&&Number.isFinite(v.rowingPhase),'actual followers command real human stroke state');}
      if(v.model==='taino-canoe'){assert.equal(v.sails,0);assert.deepEqual(v.controls,[]);assert.equal(v.anchorPhase,'absent');}
      if(['oseberg','lusoria'].includes(v.model)){assert.equal(v.sails,1);assert.deepEqual(v.controls,['main']);}
      if(v.model==='flying-cloud')assert.equal(v.sails,25);
      if(v.model==='gipsy-moth-iv'){assert.equal(v.sails,4);assert.deepEqual(v.controls,['fore','main','mizzen']);}
    }
    assert.ok(s.image.visible>s.image.pixels*.25);assert.deepEqual(s.errors,[]);assert.equal(s.lost,null);assert.deepEqual(errors,[]);
    const isolation=await page.evaluate(()=>{
      const ships=oceanFleet.vessels,[lead,,,,row]=ships,commands=v=>JSON.stringify({model:v.boat.modelId,rudder:v.boat.rudderTarget,fore:v.boat.sailFore,main:v.boat.sailMain,mizzen:v.boat.sailMizzen,hatches:v.boat.hatchesClosed,effort:v.boat.rowingEffort,turn:v.boat.rowingTurn,cadence:v.boat.rowingCadence,phase:v.boat.rowingState?.phase,rig:v.boat.sailState.rig.map(r=>({side:r.side,opening:r.opening,dip:r.dip,deployed:r.deployed}))});
      const untouched=ships.filter(v=>v!==lead&&v!==row),before=untouched.map(commands),water=untouched.filter(v=>v.rowingWater).map(v=>JSON.stringify(v.rowingWater.state));
      lead.boat.rudderTarget=-19;lead.boat.sailFore=.27;lead.boat.hatchesClosed=.61;lead.boat.sailState.rig[0].fill=.13;
      row.boat.rowingEffort=.77;row.boat.rowingTurn=.31;row.boat.rowingCadence=.55;row.boat.rowingState.phase=.47;row.rowingWater.reset();
      return {before,after:untouched.map(commands),water,waterAfter:untouched.filter(v=>v.rowingWater).map(v=>JSON.stringify(v.rowingWater.state)),cleared:row.rowingWater.state===null};
    });
    assert.deepEqual(isolation.after,isolation.before);assert.deepEqual(isolation.waterAfter,isolation.water);assert.ok(isolation.cleared);
    for(let i=0;i<6;i++)await nineStep(page);const last=await nineSnapshot(page);assert.deepEqual(last.rows.map(v=>v.source),s.rows.map(v=>v.source),'commands and animation do not mutate immutable class geometry');
    assert.ok(last.rows.filter(v=>v.rowing).every(v=>v.water&&v.waterSample));assert.ok(last.rows.every(v=>v.bodyFinite&&v.meshFinite&&v.crewFinite));assert.deepEqual(last.errors,[]);assert.equal(last.lost,null);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
