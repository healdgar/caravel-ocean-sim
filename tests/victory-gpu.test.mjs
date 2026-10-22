import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.VICTORY_TEST_PORT||8096,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',port],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Victory test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

function instrumentVictory(){
  window.victoryCheck={callback:null,errors:[],render:{},compute:{},device:null,target:null};
  window.requestAnimationFrame=callback=>{victoryCheck.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);victoryCheck.device=device;device.addEventListener('uncapturederror',e=>victoryCheck.errors.push(e.error.message));return device;};
  const configurations=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configurations.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){
    const desc=configurations.get(this),{width,height}=this.canvas;
    if(!victoryCheck.target||victoryCheck.target.width!==width||victoryCheck.target.height!==height){victoryCheck.target?.destroy();victoryCheck.target=desc.device.createTexture({size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});}
    return victoryCheck.target;
  };
  const render=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){victoryCheck.render[pipeline.label]=(victoryCheck.render[pipeline.label]||0)+1;return render.call(this,pipeline);};
  const labels=new WeakMap(),setCompute=GPUComputePassEncoder.prototype.setPipeline,dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){labels.set(this,pipeline.label);return setCompute.call(this,pipeline);};
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...args){const label=labels.get(this);victoryCheck.compute[label]=(victoryCheck.compute[label]||0)+1;return dispatch.apply(this,args);};
}
async function step(page){
  const result=await page.evaluate(async()=>{
    const callback=victoryCheck.callback;victoryCheck.callback=null;victoryCheck.render={};victoryCheck.compute={};callback(performance.now()+100);
    await victoryCheck.device.queue.onSubmittedWorkDone();return {errors:victoryCheck.errors,render:victoryCheck.render,compute:victoryCheck.compute};
  });
  assert.deepEqual(result.errors,[]);return result;
}

test('a selectable Victory fleet renders with independent ship state, correct captain height and a model-preserving share link',{timeout:180000},async()=>{
  const source=await readFile(new URL('../js/main.js',import.meta.url),'utf8'),marker='window.oceanFleet={vessels,config:fleetConfig,wakes:wakePool,renderAssets};';
  assert.ok(source.includes(marker),'fixture must expose actual runtime vessel records');
  const fixture=source.replace(marker,marker+'window.victoryFixture={...window.oceanFleet,shipAssets};');
  const page=await browser.newPage({viewport:{width:480,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',msg=>{if(msg.text().includes(' error ')||msg.text().includes('init failed'))errors.push(msg.text());});
  try{
    await page.addInitScript(instrumentVictory);
    await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:fixture}));
    await page.goto(`${origin}/?ship=victory&view=ship&follower=1&sunElev=35&clouds=0&windSpeed=7&swellHs=.5&w=144&h=108`);
    await page.waitForFunction(()=>victoryCheck.callback||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
    assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
    const frame=await step(page);
    assert.equal(frame.render['victory vessel'],2);assert.equal(frame.render.crew,2);
    assert.equal(frame.render.ocean,1);assert.equal(frame.compute['fft rows'],1);
    assert.equal(frame.compute['height probe'],2);assert.equal(frame.render['solid shadows'],2);assert.equal(frame.render['canvas shadows'],2);
    await page.waitForFunction(()=>victoryFixture.vessels.every(v=>!v.probe.pending));
    const state=await page.evaluate(async()=>{
      const {vessels,shipAssets}=victoryFixture,[player,following]=vessels,boat=player.boat,companion=following.boat,shipAsset=player.asset;
      const {VICTORY_DESIGN,victoryVesselDeck}=await import('/js/models/victory.js');
      const {boatEyePosition}=await import('/js/boat.js');
      const eye=boatEyePosition(new Float64Array(3),{...boat,x:0,z:0,heave:0,heading:0,pitch:0,roll:0});
      return {ids:[boat.modelId,companion.modelId],size:[boat.length,boat.beam],
        separateRig:boat.sailState!==companion.sailState,separateHull:vessels[0].hullUBO!==vessels[1].hullUBO,
        separateWetness:vessels[0].wetness.state!==vessels[1].wetness.state,
        companies:vessels.map(v=>v.crew.state.modelId),sameModel:boat.model===companion.model,
        sharedGeometry:shipAssets.get('victory')===shipAsset&&following.asset===shipAsset,
        modelFlags:vessels.map(v=>v.hullData[23]),yScales:vessels.map(v=>v.hullData[3]),
        eyeAboveDeck:eye[1]-victoryVesselDeck(VICTORY_DESIGN.helm.z)*VICTORY_DESIGN.frame.verticalScale,
        finite:Array.from(vessels[0].hullData).every(Number.isFinite)};
    });
    assert.deepEqual(state.ids,['victory','victory']);assert.deepEqual(state.companies,['victory','victory']);
    assert.deepEqual(state.size,[56.6928,15.8496]);assert.deepEqual(state.modelFlags,[1,1]);
    for(const value of state.yScales)assert.ok(Math.abs(value-56.6928/12)<1e-6);
    for(const key of ['separateRig','separateHull','separateWetness','sameModel','sharedGeometry','finite'])assert.equal(state[key],true,key);
    assert.ok(Math.abs(state.eyeAboveDeck-1.6)<1e-8);
    await page.getByRole('button',{name:'Ship settings',exact:true}).click();assert.equal(await page.locator('#ship-model').inputValue(),'victory');
    await page.getByRole('button',{name:'Copy share link',exact:true}).click();
    const link=new URL(await page.getByRole('textbox',{name:'Share link',exact:true}).inputValue());assert.equal(link.searchParams.get('ship'),'victory');
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>victoryCheck.errors),[]);
  }finally{await page.close();}
});

for(const entry of ['ocean.html','ocean.min.html','docs/index.html'])test(`Victory starts and renders from ${entry}`,{timeout:120000},async()=>{
  const page=await browser.newPage({viewport:{width:480,height:360}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',msg=>{if(msg.text().includes('init failed')){errors.push(msg.text());page.evaluate(message=>{victoryCheck.startupFailure=message;},msg.text()).catch(()=>{});}});
  try{
    await page.addInitScript(instrumentVictory);
    await page.goto(`${origin}/${entry}?ship=victory&view=ship&follower=0&sunElev=30&clouds=0&w=144&h=108`);
    await page.waitForFunction(()=>victoryCheck.callback||victoryCheck.startupFailure||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
    assert.equal(await page.locator('#err').textContent(),'');assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>typeof victoryCheck.callback),'function');
    const frame=await step(page);assert.equal(frame.render['victory vessel'],1);assert.equal(frame.render.crew,1);assert.equal(frame.render.ocean,1);
    await page.getByRole('button',{name:'Ship settings',exact:true}).click();assert.equal(await page.locator('#ship-model').inputValue(),'victory');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('Victory GPU cloth, reefing, support contact and hull-water footprint match the CPU geometry',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__victory-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__victory-test`);
    const result=await page.evaluate(async()=>{
      const {VESSEL_RIG}=await import('/js/wgsl/vessel.js'),{HULL_PROFILE}=await import('/js/wgsl/hull.js');
      const {VICTORY_DESIGN:D,VICTORY_SAILS:S,VICTORY_RUNNING_LINES:L,victoryHullHalfWidth}=await import('/js/models/victory.js');
      const {victoryPose,victoryClothPoint,victoryYardPoint}=await import('/js/victory-motion.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const sample=[];for(const sail of S){const uv=sail.corners.length===3?[[.2,.2],[.65,.1],[.1,.75],[.6,0]]:[[.35,.65],[.1,.25],[.9,.9],[.6,0]];for(const p of uv)sample.push([sail.id,...p,-6+sample.length/4]);}
      for(let i=0;i<L.length;i++)for(const t of [0,.5,1])sample.push([0,i,t,0]);
      const input=new Float32Array(sample.flat()),code=VESSEL_RIG+HULL_PROFILE+`
@group(0)@binding(0)var<uniform>hull:Hull;
@group(0)@binding(1)var<storage,read>points:array<vec4f>;
@group(0)@binding(2)var<storage,read_write>results:array<vec4f>;
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)i:vec3u){if(i.x>=arrayLength(&points)){return;}let p=points[i.x];var xyz:vec3f;if(p.x>.5){xyz=victoryClothPoint(u32(p.x),p.yz);}else{xyz=victoryRopePoint(u32(p.y),p.z);}results[i.x]=vec4f(xyz,modelHullWidth(p.w,.1,1.0));}`;
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}}),B=GPUBufferUsage;
      const h=device.createBuffer({size:208,usage:B.UNIFORM|B.COPY_DST}),p=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_DST}),out=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:input.byteLength,usage:B.COPY_DST|B.MAP_READ});
      device.queue.writeBuffer(p,0,input);const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[h,p,out].map((buffer,binding)=>({binding,resource:{buffer}}))});let maxError=0,checked=0,changed=0,first=null;
      for(const set of [1,.5,0]){
        const state={squareYaw:.38,lateenYaw:.6,windSide:3,windForward:5,set:[set,set,set],rig:Array.from({length:3},()=>({fill:.7}))},uniform=new Float32Array(52);
        uniform[0]=1;uniform[3]=D.frame.verticalScale;uniform[5]=1;uniform[10]=-1;uniform[12]=D.runtime.beam;uniform[13]=D.runtime.length;uniform[19]=1.25;uniform[21]=6;uniform[23]=1;uniform.set(state.set,24);uniform[28]=state.squareYaw;uniform[29]=state.lateenYaw;uniform[32]=state.windSide;uniform[33]=-state.windForward;for(let m=0;m<3;m++)uniform[39+m*4]=.7;
        device.queue.writeBuffer(h,0,uniform);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(sample.length/32));pass.end();encoder.copyBufferToBuffer(out,0,read,0,input.byteLength);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const values=new Float32Array(read.getMappedRange()).slice();read.unmap();
        for(let i=0;i<sample.length;i++){
          const [id,u,v,z]=sample[i];let xyz;
          if(id)xyz=victoryClothPoint(id,u,v,victoryPose(S[id-1],state),1.25,6);
          else{
            const line=L[u],pose=victoryPose(S[line.sail-1],state),a=line.kind==='sheet'?victoryClothPoint(line.sail,...line.uv,pose,1.25,6):victoryYardPoint(line.sail,line.a,pose),b=line.bSail?victoryYardPoint(line.bSail,line.b,victoryPose(S[line.bSail-1],state)):line.b;
            xyz=a.map((x,k)=>x+(b[k]-x)*v);
          }
          const expected=[...xyz,victoryHullHalfWidth(z,.1)];
          for(let k=0;k<4;k++){const value=values[i*4+k];if(!Number.isFinite(value))throw Error('Nonfinite Victory GPU geometry');maxError=Math.max(maxError,Math.abs(value-expected[k]));checked++;if(first&&k<3&&Math.abs(value-first[i*4+k])>.05)changed++;}
        }
        first??=values;
      }
      device.destroy();return {maxError,checked,changed,errors,samples:sample.length,lines:L.length};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.checked,result.samples*4*3);assert.ok(result.lines>30);assert.ok(result.changed>50);assert.ok(result.maxError<3e-4,`CPU/GPU model error ${result.maxError}`);
  }finally{await page.close();}
});

test('the full Victory GPU hull footprint matches CPU sections through bow, keel, tumblehome and outside caps',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__victory-hull',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__victory-hull`);
    const result=await page.evaluate(async()=>{
      const {HULL_PROFILE}=await import('/js/wgsl/hull.js'),{VICTORY_DESIGN:D,victoryHullHalfWidth,victoryHullPoint,victorySheer}=await import('/js/models/victory.js');
      const {hullHalfWidth}=await import('/js/hull.js');
      const probes=[];
      // Deliberately sample between authored knots, not merely the same table
      // entries on both processors. Boundary probes use a finite offset on
      // either side of the cap, avoiding an ambiguous float-rounded equality.
      for(let iz=0;iz<190;iz++)for(let iy=0;iy<65;iy++)probes.push([-6.9+iz*.073,-D.hull.draft-.17+iy*.083,1,0]);
      for(const station of [-6,6])for(const base of [-D.hull.draft,-1.5,-.8,-.2,0,.5,1.17,1.67,2.15,2.6]){
        const point=victoryHullPoint(station,base,1);
        for(const dz of [-.001,.001])probes.push([point[2]+dz,point[1],1,0]);
      }
      for(const z of [-5.5,-4,-1,0,1,3,5.5])for(const base of [0,.5,1.17,1.58,1.67,2.04,2.15,2.65])probes.push([z,base+victorySheer(z),1,0]);
      for(const z of [-6,-5,-3,0,3,5])for(const y of [-1,-.5,0,.5,1])probes.push([z,y,0,0]);
      const input=new Float32Array(probes.flat()),adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const code=HULL_PROFILE+`
@group(0)@binding(0)var<storage,read>points:array<vec4f>;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(64)fn hullProbe(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&points)){return;}let p=points[i.x];answers[i.x]=vec4f(modelHullWidth(p.x,p.y,p.z),0,0,0);
}`;
      const module=device.createShaderModule({code}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'hullProbe'}}),B=GPUBufferUsage;
      const source=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_DST}),output=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:input.byteLength,usage:B.COPY_DST|B.MAP_READ});device.queue.writeBuffer(source,0,input);
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(probes.length/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,input.byteLength);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=new Float32Array(read.getMappedRange()).slice();read.unmap();let maxError=0,worst=null,inside=0,outside=0;
      for(let i=0;i<probes.length;i++){
        const z=input[i*4],y=input[i*4+1],expected=input[i*4+2]>.5?victoryHullHalfWidth(z,y):hullHalfWidth(z,y),value=values[i*4];
        if(!Number.isFinite(value)||value<0)throw Error('Invalid GPU hull width');
        const error=Math.abs(value-expected);if(error>maxError){maxError=error;worst={z,y,value,expected};}if(expected>0)inside++;else outside++;
      }
      device.destroy();return {errors,count:probes.length,maxError,worst,inside,outside};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.count>12000&&result.inside>3000&&result.outside>1000,'exercise the full hull and exterior domain');
    assert.ok(result.maxError<3e-4,`dense CPU/GPU hull error ${JSON.stringify(result.worst)}`);
  }finally{await page.close();}
});
