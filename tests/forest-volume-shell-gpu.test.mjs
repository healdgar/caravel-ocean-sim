// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// A folded, perforated mesh proves shading cannot manufacture a filled box.
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
  const files={},prototypes=[],fields=[],vertices=[],N=8;
  for(const [id,[species,density,escape]]of [['empty',0,255],['source',1,255],['thick',4,255],['shadow',1,64],['layered',1,255]].entries()){
    const field=new Uint8Array(N**3*8),view=new DataView(field.buffer),exposure=new Uint8Array(N**3).fill(escape);
    for(let z=0;z<N;z++)for(let y=0;y<N;y++)for(let x=0;x<N;x++){
      const rgb=species==='layered'?(z<4?[.8,.1,.05]:[.1,.2,.8]):[.75,.25,.125],at=((z*N+y)*N+x)*8;
      for(let k=0;k<4;k++)view.setUint16(at+k*2,half(k===3?density:rgb[k]*density),true);
    }
    const record=(suffix,raw)=>{const gzip=gzipSync(raw),r={file:`prototype-${id}-${species}/${suffix}`,...receipt(raw),gzip:{file:`prototype-${id}-${species}/${suffix}.gz`,...receipt(gzip)}};files[r.file]=r;return r;};
    prototypes.push({id,species,originXYZ:[-.875,-.875,-.875],cellMetres:.25,dimensionsXYZ:[N,N,N],low:[-1,0,-1],high:[1,1,1],samplingFootprintMetres:Math.sqrt(3)*.25,sourceField:{file:`prototype-${id}-${species}.npz`,...receipt(Buffer.from('synthetic '+species))},field:record('field.rgba16f.bin',field),exposure:record('exposure.r8.bin',exposure)});
    fields.push({field:Array.from(field),exposure:Array.from(exposure)});
  }
  // Four strips surround a real untriangulated aperture. Side strips fold
  // towards the camera; top/bottom remain flat. A separate buried strip tests
  // the only permitted visibility discard, at the biological collar.
  for(const [x0,x1,y0,y1,slope]of [[-.9,-.25,.05,.95,-.4],[.25,.9,.05,.95,.4],[-.25,.25,.65,.95,0],[-.25,.25,.05,.35,0],[-.8,-.5,-.6,-.2,0]]){
    const n=[-slope,0,1],length=Math.hypot(...n),z=x=>slope===0?.3:.2+.4*Math.abs(x),corners=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
    for(const i of [0,1,2,0,2,3]){const [x,y]=corners[i];vertices.push(x,y,z(x),...n.map(v=>v/length),4,.8,0,0,.125,.5,.25);}
  }
  return {manifest:{format:'waterworld.native-forest-volume',version:1,appearanceErrorSupported:false,recipe:{version:1,nativeGroundPlaneY:0,extinction:.5},source:{files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map(name=>[name,receipt(Buffer.from('synthetic '+name))])),nativeFieldManifest:receipt(Buffer.from('synthetic shell field')),method:{file:'scripts/prepare-forest-volume.py',...receipt(Buffer.from('synthetic shell provenance'))}},prototypes,files},fields,vertices};
}

test('production opaque forest shell keeps real mesh holes and raster depth while fields shade its interior',{timeout:120000},async t=>{
  const input=fixture(),server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port+'/tests/fixtures/forest-gpu.html');
    const result=await page.evaluate(async input=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{FOREST_VERTEX_WGSL,FOREST_MIDDLE_VERTEX_LAYOUT}=await import('/js/forest-scenery.js'),{FOREST_VOLUME_WGSL,FOREST_VOLUME_SHELL_WGSL,createForestVolumeResources}=await import('/js/forest-volume.js');
      if(!FOREST_VERTEX_WGSL.includes(FOREST_VOLUME_WGSL)||!FOREST_VERTEX_WGSL.includes(FOREST_VOLUME_SHELL_WGSL))throw Error('Production forest shader omits the exact volume/shell entry points');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage,errors=[],buffers=[],textures=[],writes=new Map(),textureWrites=new Map(),runtimeBuffers=[];let active=false;
      device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async code=>{const module=device.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const createBuffer=device.createBuffer.bind(device);device.createBuffer=description=>{const b=createBuffer(description);if(description.label?.startsWith('forest volume immutable'))runtimeBuffers.push(b);return b;};
      const write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,...args)=>{if(active&&(buffer.label.startsWith('forest volume immutable')||buffer.label.startsWith('fixture immutable')))throw Error('CPU shell/input update after initialization');writes.set(buffer,(writes.get(buffer)??0)+1);return write(buffer,...args);};
      const writeTexture=device.queue.writeTexture.bind(device.queue);device.queue.writeTexture=(target,...args)=>{if(active)throw Error('CPU volume texture update after initialization');textureWrites.set(target.texture,(textureWrites.get(target.texture)??0)+1);return writeTexture(target,...args);};
      const createEncoder=device.createCommandEncoder.bind(device);device.createCommandEncoder=(...args)=>{const encoder=createEncoder(...args);for(const name of ['copyBufferToTexture','copyTextureToTexture']){const copy=encoder[name].bind(encoder);encoder[name]=(source,target,...rest)=>{if(active&&target.texture.label.startsWith('forest volume immutable'))throw Error('CPU volume staging upload after initialization');return copy(source,target,...rest);};}const copy=encoder.copyBufferToBuffer.bind(encoder);encoder.copyBufferToBuffer=(source,offset,target,...rest)=>{if(active&&(target.label.startsWith('forest volume immutable')||target.label.startsWith('fixture immutable')))throw Error('CPU shell/input staging upload after initialization');return copy(source,offset,target,...rest);};return encoder;};
      const make=(data,usage,label)=>{const buffer=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);buffers.push(buffer);return buffer;};
      const resources=createForestVolumeResources({device,pack:{manifest:input.manifest,prototypes:input.fields.map(row=>({field:new Uint8Array(row.field),exposure:new Uint8Array(row.exposure)})),sourceValidated:true}});
      const module=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{
 if(F.sunDir.w>.5){return vec4f(ambient,diffuse,0,1);}return vec4f(albedo,1);
}
`+FOREST_VERTEX_WGSL+`
// Same production VS and source mesh, independently ordinary raster depth.
@fragment fn shellReferenceFS(in:ForestVolumeShellVertex)->@location(0)vec4f{if(in.local.y<forestVolumeMeta.highFloor.w){discard;}return vec4f(1);}`);
      const layouts=[device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform'}}]}),device.createBindGroupLayout({entries:[]}),device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:1,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:S.VERTEX,buffer:{type:'uniform'}}]}),device.createBindGroupLayout({entries:[{binding:0,visibility:S.FRAGMENT,texture:{viewDimension:'3d'}},{binding:1,visibility:S.FRAGMENT,texture:{viewDimension:'3d'}},{binding:2,visibility:S.FRAGMENT,sampler:{}},{binding:3,visibility:S.FRAGMENT,buffer:{type:'uniform'}}]})],layout=device.createPipelineLayout({bindGroupLayouts:layouts});
      const create=entryPoint=>device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'forestVolumeShellVS',buffers:[FOREST_MIDDLE_VERTEX_LAYOUT]},fragment:{module,entryPoint,targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4,alphaToCoverageEnabled:false}}),pipeline=await create('forestVolumeShellFS'),reference=await create('shellReferenceFS');
      const W=256,H=128,fd=new Float32Array(96);fd[0]=1/.8;fd[5]=1/.4;fd[11]=-1;fd[14]=.1;fd.set([0,10.5,10,0],16);fd.set([.8,0,0],20);fd.set([0,.4,0],24);fd.set([0,0,-1],28);fd.set([W,H,1/W,1/H],36);
      const sunRight=[.8,.4,Math.sqrt(.2)],sunLeft=[-.8,.4,Math.sqrt(.2)],frame=make(fd,B.UNIFORM,'fixture shell frame'),mesh=make(new Float32Array(input.vertices),B.VERTEX,'fixture immutable perforated shell'),roots=make(new Float32Array([-2.5,10,0,1,0,1,1,1,0,0,-1,0,2.5,10,0,1.5,Math.PI,.5,1,.75,0,0,-1,0]),B.STORAGE,'fixture immutable shell roots'),visible=make(new Uint32Array([0,1]),B.STORAGE,'fixture immutable shell visible IDs'),bin=make(new Uint32Array(4),B.UNIFORM,'fixture immutable shell bin');
      const common=[device.createBindGroup({layout:layouts[0],entries:[{binding:0,resource:{buffer:frame}}]}),device.createBindGroup({layout:layouts[1],entries:[]}),device.createBindGroup({layout:layouts[2],entries:[roots,visible,bin].map((buffer,binding)=>({binding,resource:{buffer}}))})],groups=input.fields.map((_,id)=>resources.bind(pipeline,id)),referenceGroup=resources.bind(reference,0);
      const target=()=>{const colour=device.createTexture({size:[W,H],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),msaa=device.createTexture({size:[W,H],format:'rgba16float',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});textures.push(colour,msaa,depth);return {colour,msaa,depth};},base=target(),actual=target(),read=device.createBuffer({size:W*H*8,usage:B.COPY_DST|B.MAP_READ}),diffRead=device.createBuffer({size:8,usage:B.COPY_DST|B.MAP_READ});buffers.push(read,diffRead);
      const diffModule=await shader(`@group(0)@binding(0)var reference:texture_depth_multisampled_2d;
@group(0)@binding(1)var actual:texture_depth_multisampled_2d;
@group(0)@binding(2)var<storage,read_write>stats:array<atomic<u32>>;
@compute @workgroup_size(1)fn reset(){atomicStore(&stats[0],0u);atomicStore(&stats[1],0u);}
@compute @workgroup_size(8,8)fn compare(@builtin(global_invocation_id)id:vec3u){if(id.x>=256u||id.y>=128u){return;}for(var sample=0;sample<4;sample++){let a=bitcast<u32>(textureLoad(reference,vec2i(id.xy),sample));let b=bitcast<u32>(textureLoad(actual,vec2i(id.xy),sample));if(a!=b){atomicAdd(&stats[0],1u);atomicMax(&stats[1],max(a,b)-min(a,b));}}}`),stats=make(new Uint32Array(2),B.STORAGE|B.COPY_SRC,'fixture GPU shell depth comparison');
      const reset=await device.createComputePipelineAsync({layout:'auto',compute:{module:diffModule,entryPoint:'reset'}}),compare=await device.createComputePipelineAsync({layout:'auto',compute:{module:diffModule,entryPoint:'compare'}}),resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:2,resource:{buffer:stats}}]}),compareGroup=device.createBindGroup({layout:compare.getBindGroupLayout(0),entries:[{binding:0,resource:base.depth.createView()},{binding:1,resource:actual.depth.createView()},{binding:2,resource:{buffer:stats}}]});
      const half=(view,at)=>{const h=view.getUint16(at,true),s=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return s*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));};
      const draw=(encoder,target,pipe,group)=>{const pass=encoder.beginRenderPass({colorAttachments:[{view:target.msaa.createView(),resolveTarget:target.colour.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:target.depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});pass.setPipeline(pipe);for(let i=0;i<3;i++)pass.setBindGroup(i,common[i]);pass.setBindGroup(3,group);pass.setVertexBuffer(0,mesh);pass.draw(input.vertices.length/13,2);pass.end();};
      fd.set([...sunRight,0],32);device.queue.writeBuffer(frame,0,fd);{const encoder=device.createCommandEncoder();draw(encoder,base,reference,referenceGroup);encoder.copyTextureToBuffer({texture:base.colour},{buffer:read,bytesPerRow:W*8},[W,H]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);}
      const baseline=new Uint8Array(read.getMappedRange()).slice();read.unmap();const basePixels=new DataView(baseline.buffer),sample=(pixels,x,y)=>[0,1,2,3].map(c=>half(pixels,(y*W+x)*8+c*2)),bodies=[[76,64],[179,60]],holes=[[87,64],[166,60]],buried=[[76,79],[181,81]],results=[];
      const cases=[['empty-pigment',0,0,sunRight],['source-pigment',1,0,sunRight],['thick-pigment',2,0,sunRight],['shadow-pigment',3,0,sunRight],['layered-pigment',4,0,sunRight],['empty-light',0,1,sunRight],['source-light',1,1,sunRight],['shadow-light',3,1,sunRight],['source-light-left',1,1,sunLeft]];active=true;
      for(const [name,id,mode,sun]of cases){
        fd.set([...sun,mode],32);device.queue.writeBuffer(frame,0,fd);const encoder=device.createCommandEncoder();draw(encoder,actual,pipeline,groups[id]);const compute=encoder.beginComputePass();compute.setPipeline(reset);compute.setBindGroup(0,resetGroup);compute.dispatchWorkgroups(1);compute.setPipeline(compare);compute.setBindGroup(0,compareGroup);compute.dispatchWorkgroups(W/8,H/8);compute.end();encoder.copyTextureToBuffer({texture:actual.colour},{buffer:read,bytesPerRow:W*8},[W,H]);encoder.copyBufferToBuffer(stats,0,diffRead,0,8);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);await diffRead.mapAsync(GPUMapMode.READ);
        const pixels=new DataView(read.getMappedRange());let alphaDifferences=0,solid=0,nonfinite=0;for(let i=0;i<W*H;i++){const a=half(pixels,i*8+6),expected=half(basePixels,i*8+6);if(a!==expected)alphaDifferences++;if(a===1)solid++;for(let c=0;c<4;c++)if(!Number.isFinite(half(pixels,i*8+c*2)))nonfinite++;}
        results.push({name,alphaDifferences,solid,nonfinite,depth:Array.from(new Uint32Array(diffRead.getMappedRange())),bodies:bodies.map(([x,y])=>sample(pixels,x,y)),holes:holes.map(([x,y])=>sample(pixels,x,y)),buried:buried.map(([x,y])=>sample(pixels,x,y))});read.unmap();diffRead.unmap();
      }
      active=false;await device.queue.onSubmittedWorkDone();const immutable={meshWrites:writes.get(mesh),rootWrites:writes.get(roots),visibleWrites:writes.get(visible),binWrites:writes.get(bin),textureWrites:Array.from(textureWrites.values()),runtime:runtimeBuffers.map(b=>({label:b.label,writes:writes.get(b),readback:!!(b.usage&(B.MAP_READ|B.COPY_SRC))})),meshReadback:!!(mesh.usage&(B.MAP_READ|B.COPY_SRC))},baselineSamples={bodies:bodies.map(([x,y])=>sample(basePixels,x,y)),holes:holes.map(([x,y])=>sample(basePixels,x,y)),buried:buried.map(([x,y])=>sample(basePixels,x,y))};resources.destroy();for(const buffer of buffers)buffer.destroy();for(const texture of textures)texture.destroy();device.destroy();return {errors,results,immutable,baselineSamples};
    },input);
    assert.deepEqual(result.errors,[]);assert.equal(result.results.length,9);for(const key of ['meshWrites','rootWrites','visibleWrites','binWrites'])assert.equal(result.immutable[key],1);assert.equal(result.immutable.meshReadback,false);assert.equal(result.immutable.textureWrites.length,10);assert.ok(result.immutable.textureWrites.every(n=>n===1));assert.equal(result.immutable.runtime.length,6);for(const row of result.immutable.runtime){assert.equal(row.writes,1);assert.equal(row.readback,false);}
    for(const body of result.baselineSamples.bodies)assert.equal(body[3],1,'reference includes actual folded/lobed mesh');for(const sample of [...result.baselineSamples.holes,...result.baselineSamples.buried])assert.equal(sample[3],0);
    const cases=Object.fromEntries(result.results.map(row=>[row.name,row])),close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.002,message+': '+JSON.stringify({actual,expected}));
    for(const row of result.results){assert.equal(row.nonfinite,0);assert.ok(row.solid>100);assert.equal(row.alphaDifferences,0,'field colour/lighting cannot change mesh coverage');assert.deepEqual(row.depth,[0,0],'every MSAA depth sample equals ordinary source-mesh raster depth');for(const body of row.bodies)assert.equal(body[3],1,'opaque shell interior even for an empty field');for(const sample of [...row.holes,...row.buried])assert.equal(sample[3],0,'real mesh aperture and collar remain open');}
    for(let id=0;id<2;id++)for(let c=0;c<3;c++){
      const tint=id===0?[1,1,1]:[.5,1,.75];close(cases['empty-pigment'].bodies[id][c],[.125,.5,.25][c]*tint[c],'empty volume falls back to original vertex pigment');
      for(const name of ['source-pigment','thick-pigment','shadow-pigment'])close(cases[name].bodies[id][c],[.75,.25,.125][c]*tint[c],'interior density moments divide once and tint once');
    }
    assert.ok(cases['layered-pigment'].bodies[0][0]>.4&&cases['layered-pigment'].bodies[0][2]<.45,'front pose sees red pigment through interior samples');assert.ok(cases['layered-pigment'].bodies[1][0]<.08&&cases['layered-pigment'].bodies[1][2]>.55,'opposite pose samples the actual blue interior, preserving pose/scale');
    const normalDot=(.4*.8+Math.sqrt(.2))/Math.sqrt(1.16);close(cases['empty-light'].bodies[0][1],normalDot,'empty field leaves solar diffuse unattenuated');close(cases['source-light'].bodies[0][1],normalDot*Math.exp(-1),'four actual half-metre density samples attenuate sunlight');close(cases['source-light'].bodies[0][0],.67,'source escape supplies ambient visibility');close(cases['shadow-light'].bodies[0][0],.12+.55*64/255,'source escape darkens ambient without changing pigment');assert.ok(cases['source-light'].bodies[0][1]-cases['source-light-left'].bodies[0][1]>.15,'sun rotation affects actual shell lighting');
    t.diagnostic(JSON.stringify({qualification:'Synthetic shell raster/colour/light/GPU contract; no native silhouette/appearance certificate',...result}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
