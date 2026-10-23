// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Tiny schema fixtures validate transport/addressing, not native appearance.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {validateForestMass,decodeForestMass,loadForestMass} from '../js/forest-mass.js';

const receipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
// Independent, bounded [0,1] fixture encoder and general IEEE binary16 reader.
const unitHalf=n=>{if(n===0)return 0;const e=Math.floor(Math.log2(n));if(e< -14)return Math.round(n*2**24);let m=Math.round((n/2**e-1)*1024),biased=e+15;if(m===1024){m=0;biased++;}return biased*1024+m;};
const readHalf=n=>{const sign=n&0x8000?-1:1,e=(n>>10)&31,m=n&1023;return sign*(e===31?(m?NaN:Infinity):e===0?m*2**-24:(1+m/1024)*2**(e-15));};
function fixture({neighbors=false}={}){
  const vertices=[],indices=[],chunks=[];
  for(const [id,centre]of [[0,[-4,10,-40]],[1,[4,10,-1000]]]){
    const firstIndex=indices.length;
    for(const [normal,corners]of [[[0,0,1],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],[[0,0,-1],[[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],[[1,0,0],[[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],[[-1,0,0],[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],[[0,1,0],[[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],[[0,-1,0],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]]]){
      const base=vertices.length/13;for(const corner of corners)vertices.push(...corner.map((v,k)=>v+centre[k]),...normal,4,.8,0,0,.08,.3,.1);indices.push(base,base+1,base+2,base,base+2,base+3);
    }
    chunks.push({id,nominalBoundsXZ:[centre[0]-2,centre[0]+2,centre[2]-2,centre[2]+2],low:centre.map(v=>v-1),high:centre.map(v=>v+1),centre,radius:2,lodErrorMetres:2.1,rootCount:1,firstIndex,indexCount:36});
  }
  const roots=new Float32Array([[-4,10,-40],[4,10,-1000],[0,10,-400],[0,10,20]].flatMap(p=>[...p,1,0,1,1,1,0,0,0,0]));
  const streams={'vertices.bin':new Float32Array(vertices).buffer,'indices.bin':new Uint32Array(indices).buffer,'root-chunks.bin':new Uint32Array([0,1,0xffffffff,0xffffffff]).buffer};
  if(neighbors)streams['root-neighbors.bin']=new Uint32Array([0,1,0xffffffff,0xffffffff,1,0xffffffff,0xffffffff,0xfffffffe,0xffffffff,0xffffffff,0xffffffff,0xffffffff,0,1,0,1]).buffer;
  const forest={manifest:{rootCount:4,files:{'vertices.bin':receipt(Buffer.from('original detailed native vertices')),'indices.bin':receipt(Buffer.from('original detailed native indices')),'roots.bin':receipt(new Uint8Array(roots.buffer))}},roots};
  const files={},encoded={};for(const [name,raw]of Object.entries(streams)){const bytes=new Uint8Array(raw),gzip=gzipSync(bytes);files[name]={...receipt(bytes),gzip:{file:name+'.gz',...receipt(gzip)}};encoded[name+'.gz']=gzip;}
  const manifest={format:'waterworld.native-forest-mass',version:1,units:'metres',upAxis:'Y',vertexStride:52,chunks,files,appearanceErrorSupported:false,geometryErrorSupported:false,
    source:{files:structuredClone(forest.manifest.files),nativeFieldManifest:receipt(Buffer.from('original native triangle MASK area and pigment field manifest')),method:{file:'scripts/prepare-forest-mass.py',...receipt(Buffer.from('field assembly source fixture'))},nativeFieldRecipe:{version:1,source:'Synthetic schema fixture only; no appearance claim'}}};
  const fetchAsset=async name=>new Response(name==='manifest.json'?JSON.stringify(manifest):encoded[name],{status:encoded[name]||name==='manifest.json'?200:404});
  const assets=Object.fromEntries(['manifest.json',...Object.keys(encoded)].map(name=>[name,name]));return {manifest,streams,forest,encoded,assets,fetchAsset};
}
function compactFixture(){
  const f=fixture(),source=new Float32Array(f.streams['vertices.bin'].slice(0)),bytes=new ArrayBuffer(source.length/13*24),view=new DataView(bytes);
  source.set([.2,.5,Math.sqrt(.71)],3); // Non-axis unit normal exercises snorm quantization.
  for(let i=0;i<source.length/13;i++){
    for(let k=0;k<3;k++){view.setFloat32(i*24+k*4,source[i*13+k],true);view.setInt8(i*24+12+k,Math.round(source[i*13+3+k]*127));view.setUint16(i*24+16+k*2,unitHalf(source[i*13+10+k]),true);}
    view.setInt8(i*24+15,0);view.setUint16(i*24+22,unitHalf(1),true);
  }
  f.manifest.version=2;f.manifest.vertexStride=24;f.streams['vertices.bin']=bytes;f.encoded['vertices.bin.gz']=gzipSync(new Uint8Array(bytes));
  f.manifest.files['vertices.bin']={...receipt(new Uint8Array(bytes)),gzip:{file:'vertices.bin.gz',...receipt(f.encoded['vertices.bin.gz'])}};return {...f,source};
}

test('native mass loader verifies original source identities and both transport hashes',async()=>{
  const f=fixture(),loaded=await loadForestMass({forest:f.forest,fetchAsset:f.fetchAsset,assets:f.assets});assert.equal(loaded.finiteValidated,true);assert.equal(loaded.rootChunks.length,4);assert.equal(loaded.indices.length,72);
  for(const name of ['vertices.bin','indices.bin','roots.bin']){
    const wrong=structuredClone(f.forest.manifest);wrong.files[name].sha256='f'.repeat(64);assert.throws(()=>validateForestMass(f.manifest,wrong),/source forest mismatch/);
  }
  for(const change of [m=>m.source.nativeFieldManifest.sha256='bad',m=>delete m.source.nativeFieldRecipe.version,m=>m.source.method.file='scripts/prepare-forest-canopy.py',m=>m.appearanceErrorSupported=true,m=>m.geometryErrorSupported=true,m=>m.chunks[0].lodErrorMetres=NaN,m=>m.chunks[0].lodErrorMetres=1e40,m=>m.chunks[0].radius=.1,m=>m.chunks[1].firstIndex=0]){
    const wrong=structuredClone(f.manifest);change(wrong);assert.throws(()=>validateForestMass(wrong,f.forest));
  }
  for(const kind of ['encoded','decoded']){
    const manifest=structuredClone(f.manifest),encoded={...f.encoded};
    if(kind==='encoded'){encoded['vertices.bin.gz']=Buffer.from(encoded['vertices.bin.gz']);encoded['vertices.bin.gz'][encoded['vertices.bin.gz'].length>>1]^=1;}
    else manifest.files['vertices.bin'].sha256='e'.repeat(64);
    await assert.rejects(()=>loadForestMass({forest:f.forest,assets:f.assets,fetchAsset:async name=>new Response(name==='manifest.json'?JSON.stringify(manifest):encoded[name])}),new RegExp(kind+' digest mismatch'));
  }
  const unsafe=structuredClone(f.manifest);unsafe.files['vertices.bin'].gzip.file='../vertices.bin.gz';assert.throws(()=>validateForestMass(unsafe,f.forest),/receipt/);
});

test('native mass rejects nonfinite geometry, invalid addresses and inconsistent original root ownership',async()=>{
  const f=fixture();assert.equal(decodeForestMass(f.manifest,f.streams,f.forest).finiteValidated,true);
  const mutate=(name,Type,change)=>{const streams={...f.streams,[name]:f.streams[name].slice(0)};change(new Type(streams[name]));return streams;};
  for(const change of [a=>a[0]=NaN,a=>a[5]=0,a=>a[6]=3,a=>a[7]=1.1,a=>a[10]=-1]){
    const streams=mutate('vertices.bin',Float32Array,change);assert.throws(()=>decodeForestMass(f.manifest,streams,f.forest),/vertex/);
  }
  assert.throws(()=>decodeForestMass(f.manifest,mutate('indices.bin',Uint32Array,a=>a[0]=48),f.forest),/index/);
  assert.throws(()=>decodeForestMass(f.manifest,mutate('root-chunks.bin',Uint32Array,a=>a[0]=2),f.forest),/owner/);
  assert.throws(()=>decodeForestMass(f.manifest,mutate('root-chunks.bin',Uint32Array,a=>{a[0]=1;a[1]=0;}),f.forest),/root position/);
  const boundaryRoots=f.forest.roots.slice();boundaryRoots[0]=f.manifest.chunks[0].nominalBoundsXZ[1];assert.throws(()=>decodeForestMass(f.manifest,f.streams,{...f.forest,roots:boundaryRoots}),/root position/);
  assert.throws(()=>decodeForestMass(f.manifest,mutate('root-chunks.bin',Uint32Array,a=>a[0]=0xffffffff),f.forest),/owner count/);
  const absent={...f.streams,'vertices.bin':f.streams['vertices.bin'].slice(4)};assert.throws(()=>decodeForestMass(f.manifest,absent,f.forest),/Incomplete/);
  // Correct SHA/gzip receipts cannot make NaN GPU input acceptable.
  const raw=mutate('vertices.bin',Float32Array,a=>a[0]=NaN)['vertices.bin'],encoded=gzipSync(new Uint8Array(raw)),manifest=structuredClone(f.manifest);
  manifest.files['vertices.bin']={...receipt(new Uint8Array(raw)),gzip:{file:'vertices.bin.gz',...receipt(encoded)}};
  await assert.rejects(()=>loadForestMass({forest:f.forest,assets:f.assets,fetchAsset:async name=>new Response(name==='manifest.json'?JSON.stringify(manifest):name==='vertices.bin.gz'?encoded:f.encoded[name])}),/vertex/);
});

test('native mass neighbor transport preserves four entries per original root and both sentinels',async()=>{
  const legacy=fixture();assert.equal(decodeForestMass(legacy.manifest,legacy.streams,legacy.forest).rootNeighbors,null,'absent optional stream retains the legacy owner contract');
  const f=fixture({neighbors:true}),loaded=await loadForestMass({forest:f.forest,fetchAsset:f.fetchAsset,assets:f.assets});
  assert.deepEqual(Array.from(loaded.rootNeighbors),Array.from(new Uint32Array(f.streams['root-neighbors.bin'])));assert.equal(loaded.rootNeighbors.length,f.forest.manifest.rootCount*4);
  for(const change of [m=>m.files['root-neighbors.bin'].bytes-=4,m=>m.files['root-neighbors.bin'].gzip.file='../root-neighbors.bin.gz']){
    const bad=structuredClone(f.manifest);change(bad);assert.throws(()=>validateForestMass(bad,f.forest),/neighbor receipt/);
  }
  const bad=f.streams['root-neighbors.bin'].slice(0);new Uint32Array(bad)[3]=2;
  assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'root-neighbors.bin':bad},f.forest),/neighbor outside chunk table/,'fourth slot is validated, not silently truncated');
  assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'root-neighbors.bin':bad.slice(4)},f.forest),/Incomplete/);
  for(const kind of ['encoded','decoded']){
    const manifest=structuredClone(f.manifest),encoded={...f.encoded};
    if(kind==='encoded'){encoded['root-neighbors.bin.gz']=Buffer.from(encoded['root-neighbors.bin.gz']);encoded['root-neighbors.bin.gz'][encoded['root-neighbors.bin.gz'].length>>1]^=1;}
    else manifest.files['root-neighbors.bin'].sha256='e'.repeat(64);
    await assert.rejects(()=>loadForestMass({forest:f.forest,assets:f.assets,fetchAsset:async name=>new Response(name==='manifest.json'?JSON.stringify(manifest):encoded[name])}),new RegExp(kind+' digest mismatch'));
  }
});

test('compact native mass preserves world float32 positions and validates packed normals and linear half colour',async()=>{
  const f=compactFixture(),decoded=decodeForestMass(f.manifest,f.streams,f.forest),loaded=await loadForestMass({forest:f.forest,fetchAsset:f.fetchAsset,assets:f.assets}),view=new DataView(f.streams['vertices.bin']);
  assert.ok(decoded.vertices instanceof Uint8Array);assert.equal(decoded.vertices.buffer,f.streams['vertices.bin'],'validation never expands packed geometry');assert.equal(decoded.vertices.byteLength,f.source.length/13*24);assert.deepEqual(loaded.vertices,decoded.vertices);
  assert.deepEqual(f.manifest.source.files,f.forest.manifest.files,'packing retains original native provenance');
  const original=new DataView(f.source.buffer);
  for(let i=0;i<f.source.length/13;i++){
    const normal=[0,1,2].map(k=>Math.max(-1,view.getInt8(i*24+12+k)/127)),length=Math.hypot(...normal);
    for(let k=0;k<3;k++){
      assert.equal(view.getUint32(i*24+k*4,true),original.getUint32((i*13+k)*4,true),'world positions retain every float32 bit');
      assert.ok(Math.abs(normal[k]/length-f.source[i*13+3+k])<=Math.sqrt(3)/127,'normalized snorm error stays within quantization envelope');
      assert.ok(Math.abs(readHalf(view.getUint16(i*24+16+k*2,true))-f.source[i*13+10+k])<=Math.max(2**-24,Math.abs(f.source[i*13+10+k])*2**-10),'linear RGB uses half precision, not normalized/sRGB bytes');
    }
  }
  for(const change of [m=>m.version=1,m=>m.vertexStride=52,m=>m.version=3]){const bad=structuredClone(f.manifest);change(bad);assert.throws(()=>validateForestMass(bad,f.forest),/Unsupported/);}
  for(const change of [v=>v.setFloat32(0,NaN,true),v=>{v.setInt8(12,0);v.setInt8(13,0);v.setInt8(14,0);},v=>{v.setInt8(12,127);v.setInt8(13,127);v.setInt8(14,0);},v=>v.setUint16(16,0x7e00,true),v=>v.setUint16(18,0x7c00,true),v=>v.setUint16(20,0xb800,true),v=>v.setUint16(22,0x7e00,true),v=>v.setUint16(22,0x3e00,true)]){
    const raw=f.streams['vertices.bin'].slice(0);change(new DataView(raw));assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'vertices.bin':raw},f.forest),/packed.*vertex/);
  }
  const negativeEndpoint=f.streams['vertices.bin'].slice(0),endpointView=new DataView(negativeEndpoint);endpointView.setInt8(12,-128);endpointView.setInt8(13,0);endpointView.setInt8(14,0);assert.equal(decodeForestMass(f.manifest,{...f.streams,'vertices.bin':negativeEndpoint},f.forest).finiteValidated,true,'snorm -128 decodes to -1, not below -1');
  const outside=f.streams['vertices.bin'].slice(0);new DataView(outside).setFloat32(0,f.manifest.chunks[0].high[0]+1,true);assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'vertices.bin':outside},f.forest),/outside chunk bound/);
  const invalidIndex=f.streams['indices.bin'].slice(0);new Uint32Array(invalidIndex)[0]=f.source.length/13;assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'indices.bin':invalidIndex},f.forest),/index outside geometry/);
  assert.throws(()=>decodeForestMass(f.manifest,{...f.streams,'vertices.bin':f.streams['vertices.bin'].slice(4)},f.forest),/Incomplete/);
  const raw=f.streams['vertices.bin'].slice(0);new DataView(raw).setUint16(16,0x7e00,true);const encoded=gzipSync(new Uint8Array(raw)),manifest=structuredClone(f.manifest);manifest.files['vertices.bin']={...receipt(new Uint8Array(raw)),gzip:{file:'vertices.bin.gz',...receipt(encoded)}};
  await assert.rejects(()=>loadForestMass({forest:f.forest,assets:f.assets,fetchAsset:async name=>new Response(name==='manifest.json'?JSON.stringify(manifest):name==='vertices.bin.gz'?encoded:f.encoded[name])}),/packed.*vertex/,'matching transport hashes do not authorize a half NaN');
});

test('compact native mass GPU vertex fetch decodes normalized snorm and linear half RGB',{timeout:120000},async()=>{
  const f=compactFixture(),packed=new Uint8Array(72),data=new DataView(packed.buffer),first=new Uint8Array(f.streams['vertices.bin'],0,24);
  for(const [i,position]of [[-1,-1,.5],[3,-1,.5],[-1,3,.5]].entries()){packed.set(first,i*24);for(let k=0;k<3;k++)data.setFloat32(i*24+k*4,position[k],true);}
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__mass_vertex_fetch',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__mass_vertex_fetch');
    const result=await page.evaluate(async bytes=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{TERRAIN}=await import('/js/wgsl/terrain.js'),{FOREST_MASS_VERTEX_LAYOUT,FOREST_MASS_VERTEX_WGSL}=await import('/js/forest-mass.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const begin=TERRAIN.indexOf('struct CanopyVertex'),end=TERRAIN.indexOf('@vertex fn bakedCanopyVS',begin);if(begin<0||end<=begin)throw Error('Production canopy varying structure missing');
      const module=device.createShaderModule({code:FRAME_WGSL+'@group(0)@binding(0)var<uniform>F:Frame;'+TERRAIN.slice(begin,end)+FOREST_MASS_VERTEX_WGSL+`
struct Witness {@location(0)normal:vec4f,@location(1)colour:vec4f};
@fragment fn witness(in:CanopyVertex)->Witness{return Witness(vec4f(in.normal,1),vec4f(in.colour,1));}`});
      const compilation=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(compilation.length)throw Error(compilation.map(m=>m.message).join('\n'));
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'forestMassVS',buffers:[FOREST_MASS_VERTEX_LAYOUT]},fragment:{module,entryPoint:'witness',targets:[{format:'rgba32float'},{format:'rgba32float'}]}});
      const vertices=device.createBuffer({size:bytes.length,usage:B.VERTEX|B.COPY_DST}),frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST}),fd=new Float32Array(96);fd[0]=fd[5]=fd[10]=fd[15]=1;device.queue.writeBuffer(vertices,0,new Uint8Array(bytes));device.queue.writeBuffer(frame,0,fd);
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]}),textures=[0,1].map(()=>device.createTexture({size:[1,1],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC})),read=device.createBuffer({size:512,usage:B.COPY_DST|B.MAP_READ});
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:textures.map(texture=>({view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}))});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,vertices);pass.draw(3);pass.end();for(let i=0;i<2;i++)encoder.copyTextureToBuffer({texture:textures[i]},{buffer:read,offset:i*256,bytesPerRow:256},[1,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const values=new Float32Array(read.getMappedRange()),normal=Array.from(values.subarray(0,4)),colour=Array.from(values.subarray(64,68));read.unmap();await device.queue.onSubmittedWorkDone();for(const resource of [vertices,frame,read,...textures])resource.destroy();device.destroy();return {errors,normal,colour,layout:FOREST_MASS_VERTEX_LAYOUT};
    },Array.from(packed));
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.layout,{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'snorm8x4'},{shaderLocation:6,offset:16,format:'float16x4'}]});
    const normal=[0,1,2].map(k=>Math.max(-1,data.getInt8(12+k)/127)),length=Math.hypot(...normal),colour=[0,1,2].map(k=>readHalf(data.getUint16(16+k*2,true)));
    for(let k=0;k<3;k++){assert.ok(Math.abs(result.normal[k]-normal[k]/length)<=1e-6,'production VS normalizes actual snorm fetch');assert.ok(Math.abs(result.colour[k]-colour[k])<=1e-7,'GPU decodes linear binary16 without sRGB/gamma conversion');}
    assert.equal(result.normal[3],1);assert.equal(result.colour[3],1);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('native mass GPU uses projected authored error and suppresses exclusively selected original owners',{timeout:120000},async t=>{
  const f=fixture(),server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__mass_gpu',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__mass_gpu');
    const result=await page.evaluate(async chunks=>{
      const {FOREST_MASS_CULL_WGSL}=await import('/js/forest-mass.js'),{FOREST_MASS_ROOT_CULL_WGSL,FOREST_MASS_NEIGHBOR_ROOT_CULL_WGSL,FOREST_MASS_MIDDLE_NEIGHBOR_ROOT_CULL_WGSL}=await import('/js/forest-scenery.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[],allocated=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async code=>{const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return module;};
      const writes=new Map(),write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,...args)=>{writes.set(buffer,(writes.get(buffer)??0)+1);return write(buffer,...args);};
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);allocated.push(b);return b;};
      const fd=new Float32Array(96),frame=make(fd,B.UNIFORM),metadata=new ArrayBuffer(chunks.length*64),mf=new Float32Array(metadata),mu=new Uint32Array(metadata);
      for(const p of chunks){mf.set([...p.centre,p.radius,...p.low,p.lodErrorMetres,...p.high,0],p.id*16);mu.set([p.firstIndex,p.indexCount,p.rootCount,0],p.id*16+12);}
      const blocks=make(new Uint8Array(metadata),B.STORAGE),commands=make(new Uint32Array(chunks.flatMap(p=>[p.indexCount,999,p.firstIndex,0,0])),B.STORAGE|B.INDIRECT|B.COPY_SRC),selected=make(new Uint32Array(chunks.length),B.STORAGE|B.COPY_SRC),pd=new Float32Array([chunks.length,3,0,0]),policy=make(pd,B.UNIFORM),residency=make(new Uint32Array([1,0,0,0]),B.UNIFORM);
      const module=await shader(FOREST_MASS_CULL_WGSL),pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'forestMassCull'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[frame,blocks,commands,selected,policy,residency].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const read=make(new Uint32Array(chunks.length*6),B.COPY_DST|B.MAP_READ);
      async function run({height=1080,tan=.5,x=0,mode=0,preview=false,resident=true}={}){
        fd.fill(0);fd[0]=1/(tan*16/9);fd[5]=1/tan;fd[11]=-1;fd[14]=.1;fd[16]=x;fd.set([tan*16/9,0,0],20);fd.set([0,tan,0],24);fd.set([0,0,-1],28);fd.set([height*16/9,height,9/(height*16),1/height],36);pd[2]=mode;pd[3]=preview?1:0;
        device.queue.writeBuffer(frame,0,fd);device.queue.writeBuffer(policy,0,pd);device.queue.writeBuffer(residency,0,new Uint32Array([resident?1:0,0,0,0]));
        const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,group);p.dispatchWorkgroups(1);p.end();e.copyBufferToBuffer(commands,0,read,0,chunks.length*20);e.copyBufferToBuffer(selected,0,read,chunks.length*20,chunks.length*4);device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);const data=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();return {options:{height,tan,x,mode,preview,resident},commands:data.slice(0,chunks.length*5),selected:data.slice(chunks.length*5)};
      }
      const cases={normal:await run(),repeat:await run(),high:await run({height:4320}),narrow:await run({tan:.1}),offaxis:await run({x:-700}),wide:await run({x:-700,tan:.75}),near:await run({mode:1}),nonresident:await run({resident:false}),nearBeforePreview:await run({mode:1}),preview:await run({resident:false,preview:true}),forced:await run({mode:2}),nearLast:await run({mode:1})};

      const rootData=new Float32Array([[-4,10,-40,0],[4,10,-1000,1],[0,10,-400,-1]].flatMap(([x,y,z,owner])=>[x,y,z,1,0,1,1,1,0,0,owner,0])),roots=make(rootData,B.STORAGE);
      const meta=new ArrayBuffer(80),f=new Float32Array(meta),u=new Uint32Array(meta);f.set([0,1,0,2]);u.set([0,3,6,32],4);u.set([0,3,0,0,3,3,0,0,6,3,0,0],8);
      const prototype=make(new Uint8Array(meta),B.STORAGE),visible=make(new Uint32Array(9).fill(0xffffffff),B.STORAGE|B.COPY_SRC),draws=make(new Uint32Array([3,999,0,0,0,3,999,3,0,0,3,999,6,0,0,6,999,0,0,0]),B.STORAGE|B.INDIRECT|B.COPY_SRC),previous=make(new Uint32Array(3),B.STORAGE),parametersData=new Float32Array([3,1,3,1]),parameters=make(parametersData,B.UNIFORM);
      const rootModule=await shader(FOREST_MASS_ROOT_CULL_WGSL),reset=await device.createComputePipelineAsync({layout:'auto',compute:{module:rootModule,entryPoint:'forestReset'}}),cull=await device.createComputePipelineAsync({layout:'auto',compute:{module:rootModule,entryPoint:'forestCull'}});
      const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:draws}},{binding:6,resource:{buffer:parameters}}]}),rootGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frame,roots,prototype,visible,draws,previous,parameters,residency,selected].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const rootRead=make(new Uint32Array(29),B.COPY_DST|B.MAP_READ),ownership=[];
      for(const massMode of [0,2,1])for(const rootMode of [1,2,0]){
        const mass=await run({mode:massMode});parametersData[3]=rootMode;device.queue.writeBuffer(parameters,0,parametersData);
        const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(reset);p.setBindGroup(0,resetGroup);p.dispatchWorkgroups(1);p.setPipeline(cull);p.setBindGroup(0,rootGroup);p.dispatchWorkgroups(1);p.end();e.copyBufferToBuffer(draws,0,rootRead,0,80);e.copyBufferToBuffer(visible,0,rootRead,80,36);device.queue.submit([e.finish()]);await rootRead.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(rootRead.getMappedRange()));rootRead.unmap();
        const counts=[values[1],values[11],values[16]],ids=[];for(let tier=0;tier<3;tier++)ids.push(...values.slice(20+tier*3,20+tier*3+counts[tier]));ownership.push({massMode,rootMode,selected:mass.selected,counts,ids:ids.sort(),leafCount:values[6]});
      }
      const immutable={rootWrites:writes.get(roots),blockWrites:writes.get(blocks),prototypeWrites:writes.get(prototype),rootReadUsage:!!(roots.usage&(B.MAP_READ|B.COPY_SRC))};

      // Isolate neighbor eligibility with GPU-authored block outputs. The real
      // mass selector/projection is exercised above; no CPU visibility upload.
      const P=0xffffffff,M=0xfffffffe,N=8,owners=[0,1,0,0,0,-1,1,0];
      const neighborWords=new Uint32Array([0,1,P,P,0,1,P,P,P,P,P,P,0,P,P,M,P,P,P,1,0,1,P,P,1,P,P,P,0,1,0,1]);
      const neighborRoots=make(new Float32Array(owners.flatMap((owner,id)=>[id*2-7,10,-400,1,0,1,1,1,0,0,owner,0])),B.STORAGE),neighbors=make(neighborWords,B.STORAGE);
      const stateInput=make(new Uint32Array(4),B.UNIFORM),stateShader=await shader('@group(0)@binding(0)var<uniform>selectionState:vec4u;@group(0)@binding(1)var<storage,read_write>selectionOutput:array<u32>;@compute @workgroup_size(1)fn selectBlocks(){selectionOutput[0]=selectionState.x;selectionOutput[1]=selectionState.y;}');
      const statePipe=await device.createComputePipelineAsync({layout:'auto',compute:{module:stateShader,entryPoint:'selectBlocks'}}),stateGroup=device.createBindGroup({layout:statePipe.getBindGroupLayout(0),entries:[stateInput,selected].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const neighborCases=[],neighborImmutable=[];
      await run({mode:1}); // Restore the normal in-frustum camera.
      for(const [variant,source,flags]of [['legacy',FOREST_MASS_NEIGHBOR_ROOT_CULL_WGSL,6],['middle',FOREST_MASS_MIDDLE_NEIGHBOR_ROOT_CULL_WGSL,14]]){
        const data=new ArrayBuffer(80),af=new Float32Array(data),au=new Uint32Array(data);af.set([0,1,0,2]);au.set([0,N,flags,32],4);au.set([0,3,0,0,3,3,0,0,6,3,0,0],8);af[18]=.01;
        const proto=make(new Uint8Array(data),B.STORAGE),ids=make(new Uint32Array(N*3).fill(P),B.STORAGE|B.COPY_SRC),indirect=make(new Uint32Array([3,999,0,0,0,3,999,3,0,0,3,999,6,0,0,6,999,0,0,0]),B.STORAGE|B.INDIRECT|B.COPY_SRC),history=make(new Uint32Array(N),B.STORAGE),paramsData=new Float32Array([N,1,3,1]),params=make(paramsData,B.UNIFORM);
        const sm=await shader(source),resetNeighbors=await device.createComputePipelineAsync({layout:'auto',compute:{module:sm,entryPoint:'forestReset'}}),cullNeighbors=await device.createComputePipelineAsync({layout:'auto',compute:{module:sm,entryPoint:'forestCull'}});
        const rg=device.createBindGroup({layout:resetNeighbors.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:indirect}},{binding:6,resource:{buffer:params}}]}),cg=device.createBindGroup({layout:cullNeighbors.getBindGroupLayout(0),entries:[frame,neighborRoots,proto,ids,indirect,history,params,residency,selected,neighbors].map((buffer,binding)=>({binding,resource:{buffer}}))});
        const output=make(new Uint32Array(20+N*3+2),B.COPY_DST|B.MAP_READ);
        for(const rootMode of [1,2,0])for(const selection of [[0,0],[1,0],[0,1],[1,1],[1,0],[0,0]]){
          device.queue.writeBuffer(stateInput,0,new Uint32Array([...selection,0,0]));paramsData[3]=rootMode;device.queue.writeBuffer(params,0,paramsData);
          const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(statePipe);p.setBindGroup(0,stateGroup);p.dispatchWorkgroups(1);p.setPipeline(resetNeighbors);p.setBindGroup(0,rg);p.dispatchWorkgroups(1);p.setPipeline(cullNeighbors);p.setBindGroup(0,cg);p.dispatchWorkgroups(1);p.end();
          e.copyBufferToBuffer(indirect,0,output,0,80);e.copyBufferToBuffer(ids,0,output,80,N*12);e.copyBufferToBuffer(selected,0,output,80+N*12,8);device.queue.submit([e.finish()]);await output.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(output.getMappedRange()));output.unmap();
          const counts=[values[1],values[11],values[16]],visibleIDs=[];for(let tier=0;tier<3;tier++)visibleIDs.push(...values.slice(20+tier*N,20+tier*N+counts[tier]));
          neighborCases.push({variant,rootMode,selection,selected:values.slice(20+N*3),counts,leafCount:values[6],ids:visibleIDs.sort((a,b)=>a-b),commands:values.slice(0,20)});
        }
        neighborImmutable.push({variant,prototypeWrites:writes.get(proto),rootWrites:writes.get(neighborRoots),neighborWrites:writes.get(neighbors),rootReadUsage:!!(neighborRoots.usage&(B.MAP_READ|B.COPY_SRC)),neighborReadUsage:!!(neighbors.usage&(B.MAP_READ|B.COPY_SRC))});
      }
      await device.queue.onSubmittedWorkDone();for(const b of allocated)b.destroy();device.destroy();return {errors,cases,ownership,immutable,neighborCases,neighborImmutable};
    },f.manifest.chunks);
    assert.deepEqual(result.errors,[]);
    for(const name of ['normal','repeat','wide','nonresident'])assert.deepEqual(result.cases[name].selected,[0,1],name+' applies the authored3px projection');
    for(const name of ['high','narrow','offaxis','near','nearBeforePreview','nearLast'])assert.deepEqual(result.cases[name].selected,[0,0],name+' retains detailed source');
    for(const name of ['preview','forced'])assert.deepEqual(result.cases[name].selected,[1,1],name+' is an explicit labelled bypass only');
    for(const row of Object.values(result.cases))for(const p of f.manifest.chunks)assert.deepEqual(row.commands.slice(p.id*5,p.id*5+5),[p.indexCount,row.selected[p.id],p.firstIndex,0,0],'indirect counts reset while immutable topology survives');
    for(const row of result.ownership){const expected=[0,1,2].filter(id=>id===2||!row.selected[id]);assert.deepEqual(row.ids,expected,'GPU suppression exclusive across every individual tier '+JSON.stringify(row));assert.equal(row.counts[0],row.leafCount);}
    assert.deepEqual(result.immutable,{rootWrites:1,blockWrites:1,prototypeWrites:1,rootReadUsage:false},'root/geometry metadata stays immutable and has no CPU readback path');
    const neighborExpected={'0,0':[0,1,2,3,4,5,6,7],'1,0':[0,1,3,4,5,6,7],'0,1':[0,1,2,3,4,5,7],'1,1':[3,5]};
    for(const row of result.neighborCases){
      const expected=neighborExpected[row.selection.join(',')],tier=row.rootMode===1?0:row.rootMode===2?1:2;
      assert.deepEqual(row.selected,row.selection,'fixture selected states are produced by GPU');
      assert.deepEqual(row.ids,expected,'cross-block crown remains whenever any required block is absent '+JSON.stringify(row));
      assert.deepEqual(row.counts,[0,1,2].map(i=>i===tier?expected.length:0),'owner guard applies equally to native, middle/far and atlas');assert.equal(row.leafCount,row.counts[0]);
      for(let command=0;command<4;command++)assert.deepEqual([row.commands[command*5],...row.commands.slice(command*5+2,command*5+5)],[[3,0,0,0],[3,3,0,0],[3,6,0,0],[6,0,0,0]][command],'reset preserves indexed topology');
    }
    assert.equal(result.neighborCases.length,36);for(const row of result.neighborImmutable)assert.deepEqual(row,{variant:row.variant,prototypeWrites:1,rootWrites:1,neighborWrites:1,rootReadUsage:false,neighborReadUsage:false},'neighbor/root inputs upload once and never expose CPU readback');
    t.diagnostic(JSON.stringify({qualification:'Authored footprint selection/ownership only; no native leaf appearance or zero-overlap certificate',cases:result.cases,ownership:result.ownership,neighbors:result.neighborCases}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
