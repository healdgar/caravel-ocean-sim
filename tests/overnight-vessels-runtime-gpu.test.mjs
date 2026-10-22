// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Actual modular and packaged WebGPU integration. Root alone runs this suite;
// no frame-rate, device-thermal or historical-performance claim is made here.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

function instrumentOvernightVessels(){
  const r=window.overnightVesselsGPU={callback:null,now:null,device:null,errors:[],lost:null,buffers:[],draws:{},compute:{},pipelines:new WeakMap(),target:null,simClock:null,fieldUpdates:{},watched:new WeakSet()};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const requestDevice=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await requestDevice.apply(this,args);r.device=device;device.addEventListener('uncapturederror',event=>r.errors.push(event.error.message));device.lost.then(reason=>r.lost=reason.message);return device;};
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(desc){const inspect=/ geometry$/.test(desc.label||''),buffer=createBuffer.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);r.buffers.push(buffer);return buffer;};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...rest){
    if(buffer.label==='sim ubo'&&offset===0){
      const byteOffset=ArrayBuffer.isView(data)?data.byteOffset:0,backing=ArrayBuffer.isView(data)?data.buffer:data,elementBytes=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT??1:1;
      const values=new Float32Array(backing,byteOffset+(rest[0]??0)*elementBytes,56);r.simClock={time:values[52],dt:values[53],loop:values[50]};
    }
    return write.call(this,buffer,offset,data,...rest);
  };
  const render=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){r.pipelines.set(this,pipeline.label);return render.call(this,pipeline);};
  const draw=GPURenderPassEncoder.prototype.drawIndexed;
  GPURenderPassEncoder.prototype.drawIndexed=function(indices,instances=1,...args){const label=r.pipelines.get(this);r.draws[label]??={calls:0,instances:0,indices:0};r.draws[label].calls++;r.draws[label].instances+=instances;r.draws[label].indices+=indices*instances;return draw.call(this,indices,instances,...args);};
  const compute=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){r.compute[pipeline.label]=(r.compute[pipeline.label]||0)+1;return compute.call(this,pipeline);};
  const configs=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configs.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){const desc=configs.get(this),width=this.canvas.width,height=this.canvas.height;if(!r.target||r.target.width!==width||r.target.height!==height){r.target?.destroy();r.target=desc.device.createTexture({label:'overnight vessels fixture canvas',size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});r.format=desc.format;}return r.target;};
  r.read=async(buffer,offset=0,size=buffer.size)=>{
    const read=r.device.createBuffer({label:'overnight runtime read',size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,offset,read,0,size);r.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const data=Array.from(new Float32Array(read.getMappedRange()));read.unmap();read.destroy();return data;
  };
  r.image=async()=>{
    const t=r.target,row=Math.ceil(t.width*4/256)*256,read=r.device.createBuffer({size:row*t.height,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=r.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:t},{buffer:read,bytesPerRow:row},[t.width,t.height]);r.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(read.getMappedRange());let nonblack=0;for(let y=0;y<t.height;y++)for(let x=0;x<t.width;x++){const at=y*row+x*4;if(Math.max(bytes[at],bytes[at+1],bytes[at+2])>2)nonblack++;}read.unmap();read.destroy();return {nonblack,width:t.width,height:t.height};
  };
}
async function openRuntime(path,params={}){
  const page=await browser.newPage({viewport:{width:600,height:500}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(/init failed|GPU error:|Shader compile error/i.test(message.text()))errors.push(message.text());});
  await page.addInitScript(instrumentOvernightVessels);
  const query=new URLSearchParams({fleet:'',view:'ship',boatHeading:'90',boatX:'0',boatZ:'0',boatSpeed:'0',propulsion:'sail',sunElev:'35',clouds:'0',windSpeed:'7',windDir:'118',swellHs:'.35',orbitElevation:'20',orbitYaw:'95',orbitDistance:'50',w:'160',h:'108',...params});
  await page.goto(origin+path+'?'+query);
  await page.waitForFunction(()=>overnightVesselsGPU.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:180000});
  assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));assert.ok(await page.evaluate(()=>!!window.oceanFleet));return {page,errors};
}
async function frame(page,dt=.05){
  const result=await page.evaluate(async dt=>{
    const r=overnightVesselsGPU,callback=r.callback;if(typeof callback!=='function')throw Error('Missing production frame');r.callback=null;r.draws={};r.compute={};r.fieldUpdates={};
    for(const v of oceanFleet.vessels)if(v.rowingWater&&!r.watched.has(v.rowingWater)){
      const probe=v.rowingWater,update=probe.update;r.watched.add(probe);
      probe.update=function(boat,elapsed,options){r.fieldUpdates[v.id]={time:options.time,dt:elapsed,resetSea:options.resetSea};return update.call(this,boat,elapsed,options);};
    }
    // A deterministic RAF clock keeps actual GPU/CPU waiting out of simulation
    // dt. No production integrator, shader, force or water sample is replaced.
    r.now=(r.now??performance.now())+dt*1000;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));return {errors:r.errors,lost:r.lost,draws:r.draws,compute:r.compute,simClock:r.simClock,fieldUpdates:r.fieldUpdates,accepted:oceanFleet.vessels.map(v=>v.rowingWater?.state??null)};
  },dt);assert.deepEqual(result.errors,[]);assert.equal(result.lost,null);return result;
}
async function settle(page,count=8){let result;for(let i=0;i<count;i++)result=await frame(page);return result;}
async function snapshot(page){
  return page.evaluate(async()=>{
    const r=overnightVesselsGPU,rows=[];
    for(const v of oceanFleet.vessels){
      let at=0;for(let i=0;i<v.mesh.length;i+=9)if([9,13,16,17].includes(Math.floor(v.mesh[i+6]))){at=i;break;}
      const upload=await r.read(v.vertexBuffer,at*4,36),b=v.boat,sample=v.rowingWater?.sample(b.x,b.z);
      rows.push({id:v.id,model:v.asset.model.id,crew:v.crew?.state.crew.length??0,crewVisible:v.crew?.state.crew.filter(s=>s.visible).length??0,
        crewFinite:v.crew?.state.crew.every(s=>s.transform.every(Number.isFinite))??false,meshFinite:v.mesh.every(Number.isFinite),vertices:v.mesh.length/9,indices:v.asset.indices.length,
        uploadMatches:upload.every((n,i)=>Object.is(n,v.mesh[at+i])),masts:v.asset.model.rig.masts.map(m=>({id:m.id,index:m.index,controlGroup:m.controlGroup})),controls:[...new Set(v.asset.model.rig.sails.map(s=>s.controlGroup))],
        guns:v.gunnery.state.guns.length,anchorInstalled:v.anchor.installed!==false,rowingWater:!!v.rowingWater,boatWaterAlias:!v.rowingWater||v.boat.rowingWater===v.rowingWater,waterState:v.rowingWater?.state??null,waterSample:sample??null,
        poseFinite:[b.x,b.z,b.heading,b.heave,b.pitch,b.roll,b.surgeVelocity??0].every(Number.isFinite)});
    }
    return {rows,errors:r.errors,lost:r.lost,startup:window.oceanStartup.state,image:await r.image()};
  });
}
const companies={oseberg:32,lusoria:26,'taino-canoe':30,'flying-cloud':12,'gipsy-moth-iv':1};

for(const path of ['/', '/docs/index.html'])for(const [id,count]of Object.entries(companies))test(`${path} ${id}: actual mesh, company, uploaded poses and native draw startup`,{timeout:240000},async()=>{
  const {page,errors}=await openRuntime(path,{ship:id});
  try{
    const drawn=await settle(page),s=await snapshot(page);assert.equal(s.startup,'ready');assert.equal(s.rows.length,1);const v=s.rows[0];
    assert.equal(v.model,id);assert.equal(v.crew,count);assert.equal(v.crewVisible,count);assert.ok(v.crewFinite&&v.meshFinite&&v.poseFinite);assert.ok(v.vertices>1000&&v.indices>3000);assert.ok(v.uploadMatches);
    assert.ok(drawn.draws[id+' vessel']?.indices>3000,'actual requested vessel issues indexed GPU draws');assert.equal(drawn.draws.crew?.instances,count,'gender batches draw exactly the real company, including the one-person yacht');
    assert.ok(s.image.nonblack>s.image.width*s.image.height*.25);assert.deepEqual(s.errors,[]);assert.equal(s.lost,null);assert.deepEqual(errors,[]);
    if(['oseberg','lusoria','taino-canoe'].includes(id)){
      assert.ok(v.rowingWater&&v.boatWaterAlias);assert.ok(v.waterState?.time>=0);assert.equal(v.waterState.modelId,id);assert.equal(v.waterState.quality,'surface-orbital');assert.ok(v.waterSample&&[v.waterSample.height,...v.waterSample.velocity].every(Number.isFinite));
      assert.ok(drawn.compute['rowing actual water field']>0,'the production GPU orbital-field pass actually runs');
      const field=await page.evaluate(async id=>{const r=overnightVesselsGPU,b=r.buffers.find(b=>b.label===id+' rowing water field');if(!b)throw Error('No actual rowing field buffer');const values=await r.read(b);let min=Infinity,max=-Infinity,velocity=0,valid=0;for(let i=0;i<values.length;i+=4)if(values.slice(i,i+4).every(x=>Number.isFinite(x)&&Math.abs(x)<1e10)){valid++;min=Math.min(min,values[i]);max=Math.max(max,values[i]);velocity=Math.max(velocity,...values.slice(i+1,i+4).map(Math.abs));}return {valid,cells:values.length/4,span:max-min,velocity};},id);
      assert.ok(field.valid>field.cells*.5);assert.ok(field.span>1e-5&&field.velocity>1e-6,'actual wave height and orbital motion reach the blade field');
    }else assert.equal(v.rowingWater,false);
  }finally{await page.close();}
});

test('canoe exposes only actual paddle controls; rowboats use main canvas and yacht has two masts under three real controls',{timeout:300000},async()=>{
  for(const id of ['taino-canoe','oseberg','lusoria','gipsy-moth-iv']){
    const {page,errors}=await openRuntime('/docs/index.html',{ship:id});
    try{
      await settle(page,3);await page.getByRole('button',{name:'Ship settings',exact:true}).click();
      const actual=[];for(const [group,key]of [['fore','sailFore'],['main','sailMain'],['mizzen','sailMizzen']])if(await page.locator('#boat-'+key).isVisible())actual.push(group);
      assert.deepEqual(actual,id==='taino-canoe'?[]:id==='gipsy-moth-iv'?['fore','main','mizzen']:['main']);
      if(id!=='gipsy-moth-iv'){
        const cadence=page.locator('#boat-rowing-cadence');
        for(const spm of [27,36]){
          await cadence.fill(String(spm));assert.ok(await cadence.evaluate(input=>input.validity.valid&&!input.validity.stepMismatch),'normal rowing cadence is a valid browser number/step');
          assert.equal(await page.evaluate(()=>oceanFleet.vessels[0].boat.rowingCadence),spm/60,'strokes/minute UI converts to physical Hz');
        }
        await page.locator('#boat-propulsion').selectOption('manual');assert.equal(await page.evaluate(()=>oceanFleet.vessels[0].boat.propulsion),'manual');
        await page.getByRole('button',{name:'Hide ship settings',exact:true}).click();await page.locator('#helm-controls [data-rowing="1"]').click();
        assert.equal(await page.evaluate(()=>oceanFleet.vessels[0].boat.propulsion),'sail','human rowing returns to force-driven mode');
        await page.getByRole('button',{name:'Ship settings',exact:true}).click();assert.equal(await page.locator('#boat-propulsion').inputValue(),'sail','visible propulsion settings follow the actual helm command');
        assert.equal(await cadence.inputValue(),'36');
        if(id!=='taino-canoe')assert.equal(await page.locator('#boat-sailMain').isVisible(),true,'real main canvas controls reappear after leaving set-speed mode');
      }else assert.equal(await page.locator('#boat-rowing-cadence').count(),0);
      await page.getByRole('button',{name:'Hide ship settings',exact:true}).click();
      if(id==='taino-canoe'){
        assert.equal(await page.getByRole('group',{name:'Sail amount',exact:true}).isVisible(),false);
        assert.equal(await page.locator('#helm-controls [data-rowing="1"]').isVisible(),true);
        await page.getByRole('button',{name:'Captain',exact:true}).click();
        assert.equal(await page.locator('.gunnery-controls').isVisible(),false);assert.equal(await page.locator('#drop-anchor').isVisible(),false);assert.equal(await page.locator('#weigh-anchor').isVisible(),false);
        for(const order of ['full','reduced','furl','transfer'])assert.equal(await page.locator('[data-order="'+order+'"]').isVisible(),false,'no nonexistent sail job '+order);
      }
      if(id==='gipsy-moth-iv'){const s=await snapshot(page);assert.deepEqual(s.rows[0].masts.map(m=>m.id),['main','mizzen']);assert.deepEqual(s.rows[0].controls,['main','mizzen','fore']);}
      assert.deepEqual(errors,[]);
    }finally{await page.close();}
  }
});

for(const id of ['oseberg','lusoria','taino-canoe'])test(`${id}: actual GPU blade water drives physical thrust; Rest removes human power and preserves inertia`,{timeout:240000},async()=>{
  const {page,errors}=await openRuntime('/',{ship:id,windSpeed:'0',swellHs:'0',sailFore:'0',sailMain:'0',sailMizzen:'0',rowingEffort:'0',effects:'0'});
  try{
    await settle(page,12);const rest=await page.evaluate(()=>{const v=oceanFleet.vessels[0],b=v.boat;return {speed:b.surgeVelocity??0,power:b.rowingLoads?.crewPower,effort:b.rowingState?.effortPort,water:!!v.rowingWater.state,sample:!!v.rowingWater.sample(b.x,b.z)};});
    assert.ok(rest.water&&rest.sample);assert.equal(rest.power,0);assert.equal(rest.effort,0);assert.ok(Math.abs(rest.speed)<.03,'calm rest has no commanded propulsion');
    await page.locator('#helm-controls [data-rowing="1"]').click();const history=[];
    for(let i=0;i<24;i++){await frame(page);history.push(await page.evaluate(()=>{const b=oceanFleet.vessels[0].boat;return {speed:b.surgeVelocity??0,forward:b.rowingLoads?.forward??0,power:b.rowingLoads?.crewPower??0,blades:b.rowingLoads?.activeBlades??0,effort:b.rowingEffort,propulsion:b.propulsion};}));}
    assert.ok(history.every(h=>h.effort===1&&h.propulsion==='sail'));assert.ok(history.some(h=>h.forward>1&&h.power>0&&h.blades>0),'immersed human strokes produce actual water reaction');
    const peak=Math.max(...history.map(h=>h.speed));assert.ok(peak>rest.speed+.001,'real force changes integrated speed');
    const before=history.at(-1).speed;await page.locator('#helm-controls [data-rowing="0"]').click();await frame(page);
    const stopped=await page.evaluate(()=>{const b=oceanFleet.vessels[0].boat;return {speed:b.surgeVelocity??0,power:b.rowingLoads?.crewPower,effort:b.rowingState.effortPort};});
    assert.equal(stopped.power,0);assert.equal(stopped.effort,0);assert.ok(stopped.speed>0&&stopped.speed<=before+.003,'Rest coasts rather than changing speed directly');assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('production rowing metadata uses the encoded FFT clock under varying frame dt and loop wrap',{timeout:240000},async()=>{
  const {page,errors}=await openRuntime('/',{ship:'oseberg',t:'599.94',windSpeed:'4',swellHs:'.2'});
  try{
    let prior=599.94,wrapped=false,accepted=false;const actualDts=[];
    for(let i=0;i<24;i++){
      const result=await frame(page,i%2?.048:.012),clock=result.simClock,updates=Object.values(result.fieldUpdates);
      assert.equal(clock.loop,600);assert.equal(updates.length,1);const update=updates[0];
      assert.ok(Math.abs(update.time-clock.time)<5e-5,`probe time ${update.time} differs from actual uploaded FFT time ${clock.time}`);
      assert.ok(Math.abs(update.dt-clock.dt)<1e-7,`probe dt ${update.dt} differs from actual uploaded FFT dt ${clock.dt}`);
      if(i>0)actualDts.push(clock.dt);
      if(clock.time<prior-1){wrapped=true;assert.equal(update.resetSea,true,'spectrum wrap discards incompatible orbital history');assert.ok(result.accepted[0]===null||result.accepted[0].time<=clock.time+5e-5,'pre-wrap readback cannot survive into the next loop');}
      if(result.accepted[0]){accepted=true;assert.ok(result.accepted[0].time<=clock.time+5e-5);}
      prior=clock.time;
    }
    assert.ok(wrapped&&accepted,'exercise a real wrap and new post-wrap orbital readback');assert.ok(actualDts.some(t=>Math.abs(t-.012)<1e-6)&&actualDts.some(t=>Math.abs(t-.048)<1e-6));assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('mixed real fleet keeps rowing water, crew, geometry and command state independent',{timeout:300000},async()=>{
  const {page,errors}=await openRuntime('/docs/index.html',{ship:'oseberg',fleet:'oseberg,gipsy-moth-iv,taino-canoe'});
  try{
    const drawn=await settle(page),s=await snapshot(page);assert.deepEqual(s.rows.map(v=>v.model),['oseberg','oseberg','gipsy-moth-iv','taino-canoe']);assert.deepEqual(s.rows.map(v=>v.crew),[32,32,1,30]);assert.equal(drawn.draws.crew.instances,95);
    const isolated=await page.evaluate(()=>{
      const [a,b,m,c]=oceanFleet.vessels,states=[b,c].map(v=>JSON.stringify(v.rowingWater.state)),commands=[b,c].map(v=>JSON.stringify({effort:v.boat.rowingEffort,turn:v.boat.rowingTurn,cadence:v.boat.rowingCadence,state:v.boat.rowingState}));
      const identities={asset:a.asset===b.asset,mesh:a.mesh!==b.mesh,vertex:a.vertexBuffer!==b.vertexBuffer,crew:a.crew.state!==b.crew.state,rowing:a.boat.rowingState!==b.boat.rowingState,water:a.rowingWater!==b.rowingWater,wetness:a.wetness.state!==b.wetness.state,moth:m.rowingWater===null};
      a.boat.rowingEffort=.91;a.boat.rowingTurn=-.42;a.boat.rowingCadence=.61;a.boat.rowingState.phase=.37;a.rowingWater.reset();
      return {identities,states,afterStates:[b,c].map(v=>JSON.stringify(v.rowingWater.state)),commands,afterCommands:[b,c].map(v=>JSON.stringify({effort:v.boat.rowingEffort,turn:v.boat.rowingTurn,cadence:v.boat.rowingCadence,state:v.boat.rowingState})),cleared:a.rowingWater.state===null};
    });
    assert.ok(Object.values(isolated.identities).every(Boolean));assert.ok(isolated.cleared);assert.deepEqual(isolated.afterStates,isolated.states);assert.deepEqual(isolated.afterCommands,isolated.commands);
    await settle(page,6);const recovered=await snapshot(page);assert.ok(recovered.rows.filter(v=>v.rowingWater).every(v=>v.waterState&&v.waterSample&&v.boatWaterAlias));assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
