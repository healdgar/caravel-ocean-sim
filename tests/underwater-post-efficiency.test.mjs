// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {BLOOM_DOWN,COMPOSITE,createUnderwaterPost} from '../js/wgsl/post.js';

test('underwater post variants tolerate distributed shader formatting and reject unknown inputs',()=>{
  for(const [source,kind]of [[BLOOM_DOWN,'bloom'],[COMPOSITE,'composite']]){
    for(const text of [source,source.replace(/\s+/g,' ').replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g,'$1')]){
      assert.match(createUnderwaterPost(text,kind),/if\(postCameraSea\[9\]-postFrame\.camPos\.y<=\.005\)/);
    }
  }
  assert.throws(()=>createUnderwaterPost('not a post shader','bloom'),/Unrecognized/);
  assert.throws(()=>createUnderwaterPost(COMPOSITE,'unknown'),/Unknown/);
});
import {createDevServer} from '../server.mjs';

// The reference retains the former identity medium copy in air. Both paths
// then run the actual first bloom downsample and final colour transform.
test('GPU-selected underwater post sources preserve pixels across air, water, crossing and resize',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();
    await page.route('**/__underwater-post-efficiency',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__underwater-post-efficiency');
    const result=await page.evaluate(async()=>{
      const {createUnderwaterMedium}=await import('/js/wgsl/underwater.js');
      const {BLOOM_DOWN,COMPOSITE,createUnderwaterPost}=await import('/js/wgsl/post.js');
      const {CASCADES}=await import('/js/wgsl/common.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const half=value=>{
        if(value<0)return half(-value)|32768;if(value===0)return 0;
        const e=Math.floor(Math.log2(value));
        return Math.max(0,Math.min(65535,((e+15)<<10)+Math.round((value/2**e-1)*1024)));
      };
      const makeBuffer=(values,usage)=>{
        const buffer=device.createBuffer({size:values.byteLength,usage:usage|B.COPY_DST});
        device.queue.writeBuffer(buffer,0,values);return buffer;
      };
      const compile=async(code,label)=>{
        const module=device.createShaderModule({code,label});
        const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>label+': '+m.message);
        if(bad.length)throw Error(bad.join('\n'));return module;
      };
      const pipeline=async(code,format,label)=>{
        const module=await compile(code,label);
        return device.createRenderPipelineAsync({label,layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]}});
      };
      const post={
        referenceBloom:await pipeline(BLOOM_DOWN,'rgba16float','reference bloom'),
        selectedBloom:await pipeline(createUnderwaterPost(BLOOM_DOWN,'bloom'),'rgba16float','selected bloom'),
        referenceComposite:await pipeline(COMPOSITE,'rgba8unorm','reference composite'),
        selectedComposite:await pipeline(createUnderwaterPost(COMPOSITE,'composite'),'rgba8unorm','selected composite'),
      };
      const bind=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const frameData=new Float32Array(96);
      frameData[0]=frameData[5]=1;frameData[11]=1;frameData[14]=.05;
      frameData.set([.5,0,0,0],20);frameData.set([0,.4,0,0],24);frameData.set([0,0,1,0],28);
      frameData.set([0,1,0,14],32);frameData[73]=.01;
      // Zero scatter albedo isolates the ordinary view/lighting attenuation;
      // nonuniform captured RGB/depth still exercises the full material path.
      const frame=makeBuffer(frameData,B.UNIFORM),opticsData=new Float32Array([.4,1,-100,0]);
      const optics=makeBuffer(opticsData,B.UNIFORM),probeData=new Float32Array(16),probe=makeBuffer(probeData,B.STORAGE);
      const sun=makeBuffer(new Float32Array([0,0,0,0]),B.STORAGE);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const seaSampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const unitTexture=values=>{
        const texture=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
        device.queue.writeTexture({texture},new Uint16Array(values.map(half)),{bytesPerRow:8},[1,1]);return texture;
      };
      const trans=unitTexture([1,1,1,1]),sky=unitTexture([.02,.03,.05,1]);
      const derivatives=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:derivatives},new Uint16Array(CASCADES*4),{bytesPerRow:8,rowsPerImage:1},[1,1,CASCADES]);
      const compositeValues=new Float32Array([1.35,.1,7,.1,1.05,1.06,0,1]);
      const compositeUniform=makeBuffer(compositeValues,B.UNIFORM);
      const mediumClear=[.125,.25,.5,.75],clearBits=mediumClear.map(half),rows=[];
      const cases=[
        {name:'air',eye:2,water:0,cpu:100,air:true},
        {name:'underwater',eye:-2,water:0,cpu:-100,air:false},
        {name:'GPU surface rose above eye',eye:2,water:4,cpu:-100,air:false},
        {name:'GPU surface dropped below eye',eye:-2,water:-4,cpu:100,air:true},
        {name:'below threshold',eye:0,water:.00499,cpu:100,air:true},
        {name:'exact threshold',eye:0,water:.005,cpu:100,air:true},
        {name:'above threshold',eye:0,water:.00501,cpu:-100,air:false},
      ];
      const readTexture=async(texture,width,height,halfFloat)=>{
        const pixelBytes=halfFloat?8:4,rowBytes=Math.ceil(width*pixelBytes/256)*256;
        const read=device.createBuffer({size:rowBytes*height,usage:B.COPY_DST|B.MAP_READ});
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:rowBytes},[width,height]);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange()),packed=new Uint8Array(width*height*pixelBytes);
        for(let y=0;y<height;y++)packed.set(bytes.subarray(y*rowBytes,y*rowBytes+width*pixelBytes),y*width*pixelBytes);
        read.unmap();read.destroy();return halfFloat?Array.from(new Uint16Array(packed.buffer)):Array.from(packed);
      };
      const difference=(a,b)=>{let changed=0,max=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d)changed++;max=Math.max(max,d);}return {changed,max};};
      for(const samples of [1,4]){
        const medium={
          reference:await pipeline(createUnderwaterMedium({samples,cameraProbe:true}),'rgba16float','reference medium '+samples),
          selected:await pipeline(createUnderwaterMedium({samples,cameraProbe:true,skipAir:true}),'rgba16float','selected medium '+samples),
        };
        for(const [width,height]of [[8,6],[13,9]]){
          const bw=Math.max(1,width>>1),bh=Math.max(1,height>>1);
          const color=(w,h,format='rgba16float',write=false)=>device.createTexture({size:[w,h],format,usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT|T.COPY_SRC|(write?T.COPY_DST:0)});
          const hdr=color(width,height,'rgba16float',true),raw=color(width,height,'rgba16float',true);
          const targets={reference:color(width,height),selected:color(width,height)};
          const blooms={reference:color(bw,bh),selected:color(bw,bh)};
          const composites={reference:color(width,height,'rgba8unorm'),selected:color(width,height,'rgba8unorm')};
          const depth=device.createTexture({size:[width,height],sampleCount:samples,format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
          const hdrPixels=new Uint16Array(width*height*4),rawPixels=new Uint16Array(width*height*4);
          for(let y=0;y<height;y++)for(let x=0;x<width;x++){
            const at=(y*width+x)*4;
            hdrPixels.set([.04+x*.18,.06+y*.22,.03+(x+y)%5*.37,1].map(half),at);
            rawPixels.set([.4+x*.035,.6-y*.013,.2+(x+y)%4*.08,3+(x+y)%3*.2].map(half),at);
          }
          device.queue.writeTexture({texture:hdr},hdrPixels,{bytesPerRow:width*8},[width,height]);
          device.queue.writeTexture({texture:raw},rawPixels,{bytesPerRow:width*8},[width,height]);
          frameData.set([width,height,1/width,1/height],36);device.queue.writeBuffer(frame,0,frameData);
          const bloomUniform=makeBuffer(new Float32Array([1/width,1/height,1,0]),B.UNIFORM);
          const mediumResources=[{buffer:frame},hdr.createView(),depth.createView(),raw.createView(),{buffer:optics},trans.createView(),sky.createView(),sampler,{buffer:sun},derivatives.createView({dimension:'2d-array'}),seaSampler,{buffer:probe}];
          const groups={reference:bind(medium.reference,mediumResources),selected:bind(medium.selected,mediumResources)};
          const bloomGroups={
            reference:bind(post.referenceBloom,[targets.reference.createView(),sampler,{buffer:bloomUniform}]),
            selected:bind(post.selectedBloom,[targets.selected.createView(),sampler,{buffer:bloomUniform},hdr.createView(),{buffer:frame},{buffer:probe}]),
          };
          const compositeGroups={
            reference:bind(post.referenceComposite,[targets.reference.createView(),blooms.reference.createView(),sampler,{buffer:compositeUniform}]),
            selected:bind(post.selectedComposite,[targets.selected.createView(),blooms.selected.createView(),sampler,{buffer:compositeUniform},hdr.createView(),{buffer:frame},{buffer:probe}]),
          };
          for(const setting of cases){
            frameData[17]=setting.eye;device.queue.writeBuffer(frame,0,frameData);
            opticsData[2]=setting.cpu;device.queue.writeBuffer(optics,0,opticsData);
            probeData[9]=setting.water;device.queue.writeBuffer(probe,0,probeData);
            const encoder=device.createCommandEncoder();
            const depthPass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:.05/8,depthLoadOp:'clear',depthStoreOp:'store'}});depthPass.end();
            for(const mode of ['reference','selected']){
              const pass=encoder.beginRenderPass({colorAttachments:[{view:targets[mode].createView(),clearValue:mediumClear,loadOp:'clear',storeOp:'store'}]});
              pass.setPipeline(medium[mode]);pass.setBindGroup(0,groups[mode]);pass.draw(3);pass.end();
              const bloomPass=encoder.beginRenderPass({colorAttachments:[{view:blooms[mode].createView(),clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}]});
              bloomPass.setPipeline(mode==='reference'?post.referenceBloom:post.selectedBloom);bloomPass.setBindGroup(0,bloomGroups[mode]);bloomPass.draw(3);bloomPass.end();
            }
            device.queue.submit([encoder.finish()]);
            const referenceMedium=await readTexture(targets.reference,width,height,true),selectedMedium=await readTexture(targets.selected,width,height,true);
            const referenceBloom=await readTexture(blooms.reference,bw,bh,true),selectedBloom=await readTexture(blooms.selected,bw,bh,true);
            const row={samples,width,height,name:setting.name,air:setting.air,
              medium:difference(referenceMedium,selectedMedium),bloom:difference(referenceBloom,selectedBloom),
              airUntouched:selectedMedium.every((value,i)=>value===clearBits[i%4]),
              referenceAirMatchesHDR:referenceMedium.every((value,i)=>value===hdrPixels[i]),composites:[]};
            for(const strength of [0,.1]){
              compositeValues[1]=strength;device.queue.writeBuffer(compositeUniform,0,compositeValues);
              const compositeEncoder=device.createCommandEncoder();
              for(const mode of ['reference','selected']){
                const pass=compositeEncoder.beginRenderPass({colorAttachments:[{view:composites[mode].createView(),clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}]});
                pass.setPipeline(mode==='reference'?post.referenceComposite:post.selectedComposite);pass.setBindGroup(0,compositeGroups[mode]);pass.draw(3);pass.end();
              }
              device.queue.submit([compositeEncoder.finish()]);
              row.composites.push({strength,...difference(await readTexture(composites.reference,width,height,false),await readTexture(composites.selected,width,height,false))});
            }
            rows.push(row);
          }
          for(const texture of[hdr,raw,depth,...Object.values(targets),...Object.values(blooms),...Object.values(composites)])texture.destroy();bloomUniform.destroy();
        }
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,rows};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.rows.length,28);
    for(const row of result.rows){
      const context=`${row.name}, ${row.samples} depth samples, ${row.width}×${row.height}`;
      assert.equal(row.bloom.changed,0,'first bloom downsample must remain bit-identical: '+context);
      for(const composite of row.composites)assert.equal(composite.changed,0,`final pixels must remain identical with bloom ${composite.strength}: ${context}`);
      if(row.air){
        assert.equal(row.airUntouched,true,'above-water medium must leave its target clear: '+context);
        assert.equal(row.referenceAirMatchesHDR,true,'the former pass really copied the original image in air: '+context);
      }else{
        assert.equal(row.medium.changed,0,'submerged medium must remain bit-identical: '+context);
        assert.equal(row.airUntouched,false,'submerged geometry must produce actual filtered pixels: '+context);
      }
    }
    t.diagnostic(`${result.rows.length} medium/bloom cases; ${result.rows.length*2} final composites compared bit-for-bit.`);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
