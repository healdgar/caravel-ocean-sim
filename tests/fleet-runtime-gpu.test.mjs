// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Production integration fixtures. Root alone executes these, sequentially with
// other GPU suites. Viewport is bounded; frame time is deliberately not a gate.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {computeAstronomy} from '../js/astronomy.js';

let fleetRuntimeServer,fleetRuntimeBrowser,fleetRuntimeOrigin;
before(async()=>{
  fleetRuntimeServer=createDevServer();fleetRuntimeServer.listen(0,'127.0.0.1');await once(fleetRuntimeServer,'listening');fleetRuntimeOrigin='http://127.0.0.1:'+fleetRuntimeServer.address().port;
  fleetRuntimeBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
  await mkdir(new URL('../shots/',import.meta.url),{recursive:true});
});
after(async()=>{await fleetRuntimeBrowser?.close();if(fleetRuntimeServer)await new Promise(resolve=>fleetRuntimeServer.close(resolve));});

function instrumentFleetRuntime(){
  const r=window.fleetRuntime={callback:null,device:null,errors:[],lost:null,buffers:[],textures:[],views:new WeakMap(),groups:new WeakMap(),writes:new WeakMap(),render:{},compute:{},now:0,target:null};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const requestDevice=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await requestDevice.apply(this,args);r.device=device;device.addEventListener('uncapturederror',event=>r.errors.push(event.error.message));device.lost.then(reason=>r.lost=reason.message);return device;};
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(desc){
    // Inspection only: the real production geometry/uniform/wetting uploads are
    // unchanged. COPY_SRC lets this fixture verify bytes after the actual frame.
    const inspect=/ geometry$|^wetness probes$|^frame ubo|^fleet wake domains$|^sun visibility and ocean lighting$/.test(desc.label||'');
    const buffer=createBuffer.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);r.buffers.push(buffer);return buffer;
  };
  const createTexture=GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture=function(desc){const texture=createTexture.call(this,desc);r.textures.push(texture);return texture;};
  const createView=GPUTexture.prototype.createView;
  GPUTexture.prototype.createView=function(desc={}){const view=createView.call(this,desc);r.views.set(view,{texture:this,baseArrayLayer:desc.baseArrayLayer||0,arrayLayerCount:desc.arrayLayerCount??this.depthOrArrayLayers,dimension:desc.dimension});return view;};
  const createGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(desc){const group=createGroup.call(this,desc);r.groups.set(group,desc.entries);return group;};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,...args){r.writes.set(buffer,(r.writes.get(buffer)||0)+1);return write.call(this,buffer,...args);};
  const render=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){r.render[pipeline.label]=(r.render[pipeline.label]||0)+1;return render.call(this,pipeline);};
  const compute=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){r.compute[pipeline.label]=(r.compute[pipeline.label]||0)+1;return compute.call(this,pipeline);};
  // Use the actual final GPU composite texture, without relying on headless
  // canvas presentation. No material, scene pass, shader or physics is replaced.
  const configs=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configs.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){const desc=configs.get(this),width=this.canvas.width,height=this.canvas.height;if(!r.target||r.target.width!==width||r.target.height!==height){r.target?.destroy();r.target=desc.device.createTexture({label:'fleet fixture final canvas',size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});r.format=desc.format;}return r.target;};
  r.read=async(buffer,offset=0,size=buffer.size)=>{const read=r.device.createBuffer({label:'fleet inspection read',size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,offset,read,0,size);r.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const result=Array.from(new Float32Array(read.getMappedRange()));read.unmap();read.destroy();return result;};
  r.hash=async(array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',array.buffer.slice(array.byteOffset,array.byteOffset+array.byteLength)))).map(value=>value.toString(16).padStart(2,'0')).join('');
}

async function fleetRuntimeOpen(path,params={},capture=false){
  const page=await fleetRuntimeBrowser.newPage({viewport:capture?{width:640,height:400}:{width:384,height:256}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(/init failed|GPU error:|Shader compile error/i.test(message.text()))errors.push(message.text());});
  await page.addInitScript(instrumentFleetRuntime);
  const query=new URLSearchParams({ship:'nina',fleet:'',view:'ship',boatHeading:'90',boatX:'0',boatZ:'0',sunElev:'30',clouds:'0',windSpeed:'7',windDir:'118',swellHs:'.35',orbitElevation:'17',orbitYaw:'95',orbitDistance:'40',w:capture?'640':'160',h:capture?'400':'108',...params});
  await page.goto(fleetRuntimeOrigin+path+'?'+query);
  await page.waitForFunction(()=>fleetRuntime.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:120000});
  assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
  assert.ok(await page.evaluate(()=>!!window.oceanFleet),'production oceanFleet integration exists');
  return {page,errors};
}
async function fleetRuntimeStep(page,dt=.1){
  const result=await page.evaluate(async dt=>{const r=fleetRuntime,callback=r.callback;if(typeof callback!=='function')throw Error('Production RAF callback missing');r.callback=null;r.render={};r.compute={};r.now=Math.max(r.now,performance.now())+dt*1000;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));return {errors:r.errors,lost:r.lost,render:r.render,compute:r.compute,startup:window.oceanStartup?.state};},dt);
  assert.deepEqual(result.errors,[]);assert.equal(result.lost,null);return result;
}
async function fleetRuntimeSnapshot(page){
  return page.evaluate(async()=>{
    const r=fleetRuntime,f=window.oceanFleet,vessels=f.vessels;
    const ids=objects=>new Set(objects).size;
    const sources=await Promise.all([...f.renderAssets.values()].map(async asset=>({model:asset.asset.model.id,vertices:await r.hash(asset.asset.vertices),indices:await r.hash(asset.asset.indices),assetFrozen:Object.isFrozen(asset.asset),groupsFrozen:Object.isFrozen(asset.asset.groups)})));
    const rows=await Promise.all(vessels.map(async(v,index)=>{
      const views=(r.groups.get(v.lighting)||[]).filter(entry=>[1,3,4].includes(entry.binding)).map(entry=>{const d=r.views.get(entry.resource);return {layer:d?.baseArrayLayer,count:d?.arrayLayerCount,total:d?.texture.depthOrArrayLayers,label:d?.texture.label};});
      let dynamic=-1;for(let i=0;i<v.mesh.length;i+=9){const material=Math.floor(v.mesh[i+6]);if((material===9||material===13)&&(v.mesh[i]!==v.asset.vertices[i]||v.mesh[i+1]!==v.asset.vertices[i+1]||v.mesh[i+2]!==v.asset.vertices[i+2])){dynamic=i;break;}}
      const sample=dynamic<0?0:dynamic,upload=await r.read(v.vertexBuffer,sample*4,Math.min(36,v.vertexBuffer.size-sample*4));
      return {id:v.id,model:v.asset.model.id,vertices:v.mesh.length/9,indices:v.asset.indices.length,cpuPose:typeof v.asset.pose==='function',gpuPose:!!v.pose,mesh:await r.hash(v.mesh),dynamic,sampleMatches:upload.every((value,i)=>Object.is(value,v.mesh[sample+i])),uploads:r.writes.get(v.vertexBuffer)||0,crew:v.crew?.state.crew.length||0,crewFinite:!!v.crew&&v.crew.state.crew.every(s=>s.transform.every(Number.isFinite)),probeTime:v.probe.state.time,probeFinite:[v.boat.heave,v.boat.pitch,v.boat.roll,v.boat.x,v.boat.z,v.boat.heading].every(Number.isFinite),shadowViews:views};
    }));
    const sameModels=[];for(let i=0;i<vessels.length;i++)for(let j=i+1;j<vessels.length;j++)if(vessels[i].modelId===vessels[j].modelId)sameModels.push({sharedAsset:vessels[i].asset===vessels[j].asset,sharedRender:vessels[i].render===vessels[j].render,sharedIndices:vessels[i].render.indexBuffer===vessels[j].render.indexBuffer,ownMesh:vessels[i].mesh!==vessels[j].mesh,ownWetness:vessels[i].wetness.state!==vessels[j].wetness.state,ownCrew:vessels[i].crew.state!==vessels[j].crew.state});
    return {rows,sources,config:f.config,active:vessels.length,models:[...f.renderAssets.keys()],sameModels,
      unique:{geometry:ids(vessels.map(v=>v.vertexBuffer)),mesh:ids(vessels.map(v=>v.mesh)),hull:ids(vessels.map(v=>v.hullUBO)),wetness:ids(vessels.map(v=>v.wetness.state)),wetnessPoints:ids(vessels.map(v=>v.wetness.points)),probeOutput:ids(vessels.map(v=>v.probe.output)),probeRead:ids(vessels.map(v=>v.probe.read)),probeUniform:ids(vessels.map(v=>v.probe.uniform)),crew:ids(vessels.map(v=>v.crew?.state)),guns:ids(vessels.map(v=>v.gunnery.state)),shadow:ids(vessels.map(v=>v.shadows.uniform)),wakeState:ids(vessels.map(v=>v.interaction))},
      crewBuffers:{joints:r.buffers.filter(b=>b.label==='crew joints').length,actors:r.buffers.filter(b=>b.label==='crew transforms').length,vertices:r.buffers.filter(b=>b.label==='crew vertices').length,indices:r.buffers.filter(b=>b.label==='crew indices').length},
      wakes:{count:f.wakes.count,parity:f.wakes.current,layers:f.wakes.textures.map(t=>t.depthOrArrayLayers)},shadows:r.textures.filter(t=>/^fleet shadow [012]$/.test(t.label)).map(t=>({label:t.label,layers:t.depthOrArrayLayers,width:t.width,height:t.height})),frameBuffers:r.buffers.filter(b=>/^frame ubo/.test(b.label)).map(b=>({label:b.label,size:b.size})),errors:r.errors,lost:r.lost};
  });
}
function assertFleetSnapshot(snapshot,expected){
  assert.equal(snapshot.active,expected);assert.deepEqual(snapshot.crewBuffers,{joints:2*expected,actors:2*expected,vertices:2,indices:2},'only immutable crew geometry is shared; real joint/actor GPU buffers belong to each vessel');assert.ok(snapshot.sources.every(source=>source.assetFrozen&&source.groupsFrozen));assert.deepEqual(snapshot.errors,[]);assert.equal(snapshot.lost,null);
  for(const [kind,count]of Object.entries(snapshot.unique))assert.equal(count,expected,'each active ship owns '+kind);
  assert.deepEqual(snapshot.wakes.layers,[expected,expected]);assert.equal(snapshot.wakes.count,expected);
  assert.equal(snapshot.shadows.length,3);assert.ok(snapshot.shadows.every(s=>s.layers===expected&&s.width===2048&&s.height===2048));
  assert.deepEqual(snapshot.frameBuffers.map(b=>b.size),[528],'actual production celestial Frame allocation');
  for(const [index,row]of snapshot.rows.entries()){
    assert.ok(row.vertices>1000&&row.indices>3000,row.model+' actual geometry');assert.equal(row.crew,12,row.model+' actual crew');assert.ok(row.crewFinite&&row.probeFinite,row.model+' finite live state');assert.ok(row.probeTime>=0,row.model+' receives its own actual sea readback');
    assert.ok(row.sampleMatches,row.model+' GPU vertex upload matches current instance geometry');assert.equal(row.shadowViews.length,3);assert.ok(row.shadowViews.every(view=>view.layer===index&&view.count===1&&view.total===expected),'shadow draws select this ship’s actual array layers');
    assert.equal(row.cpuPose,false,row.model+' has no runtime CPU mesh animator');assert.equal(row.gpuPose,true,row.model+' owns an actual GPU pose');assert.equal(row.dynamic,-1,row.model+' CPU sail vertices remain immutable');assert.equal(row.uploads,1,row.model+' source geometry is uploaded only at initialization');
  }
  for(const pair of snapshot.sameModels)assert.ok(Object.values(pair).every(Boolean),'immutable assets/index buffers shared; mutable ship state independent');
}
async function fleetRuntimeCapture(page,name){
  const result=await page.evaluate(async()=>{
    const r=fleetRuntime,t=r.target,width=t.width,height=t.height,row=Math.ceil(width*4/256)*256,read=r.device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=r.device.createCommandEncoder();enc.copyTextureToBuffer({texture:t},{buffer:read,bytesPerRow:row},[width,height]);r.device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const raw=new Uint8Array(read.getMappedRange()),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const context=canvas.getContext('2d'),pixels=context.createImageData(width,height),bgra=r.format.startsWith('bgra');let luminance=0,nonblack=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=y*row+x*4,b=(y*width+x)*4;pixels.data[b]=raw[a+(bgra?2:0)];pixels.data[b+1]=raw[a+1];pixels.data[b+2]=raw[a+(bgra?0:2)];pixels.data[b+3]=255;const l=.2126*pixels.data[b]+.7152*pixels.data[b+1]+.0722*pixels.data[b+2];luminance+=l;if(l>1)nonblack++;}
    context.putImageData(pixels,0,0);read.unmap();read.destroy();return {png:canvas.toDataURL('image/png').split(',')[1],luminance:luminance/(width*height),nonblack,width,height};
  });
  if(name)await writeFile(new URL('../shots/'+name+'.png',import.meta.url),Buffer.from(result.png,'base64'));
  return {luminance:result.luminance,nonblack:result.nonblack,width:result.width,height:result.height};
}

for(const path of ['/', '/docs/index.html'])for(const model of ['nina','pinta','santa-maria','victory'])test(`${path} ${model}: production startup, instance state, sea probes and actual render passes`,{timeout:180000},async()=>{
  const {page,errors}=await fleetRuntimeOpen(path,{ship:model});
  try{
    await fleetRuntimeStep(page);await fleetRuntimeStep(page);const first=await fleetRuntimeSnapshot(page);assertFleetSnapshot(first,1);
    const next=await fleetRuntimeStep(page);await fleetRuntimeStep(page);const last=await fleetRuntimeSnapshot(page);assertFleetSnapshot(last,1);
    assert.deepEqual(last.sources,first.sources,'rest vertices and immutable source indices survive live animation');
    assert.equal(last.rows[0].mesh,first.rows[0].mesh,'live GPU cloth never rewrites CPU rest vertices');
    assert.ok(next.render[model+' vessel']>0,'requested model actually draws');if(model==='victory')assert.ok(next.compute['shared vessel deformation']>0,'Victory uses real GPU deformation');
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

for(const path of ['/', '/docs/index.html'])test(`${path} four different ships share one ocean, disable rows without GPU allocation and keep animation/state independent`,{timeout:240000},async()=>{
  const {page,errors}=await fleetRuntimeOpen(path,{fleet:'pinta,santa-maria,victory,!victory'},path==='/docs/index.html');
  try{
    await fleetRuntimeStep(page);const first=await fleetRuntimeSnapshot(page);assertFleetSnapshot(first,4);assert.deepEqual(first.rows.map(v=>v.model),['nina','pinta','santa-maria','victory']);assert.equal(first.config.length,4);assert.equal(first.config.filter(v=>!v.enabled).length,1);assert.ok(!first.rows.some(v=>v.id===first.config.find(v=>!v.enabled).id),'disabled configuration row allocates no vessel');
    await page.getByRole('button',{name:'Camera views',exact:true}).click();await page.getByRole('button',{name:'View fleet',exact:true}).click();
    const secondFrame=await fleetRuntimeStep(page);await fleetRuntimeStep(page);const second=await fleetRuntimeSnapshot(page);assertFleetSnapshot(second,4);assert.deepEqual(second.sources,first.sources);
    for(const model of ['nina','pinta','santa-maria','victory'])assert.ok(secondFrame.render[model+' vessel']>0,'fleet renders '+model);
    for(const row of second.rows)assert.equal(row.mesh,first.rows.find(v=>v.id===row.id).mesh,row.model+' GPU cloth preserves instance rest geometry');
    if(path==='/docs/index.html'){const shot=await fleetRuntimeCapture(page,'fleet-four-ships');assert.ok(shot.nonblack>1000);}
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

for(const path of ['/', '/docs/index.html'])test(`${path} maximum nine real GPU vessels retain shared immutable model assets and isolated moisture`,{timeout:300000},async()=>{
  const {page,errors}=await fleetRuntimeOpen(path,{fleet:'pinta,santa-maria,victory,nina,pinta,santa-maria,victory,nina',w:'128',h:'96'});
  try{
    await fleetRuntimeStep(page);await fleetRuntimeStep(page);const snapshot=await fleetRuntimeSnapshot(page);assertFleetSnapshot(snapshot,9);assert.equal(snapshot.models.length,4);assert.ok(snapshot.sameModels.length>=5);assert.ok(snapshot.rows.every(v=>v.crew===12));
    const isolation=await page.evaluate(async()=>{const f=oceanFleet,r=fleetRuntime;await r.device.queue.onSubmittedWorkDone();const prior=await Promise.all(f.vessels.map(v=>r.read(v.wetness.state,0,8)));r.device.queue.writeBuffer(f.vessels[0].wetness.state,0,new Float32Array([.25,.5]));const after=await Promise.all(f.vessels.map(v=>r.read(v.wetness.state,0,8)));return {prior,after};});
    assert.deepEqual(isolation.after[0],[.25,.5]);for(let i=1;i<9;i++)assert.deepEqual(isolation.after[i],isolation.prior[i],'one ship’s moisture write cannot change ship '+i);
    const next=await fleetRuntimeStep(page);for(const model of snapshot.models)assert.ok(next.render[model+' vessel']>0,'maximum fleet actually renders '+model);assert.deepEqual(next.errors,[]);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('production528B manual/day/full/new sky cases render with different physical night illumination',{timeout:300000},async()=>{
  const observer={latitude:17.635,longitude:-63.238,height:0};let fullLight,newLight;
  const cases=[{name:'manual',params:{sunElev:'30'},astro:false},{name:'day',date:'2026-10-21T16:00:00Z',astro:true},{name:'full-moon',date:'2024-01-26T04:00:00Z',astro:true},{name:'new-moon',date:'2024-02-10T04:00:00Z',astro:true}];
  for(const scene of cases){
    // Camera stays at a normal ship-inspection distance. A wide astronomical
    // view includes the vessel below and the actual high Moon above it.
    const state=scene.astro?computeAstronomy(scene.date,observer):null,az=(state?.moon.azimuth||0)*Math.PI/180,distance=45;
    const params={ship:'nina',fleet:'',view:'free',cam:[-Math.sin(az)*distance,7,Math.cos(az)*distance,az*180/Math.PI,30].join(','),fov:'120',windSpeed:'3',swellHs:'.15',clouds:'0',...scene.params,...(scene.astro?{skyMode:'astronomy',astroDate:scene.date,astroRate:'0',latitude:String(observer.latitude),longitude:String(observer.longitude)}:{skyMode:'manual'})};
    const {page,errors}=await fleetRuntimeOpen('/docs/index.html',params,true);
    try{
      await fleetRuntimeStep(page);await fleetRuntimeStep(page);const snapshot=await fleetRuntimeSnapshot(page);assertFleetSnapshot(snapshot,1);
      const values=await page.evaluate(async()=>{const frame=fleetRuntime.buffers.find(b=>/^frame ubo/.test(b.label));return {frame:await fleetRuntime.read(frame),astro:window.oceanAstronomy.state,mode:window.oceanAstronomy.clock.mode};});
      assert.equal(values.frame.length,132);assert.equal(values.frame[112],scene.astro?1:0);assert.ok(values.frame.every(Number.isFinite));assert.equal(values.mode,scene.astro?'astronomy':'manual');
      if(scene.name==='manual'){assert.ok(Math.abs(values.frame[33]-.5)<1e-6);assert.equal(values.frame[99],0);}
      if(scene.name==='day')assert.ok(values.frame[33]>.2,'astronomical Sun remains above horizon');
      if(scene.name==='full-moon'){assert.ok(values.frame[33]<0&&values.frame[97]>0&&values.frame[107]>.995);fullLight=await fleetRuntimeCapture(page,'night-full-moon');}
      if(scene.name==='new-moon'){assert.ok(values.frame[33]<0&&values.frame[107]<.01);newLight=await fleetRuntimeCapture(page,'night-new-moon');}
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }
  assert.ok(fullLight.nonblack>100&&fullLight.luminance>newLight.luminance+1,'actual full-Moon scene is brighter than adapted moonless night');
});

test('modular and Pages manual Sun controls cover full angles and restore daylight after real cached night rendering',{timeout:300000},async()=>{
  const degrees=Math.PI/180,near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<2e-6,label+': '+actual+' vs '+expected);
  for(const path of ['/', '/docs/index.html']){
    // Fixed camera and low physical resolution isolate lighting changes from
    // orbit framing and adaptive resolution. Clouds exercise their real cache.
    const {page,errors}=await fleetRuntimeOpen(path,{view:'free',cam:'0,8,45,0,0',skyMode:'manual',sunElev:'30',sunAzim:'-85',windDir:'-90',swellDir:'-450',windSpeed:'2',swellHs:'.1',clouds:'.35',cloudQuality:'.25',astroDate:'2026-10-21T16:00:00Z',astroRate:'0'});
    try{
      const slider=async(key,value)=>page.locator('#sea-'+key).evaluate((input,value)=>{input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));},value);
      await fleetRuntimeStep(page);await page.getByRole('button',{name:'Sea settings',exact:true}).click();await page.locator('#astronomy-controls summary').click();
      for(const width of [320,768]){
        await page.setViewportSize({width,height:666});
        const layout=await page.locator('#astronomy-date').evaluate(input=>({width:input.getBoundingClientRect().width,overflow:input.closest('.panel-body').scrollWidth>input.closest('.panel-body').clientWidth}));
        assert.ok(layout.width>220,path+' date and time remain readable at viewport '+width);assert.equal(layout.overflow,false,path+' astronomy controls stay inside the panel');
      }
      const frame=async()=>page.evaluate(async()=>{const r=fleetRuntime,buffer=r.buffers.find(b=>/^frame ubo/.test(b.label)),lighting=r.buffers.find(b=>b.label==='sun visibility and ocean lighting');return {values:await r.read(buffer),light:await r.read(lighting),mode:oceanAstronomy.clock.mode,selected:document.querySelector('#sky-mode').value};});
      const settle=async()=>{for(let i=0;i<3;i++)await fleetRuntimeStep(page,.02);};
      const controls=await page.evaluate(()=>Object.fromEntries(['sunElev','sunAzim','windDir','swellDir'].map(key=>{const input=document.querySelector('#sea-'+key);return [key,{min:Number(input.min),max:Number(input.max),value:Number(input.value),output:Number(input.closest('label').querySelector('output').textContent),details:input.closest('details')?.id||null}];})));
      assert.deepEqual([controls.sunElev.min,controls.sunElev.max],[-90,90]);
      for(const key of ['sunAzim','windDir','swellDir'])assert.deepEqual([controls[key].min,controls[key].max],[0,360],path+' complete '+key+' range');
      assert.equal(controls.sunElev.details,'astronomy-controls');assert.equal(controls.sunAzim.details,'astronomy-controls');
      for(const [key,expected]of [['sunAzim',275],['windDir',270],['swellDir',270]]){
        assert.equal(controls[key].value,expected,path+' normalizes imported '+key);assert.equal(controls[key].output,expected,path+' normalized readout matches slider');
      }
      await settle();const initial=await frame();assert.equal(initial.values.length,132);assert.ok(initial.values.every(Number.isFinite));
      near(initial.values[32],Math.sin(275*degrees)*Math.cos(30*degrees),'signed azimuth actual Sun X');
      near(initial.values[33],.5,'signed azimuth actual Sun Y');near(initial.values[34],-Math.cos(275*degrees)*Math.cos(30*degrees),'signed azimuth actual Sun Z');
      near(initial.values[56],0,'normalized imported wind X');near(initial.values[57],-1,'normalized imported wind Z');
      for(const azimuth of [0,360]){await slider('sunAzim',azimuth);await settle();const bearing=await frame();near(bearing.values[32],0,'Sun full-circle endpoint X');near(bearing.values[34],-Math.cos(30*degrees),'Sun full-circle endpoint Z');}
      await slider('sunAzim',275);
      await slider('windDir',360);await slider('swellDir',360);const changed=await fleetRuntimeStep(page,.02);
      assert.ok(changed.compute['sim init']>0,'full-circle wind/swell endpoints reach actual spectrum rebuild');
      for(const key of ['windDir','swellDir'])assert.equal(await page.locator('#sea-'+key).inputValue(),'360');
      const endpoint=await frame();near(endpoint.values[56],1,'360-degree wind X');near(endpoint.values[57],0,'360-degree wind Z');
      await settle();const daylight=await fleetRuntimeCapture(page);assert.ok(daylight.luminance>5&&daylight.nonblack>1000,path+' daylight image contains a lit scene');

      await page.locator('#sky-mode').evaluate(input=>{input.value='astronomy';input.dispatchEvent(new Event('change',{bubbles:true}));});
      await fleetRuntimeStep(page,.02);const astronomical=await frame();assert.equal(astronomical.mode,'astronomy');assert.equal(astronomical.selected,'astronomy');assert.equal(astronomical.values[112],1);
      await slider('sunElev',-30);await settle();const manual=await frame(),night=await fleetRuntimeCapture(page);
      assert.equal(manual.mode,'manual');assert.equal(manual.selected,'manual');assert.equal(manual.values[112],0);assert.equal(manual.values[99],0,'manual override does not introduce an unrelated astronomical Moon');
      assert.ok(manual.light.slice(4,7).every(value=>value===0),'actual cached ocean direct Sun is extinguished at manual night');
      near(manual.values[33],-.5,'manual Sun input survives the astronomical frame writer');
      assert.ok(night.luminance<daylight.luminance*.55,path+' manual -30-degree Sun must substantially darken final GPU pixels: '+JSON.stringify({day:daylight.luminance,night:night.luminance}));

      for(const altitude of [-90,90]){
        await slider('sunElev',altitude);await settle();const pole=await frame();
        assert.ok(pole.values.every(Number.isFinite),path+' pole retains a finite complete production Frame');near(pole.values[33],Math.sign(altitude),'Sun pole altitude');
        assert.ok(pole.light.every(Number.isFinite),path+' solar-disc cloud rays and ocean lighting remain finite at both poles');
        near(Math.hypot(...pole.values.slice(32,35)),1,'unit Sun direction at pole');
        if(altitude<0){const nadir=await fleetRuntimeCapture(page);assert.ok(nadir.luminance<daylight.luminance*.55,path+' -90-degree Sun remains night');}
      }
      await slider('sunElev',30);await settle();const recovered=await fleetRuntimeCapture(page),last=await frame();
      near(last.values[33],.5,'daylight Sun altitude restored');assert.equal(last.mode,'manual');
      assert.ok(recovered.luminance>daylight.luminance*.7&&recovered.luminance<daylight.luminance*1.4,path+' restored environment/cloud lighting recovers comparable daylight: '+JSON.stringify({before:daylight.luminance,after:recovered.luminance}));
      assert.ok(recovered.luminance>night.luminance*2+3,path+' day recovery is visible in the real final composite');
      assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>fleetRuntime.errors),[]);
    }finally{await page.close();}
  }
});
