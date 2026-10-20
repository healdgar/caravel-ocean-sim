// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.WATER_OPTICS_TEST_PORT||8104,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Water optics test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

async function probePage(run){
  const page=await browser.newPage();
  try{
    await page.route('**/__water-optics',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__water-optics`);return await page.evaluate(run);
  }finally{await page.close();}
}

test('water optics obey Snell refraction, dielectric Fresnel and spectral depth/turbidity attenuation',{timeout:120000},async()=>{
  const result=await probePage(async()=>{
    const {WATER_OPTICS}=await import('/js/wgsl/water-optics.js');
    const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
    const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const cases=[];
    for(const cosine of [1,.8,.5,.2,.05,0])cases.push({name:`fresnel ${cosine}`,view:[0,1,0],normal:[0,1,0],cosine,path:0,turbidity:0});
    for(const path of [0,1,5,20,100])for(const turbidity of [0,.5,2])cases.push({name:`path ${path}, turbidity ${turbidity}`,view:[0,1,0],normal:[0,1,0],cosine:1,path,turbidity});
    for(const angle of [0,30,60,85]){const a=angle*Math.PI/180;cases.push({name:`refraction ${angle}`,view:[Math.sin(a),Math.cos(a),0],normal:[0,1,0],cosine:Math.cos(a),path:5,turbidity:.5});}
    for(const slope of [-.3,.3])cases.push({name:`ripple ${slope}`,view:[0,1,0],normal:[slope,Math.sqrt(1-slope*slope),0],cosine:1,path:5,turbidity:.5});
    const inputData=new Float32Array(cases.flatMap(c=>[...c.view,c.cosine,...c.normal,c.path,c.turbidity,0,0,0]));
    const B=GPUBufferUsage,buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const input=buffer(inputData,B.STORAGE),output=device.createBuffer({size:cases.length*32,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:cases.length*32,usage:B.COPY_DST|B.MAP_READ});
    const code=WATER_OPTICS+`
struct OpticalProbe {view:vec4f,normal:vec4f,medium:vec4f};
struct OpticalAnswer {transmission:vec4f,ray:vec4f};
@group(0)@binding(0)var<storage,read>input:array<OpticalProbe>;
@group(0)@binding(1)var<storage,read_write>output:array<OpticalAnswer>;
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&input)){return;}let p=input[id.x];
 output[id.x].transmission=vec4f(waterTransmittance(p.normal.w,p.medium.x),waterFresnel(p.view.w));
 output[id.x].ray=vec4f(waterRefract(p.view.xyz,p.normal.xyz),0);
}`;
    const module=device.createShaderModule({code}),messages=await module.getCompilationInfo();errors.push(...messages.messages.filter(m=>m.type==='error').map(m=>m.message));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
    const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(cases.length/32));pass.end();enc.copyBufferToBuffer(output,0,read,0,cases.length*32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();return {errors,cases:cases.map((c,i)=>({...c,transmission:values.slice(i*8,i*8+3),fresnel:values[i*8+3],ray:values.slice(i*8+4,i*8+7)}))};
  });
  assert.deepEqual(result.errors,[]);
  const byName=Object.fromEntries(result.cases.map(c=>[c.name,c]));
  for(const c of result.cases){
    assert.ok([...c.transmission,c.fresnel,...c.ray].every(Number.isFinite),c.name);
    assert.ok(c.transmission.every(v=>v>=0&&v<=1)&&c.fresnel>=0&&c.fresnel<=1,c.name);
    assert.ok(Math.abs(Math.hypot(...c.ray)-1)<1e-5&&c.ray[1]<0,`${c.name}: refraction must enter water with a unit direction`);
  }
  const f0=((1.333-1)/(1.333+1))**2;
  assert.ok(Math.abs(byName['fresnel 1'].fresnel-f0)<1e-5,'normal-incidence reflection uses the air/water index');
  assert.ok(Math.abs(byName['fresnel 0'].fresnel-1)<1e-5,'grazing water reflects the entire ray');
  let previous=0;for(const cosine of [1,.8,.5,.2,.05,0]){const value=byName[`fresnel ${cosine}`].fresnel;assert.ok(value>=previous,'grazing increases the reflective mask');previous=value;}
  for(const turbidity of [0,.5,2]){
    let previous=[1,1,1];for(const path of [0,1,5,20,100]){
      const c=byName[`path ${path}, turbidity ${turbidity}`];
      assert.ok(c.transmission.every((v,i)=>v<=previous[i]+1e-7),'underwater contrast must decrease with optical path');
      if(path===0)assert.deepEqual(c.transmission,[1,1,1]);
      else assert.ok(c.transmission[0]<c.transmission[1]&&c.transmission[1]<c.transmission[2],'water absorbs red before green and blue');
      previous=c.transmission;
    }
  }
  for(const path of [1,5,20,100])for(let channel=0;channel<3;channel++){
    const values=[0,.5,2].map(t=>byName[`path ${path}, turbidity ${t}`].transmission[channel]);
    assert.ok(values[0]>values[1]&&values[1]>values[2],'turbidity increases spectral extinction');
  }
  for(const angle of [0,30,60,85]){
    const c=byName[`refraction ${angle}`],sine=Math.sin(angle*Math.PI/180)/1.333;
    assert.ok(Math.abs(Math.abs(c.ray[0])-sine)<1e-5,`${angle} degrees obeys Snell's law`);
    assert.ok(Math.abs(c.ray[1]+Math.sqrt(1-sine*sine))<1e-5,`${angle} degrees bends toward the surface normal`);
  }
  const left=byName['ripple -0.3'].ray,right=byName['ripple 0.3'].ray;
  assert.ok(Math.abs(left[0])>.05&&Math.abs(left[0]+right[0])<1e-6,'opposite ripple slopes displace submerged silhouettes oppositely');
});

test('the production water compositor bends silhouettes and suppresses them through depth and turbidity without sampling foreground',{timeout:120000},async()=>{
  const result=await probePage(async()=>{
    const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{WATER_TRANSMISSION}=await import('/js/wgsl/water-optics.js');
    const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const B=GPUBufferUsage,T=GPUTextureUsage,W=64,H=64,body=[.2,.3,.4];
    const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    // A real perspective camera looks vertically down at a horizontal water
    // surface. Source alpha stores forward camera depth, not normalized depth.
    const frameData=new Float32Array(96);frameData[0]=1;frameData[7]=-1;frameData[9]=-1;frameData[14]=.1;
    frameData.set([0,10,0,0],16);frameData.set([1,0,0,0],20);frameData.set([0,0,-1,0],24);frameData.set([0,-1,0,0],28);frameData.set([W,H,1/W,1/H],36);
    const frame=make(frameData,B.UNIFORM),opticsData=new Float32Array([0,1,0,0]),optics=make(opticsData,B.UNIFORM),normal=make(new Float32Array([0,1,0,0]),B.UNIFORM);
    const output=device.createBuffer({size:W*H*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ});
    const source=device.createTexture({size:[W,H],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
    const code=FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;`+WATER_TRANSMISSION+`
@group(0)@binding(1)var<uniform>surfaceNormal:vec4f;
@group(0)@binding(2)var<storage,read_write>colors:array<vec4f>;
@compute @workgroup_size(8,8)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=64u||i.y>=64u){return;}let uv=(vec2f(i.xy)+.5)/64.0;
 let world=select(vec3f((uv.x-.5)*20.0,0,(uv.y-.5)*20.0),vec3f(0,1,10),surfaceNormal.w>.5);
 colors[i.y*64u+i.x]=vec4f(waterTransmission(world,surfaceNormal.xyz,vec3f(.2,.3,.4)),1);
}`;
    const module=device.createShaderModule({code}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:1,resource:{buffer:normal}},{binding:2,resource:{buffer:output}}]});
    const sourceGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(3),entries:[{binding:0,resource:source.createView()},{binding:1,resource:sampler},{binding:2,resource:{buffer:optics}}]});
    const emptyGroups=[1,2].map(i=>device.createBindGroup({layout:pipeline.getBindGroupLayout(i),entries:[]}));
    const half=value=>{if(value===0)return 0;const exponent=Math.floor(Math.log2(value));return Math.max(0,Math.min(65535,((exponent+15)<<10)+Math.round((value/2**exponent-1)*1024)));};
    const luma=p=>p[0]*.2126+p[1]*.7152+p[2]*.0722,bodyLuma=luma(body);
    async function render({depth=2,turbidity=0,slope=0,enabled=1,alpha=null,sparse=false,crest=false}={}){
      const pixels=new Uint16Array(W*H*4),forwardDepth=alpha??10+depth;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const worldX=((x+.5)/W-.5)*2*(10+depth),worldZ=((y+.5)/H-.5)*2*(10+depth);
        const target=crest||Math.abs(worldX)<1.7&&Math.abs(worldZ)<1.7,colour=target?[.012,.018,.024]:body,at=(y*W+x)*4;
        pixels.set([...colour.map(half),half(sparse&&!target?0:forwardDepth)],at);
      }
      device.queue.writeTexture({texture:source},pixels,{bytesPerRow:W*8},[W,H]);
      if(crest){
        frameData.fill(0,0,36);frameData[0]=1;frameData[5]=1;frameData[11]=1;frameData[14]=.1;
        frameData.set([1,0,0,0],20);frameData.set([0,1,0,0],24);frameData.set([0,0,1,0],28);device.queue.writeBuffer(frame,0,frameData);
      }
      device.queue.writeBuffer(normal,0,new Float32Array(crest?[0,.6,-.8,1]:[slope,Math.sqrt(1-slope*slope),0,0]));opticsData.set([turbidity,enabled]);device.queue.writeBuffer(optics,0,opticsData);
      const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,emptyGroups[0]);pass.setBindGroup(2,emptyGroups[1]);pass.setBindGroup(3,sourceGroup);pass.dispatchWorkgroups(8,8);pass.end();enc.copyBufferToBuffer(output,0,read,0,W*H*16);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();let sum=0,xSum=0,zSum=0,maximum=0,bodyError=0;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const p=values.slice((y*W+x)*4,(y*W+x)*4+3),contrast=Math.max(0,bodyLuma-luma(p));
        if(p.some(v=>!Number.isFinite(v)))throw Error('Nonfinite water radiance');sum+=contrast;xSum+=(x+.5)*contrast;zSum+=(y+.5)*contrast;maximum=Math.max(maximum,contrast);bodyError=Math.max(bodyError,...p.map((v,i)=>Math.abs(v-body[i])));
      }
      return {contrast:maximum,areaContrast:sum,centroid:[xSum/sum,zSum/sum],bodyError,centre:values.slice((32*W+32)*4,(32*W+32)*4+3)};
    }
    const flat=await render(),left=await render({slope:-.3}),right=await render({slope:.3});
    const deep=await render({depth:12}),deeper=await render({depth:60}),turbid=await render({turbidity:2});
    const disabled=await render({enabled:0}),missing=await render({alpha:0}),foreground=await render({alpha:8});
    const sparseFlat=await render({sparse:true}),sparseLeft=await render({sparse:true,slope:-.6}),sparseRight=await render({sparse:true,slope:.6});
    const sparseDeep=await render({sparse:true,depth:12}),sparseDeeper=await render({sparse:true,depth:60});
    const aboveEyeCrest=await render({crest:true,alpha:14});
    device.destroy();return {errors,flat,left,right,deep,deeper,turbid,disabled,missing,foreground,sparseFlat,sparseLeft,sparseRight,sparseDeep,sparseDeeper,aboveEyeCrest};
  });
  assert.deepEqual(result.errors,[]);
  assert.ok(result.flat.contrast>.15,'a shallow, dark submerged object remains visible through clear water');
  assert.ok(result.deep.contrast<result.flat.contrast*.65&&result.deeper.contrast<result.deep.contrast*.3,'deep objects approach the water body rather than retaining an opaque silhouette');
  assert.ok(result.turbid.contrast<result.flat.contrast*.8,'suspended particles reduce underwater contrast');
  assert.ok(Math.abs(result.left.centroid[0]-result.right.centroid[0])>.75,'ripple slope moves the actual source silhouette: '+JSON.stringify({flat:result.flat,left:result.left,right:result.right}));
  assert.ok((result.left.centroid[0]-result.flat.centroid[0])*(result.right.centroid[0]-result.flat.centroid[0])<0,'opposite slopes move silhouettes in opposite directions');
  assert.ok(Math.abs(result.left.centroid[1]-result.right.centroid[1])<.1,'a transverse ripple does not manufacture longitudinal motion');
  for(const name of ['disabled','missing','foreground'])assert.ok(result[name].bodyError<1e-6,`${name} source must preserve ordinary water radiance exactly`);
  for(const name of ['sparseLeft','sparseRight'])assert.ok(result[name].areaContrast>result.sparseFlat.areaContrast*.9,'refraction must preserve an isolated animal silhouette beyond its undistorted source footprint: '+JSON.stringify({flat:result.sparseFlat,left:result.sparseLeft,right:result.sparseRight}));
  assert.ok(result.sparseDeep.contrast<result.sparseFlat.contrast*.65&&result.sparseDeeper.contrast<result.sparseDeep.contrast*.3,
    'deep isolated silhouettes, including their strongest edge pixel, must fade with the real optical path: '+JSON.stringify({shallow:result.sparseFlat,deep:result.sparseDeep,deeper:result.sparseDeeper}));
  assert.ok(result.aboveEyeCrest.contrast>.1,'an air camera can see transmission through a crest front above eye level');
});

test('all opaque material families support capture and the capture clips to every wave cascade while preserving unfogged radiance and eye depth',{timeout:120000},async()=>{
  const result=await probePage(async()=>{
    const {createSubmergedShader,createWaterOptics}=await import('/js/water-optics.js'),{FRAME_WGSL,CASCADES}=await import('/js/wgsl/common.js');
    const {CARAVEL}=await import('/js/wgsl/caravel.js'),{CREW_RENDER}=await import('/js/wgsl/crew.js'),{ANCHOR_RENDER}=await import('/js/wgsl/anchor.js');
    const {TERRAIN}=await import('/js/wgsl/terrain.js'),{DOLPHIN_RENDER}=await import('/js/wgsl/dolphins.js'),{MARINE_LIFE_RENDER}=await import('/js/wgsl/marine-life.js');
    const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo(),failures=info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message);errors.push(...failures);if(failures.length)throw Error(failures.join('\n'));return module;};
    for(const [name,source,entry,world] of [['hull',CARAVEL,'fs','in.world'],['crew',CREW_RENDER,'fs','v.world'],['anchor',ANCHOR_RENDER,'fs','v.world'],['terrain',TERRAIN,'fs','in.world'],['dolphin',DOLPHIN_RENDER,'dolphinFS','v.world'],['whale/shark',MARINE_LIFE_RENDER,'dolphinFS','v.world']])await shader(createSubmergedShader(source,entry,world),name);
    const B=GPUBufferUsage,T=GPUTextureUsage,buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const frameData=new Float32Array(96);frameData.set([0,10,0,0],16);frameData.set([0,-1,0,0],28);frameData.set([32,32,1/32,1/32],36);frameData.set([1,1,1,1,1,1],48);
    const frame=buffer(frameData,B.UNIFORM),height=buffer(new Float32Array([-.5,0,0,0]),B.UNIFORM);
    const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
    const source=FRAME_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>bodyPlane:vec4f;
struct Vertex {@builtin(position)pos:vec4f,@location(0)world:vec3f};
@vertex fn vs(@builtin(vertex_index)i:u32)->Vertex {
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;
 var v:Vertex;v.pos=vec4f(p,.5,1);v.world=vec3f(p.x,bodyPlane.x,p.y);return v;
}
fn surfaceAir(colour:vec3f,world:vec3f)->vec3f {return colour*.1+vec3f(.3);}
@fragment fn fs(v:Vertex)->@location(0)vec4f {return vec4f(surfaceAir(vec3f(.3,.2,.1),v.world),1);}
`;
    const optics=createWaterOptics({device,shader,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler}),capture=await optics.capture({source,vertex:{buffers:[]}});
    const group=capture.bindGroup([{buffer:frame},{buffer:height}]);
    const target=device.createTexture({size:[32,32],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[32,32],format:'depth32float',usage:T.RENDER_ATTACHMENT}),read=device.createBuffer({size:32*32*8,usage:B.COPY_DST|B.MAP_READ});
    const half=bits=>{const sign=bits&0x8000?-1:1,e=(bits>>10)&31,m=bits&1023;return sign*(e?(1+m/1024)*2**(e-15):m*2**-24);};
    async function render(y){
      device.queue.writeBuffer(height,0,new Float32Array([y,0,0,0]));
      const enc=device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}});
      capture.bind(pass);pass.setBindGroup(0,group);pass.draw(3);pass.end();enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256},[32,32]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const data=new Uint16Array(read.getMappedRange()),centre=Array.from(data.slice((16*32+16)*4,(16*32+16)*4+4),half),count=Array.from(data).filter(v=>v!==0).length;read.unmap();return {centre,count};
    }
    const submerged=await render(-.5),above=await render(.5);
    // Only the capillary cascade raises water. A broad-swell-only clip would
    // incorrectly discard the same now-submerged target.
    device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array([0,0x3c00,0,0]),{bytesPerRow:8},[1,1]);
    const raised=await render(.5);frameData.set([0,1,0,0],28);device.queue.writeBuffer(frame,0,frameData);const behindEye=await render(-.5);
    device.destroy();return {errors,submerged,above,raised,behindEye};
  });
  assert.deepEqual(result.errors,[]);assert.equal(result.above.count,0);assert.equal(result.behindEye.count,0);
  assert.ok(result.submerged.count>100&&result.raised.count>100,'submerged capture survives the fine wave bands');
  for(const frame of [result.submerged,result.raised])for(const [index,value] of [.3,.2,.1].entries())assert.ok(Math.abs(frame.centre[index]-value)<.0002,'capture stores raw material radiance before air fog');
  assert.ok(Math.abs(result.submerged.centre[3]-10.5)<.01&&Math.abs(result.raised.centre[3]-9.5)<.01,'capture alpha retains metres of forward eye depth');
});
