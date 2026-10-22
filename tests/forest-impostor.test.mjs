// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {validateForestImpostors,loadForestImpostors,FOREST_IMPOSTOR_WGSL} from '../js/forest-impostor.js';

function atlasFixture(){
  const hash='0'.repeat(64),receipt=(file,bytes=4)=>({file,bytes,sha256:hash});
  const maps=[receipt('leaf-oak-0-albedo.png'),receipt('leaf-oak-0-normal.png')];
  const prototype={id:0,species:'oak',centre:[0,0,0],radius:1,wood:{firstIndex:0,indexCount:3},leaf:{firstIndex:3,indexCount:3},
    nativeMaterials:[{name:'foliage_0',index:0,albedo:maps[0],normal:maps[1],roughness:.7,transmission:.13}]};
  const files=Object.fromEntries(['vertices.bin','indices.bin','roots.bin',...maps.map(m=>m.file)].map(file=>[file,receipt(file)]));
  const views=[];
  for(let row=0;row<16;row++)for(let column=0;column<16;column++){
    const u=2*(column+.5)/16-1,v=2*(row+.5)/16-1;let x=u,y=1-Math.abs(u)-Math.abs(v),z=v;
    if(y<0){x=(1-Math.abs(v))*Math.sign(u);z=(1-Math.abs(u))*Math.sign(v);}
    const length=Math.hypot(x,y,z),direction=[x/length,y/length,z/length];
    const reference=Math.abs(direction[1])>.999?[0,0,1]:[0,1,0],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const first=cross(reference,direction),right=first.map(n=>n/Math.hypot(...first)),up=cross(direction,right);
    views.push({index:views.length,row,column,u,v,direction,right,up});
  }
  const output=file=>({...receipt(file,1024*1024*8),gzip:{...receipt(file+'.gz'),uncompressedSHA256:hash}});
  const forest={files,prototypes:[prototype]},manifest={format:'waterworld.native-impostors',version:1,complete:true,units:'metres',upAxis:'Y',
    layout:{grid:[16,16],tilePixels:64,atlasPixels:[1024,1024],views},source:{files},prototypes:[{...prototype,projection:{extent:1.05},
      detailedGeometry:{wood:prototype.wood,leaf:prototype.leaf},outputs:{albedo:output('prototype-0-oak/albedo.rgba16f.bin'),normalDepth:output('prototype-0-oak/normal-depth.rgba16f.bin')}}]};
  return{forest,manifest};
}

test('native atlas validation binds exact geometry, materials, cameras and depth data to its specimen',()=>{
  const {forest,manifest}=atlasFixture();assert.equal(validateForestImpostors(manifest,forest),manifest);
  assert.ok(manifest.layout.views.some(v=>v.direction[1]<0),'boat-level views have genuine lower-hemisphere source frames');
  for(const mutate of [m=>m.complete=false,m=>m.layout.views[0].right[0]+=1,m=>m.source.files['vertices.bin']={bytes:4,sha256:'1'.repeat(64)},
    m=>m.prototypes[0].centre[0]=.1,m=>m.prototypes[0].outputs.albedo.gzip.file='../escape',m=>m.prototypes[0].outputs.normalDepth.bytes=4]){
    const f=atlasFixture(),document=structuredClone(f.manifest);mutate(document);assert.throws(()=>validateForestImpostors(document,f.forest));
  }
  assert.match(FOREST_IMPOSTOR_WGSL,/@builtin\(frag_depth\)/);
  assert.match(FOREST_IMPOSTOR_WGSL,/forestAtlasFrame/);assert.match(FOREST_IMPOSTOR_WGSL,/forestAtlasRay/);
  assert.doesNotMatch(FOREST_IMPOSTOR_WGSL,/leafSpray|tree-foliage|discard/);
});

test('atlas transport verifies compressed and decoded bytes without a global fetch shim',async()=>{
  const {forest,manifest}=atlasFixture(),responses={},assets={'manifest.json':'manifest.json'},hash=raw=>createHash('sha256').update(raw).digest('hex');
  for(const receipt of Object.values(manifest.prototypes[0].outputs)){
    const raw=new Uint8Array(receipt.bytes),encoded=gzipSync(raw);receipt.sha256=hash(raw);receipt.gzip={file:receipt.file+'.gz',bytes:encoded.byteLength,sha256:hash(encoded),uncompressedSHA256:receipt.sha256};
    assets[receipt.gzip.file]=receipt.gzip.file;responses[receipt.gzip.file]=encoded;
  }
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(Uint8Array.from(responses[name]));
  forest.impostors={file:'impostors/manifest.json',bytes:1,sha256:'0'.repeat(64)};
  await assert.rejects(loadForestImpostors({forest,fetchAsset,assets}),/manifest digest/);
  delete forest.impostors;
  const loaded=await loadForestImpostors({forest,fetchAsset,assets});assert.equal(loaded.streams[0].albedo.byteLength,1024*1024*8);
  const receipt=manifest.prototypes[0].outputs.albedo,original=Uint8Array.from(responses[receipt.gzip.file]);responses[receipt.gzip.file][8]^=1;
  await assert.rejects(loadForestImpostors({forest,fetchAsset,assets}),/gzip digest/);
  responses[receipt.gzip.file]=original;receipt.sha256='1'.repeat(64);receipt.gzip.uncompressedSHA256=receipt.sha256;
  await assert.rejects(loadForestImpostors({forest,fetchAsset,assets}),/decoded digest/);
});

test('actual GPU atlas shader reconstructs front depth rather than writing the billboard plane',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-depth',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-depth');
    const fixture=atlasFixture(),result=await page.evaluate(async({forest,manifest})=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{FOREST_VERTEX_WGSL}=await import('/js/forest-scenery.js'),{createForestImpostorResources}=await import('/js/forest-impostor.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async(code,label)=>{const m=device.createShaderModule({code,label});errors.push(...(await m.getCompilationInfo()).messages.filter(e=>e.type==='error').map(e=>e.message));return m;};
      const half=value=>{const f=new Float32Array([value]),bits=new Uint32Array(f.buffer)[0],sign=(bits>>>16)&32768,e=((bits>>>23)&255)-112,m=bits&8388607;
        if(e<=0)return sign|((m|8388608)>>(14-e));return sign|(e<<10)|((m+4096)>>13);};
      const pigment=new Uint16Array(1024*1024*4),surface=new Uint16Array(pigment.length);
      for(const view of manifest.layout.views){
        const c=[half(view.index/255),half(.25),half(.5),half(1)],n=[...view.direction.map(half),half(.25)];
        for(let y=0;y<64;y++)for(let x=0;x<64;x++){
          const offset=((view.row*64+y)*1024+view.column*64+x)*4;for(let k=0;k<4;k++){pigment[offset+k]=c[k];surface[offset+k]=n[k];}
        }
      }
      const atlas=await createForestImpostorResources({device,shader,forest,pack:{manifest,streams:[{albedo:pigment.buffer,normalDepth:surface.buffer}]}});
      const code=FRAME_WGSL+'\n@group(0)@binding(0)var<uniform>F:Frame;\nfn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(albedo,1);}\n'+FOREST_VERTEX_WGSL;
      const module=await shader(code,'actual forest impostor depth witness'),pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'forestImpostorVS'},fragment:{module,entryPoint:'forestImpostorFS',targets:[{format:'rgba16float'}]},
        primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'}});
      const B=GPUBufferUsage,T=GPUTextureUsage,buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const selected=manifest.layout.views[119],d=selected.direction,r=selected.right,u=selected.up,frame=new Float32Array(96);
      for(let k=0;k<3;k++){frame[k*4]=r[k]/.5;frame[k*4+1]=u[k]/.5;frame[k*4+3]=-d[k];}frame[14]=.1;
      frame.set(d.map(v=>v*10),16);frame.set(r.map(v=>v*.5),20);frame.set(u.map(v=>v*.5),24);frame.set(d.map(v=>-v),28);frame.set([64,64,1/64,1/64],36);
      const frameBuffer=buffer(frame,B.UNIFORM),roots=buffer(new Float32Array([0,0,0,1,0,1,1,1,0,0,0,0]),B.STORAGE),visible=buffer(new Uint32Array([0]),B.STORAGE),bin=buffer(new Uint32Array([0,0,1,0]),B.UNIFORM);
      const g0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frameBuffer}}]}),g2=device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[roots,visible,bin].map((b,binding)=>({binding,resource:{buffer:b}}))});
      const colour=device.createTexture({size:[64,64],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[64,64],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const colourRead=device.createBuffer({size:512*64,usage:B.COPY_DST|B.MAP_READ}),depthRead=device.createBuffer({size:256*64,usage:B.COPY_DST|B.MAP_READ});
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:colour.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});
      pass.setPipeline(pipeline);pass.setBindGroup(0,g0);pass.setBindGroup(2,g2);pass.setBindGroup(3,atlas.bind(pipeline));pass.setIndexBuffer(atlas.indices,'uint32');pass.drawIndexed(6,1);pass.end();
      encoder.copyTextureToBuffer({texture:colour},{buffer:colourRead,bytesPerRow:512},[64,64,1]);encoder.copyTextureToBuffer({texture:depth,aspect:'depth-only'},{buffer:depthRead,bytesPerRow:256},[64,64,1]);device.queue.submit([encoder.finish()]);
      await Promise.all([colourRead.mapAsync(GPUMapMode.READ),depthRead.mapAsync(GPUMapMode.READ)]);
      const decode=bits=>{const e=(bits>>10)&31,m=bits&1023;return (bits&32768?-1:1)*(e?Math.pow(2,e-15)*(1+m/1024):Math.pow(2,-14)*m/1024);};
      const color=Array.from(new Uint16Array(colourRead.getMappedRange(),32*512+32*8,4),decode),frontDepth=new Float32Array(depthRead.getMappedRange())[32*64+32];
      colourRead.unmap();depthRead.unmap();
      // Actual production reprojection helper: the centre-plane sample is
      // covered, but its front-depth shift lands in a genuine transparent gap.
      // Retain source fractional coverage/depth; an initially empty ray stays
      // empty. This does not add geometry or union the three source silhouettes.
      pigment.fill(0);surface.fill(0);const coverage=.5,extent=manifest.prototypes[0].projection.extent;
      for(let y=24;y<40;y++)for(let x=24;x<40;x++){
        const offset=((selected.row*64+y)*1024+selected.column*64+x)*4;
        pigment.set([.2,.3,.1,coverage].map(half),offset);surface.set([...d.map(value=>value*coverage),.25*coverage].map(half),offset);
      }
      device.queue.writeTexture({texture:atlas.albedo},pigment,{bytesPerRow:8192},[1024,1024,1]);device.queue.writeTexture({texture:atlas.normalDepth},surface,{bytesPerRow:8192},[1024,1024,1]);
      const sourceOrigin=d.map((value,k)=>value*10-r[k]*8),sourceRay=d.map((value,k)=>(-value+r[k]*.8)/Math.hypot(1,.8));
      const vec=values=>'vec3f('+values.join(',')+')';
      const witnessModule=await shader(code+'\n@group(0)@binding(1)var<storage,read_write>witness:array<vec4f>;'+
        '@compute @workgroup_size(1)fn reprojectionWitness(){let origin='+vec(sourceOrigin)+';let ray='+vec(sourceRay)+';'+
        'let hit=forestAtlasRay(119u,0u,origin,ray,vec3f(0),vec3f(0));witness[0]=hit.pigment;witness[1]=vec4f(hit.normal,hit.distance);'+
        'let empty=forestAtlasRay(119u,0u,origin+'+vec(r.map(value=>value*extent*3))+',ray,vec3f(0),vec3f(0));witness[2]=empty.pigment;}','actual atlas disocclusion witness');
      const witnessPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:witnessModule,entryPoint:'reprojectionWitness'}}),witness=buffer(new Float32Array(12),B.STORAGE|B.COPY_SRC),witnessRead=device.createBuffer({size:48,usage:B.COPY_DST|B.MAP_READ});
      const witnessEncoder=device.createCommandEncoder(),witnessPass=witnessEncoder.beginComputePass();witnessPass.setPipeline(witnessPipeline);
      witnessPass.setBindGroup(0,device.createBindGroup({layout:witnessPipeline.getBindGroupLayout(0),entries:[{binding:1,resource:{buffer:witness}}]}));witnessPass.setBindGroup(3,atlas.bind(witnessPipeline));witnessPass.dispatchWorkgroups(1);witnessPass.end();
      witnessEncoder.copyBufferToBuffer(witness,0,witnessRead,0,48);device.queue.submit([witnessEncoder.finish()]);await witnessRead.mapAsync(GPUMapMode.READ);
      const fallback=Array.from(new Float32Array(witnessRead.getMappedRange()));witnessRead.unmap();await device.queue.onSubmittedWorkDone();atlas.destroy();device.destroy();
      return{errors,color,frontDepth,expectedDepth:.1/(10-extent*.5),fallback,expectedFallbackDistance:(10-extent*.5)*Math.hypot(1,.8)};
    },fixture);
    assert.deepEqual(result.errors,[]);assert.ok(Math.abs(result.frontDepth-result.expectedDepth)<.00002,JSON.stringify(result));
    assert.ok(result.frontDepth>.0104,'front surface must occlude a surface just in front of the billboard plane');
    assert.ok(Math.abs(result.color[0]-119/255)<.002);assert.ok(Math.abs(result.color[1]-.25)<.001);assert.ok(Math.abs(result.color[2]-.5)<.001);assert.equal(result.color[3],1);
    assert.ok(Math.abs(result.fallback[3]-.5)<.0001,'later depth disocclusion retains actual half-covered leaf');
    assert.ok(Math.abs(result.fallback[7]-result.expectedFallbackDistance)<.002,'fallback retains reconstructed source front depth');
    assert.deepEqual(result.fallback.slice(8),[0,0,0,0],'initially uncovered rays remain transparent');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
