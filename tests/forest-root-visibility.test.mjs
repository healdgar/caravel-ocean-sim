// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// No terrain masks the source roots: visibility must follow each instance's
// biological collar, including crossing triangles and nonzero world heights.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native wood, leaves and generated middle clip buried roots at the instance collar on the GPU',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest_root_visibility',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__forest_root_visibility');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js');
      const {createForestLeafSurfaces,FOREST_VERTEX_WGSL,FOREST_VERTEX_LAYOUT,FOREST_MIDDLE_VERTEX_LAYOUT}=await import('/js/forest-scenery.js');
      const {forestLightGPUBytes}=await import('/js/forest-light.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage,errors=[],buffers=[],textures=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const writes=new Map(),write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,...args)=>{writes.set(buffer,(writes.get(buffer)??0)+1);return write(buffer,...args);};
      const make=(data,usage,label)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);buffers.push(b);return b;};
      const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      const sourceTextures={};
      async function png(file,normal=false){
        const canvas=new OffscreenCanvas(4,4),context=canvas.getContext('2d'),image=context.createImageData(4,4);
        for(let i=0;i<16;i++)image.data.set(normal?[128,128,255,255]:[255,255,255,255],i*4);
        context.putImageData(image,0,0);const raw=await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer();sourceTextures[file]=raw;
        return {file,bytes:raw.byteLength,sha256:await digest(raw),width:4,height:4,encoding:normal?'linear':'srgb'};
      }
      const nativeMaterials=[];for(const [index,name]of ['bark','foliage'].entries())nativeMaterials.push({name,index,albedo:await png(name+'-albedo.png'),normal:await png(name+'-normal.png',true),roughness:.7,underside:0,transmission:0,opacityThreshold:.35,undersideReference:[0,0,0],wrap:'clamp'});
      const surfaces=await createForestLeafSurfaces({device,shader,pack:{manifest:{prototypes:[{nativeMaterials}]},textures:sourceTextures}});
      const module=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(albedo,1);}
`+FOREST_VERTEX_WGSL,'production forest collar visibility');
      const W=128,H=128,fd=new Float32Array(96),frame=make(fd,B.UNIFORM,'collar frame'),rootData=new Float32Array([7,10,2,1,0,1,1,1,0,0,-1,0]),roots=make(rootData,B.STORAGE,'collar instance'),visible=make(new Uint32Array([0]),B.STORAGE,'collar visible ID'),bin=make(new Uint32Array([0,0,2,0]),B.UNIFORM,'collar bin'),materials=make(surfaces.optics,B.STORAGE,'collar exact source optics');
      const layout0=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform'}}]}),layout1=device.createBindGroupLayout({entries:[]});
      const entries=[{binding:0,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:1,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform'}},
        {binding:5,visibility:S.FRAGMENT,sampler:{}},{binding:6,visibility:S.FRAGMENT,buffer:{type:'read-only-storage'}},{binding:13,visibility:S.FRAGMENT,sampler:{}},{binding:14,visibility:S.VERTEX,buffer:{type:'read-only-storage'}}];
      for(const binding of [3,4,7,8,9,10,11,12])entries.push({binding,visibility:S.FRAGMENT,texture:{viewDimension:'2d-array'}});
      const layout2=device.createBindGroupLayout({entries}),layout=device.createPipelineLayout({bindGroupLayouts:[layout0,layout1,layout2]});
      const group0=device.createBindGroup({layout:layout0,entries:[{binding:0,resource:{buffer:frame}}]}),group1=device.createBindGroup({layout:layout1,entries:[]}),sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'});
      const canopyLight=make(forestLightGPUBytes(),B.STORAGE,'collar neutral source canopy light');
      const bindings=[roots,visible,bin].map((buffer,binding)=>({binding,resource:{buffer}}));bindings.push({binding:5,resource:sampler},{binding:6,resource:{buffer:materials}},{binding:13,resource:sampler},{binding:14,resource:{buffer:canopyLight}});
      for(let family=0;family<4;family++){const first=family?5+family*2:3,f=surfaces.families[0];bindings.push({binding:first,resource:f.albedo.createView({dimension:'2d-array'})},{binding:first+1,resource:f.normal.createView({dimension:'2d-array'})});}
      const group2=device.createBindGroup({layout:layout2,entries:bindings});
      const fixtures=[];
      for(const [name,kind,material,middle]of [['wood',3,0,false],['leaf',4,1,false],['middle-wood',3,0,true],['middle-leaf',4,1,true]]){
        const rows=[];
        // Separate buried/above cards and one straddling Y0. Each card consists
        // of two triangles, preserving interpolation across the collar plane.
        for(const [x0,x1,y0,y1]of [[-.9,-.4,-.85,-.35],[.4,.9,.35,.85],[-.25,.25,-.65,.65]]){
          const corners=[[x0,y0,0,1],[x1,y0,1,1],[x1,y1,1,0],[x0,y1,0,0]];
          for(const id of [0,1,2,0,2,3]){const [x,y,u,v]=corners[id];rows.push(x,y,0,0,0,1,kind,.72,u,v,1,1,1,...(middle?[]:[material]));}
        }
        const vertices=make(new Float32Array(rows),B.VERTEX,'immutable collar '+name),pipeline=await device.createRenderPipelineAsync({label:'collar '+name,layout,vertex:{module,entryPoint:middle?'forestMiddleVS':'forestCanopyVS',buffers:[middle?FOREST_MIDDLE_VERTEX_LAYOUT:FOREST_VERTEX_LAYOUT]},fragment:{module,entryPoint:middle?'forestMiddleFS':name==='leaf'?'forestNativeLeafFS':'forestNativeOpaqueFS',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4,alphaToCoverageEnabled:false}});
        fixtures.push({name,vertices,pipeline});
      }
      const resolve=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),msaa=device.createTexture({size:[W,H],format:'rgba8unorm',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});textures.push(resolve,msaa,depth);
      const read=device.createBuffer({size:W*H*4,usage:B.COPY_DST|B.MAP_READ});buffers.push(read);
      const regions={buried:[-.82,-.48,-.77,-.43],above:[.48,.82,.43,.77],crossingBuried:[-.18,.18,-.55,-.12],crossingAbove:[-.18,.18,.12,.55],empty:[-.82,-.48,.43,.77]},results=[];
      for(const fixture of fixtures)for(const collar of [10,-10])for(const scale of [1,1.5]){
        fd.fill(0);fd[0]=fd[5]=1/scale;fd[10]=fd[15]=1;fd.set([7,collar,1.5,0],16);fd.set([0,0,1,1],32);fd.set([W,H,1/W,1/H],36);rootData[1]=collar;rootData[3]=scale;device.queue.writeBuffer(frame,0,fd);device.queue.writeBuffer(roots,0,rootData);
        const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:msaa.createView(),resolveTarget:resolve.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:0}});
        pass.setPipeline(fixture.pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.setBindGroup(2,group2);pass.setVertexBuffer(0,fixture.vertices);pass.draw(18);pass.end();encoder.copyTextureToBuffer({texture:resolve},{buffer:read,bytesPerRow:W*4},[W,H]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(read.getMappedRange()),measured={};
        for(const [name,[x0,x1,y0,y1]]of Object.entries(regions)){let count=0,minR=255,maxR=0,minA=255,maxA=0;for(let y=Math.ceil((1-y1)*H/2);y<Math.floor((1-y0)*H/2);y++)for(let x=Math.ceil((x0+1)*W/2);x<Math.floor((x1+1)*W/2);x++){const at=(y*W+x)*4;count++;minR=Math.min(minR,pixels[at]);maxR=Math.max(maxR,pixels[at]);minA=Math.min(minA,pixels[at+3]);maxA=Math.max(maxA,pixels[at+3]);}measured[name]={count,minR,maxR,minA,maxA};}
        read.unmap();results.push({shader:fixture.name,collar,scale,regions:measured});
      }
      await device.queue.onSubmittedWorkDone();const immutable=fixtures.map(f=>({name:f.name,writes:writes.get(f.vertices)})),rootReadUsage=!!(roots.usage&(B.MAP_READ|B.COPY_SRC));surfaces.destroy();for(const b of buffers)b.destroy();for(const texture of textures)texture.destroy();device.destroy();return {errors,results,immutable,rootReadUsage,adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,adapter.info?.[k]??'']))};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.results.length,16);assert.equal(result.rootReadUsage,false);
    for(const fixture of result.immutable)assert.equal(fixture.writes,1,'source geometry uploads once: '+fixture.name);
    for(const row of result.results)for(const [name,region]of Object.entries(row.regions)){
      assert.ok(region.count>100,'nonempty interior raster witness');
      if(name==='above'||name==='crossingAbove'){assert.ok(region.minR>=254,'above-collar native geometry remains visible: '+JSON.stringify({row,name}));assert.equal(region.minA,255);}
      else{assert.equal(region.maxR,0,'buried/empty geometry cannot float over downhill abyss: '+JSON.stringify({row,name}));assert.equal(region.maxA,0);}
    }
    t.diagnostic(JSON.stringify({qualification:'Production native/middle shader collar visibility; no opaque ground or terrain occlusion, unchanged immutable source geometry',...result}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
