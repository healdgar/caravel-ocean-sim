// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

// The cull lists each tree in view once on its species' one list; what a listed tree draws is its own continuum's
// choice (forestClusterSelect), so neither the rendered resolution nor the scene's pixel error moves a tree off the
// list, and no tree, however far, is handed to another surface.
test('forest compute lists every tree in view once, however far, and resets its counts',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-gpu');
    const result=await page.evaluate(async()=>{
      const {FOREST_CULL_WGSL}=await import('/js/forest-scenery.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const frameData=new Float32Array(96);frameData[0]=1/.6;frameData[5]=1/.45;frameData[11]=-1;frameData[14]=.1;
      frameData.set([.6,0,0],20);frameData.set([0,.45,0],24);frameData.set([0,0,-1],28);frameData.set([1920,1080,1/1920,1/1080],36);
      // In front near, in front 30 km off, behind, and off to the side.
      const frame=make(frameData,B.UNIFORM),roots=make(new Float32Array([[0,0,-20],[0,0,-30000],[0,0,20],[1000,0,-20]].flatMap(p=>[...p,1,0,1,1,1,0,0,0,0])),B.STORAGE);
      const meta=new ArrayBuffer(32),f=new Float32Array(meta),u=new Uint32Array(meta);f.set([0,1,0,2]);u.set([0,4,0,0],4);
      const prototypes=make(new Uint8Array(meta),B.STORAGE),visible=make(new Uint32Array(4),B.STORAGE|B.COPY_SRC),visibleCounts=make(new Uint32Array([999]),B.STORAGE|B.COPY_SRC);
      // The roots in use as a float and, in the last word, exactly.
      const parameterData=new Float32Array([4,1,3,0]);new Uint32Array(parameterData.buffer)[3]=4;const parameters=make(parameterData,B.UNIFORM);
      const module=device.createShaderModule({code:FOREST_CULL_WGSL});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=entryPoint=>device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
      const reset=await pipeline('forestReset'),cull=await pipeline('forestCull');
      const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:visibleCounts}},{binding:5,resource:{buffer:parameters}}]});
      const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[...[frame,roots,prototypes,visible,visibleCounts,parameters].map((buffer,binding)=>({binding,resource:{buffer}}))]});
      const read=device.createBuffer({size:20,usage:B.COPY_DST|B.MAP_READ});
      async function run(height,pixelError=3,capacity=4){
        frameData[37]=height;parameterData[2]=pixelError;u[5]=capacity;
        device.queue.writeBuffer(frame,0,frameData);device.queue.writeBuffer(parameters,0,parameterData);device.queue.writeBuffer(prototypes,0,new Uint8Array(meta));
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(reset);pass.setBindGroup(0,resetGroup);pass.dispatchWorkgroups(1);pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(1);pass.end();
        enc.copyBufferToBuffer(visibleCounts,0,read,0,4);enc.copyBufferToBuffer(visible,0,read,4,16);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();
        return {count:data[0],listed:data.slice(1,1+Math.min(data[0],capacity)).sort()};
      }
      const normal=await run(1080),repeat=await run(1080),high=await run(2160),coarse=await run(1080,12);
      const full=await run(1080,3,1);
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,normal,repeat,high,coarse,full};
    });
    assert.deepEqual(result.errors,[]);
    for(const name of ['normal','repeat','high','coarse'])assert.deepEqual(result[name],{count:2,listed:[0,1]},name+': both trees in view, once each, whatever the resolution or pixel error');
    assert.equal(result.full.count,2);assert.equal(result.full.listed.length,1,'a list never writes past its species\' stretch of the roots');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('native surface arrays preserve source size, linear pigment and fractional leaf coverage through GPU minification',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-surfaces',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-surfaces');
    const result=await page.evaluate(async()=>{
      const {createForestLeafSurfaces}=await import('/js/forest-scenery.js'),device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[],uploads=[],created=[],write= device.queue.copyExternalImageToTexture.bind(device.queue),create=device.createTexture.bind(device);
      device.onuncapturederror=e=>errors.push(e.error.message);
      device.createTexture=description=>{
        created.push({label:description.label,size:description.size});
        return create(description.label.startsWith('forest immutable')?{...description,usage:description.usage|GPUTextureUsage.COPY_SRC}:description);
      };
      device.queue.copyExternalImageToTexture=(source,target,size)=>{uploads.push({label:target.texture.label,origin:target.origin,size});return write(source,target,size);};
      const textures={};
      async function png(name,width,height,colour,checker=false){
        const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d'),image=context.createImageData(width,height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const a=checker&&(x+y)%2?0:255;image.data.set(a?[...colour,a]:[0,255,255,0],(y*width+x)*4);
        }
        context.putImageData(image,0,0);const raw=await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer();textures[name]=raw;
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
        return{file:name,bytes:raw.byteLength,sha256,encoding:name.endsWith('albedo.png')?'srgb':'linear'};
      }
      const leaf={name:'foliage_0',albedo:await png('leaf-oak-0-albedo.png',4,4,[128,64,32],true),
        normal:await png('leaf-oak-0-normal.png',4,4,[128,128,255]),roughness:.7,underside:.3,transmission:.13,opacityThreshold:.35,undersideReference:[.62,.7,.58]};
      const bark={name:'bark',albedo:await png('oak-bark-albedo.png',8,4,[32,64,128]),
        normal:await png('oak-bark-normal.png',8,4,[128,128,255]),roughnessMap:await png('oak-bark-roughness.png',8,4,[64,64,64]),
        roughness:.9,underside:0,transmission:0,opacityThreshold:0,undersideReference:[0,0,0],wrap:'repeat'};
      const pack={manifest:{prototypes:[{nativeMaterials:[leaf,bark]}]},textures},before=JSON.stringify(pack.manifest);
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return module;};
      const surfaces=await createForestLeafSurfaces({device,shader,pack});
      function half(bits){const s=bits&32768?-1:1,e=(bits>>10)&31,f=bits&1023;return e?s*Math.pow(2,e-15)*(1+f/1024):s*Math.pow(2,-14)*(f/1024);}
      async function lastPixel(texture,level){
        const read=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture,mipLevel:level},{buffer:read,bytesPerRow:256},[1,1,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const result=Array.from(new Uint16Array(read.getMappedRange(),0,4),half);read.unmap();read.destroy();return result;
      }
      const rows=[];for(const family of surfaces.families)rows.push({width:family.width,height:family.height,layers:family.rows.length,
        pigment:await lastPixel(family.albedo,family.levels-1),normal:await lastPixel(family.normal,family.levels-1)});
      const metadata=Array.from(surfaces.optics);await device.queue.onSubmittedWorkDone();surfaces.destroy();device.destroy();
      return{errors,rows,metadata,uploads,created,unchanged:before===JSON.stringify(pack.manifest)};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.unchanged,true);
    assert.deepEqual(result.rows.map(r=>[r.width,r.height,r.layers]),[[4,4,1],[8,4,1]],'native size families avoid upscaling every leaf to bark resolution');
    const linear=byte=>{const c=byte/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);};
    const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.001,`${message}: ${actual} versus ${expected}`);
    for(let c=0;c<3;c++)close(result.rows[0].pigment[c],.5*linear([128,64,32][c]),'transparent pixels do not bleed colour into foliage');
    close(result.rows[0].pigment[3],.5,'unresolved leaves retain integrated area instead of disappearing at an alpha threshold');
    close(result.rows[0].normal[3],.5*.7,'native leaf roughness remains scalar');
    for(let c=0;c<3;c++)close(result.rows[1].pigment[c],linear([32,64,128][c]),'native bark pigment survives minification');
    close(result.rows[1].normal[3],64/255,'native roughness map overrides its scalar fallback');
    assert.equal(result.uploads.length,5,'each actual map uploads once');
    assert.deepEqual(result.metadata.slice(8,12),[0,0,0,0]);assert.deepEqual(result.metadata.slice(20,24),[1,0,1,0]);
    assert.equal(result.created.filter(t=>t.label.startsWith('forest immutable')).length,4);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
