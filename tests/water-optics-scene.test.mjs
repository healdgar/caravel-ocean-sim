// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.WATER_OPTICS_SCENE_PORT||8107,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Water optics scene server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

function instrumentScene(){
  const state=window.opticsScene={callback:null,errors:[],draws:[],device:null,target:null,source:null};
  window.requestAnimationFrame=callback=>{state.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);state.device=device;device.addEventListener('uncapturederror',event=>state.errors.push(event.error.message));return device;};
  const modules=new WeakMap(),makeModule=GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule=function(descriptor){const module=makeModule.call(this,descriptor);modules.set(module,descriptor.code);return module;};
  const groups=new WeakMap(),makeGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(descriptor){const group=makeGroup.call(this,descriptor);groups.set(group,descriptor.entries);return group;};
  const families=new WeakMap(),makePipeline=GPUDevice.prototype.createRenderPipelineAsync;
  GPUDevice.prototype.createRenderPipelineAsync=async function(descriptor){
    const pipeline=await makePipeline.call(this,descriptor),source=modules.get(descriptor.vertex.module)||'';
    if(descriptor.fragment?.entryPoint==='submergedFS')families.set(pipeline,source.includes('struct BoatVertex')?'hull':source.includes('struct CrewVertex')?'crew':source.includes('struct AnchorVertex')?'anchor':source.includes('struct LandVertex')?'terrain':source.includes('let whale=d.pose.w>0.0')?'marine':'dolphins');
    return pipeline;
  };
  const makeTexture=GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture=function(descriptor){
    const capture=descriptor.label==='submerged radiance and eye depth';
    const texture=makeTexture.call(this,capture?{...descriptor,usage:descriptor.usage|GPUTextureUsage.COPY_SRC}:descriptor);
    if(capture)state.source=texture;return texture;
  };
  const configurations=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(descriptor){configurations.set(this,descriptor);return configure.call(this,descriptor);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){
    const descriptor=configurations.get(this),{width,height}=this.canvas;
    if(!state.target||state.target.width!==width||state.target.height!==height){state.target?.destroy();state.target=descriptor.device.createTexture({size:[width,height],format:descriptor.format,usage:descriptor.usage|GPUTextureUsage.COPY_SRC});}
    return state.target;
  };
  const passes=new WeakMap(),begin=GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass=function(descriptor){const pass=begin.call(this,descriptor);passes.set(pass,{label:descriptor.label||'',pipeline:null,groups:[],vertices:[],indices:null});return pass;};
  const setPipeline=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){passes.get(this).pipeline=pipeline;return setPipeline.call(this,pipeline);};
  const setGroup=GPURenderPassEncoder.prototype.setBindGroup;
  GPURenderPassEncoder.prototype.setBindGroup=function(index,group,...args){passes.get(this).groups[index]=group;return setGroup.call(this,index,group,...args);};
  const setVertex=GPURenderPassEncoder.prototype.setVertexBuffer;
  GPURenderPassEncoder.prototype.setVertexBuffer=function(index,buffer,...args){passes.get(this).vertices[index]=buffer;return setVertex.call(this,index,buffer,...args);};
  const setIndex=GPURenderPassEncoder.prototype.setIndexBuffer;
  GPURenderPassEncoder.prototype.setIndexBuffer=function(buffer,...args){passes.get(this).indices=buffer;return setIndex.call(this,buffer,...args);};
  for(const method of ['draw','drawIndexed']){
    const draw=GPURenderPassEncoder.prototype[method];
    GPURenderPassEncoder.prototype[method]=function(...args){
      const pass=passes.get(this),pipeline=pass.pipeline,vessels=window.oceanFleet?.vessels||[];
      const geometry=vessels.find(v=>v.vertexBuffer===pass.vertices[0]);
      const resources=groups.get(pass.groups[0])||[],hull=vessels.find(v=>resources.some(entry=>entry.resource?.buffer===v.hullUBO));
      const submerged=pass.label==='Submerged geometry';
      const family=vessels.some(v=>v.render.submerged.pipeline===pipeline)?'hull':families.get(pipeline)||null;
      state.draws.push({pass:pass.label,label:pipeline.label,family,count:args[0],instances:args[1]??1,
        vessel:geometry?.id||hull?.id||null,geometry:geometry?.id||null,hull:hull?.id||null,
        material:geometry?pass.groups[0]===(submerged?geometry.submergedGroup:geometry.bindGroup):null,
        lighting:geometry?pass.groups[1]===(submerged?geometry.submergedLighting:geometry.lighting):null,
        indices:geometry?pass.indices===geometry.render.indexBuffer:null});
      return draw.apply(this,args);
    };
  }
}

const fixture=String.raw`
  window.opticsFixture={render(){frameIndex=40;envFull=true;frame(last);},size:()=>[W,H],
    enabled(value){qs.set('waterOptics',value?'1':'0');},
    async wildlife(kind){
      // Keep the actual two-vessel roster and resources. Move both ships behind
      // the wildlife camera instead of mutating the immutable fleet selection.
      for(const [index,v] of window.oceanFleet.vessels.entries()){v.boat.showProw=false;v.boat.x=200+index*40;v.boat.z=200;}
      setCameraMode('free');
      Object.assign(cam,{x:0,y:22,z:20,yaw:0,pitch:-Math.atan2(22,20)});
      dolphins.state.clear();marineLife.state.clear();
      if(kind==='whale'){
        // The production whale renderer/GLB is intentionally loaded on demand.
        // Wait for its actual capture pipeline before freezing an encounter.
        await marineLife.load();
        if(!marineLife.state.trigger('whale',boat,{vessels:[],behavior:'blow'}))throw Error('Whale fixture encounter was rejected');
        Object.assign(marineLife.state.animals[0],{x:0,z:0,heading:0,depth:-4,pitch:0,roll:0,scale:1,phase:0});
        marineLife.state.step=()=>{};
      }else{
        dolphins.state.trigger(boat,{vessels:[]});
        for(let i=0;i<dolphins.state.count;i++)Object.assign(dolphins.state.animals[i],{x:(i%3-1)*3,z:Math.floor(i/3)*4-2,heading:0,depth:-1.8,pitch:0,scale:1,phase:0});
        dolphins.state.step=()=>{};
      }
    }};
`;
async function loadScene(path,{source=false,viewport={width:256,height:192}}={}){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',event=>errors.push(event.message));
  page.on('console',message=>{if(message.text().includes('init failed')){errors.push(message.text());page.evaluate(text=>{opticsScene.startupFailure=text;},message.text()).catch(()=>{});}});
  await page.addInitScript(instrumentScene);
  if(source){const main=await readFile(new URL('../js/main.js',import.meta.url),'utf8'),marker='  resize();\n  updateResolutionStatus();';assert.ok(main.includes(marker),'actual main fixture entry remains available');await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:main.replace(marker,fixture+marker)}));}
  await page.goto(origin+path);
  await page.waitForFunction(()=>opticsScene.callback||opticsScene.startupFailure||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
  assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));assert.deepEqual(errors,[]);
  return {page,errors};
}
async function render(page){
  return page.evaluate(async()=>{
    opticsScene.draws=[];
    if(window.opticsFixture)opticsFixture.render();else{const callback=opticsScene.callback;opticsScene.callback=null;callback(performance.now()+50);}
    await opticsScene.device.queue.onSubmittedWorkDone();
    return {draws:opticsScene.draws,errors:opticsScene.errors,size:[opticsScene.source.width,opticsScene.source.height]};
  });
}
async function readScene(page){
  return page.evaluate(async()=>{
    const state=opticsScene,device=state.device,W=state.source.width,H=state.source.height;
    const read=async(texture,bytes)=>{
      const stride=Math.ceil(W*bytes/256)*256,buffer=device.createBuffer({size:stride*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:stride},[W,H]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      const source=new Uint8Array(buffer.getMappedRange()),data=new Uint8Array(W*H*bytes);for(let y=0;y<H;y++)data.set(source.subarray(y*stride,y*stride+W*bytes),y*W*bytes);buffer.unmap();buffer.destroy();return data;
    };
    const source=await read(state.source,8),half=new Uint16Array(source.buffer);let count=0,minDepth=Infinity,maxDepth=0;
    const float=bits=>{const e=bits>>10&31,m=bits&1023;return (bits&32768?-1:1)*(e?(1+m/1024)*2**(e-15):m*2**-24);};
    for(let i=3;i<half.length;i+=4)if(half[i]){const depth=float(half[i]);if(!Number.isFinite(depth)||depth<=0)throw Error('Invalid captured eye depth');count++;minDepth=Math.min(minDepth,depth);maxDepth=Math.max(maxDepth,depth);}
    const color=Array.from(await read(state.target,4));return {count,minDepth,maxDepth,color};
  });
}

function assertValid(frame){assert.deepEqual(frame.errors,[]);assert.ok(frame.draws.some(draw=>draw.label==='ocean'),'actual ocean surface draws');}
function difference(a,b){let pixels=0,energy=0;for(let i=0;i<a.length;i+=4){const delta=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);if(delta>3)pixels++;energy+=delta;}return {pixels,energy};}

test('the actual Niña fleet captures independent hulls and renders submerged whales and dolphins through water, including after resize',{timeout:180000},async()=>{
  const {page,errors}=await loadScene('/?ship=nina&view=ship&follower=1&sunElev=45&clouds=0&windSpeed=2&swellHs=.2&turbidity=.2&resolution=native',{source:true});
  try{
    const fleet=await render(page);assertValid(fleet);
    const roster=await page.evaluate(()=>{
      const vessels=window.oceanFleet.vessels,[player,escort]=vessels;
      return {rows:vessels.map(v=>({id:v.id,model:v.asset.model.id,label:v.render.pipeline.label,indices:v.asset.indices.length})),
        sharedAsset:player.asset===escort.asset,sharedRender:player.render===escort.render,sharedIndices:player.render.indexBuffer===escort.render.indexBuffer,
        uniqueGeometry:new Set(vessels.map(v=>v.vertexBuffer)).size,uniqueUniforms:new Set(vessels.map(v=>v.hullUBO)).size,
        uniqueCaptureGroups:new Set(vessels.map(v=>v.submergedGroup)).size,uniqueLighting:new Set(vessels.map(v=>v.submergedLighting)).size};
    });
    assert.equal(roster.rows.length,2,'legacy follower=1 allocates two actual fleet vessels');
    assert.deepEqual(roster.rows.map(v=>v.model),['nina','nina']);
    assert.ok(roster.sharedAsset&&roster.sharedRender&&roster.sharedIndices,'the model factory shares immutable Niña assets and pipelines');
    for(const property of ['uniqueGeometry','uniqueUniforms','uniqueCaptureGroups','uniqueLighting'])assert.equal(roster[property],2,'each captured vessel owns '+property);
    for(const family of ['hull','crew','anchor'])assert.ok(fleet.draws.filter(draw=>draw.pass==='Submerged geometry'&&draw.family===family).length>=2,`both vessels submit ${family} geometry`);
    for(const vessel of roster.rows){
      const captures=fleet.draws.filter(draw=>draw.pass==='Submerged geometry'&&draw.family==='hull'&&draw.vessel===vessel.id);
      const visible=fleet.draws.filter(draw=>draw.pass!=='Submerged geometry'&&draw.label===vessel.label&&draw.vessel===vessel.id);
      assert.equal(captures.length,1,vessel.id+' submits exactly one independent underwater hull');
      assert.equal(visible.length,1,vessel.id+' submits its actual model-factory surface pipeline');
      for(const draw of [...captures,...visible]){
        assert.equal(draw.geometry,vessel.id);assert.equal(draw.hull,vessel.id,'capture geometry and hull transform belong to the same ship');
        assert.equal(draw.count,vessel.indices);assert.equal(draw.instances,1);assert.ok(draw.material&&draw.lighting&&draw.indices,'each draw binds its own material and shadow groups with the shared model indices');
      }
    }
    assert.ok((await readScene(page)).count>20,'a loaded hull produces underwater source fragments');
    for(const animal of ['whale','dolphins']){
      await page.evaluate(animal=>opticsFixture.wildlife(animal),animal);
      await render(page);await render(page);
      await page.evaluate(()=>opticsFixture.enabled(false));await render(page);const ordinary=await readScene(page);
      await page.evaluate(()=>opticsFixture.enabled(true));const frame=await render(page),through=await readScene(page);assertValid(frame);
      const family=animal==='whale'?'marine':'dolphins';assert.ok(frame.draws.some(draw=>draw.pass==='Submerged geometry'&&draw.family===family),`${animal} submits its real animated mesh to capture`);
      assert.ok(through.count>(animal==='whale'?200:30),`${animal} creates measurable submerged pixels: ${through.count}`);
      assert.ok(through.minDepth>0&&through.maxDepth<80,`${animal} alpha remains camera depth in metres`);
      const delta=difference(ordinary.color,through.color);assert.ok(delta.pixels>(animal==='whale'?100:20),`${animal} must affect final water pixels, not just an unused capture: ${JSON.stringify(delta)}`);
    }
    await page.setViewportSize({width:288,height:216});const resized=await render(page);assertValid(resized);assert.deepEqual(resized.size,[288,216]);assert.ok((await readScene(page)).count>30,'resizing retains underwater wildlife');
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>opticsScene.errors),[]);
  }finally{await page.close();}
});

test('the standalone coastal Niña scene composites captured seabed with inline ocean visibility and both ships',{timeout:180000},async()=>{
  const {page,errors}=await loadScene('/ocean.html?landfall=coast&view=free&follower=1&oceanDepth=0&sunElev=35&clouds=0&resolution=native');
  try{
    const frame=await render(page);assertValid(frame);
    assert.ok(frame.draws.some(draw=>draw.pass==='Submerged geometry'&&draw.family==='terrain'),'real coastal seabed is captured');
    assert.ok(frame.draws.some(draw=>draw.label==='island'),'the ordinary land path remains active');
    assert.equal(frame.draws.filter(draw=>draw.pass==='Submerged geometry'&&draw.family==='hull').length,2);
    const capture=await readScene(page);assert.ok(capture.count>100,'coastal source contains actual submerged geometry');
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>opticsScene.errors),[]);
  }finally{await page.close();}
});
