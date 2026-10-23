// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Synthetic optical laws/coordinates only; no native appearance certificate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const receipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
const half=n=>{if(n===0)return 0;const e=Math.floor(Math.log2(n));if(e< -14)return Math.round(n*2**24);let m=Math.round((n/2**e-1)*1024),b=e+15;if(m===1024){m=0;b++;}return b*1024+m;};
function fixture(){
  const size=8,cell=.25,origin=[-.875,-.875,-.875],files={},prototypes=[],rows=[];
  const definitions=[['empty',0,255],['dense',40,255],['slab',40,255],['quarter',-Math.log(.75),255],['half',-Math.log(.5),255],['threequarter',-Math.log(.25),255],['shadow',40,64]];
  for(const [id,[species,rho,escape]]of definitions.entries()){
    const field=new Uint8Array(size**3*8),view=new DataView(field.buffer),exposure=new Uint8Array(size**3).fill(escape);
    for(let z=0;z<size;z++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const at=((z*size+y)*size+x)*8,density=species==='slab'&&z!==2&&z!==3?0:rho;
      for(const [channel,value]of [density,density*.25,density*.5,density].entries())view.setUint16(at+channel*2,half(value),true);
    }
    const record=(name,bytes)=>{const compressed=gzipSync(bytes),item={file:`prototype-${id}-${species}/${name}`,...receipt(bytes),gzip:{file:`prototype-${id}-${species}/${name}.gz`,...receipt(compressed)}};files[item.file]=item;return item;};
    prototypes.push({id,species,originXYZ:origin,cellMetres:cell,dimensionsXYZ:[size,size,size],low:[-1,0,-1],high:[1,1,1],samplingFootprintMetres:Math.sqrt(3)*cell,sourceField:{file:`prototype-${id}-${species}.npz`,...receipt(Buffer.from('synthetic '+species))},field:record('field.rgba16f.bin',field),exposure:record('exposure.r8.bin',exposure)});
    rows.push({field:Array.from(field),exposure:Array.from(exposure),rho,escape,species});
  }
  return {manifest:{format:'waterworld.native-forest-volume',version:1,appearanceErrorSupported:false,geometryErrorSupported:false,recipe:{version:1,nativeGroundPlaneY:0,extinction:.5},source:{files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map(name=>[name,receipt(Buffer.from('synthetic '+name))])),nativeFieldManifest:receipt(Buffer.from('synthetic optical laws')),method:{file:'scripts/prepare-forest-volume.py',...receipt(Buffer.from('synthetic optical fixture provenance'))}},prototypes,files},rows};
}

test('production forest volume integrates density, tint, escape and hit depth on immutable GPU inputs',{timeout:120000},async t=>{
  const input=fixture(),server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/tests/fixtures/forest-gpu.html');
    const result=await page.evaluate(async input=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{FOREST_VERTEX_WGSL}=await import('/js/forest-scenery.js'),{FOREST_VOLUME_WGSL,createForestVolumeResources}=await import('/js/forest-volume.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[],allocated=[],textureWrites=new Map(),bufferWrites=new Map(),runtimeBuffers=[];let active=false;
      device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async code=>{const module=device.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const writeTexture=device.queue.writeTexture.bind(device.queue);device.queue.writeTexture=(target,...args)=>{if(active)throw Error('Per-frame volume texture upload');textureWrites.set(target.texture,(textureWrites.get(target.texture)??0)+1);return writeTexture(target,...args);};
      const createBuffer=device.createBuffer.bind(device);device.createBuffer=description=>{const buffer=createBuffer(description);if(description.label?.startsWith('forest volume immutable'))runtimeBuffers.push(buffer);return buffer;};
      const writeBuffer=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,...args)=>{if(active&&(buffer.label.startsWith('forest volume immutable')||buffer.label.startsWith('fixture immutable')))throw Error('Per-frame volume input upload');bufferWrites.set(buffer,(bufferWrites.get(buffer)??0)+1);return writeBuffer(buffer,...args);};
      const createEncoder=device.createCommandEncoder.bind(device);device.createCommandEncoder=(...args)=>{const encoder=createEncoder(...args);for(const name of ['copyBufferToTexture','copyTextureToTexture']){const copy=encoder[name].bind(encoder);encoder[name]=(source,destination,...rest)=>{if(active&&destination.texture.label.startsWith('forest volume immutable'))throw Error('Per-frame volume texture staging copy');return copy(source,destination,...rest);};}const copy=encoder.copyBufferToBuffer.bind(encoder);encoder.copyBufferToBuffer=(source,offset,destination,...rest)=>{if(active&&destination.label.startsWith('forest volume immutable'))throw Error('Per-frame volume buffer staging copy');return copy(source,offset,destination,...rest);};return encoder;};
      const make=(data,usage,label)=>{const buffer=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);allocated.push(buffer);return buffer;};
      const pack={manifest:input.manifest,prototypes:input.rows.map(row=>({field:new Uint8Array(row.field),exposure:new Uint8Array(row.exposure)})),sourceValidated:true},resources=createForestVolumeResources({device,pack});
      const module=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
// R preserves source pigment/tint for coverage recovery; G/B expose the real
// ambient/diffuse terms passed by the production optical shader.
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(albedo.r,ambient,diffuse,1);}
`+FOREST_VERTEX_WGSL);
      if(!FOREST_VERTEX_WGSL.includes(FOREST_VOLUME_WGSL))throw Error('Production shader must include the exact volume entry points');
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'forestVolumeVS'},fragment:{module,entryPoint:'forestVolumeFS',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list',cullMode:'back'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4,alphaToCoverageEnabled:true}});
      const W=256,H=128,fd=new Float32Array(96);fd[0]=1/.8;fd[5]=1/.4;fd[11]=-1;fd[14]=.1;fd.set([0,10.5,10,0],16);fd.set([.8,0,0],20);fd.set([0,.4,0],24);fd.set([0,0,-1],28);fd.set([0,0,1,1],32);fd.set([W,H,1/W,1/H],36);
      const frame=make(fd,B.UNIFORM,'fixture volume frame'),rootData=new Float32Array([-2.5,10,0,1,0,1,1,1,0,0,-1,0,2.5,10,0,1.5,Math.PI,.5,1,1,0,0,-1,0]),roots=make(rootData,B.STORAGE,'fixture immutable volume roots'),visible=make(new Uint32Array([0,1]),B.STORAGE,'fixture immutable volume visible IDs'),bin=make(new Uint32Array(4),B.UNIFORM,'fixture immutable volume bin');
      const group0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]}),group1=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[]}),group2=device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[roots,visible,bin].map((buffer,binding)=>({binding,resource:{buffer}}))}),groups=input.rows.map((_,id)=>resources.bind(pipeline,id));
      const colour=device.createTexture({size:[W,H],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),msaa=device.createTexture({size:[W,H],format:'rgba16float',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
      const colourRead=device.createBuffer({size:W*H*8,usage:B.COPY_DST|B.MAP_READ}),depthRead=device.createBuffer({size:32,usage:B.COPY_DST|B.MAP_READ});allocated.push(colourRead,depthRead);
      const inspect=await shader(`@group(0)@binding(0)var depth:texture_depth_multisampled_2d;
@group(0)@binding(1)var<storage,read_write>result:array<f32>;
@compute @workgroup_size(1)fn main(@builtin(global_invocation_id)id:vec3u){if(id.x>=8u){return;}let p=select(vec2i(88,64),vec2i(168,64),id.x>=4u);result[id.x]=textureLoad(depth,p,i32(id.x%4u));}`),inspectPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:inspect,entryPoint:'main'}}),depthValues=make(new Float32Array(8),B.STORAGE|B.COPY_SRC,'fixture GPU depth witness'),inspectGroup=device.createBindGroup({layout:inspectPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:depth.createView()},{binding:1,resource:{buffer:depthValues}}]});
      const half=(view,at)=>{const h=view.getUint16(at,true),s=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return s*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
      const rect=(pixels,x0,x1,y0,y1)=>{const sum=[0,0,0,0];let count=0,minR=Infinity,maxR=0,maxA=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const at=(y*W+x)*8,rgba=[0,1,2,3].map(c=>half(pixels,at+c*2));count++;for(let c=0;c<4;c++)sum[c]+=rgba[c];minR=Math.min(minR,rgba[0]);maxR=Math.max(maxR,rgba[0]);maxA=Math.max(maxA,rgba[3]);}return {count,mean:sum.map(v=>v/count),minR,maxR,maxA};};
      const regions=[[84,92,60,68],[164,172,60,68]],results=[];active=true;
      for(const [id,row]of input.rows.entries()){
        const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:msaa.createView(),resolveTarget:colour.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.setBindGroup(2,group2);pass.setBindGroup(3,groups[id]);pass.setIndexBuffer(resources.indices,'uint32');pass.drawIndexed(resources.indexCount,2);pass.end();
        const compute=encoder.beginComputePass();compute.setPipeline(inspectPipeline);compute.setBindGroup(0,inspectGroup);compute.dispatchWorkgroups(8);compute.end();encoder.copyTextureToBuffer({texture:colour},{buffer:colourRead,bytesPerRow:W*8},[W,H]);encoder.copyBufferToBuffer(depthValues,0,depthRead,0,32);device.queue.submit([encoder.finish()]);await colourRead.mapAsync(GPUMapMode.READ);await depthRead.mapAsync(GPUMapMode.READ);
        const pixels=new DataView(colourRead.getMappedRange()),centres=regions.map(region=>rect(pixels,...region)),below=[rect(pixels,82,94,80,86),rect(pixels,162,174,80,86)];let area=[0,0],nonfinite=0;
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){const at=(y*W+x)*8,r=half(pixels,at),a=half(pixels,at+6);if(!Number.isFinite(r)||!Number.isFinite(a))nonfinite++;if(r>.1)area[x<W/2?0:1]++;}
        const depths=Array.from(new Float32Array(depthRead.getMappedRange()));results.push({species:row.species,rho:row.rho,escape:row.escape,centres,below,area,depths,nonfinite});colourRead.unmap();depthRead.unmap();
      }
      active=false;await device.queue.onSubmittedWorkDone();const immutable={textureUploads:Array.from(textureWrites.values()),textureReadback:Array.from(textureWrites.keys(),texture=>!!(texture.usage&T.COPY_SRC)),runtimeBuffers:runtimeBuffers.map(buffer=>({label:buffer.label,writes:bufferWrites.get(buffer),readable:!!(buffer.usage&(B.MAP_READ|B.COPY_SRC))})),rootWrites:bufferWrites.get(roots),visibleWrites:bufferWrites.get(visible),binWrites:bufferWrites.get(bin),rootReadable:!!(roots.usage&(B.MAP_READ|B.COPY_SRC)),bytes:resources.immutableBytes};resources.destroy();for(const buffer of allocated)buffer.destroy();for(const texture of [colour,msaa,depth])texture.destroy();device.destroy();return {errors,results,immutable,adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,adapter.info?.[k]??'']))};
    },input);
    assert.deepEqual(result.errors,[]);assert.equal(result.results.length,7);assert.equal(result.immutable.textureUploads.length,14);assert.ok(result.immutable.textureUploads.every(n=>n===1));assert.ok(result.immutable.textureReadback.every(flag=>flag===false));assert.equal(result.immutable.runtimeBuffers.length,8);assert.equal(result.immutable.bytes,input.rows.reduce((sum,row)=>sum+row.field.length+row.exposure.length+64,144));assert.equal(result.immutable.rootWrites,1);assert.equal(result.immutable.visibleWrites,1);assert.equal(result.immutable.binWrites,1);assert.equal(result.immutable.rootReadable,false);for(const row of result.immutable.runtimeBuffers){assert.equal(row.writes,1);assert.equal(row.readable,false);}
    const byName=Object.fromEntries(result.results.map(row=>[row.species,row]));
    for(const row of result.results){assert.equal(row.nonfinite,0);for(const below of row.below){assert.equal(below.maxR,0,'density below each biological collar stays hidden');assert.equal(below.maxA,0);}}
    assert.deepEqual(byName.empty.area,[0,0]);assert.ok(byName.empty.depths.every(d=>d===0),'empty fields never write box-front depth');
    for(const name of ['dense','slab','shadow'])for(const [id,region]of byName[name].centres.entries()){const tint=id===0?1:.5;assert.ok(Math.abs(region.mean[0]-tint)<.01,'optically dense interior is opaque with root tint once: '+name);assert.ok(region.mean[3]>.99);}
    assert.ok(byName.dense.area[1]>byName.dense.area[0]*1.8&&byName.dense.area[1]<byName.dense.area[0]*3.3,'larger instance changes projected support, not optical density');
    for(const name of ['quarter','half','threequarter']){
      const row=byName[name],recovered=[];
      for(const [id,region]of row.centres.entries()){
        const tint=id===0?1:.5,observed=region.mean[3]*tint/region.mean[0];let expected=0;
        for(let y=60;y<68;y++)for(let x=(id===0?84:164);x<(id===0?92:172);x++){const rx=(2*(x+.5)/256-1)*.8,ry=(1-2*(y+.5)/128)*.4;expected+=1-Math.exp(-.5*row.rho*2*Math.hypot(rx,ry,1));}expected/=64;
        assert.ok(region.mean[0]>0&&region.mean[0]<tint*.9,'partial field has nonzero nonopaque sample coverage');assert.ok(Math.abs(observed-expected)<.02,'resolved A/R recovers Beer–Lambert opacity independently of MSAA quantization: '+JSON.stringify({name,id,observed,expected}));recovered.push(observed);
      }
      assert.ok(Math.abs(recovered[0]-recovered[1])<.02,'uniform root scale preserves leaf-area optical depth');
    }
    for(const [id,bounds]of [[.1/10.625,.1/9.875],[.1/10.1875,.1/9.0625]].entries())for(const depth of byName.slab.depths.slice(id*4,id*4+4))assert.ok(depth>=bounds[0]-2e-6&&depth<=bounds[1]+2e-6,'actual opacity-weighted slab hit lies behind box front and inside transformed source support');
    assert.ok(byName.slab.depths.slice(4).reduce((a,b)=>a+b,0)>byName.slab.depths.slice(0,4).reduce((a,b)=>a+b,0)*1.035,'yaw and scale move the asymmetric slab hit');
    for(let id=0;id<2;id++){assert.ok(byName.dense.centres[id].mean[1]-byName.shadow.centres[id].mean[1]>.39,'own-canopy escape attenuates ambient lighting');assert.ok(byName.dense.centres[id].mean[2]-byName.shadow.centres[id].mean[2]>.5,'escape affects production diffuse light, not pigment/coverage');}
    t.diagnostic(JSON.stringify({qualification:'Synthetic optical/pose/depth/AO witnesses through production volume shader, not native appearance certification',...result}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
