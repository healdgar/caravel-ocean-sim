// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {POSED_VERTEX_LAYOUT,withPosedVesselVertices,createVesselPose} from '../js/vessel-pose.js';

test('posed vertex adapter preserves original material coordinates and rejects unknown layouts',()=>{
  const shader='struct Out{@builtin(position)p:vec4f};@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) material:f32,@location(3) uv:vec2f)->Out{let rig=rigVertex(position,normal,material,uv);let local=position;let normalLocal=normal;return Out(vec4f(rig.position,1));}';
  const posed=withPosedVesselVertices(shader);
  assert.ok(posed.includes('@location(4) posedPosition:vec3f,@location(5) posedNormal:vec3f'));
  assert.ok(posed.includes('let local=position;let normalLocal=normal;'));
  assert.ok(posed.includes('RigVertex(posedPosition,posedNormal,vec3f(hull.size.x/3.6,'));
  assert.equal(POSED_VERTEX_LAYOUT.arrayStride,32);
  assert.deepEqual(POSED_VERTEX_LAYOUT.attributes.map(a=>[a.shaderLocation,a.offset]),[[4,0],[5,16]]);
  assert.throws(()=>withPosedVesselVertices('fn main(){}'),/Unrecognized/);
  assert.throws(()=>withPosedVesselVertices(posed),/Unrecognized|already posed/);
});

test('pose output is per vessel while pipeline sharing, enable gating and GPU-buffer ownership remain explicit',async t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage');
  Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{STORAGE:1,VERTEX:2,COPY_SRC:4}});
  t.after(()=>prior?Object.defineProperty(globalThis,'GPUBufferUsage',prior):delete globalThis.GPUBufferUsage);
  let compiled=0;const buffers=[],groups=[],device={
    createBuffer(desc){const b={...desc,destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    createBindGroup(desc){groups.push(desc);return desc;},
  },pipeline={getBindGroupLayout(){return{};}},computePipe=async()=>{compiled++;return pipeline;};
  const hullA={},hullB={},sourceA={},sourceB={};
  const a=await createVesselPose({device,computePipe,sourceBuffer:sourceA,vertexCount:129,hullUBO:hullA});
  const b=await createVesselPose({device,computePipe,sourceBuffer:sourceB,vertexCount:129,hullUBO:hullB,shared:a.assets});
  assert.equal(compiled,1);assert.equal(a.assets,b.assets);assert.notEqual(a.buffer,b.buffer);
  assert.equal(groups[0].entries[0].resource.buffer,hullA);assert.equal(groups[1].entries[0].resource.buffer,hullB);
  assert.equal(groups[0].entries[1].resource.buffer,sourceA);assert.equal(groups[1].entries[1].resource.buffer,sourceB);
  const calls=[],pass={setPipeline:p=>calls.push(p),setBindGroup:(i,g)=>calls.push(g),dispatchWorkgroups:n=>calls.push(n)};
  assert.equal(a.encode(pass,false),false);assert.deepEqual(calls,[]);
  assert.equal(a.encode(pass),true);assert.equal(calls.at(-1),3);
  a.destroy();a.destroy();assert.equal(a.encode(pass),false);assert.equal(a.buffer.destroyed,true);assert.equal(b.buffer.destroyed,false);
  assert.equal(b.encode(pass),true);b.destroy();
  await assert.rejects(createVesselPose({device,computePipe,sourceBuffer:sourceA,vertexCount:0,hullUBO:hullA}),/positive vertex count/);
  await assert.rejects(createVesselPose({device:{},computePipe,sourceBuffer:sourceA,vertexCount:1,hullUBO:hullA,shared:a.assets}),/another graphics device/);
});

test('native shared ship poses match every direct Niña and Victory vertex and retain original rendering under recoil',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__vessel-pose',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__vessel-pose');
    const result=await page.evaluate(async()=>{
      const {createVesselPose,withPosedVesselVertices,POSED_VERTEX_LAYOUT}=await import('/js/vessel-pose.js');
      const {VESSEL_RIG}=await import('/js/wgsl/vessel.js'),{CARAVEL}=await import('/js/wgsl/caravel.js');
      const {createShipAssetCache}=await import('/js/ship-mesh.js');
      const {createLateenPoses,writeLateenUniform}=await import('/js/lateen.js');
      const {boatRotate}=await import('/js/boat.js'),{vesselVerticalScale}=await import('/js/hull.js');
      const {createGunRecoilMap,updateGunRecoilVertices}=await import('/js/gunnery-models.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,W=256,H=256;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);if(bad.length)throw Error(label+': '+bad.join('\n'));return module;};
      const computePipe=async(code,label)=>device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}});
      const reference=await computePipe(VESSEL_RIG+`
@group(0)@binding(0)var<uniform>hull:Hull;
@group(0)@binding(1)var<storage,read>raw:array<f32>;
@group(0)@binding(2)var<storage,read_write>answer:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 let at=i.x*9u;if(at+8u>=arrayLength(&raw)){return;}
 let direct=rigVertex(vec3f(raw[at],raw[at+1u],raw[at+2u]),vec3f(raw[at+3u],raw[at+4u],raw[at+5u]),raw[at+6u],vec2f(raw[at+7u],raw[at+8u]));
 answer[i.x*2u]=vec4f(direct.position,0);answer[i.x*2u+1u]=vec4f(direct.normal,0);
}`,'independent direct ship deformation');
      const fragment=`
@fragment fn poseParityFS(in:BoatVertex)->@location(0)vec4f {
 let rawDetail=.5+.5*sin(in.local.x*.73+in.local.y*.17+in.local.z*.19+dot(in.normalLocal,vec3f(.7,.2,.4)));
 let clothDetail=fract(in.uv.x*.11+in.uv.y*.17);
 let material=f32(in.material%7u)/7.0;
 return vec4f(clamp(abs(in.normal)*.6+vec3f(rawDetail,clothDetail,material)*.25+in.wet.x*.01,vec3f(0),vec3f(1)),1);
}`;
      // Production vertex entry and all canonical rig code remain intact;
      // an inspectable fragment exposes local/normal/UV/material preservation.
      const vertexSource=CARAVEL+fragment;
      const rawLayout={arrayStride:36,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32'},{shaderLocation:3,offset:28,format:'float32x2'}]};
      const renderPipelines=[];
      for(const posed of [false,true]){
        const module=await shader(posed?withPosedVesselVertices(vertexSource):vertexSource,'actual ship vertex rendering');
        renderPipelines.push(await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs',buffers:[rawLayout,...(posed?[POSED_VERTEX_LAYOUT]:[])]},fragment:{module,entryPoint:'poseParityFS',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'}}));
      }
      const color=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const depth=device.createTexture({size:[W,H],format:'depth32float',usage:T.RENDER_ATTACHMENT});
      const pixelRead=device.createBuffer({size:W*H*4,usage:B.COPY_DST|B.MAP_READ});
      const cache=createShipAssetCache(),results=[];let shared=null;
      for(const modelId of ['nina','victory']){
        const asset=cache.get(modelId),rawData=new Float32Array(asset.vertices),vertexCount=rawData.length/9,size=vertexCount*32;
        const model={modelId,length:modelId==='victory'?56.69:20,beam:modelId==='victory'?15.85:6};
        const sourceA=buffer(rawData,B.VERTEX|B.STORAGE),sourceB=buffer(asset.vertices,B.VERTEX|B.STORAGE);
        const hullA=buffer(new Float32Array(52),B.UNIFORM),hullB=buffer(new Float32Array(52),B.UNIFORM);
        const poseA=await createVesselPose({device,computePipe,sourceBuffer:sourceA,vertexCount,hullUBO:hullA,shared});shared=poseA.assets;
        const poseB=await createVesselPose({device,computePipe,sourceBuffer:sourceB,vertexCount,hullUBO:hullB,shared});
        const direct=device.createBuffer({size,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:size*2,usage:B.COPY_DST|B.MAP_READ});
        const refGroup=device.createBindGroup({layout:reference.getBindGroupLayout(0),entries:[hullA,sourceA,direct].map((b,binding)=>({binding,resource:{buffer:b}}))});
        const cases=[
          {label:'full',set:[1,1,1],fill:1,side:-1,pressure:1,time:.3,rudder:0,pitch:.02,roll:.08},
          {label:'reef',set:[.25,.5,.7],fill:.8,side:1,pressure:1,time:7.2,rudder:24,pitch:-.12,roll:-.18},
          {label:'luff',set:[1,1,1],fill:0,side:-1,pressure:.2,time:11.7,rudder:-30,pitch:.09,roll:.22},
          {label:'transfer',set:[.012,.05,.3],fill:.1,side:.15,pressure:-.6,time:16.1,rudder:7,dip:.65,pitch:-.03,roll:-.13},
          {label:'furled',set:[0,0,0],fill:0,side:1,pressure:1,time:27.3,rudder:-16,pitch:.13,roll:.02},
          {label:'recoil',set:[1,.7,.9],fill:.9,side:1,pressure:-1,time:30.7,rudder:12,pitch:-.07,roll:.11},
        ];
        let maxPositionError=0,maxNormalError=0,compared=0,lastValues,h;
        const recoil=createGunRecoilMap(asset);let recoilVertices=0;
        for(const [caseIndex,c]of cases.entries()){
          h=new Float32Array(52);h[3]=vesselVerticalScale(model);h[12]=model.beam;h[13]=model.length;h[15]=c.rudder;h[19]=c.time;h[21]=14;h[22]=1;h[23]=Number(modelId==='victory');
          boatRotate(h.subarray(0,3),1,0,0,.42,c.pitch,c.roll);boatRotate(h.subarray(4,7),0,1,0,.42,c.pitch,c.roll);boatRotate(h.subarray(8,11),0,0,-1,.42,c.pitch,c.roll);
          h[28]=c.side*.32;h[29]=c.side*.48;h[32]=c.side*.8;h[33]=-.45;h[34]=14;
          const rig=createLateenPoses(c.set,c.side);rig.forEach((p,i)=>Object.assign(p,{opening:.6,dip:c.dip??0,fill:c.fill,pressure:c.pressure}));writeLateenUniform(h,{rig});
          if(c.label==='recoil'){
            const gun=recoil.guns[0];const ranges=updateGunRecoilVertices(recoil,rawData,new Map([[gun.id,modelId==='victory'?.7:.055]]),model);
            recoilVertices=gun.indices.length;for(const r of ranges)device.queue.writeBuffer(sourceA,r.byteOffset,rawData.buffer,r.byteOffset,r.byteLength);
          }
          device.queue.writeBuffer(hullA,0,h);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
          poseA.encode(pass);pass.setPipeline(reference);pass.setBindGroup(0,refGroup);pass.dispatchWorkgroups(Math.ceil(vertexCount/64));pass.end();
          encoder.copyBufferToBuffer(poseA.buffer,0,read,0,size);encoder.copyBufferToBuffer(direct,0,read,size,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const values=new Float32Array(read.getMappedRange());
          for(let i=0;i<vertexCount;i++)for(let k=0;k<3;k++){
            const a=values[i*8+k],b=values[size/4+i*8+k],an=values[i*8+4+k],bn=values[size/4+i*8+4+k];
            if(![a,b,an,bn].every(Number.isFinite))throw Error(modelId+' '+c.label+' nonfinite posed vertex');
            maxPositionError=Math.max(maxPositionError,Math.abs(a-b));maxNormalError=Math.max(maxNormalError,Math.abs(an-bn));
          }
          compared+=vertexCount;if(caseIndex===cases.length-1)lastValues=values.slice(0,size/4);read.unmap();
        }
        const hb=new Float32Array(h);hb[15]=-h[15];hb[28]=-.2;hb[29]=-.35;hb[19]+=1.7;hb[24]=.2;hb[25]=.4;hb[26]=.6;device.queue.writeBuffer(hullB,0,hb);
        const otherEncoder=device.createCommandEncoder(),otherPass=otherEncoder.beginComputePass();poseB.encode(otherPass);otherPass.end();
        otherEncoder.copyBufferToBuffer(poseA.buffer,0,read,0,size);otherEncoder.copyBufferToBuffer(poseB.buffer,0,read,size,size);device.queue.submit([otherEncoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const others=new Float32Array(read.getMappedRange());let independentDifference=0,retainedDifference=0;
        for(let i=0;i<size/4;i++){retainedDifference=Math.max(retainedDifference,Math.abs(lastValues[i]-others[i]));independentDifference=Math.max(independentDifference,Math.abs(others[i]-others[size/4+i]));}
        read.unmap();
        const f=new Float32Array(96);f[0]=modelId==='victory'?.035:.10;f[5]=modelId==='victory'?.025:.075;f[8]=modelId==='victory'?.012:.035;f[10]=.002;f[13]=-.65;f[14]=.5;f[15]=1;
        const frame=buffer(f,B.UNIFORM),wet=buffer(new Float32Array([.25,.1]),B.STORAGE),lookup=buffer(new Uint32Array(vertexCount),B.STORAGE),indices=buffer(asset.indices,B.INDEX);
        const images=[];
        for(const [posed,pipeline]of renderPipelines.entries()){
          const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:6,resource:{buffer:hullA}},{binding:13,resource:{buffer:wet}},{binding:14,resource:{buffer:lookup}}]});
          const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}});
          pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setVertexBuffer(0,sourceA);if(posed)pass.setVertexBuffer(1,poseA.buffer);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(asset.indices.length);pass.end();
          encoder.copyTextureToBuffer({texture:color},{buffer:pixelRead,bytesPerRow:W*4},[W,H]);device.queue.submit([encoder.finish()]);await pixelRead.mapAsync(GPUMapMode.READ);images.push(new Uint8Array(pixelRead.getMappedRange()).slice());pixelRead.unmap();
        }
        let different=0,maxPixelError=0,covered=0;
        for(let i=0;i<W*H*4;i++){const delta=Math.abs(images[0][i]-images[1][i]);if(delta)different++;maxPixelError=Math.max(maxPixelError,delta);if(i%4===3&&images[0][i])covered++;}
        poseA.destroy();const companionSurvives=poseB.encode({setPipeline(){},setBindGroup(){},dispatchWorkgroups(){}});poseB.destroy();
        for(const resource of [sourceA,sourceB,hullA,hullB,direct,read,frame,wet,lookup,indices])resource.destroy();
        results.push({modelId,vertexCount,compared,maxPositionError,maxNormalError,recoilVertices,independentDifference,retainedDifference,companionSurvives,different,maxPixelError,covered});
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,results};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    for(const r of result.results){
      assert.equal(r.compared,r.vertexCount*6);assert.ok(r.vertexCount>50000);
      assert.ok(r.maxPositionError<2e-6,r.modelId+' all-vertex position parity');assert.ok(r.maxNormalError<2e-6,r.modelId+' all-vertex normal parity');
      assert.ok(r.recoilVertices>20,r.modelId+' must exercise mutable cannon geometry');
      assert.equal(r.retainedDifference,0,r.modelId+' companion writes cannot alter player pose');assert.ok(r.independentDifference>.01,r.modelId+' companion has its own sail/helm pose');assert.equal(r.companionSurvives,true);
      assert.ok(r.covered>100,r.modelId+' parity rendering must draw the actual ship');
      assert.equal(r.different,0,r.modelId+' actual production vertex output must render identical material coordinates and normals');
    }
    await page.close();
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
