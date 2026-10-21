// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('real surface impulses make balanced cavities, radiate ocean height, reproject and reach buoyancy probes',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__surface_test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(origin+'/__surface_test');
    const result=await page.evaluate(async()=>{
      const {createSurfaceWaves}=await import('/js/surface-waves.js');
      const {SCENE_HEIGHT_PROBE}=await import('/js/wgsl/ocean.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const computePipe=async(code,label)=>{
        const module=device.createShaderModule({code,label});
        const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      };
      const field=await createSurfaceWaves({device,computePipe}),size=512,dx=.5;
      const advance=async(dt=1/60,center={x:0,z:0})=>{
        field.update(center,dt);const enc=device.createCommandEncoder(),cp=enc.beginComputePass();field.encode(cp);cp.end();device.queue.submit([enc.finish()]);
      };
      const half=n=>{const e=(n>>10)&31,m=n&1023;return(n&32768?-1:1)*(e===31?Infinity:e?(1+m/1024)*2**(e-15):m*2**-24);};
      const read=async()=>{
        const buffer=device.createBuffer({size:size*size*8,usage:B.MAP_READ|B.COPY_DST}),enc=device.createCommandEncoder();
        enc.copyTextureToBuffer({texture:field.textures[field.current],origin:[0,0,0]},{buffer,bytesPerRow:size*8},[size,size]);device.queue.submit([enc.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);const out=Float32Array.from(new Uint16Array(buffer.getMappedRange()),half);buffer.unmap();buffer.destroy();return out;
      };
      const metrics=data=>{
        let positive=0,negative=0,peak=0,radiated=0,finite=true;
        for(let i=0;i<size*size;i++){
          const h=data[i*4],v=data[i*4+1],x=(i%size+.5-size/2)*dx,z=(Math.floor(i/size)+.5-size/2)*dx;
          positive+=Math.max(0,h)*dx*dx;negative+=Math.max(0,-h)*dx*dx;peak=Math.max(peak,Math.abs(h));finite&&=Number.isFinite(h)&&Number.isFinite(v);
          if(Math.hypot(x,z)>9&&Math.hypot(x,z)<20)radiated=Math.max(radiated,Math.abs(h));
        }
        return {positive,negative,peak,radiated,finite};
      };
      field.emit({source:'whale',id:1,x:0,z:0,kind:'entry',radiusMetres:2,closingSpeed:8,velocity:[0,-8,0]});
      await advance();const first=await read(),born=metrics(first),centre=first[((size/2)*size+size/2)*4];
      let peak=0;for(let i=0;i<first.length;i+=4)if(first[i]>first[peak])peak=i;
      // Query the actual shared scene shader at the strongest positive rim.
      const frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST}),f=new Float32Array(96);f.fill(1,48,54);
      const cell=peak/4;f[16]=(cell%size+.5-size/2)*dx;f[18]=(Math.floor(cell/size)+.5-size/2)*dx;device.queue.writeBuffer(frame,0,f);
      const emptySea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sea=emptySea.createView({dimension:'2d-array'});
      const emptyWake=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),zero=device.createBuffer({size:64,usage:B.UNIFORM}),boat=device.createBuffer({size:32,usage:B.UNIFORM});
      const output=device.createBuffer({size:64,usage:B.STORAGE|B.COPY_SRC}),readback=device.createBuffer({size:64,usage:B.COPY_DST|B.MAP_READ});
      const pipe=await computePipe(SCENE_HEIGHT_PROBE,'actual shared disturbance buoyancy');
      const resources=[{buffer:frame},sea,sampler,{buffer:output},{buffer:boat},{buffer:zero},emptyWake.createView(),sampler,sea,{buffer:zero},emptyWake.createView(),{buffer:field.uniform},field.view];
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(1);cp.end();enc.copyBufferToBuffer(output,0,readback,0,64);device.queue.submit([enc.finish()]);
      await readback.mapAsync(GPUMapMode.READ);const probes=Array.from(new Float32Array(readback.getMappedRange()));readback.unmap();
      for(let i=0;i<150;i++)await advance();const grown=metrics(await read());
      // A snapped one-metre grid translation must retain world-space waves.
      const before=await read();await advance(1/60,{x:1,z:0});const after=await read();let moved=0,original=0;
      for(let y=80;y<size-80;y++)for(let x=80;x<size-82;x++){const a=before[(y*size+x+2)*4],b=after[(y*size+x)*4];moved+=(a-b)**2;original+=a*a;}
      field.reset();await advance();const dormant=field.stats.active;
      field.emit({source:'whale',id:2,x:0,z:0,kind:'entry',radiusMetres:2,closingSpeed:0,velocity:[0,0,0]});await advance();
      const accepted=field.stats.accepted;await device.queue.onSubmittedWorkDone();device.destroy();
      return {errors,born,centre,positiveRim:first[peak],probe:probes[9],incidentSlope:probes.slice(10,12),grown,reprojectionRMS:Math.sqrt(moved/Math.max(original,1e-12)),dormant,accepted};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    assert.ok(result.born.finite&&result.grown.finite);
    assert.ok(result.centre<-.001&&result.positiveRim>.0001,'entry creates a cavity with raised surrounding water');
    assert.ok(Math.abs(result.born.positive-result.born.negative)/result.born.negative<.005,'signed displaced volume balances before reaching boundaries');
    assert.ok(Math.abs(result.probe-result.positiveRim)<1e-5,'buoyancy samples the same field that displaces ocean vertices');
    assert.deepEqual(result.incidentSlope,[0,0],'new field cannot become an artificial propulsion slope');
    assert.ok(result.grown.radiated>.0005&&result.grown.radiated>result.born.radiated*10,'water height travels out of the contact footprint');
    assert.ok(result.reprojectionRMS<.2,'grid movement preserves the world-space disturbance');
    assert.equal(result.dormant,false);assert.equal(result.accepted,1,'a stationary object does not manufacture water motion');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('a real whale encounter feeds persistent waves into the production ocean renderer',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage({viewport:{width:640,height:480}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      window.waveScene={callback:null,errors:[]};window.requestAnimationFrame=cb=>{waveScene.callback=cb;return 1;};
      const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.onuncapturederror=e=>waveScene.errors.push(e.error.message);return d;};
      const configurations=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
      GPUCanvasContext.prototype.configure=function(desc){configurations.set(this,desc);return configure.call(this,desc);};
      GPUCanvasContext.prototype.getCurrentTexture=function(){
        const desc=configurations.get(this),{width,height}=this.canvas;
        if(!waveScene.target||waveScene.target.width!==width||waveScene.target.height!==height){waveScene.target?.destroy();waveScene.target=desc.device.createTexture({size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});}
        return waveScene.target;
      };
    });
    const main=await readFile(new URL('../js/main.js',import.meta.url),'utf8'),marker='  function frame(now) {';
    assert.ok(main.includes(marker));
    const cameraMarker='  function updateCamera(dt) {',frameMarker='    device.queue.writeBuffer(frameUBO, 0, f);';
    for(const m of[cameraMarker,frameMarker])assert.ok(main.includes(m),'fixture marker '+m);
    await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:main.replace('createMarineLife({','createMarineLife({random:()=>.4,')
      .replace(cameraMarker,cameraMarker+'\n    if(waveScene.freezeCamera)return;')
      .replace(frameMarker,'    if(waveScene.freezeCamera)f[70]=waveScene.frozenFrame??(waveScene.frozenFrame=f[70]);\n'+frameMarker)
      .replace(marker,'  Object.assign(window.waveScene,{surfaceWaves,marineLife,device});\n'+marker)}));
    await page.goto(origin+'/?view=ship&whale=breach&marineView=1&follower=0&boatSpeed=0&windSpeed=2&swellHs=.05&sunElev=15&sunAzim=280&clouds=.2&w=640&h=480&ui=0');
    await page.waitForFunction(()=>waveScene.callback&&waveScene.device||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
    assert.equal(await page.locator('#err').textContent(),'');
    const result=await page.evaluate(async()=>{
      const {device,marineLife,surfaceWaves}=waveScene;let now=performance.now();
      const frame=async dt=>{const cb=waveScene.callback;waveScene.callback=null;cb(now+=dt*1000);await device.queue.onSubmittedWorkDone();};
      const read=async()=>{const tex=waveScene.target,row=Math.ceil(tex.width*4/256)*256,b=device.createBuffer({size:row*tex.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=device.createCommandEncoder();
        e.copyTextureToBuffer({texture:tex},{buffer:b,bytesPerRow:row},[tex.width,tex.height]);device.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const data=new Uint8Array(b.getMappedRange()).slice();b.unmap();b.destroy();return data;};
      for(let i=0;i<89;i++)await frame(.1);
      // The real animal lifecycle emits contacts; no manual impulse injection.
      const accepted=surfaceWaves.stats.accepted,age=marineLife.state.age;
      // Remove actor/effects without resetting the independent water field.
      waveScene.freezeCamera=true;marineLife.state.clear();await frame(0);const control=await read(),retained=surfaceWaves.stats.active;
      await frame(0);const withWaves=await read();
      // Same simulation instant, camera and scene. Only shared surface sampling
      // is disabled, so different pixels establish actual production coupling.
      const update=surfaceWaves.update;surfaceWaves.update=function(...args){update.apply(this,args);device.queue.writeBuffer(surfaceWaves.uniform,60,new Float32Array([0]));};
      await frame(0);const withoutWaves=await read();let changed=0,maxDifference=0,controlChanged=0;
      for(let i=0;i<withWaves.length;i+=4){let difference=0,noise=0;for(let c=0;c<3;c++){difference+=Math.abs(withWaves[i+c]-withoutWaves[i+c]);noise+=Math.abs(withWaves[i+c]-control[i+c]);}if(difference>6)changed++;if(noise>6)controlChanged++;maxDifference=Math.max(maxDifference,difference);}
      surfaceWaves.update=update;surfaceWaves.reset();await frame(0);const resetActive=surfaceWaves.stats.active;
      return{errors:waveScene.errors,accepted,age,retained,changed,controlChanged,maxDifference,resetActive};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);
    assert.ok(result.age>8.8&&result.age<9);assert.ok(result.accepted>=3,'real emergence and reentry contacts reach the field');
    assert.equal(result.retained,true,'ending the encounter cannot erase outgoing waves');
    assert.ok(result.changed>20&&result.maxDifference>10,'propagated water affects rendered pixels after the animal and splash disappear');
    assert.ok(result.changed>result.controlChanged*4,'shared-wave pixel changes dominate same-scene temporal noise');
    assert.equal(result.resetActive,false,'sea reset clears shared disturbance visibility');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
