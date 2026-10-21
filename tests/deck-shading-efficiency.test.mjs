// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('deck-water rejection preserves native shaded pixels while avoiding lighting for empty sheets and runoff',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__deck-efficiency',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__deck-efficiency');
    const result=await page.evaluate(async()=>{
      const {DECK_RENDER,DECK_COLS:DW,DECK_ROWS:DH}=await import('/js/wgsl/deck.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,W=128,H=128;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const frameData=new Float32Array(96),hullData=new Float32Array(24),shadowData=new Float32Array(28);
      for(const i of [0,5,10,15])frameData[i]=1;
      frameData.set([0,5,6,1.3],16);frameData.set([.3,.8,.52,1.1],32);
      frameData.set([W,H,1/W,1/H],36);frameData[72]=3;frameData[73]=.005;
      frameData.set([.0001,.0001,.0001,0],88);
      hullData[0]=hullData[5]=1;hullData[10]=-1;hullData[3]=1.667;hullData[12]=6;hullData[13]=20;
      shadowData[0]=shadowData[5]=shadowData[10]=.08;shadowData[14]=.5;shadowData[15]=1;
      shadowData[19]=1;shadowData.set([.3,.8,.52,20],20);shadowData.set([.1,.1,0,0],24);
      const frame=buffer(frameData,B.UNIFORM),hull=buffer(hullData,B.UNIFORM),shadow=buffer(shadowData,B.UNIFORM);
      const params=buffer(new Float32Array(4),B.UNIFORM),counter=buffer(new Uint32Array(4),B.STORAGE|B.COPY_SRC);
      const sun=buffer(new Float32Array([1,1,1,1]),B.STORAGE);
      const deck=device.createTexture({size:[DW,DH],format:'rgba32float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const env=device.createTexture({size:[8,8,6],mipLevelCount:4,format:'rgba16float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const trans=device.createTexture({size:[16,16],format:'rgba16float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const sky=device.createTexture({size:[16,16],format:'rgba16float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const depth=()=>device.createTexture({size:[16,16],format:'depth32float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const solid=depth(),canvas=depth();
      const transmission=device.createTexture({size:[16,16],format:'rgba16float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});
      const compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'});
      const fill=device.createCommandEncoder();
      const clear=(texture,color,extra={})=>{const p=fill.beginRenderPass({colorAttachments:[{view:texture.createView(extra),clearValue:color,loadOp:'clear',storeOp:'store'}]});p.end();};
      for(let face=0;face<6;face++)for(let mip=0;mip<4;mip++)clear(env,[.16+face*.013,.22+face*.011,.29,1],{dimension:'2d',baseArrayLayer:face,arrayLayerCount:1,baseMipLevel:mip,mipLevelCount:1});
      clear(trans,[.7,.8,.9,1]);clear(sky,[.13,.2,.28,1]);clear(transmission,[.35,.5,.7,1]);
      for(const texture of [solid,canvas]){const p=fill.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:texture.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});p.end();}
      device.queue.submit([fill.finish()]);
      const early=/  \/\/ Finish quad derivatives[\s\S]*?(?=  if\(curtain\)\{n=normalize\(face)/;
      const reference=DECK_RENDER.replace(early,'').replace('  if(alpha<0.003){discard;}\n  return vec4f(surfaceAir(color',
        '  if(abs((in.local.y-deckFloor(in.local.z))*shipY(hull.right.w)-w.x-0.008)>0.10 && !curtain){discard;}\n  if(alpha<0.003){discard;}\n  return vec4f(surfaceAir(color');
      if(reference===DECK_RENDER||early.test(reference))throw Error('Missing legacy deck shading reference');
      // Real production fragment code; a diagnostic vertex entry isolates UV,
      // cabin-gap and curtain boundaries without altering fluid/material code.
      const fixture=`
@group(2)@binding(0)var<storage,read_write>efficiencyCount:array<atomic<u32>>;
@group(2)@binding(1)var<uniform>efficiencyParameters:vec4f;
@vertex fn efficiencyVS(@builtin(vertex_index)i:u32)->DeckVertex {
 let cell=i/6u;
 let uv=(vec2f(f32(cell%128u),f32(cell/128u))+corner(i%6u))/128.0;
 let clip=uv*2.0-1.0;let water=sampleDeck(uv);
 var point=deckPoint(uv);point.y+=(.008+water.x+efficiencyParameters.y)/shipY(hull.right.w);
 var out:DeckVertex;out.pos=vec4f(clip,.5,1);out.uv=uv;out.local=point;
 out.world=deckWorld(point);out.curtain=vec2f(0);
 if(efficiencyParameters.x>.5){out.curtain=vec2f(uv.y+efficiencyParameters.z,water.w);}
 return out;
}`;
      const pipelines=[];
      for(const code of [reference,DECK_RENDER]){
        const instrumented=code.replace('  let reflection=textureSampleLevel(envCube',
          '  atomicAdd(&efficiencyCount[0],1u);\n  let reflection=textureSampleLevel(envCube')+fixture;
        const module=device.createShaderModule({code:instrumented,label:'production deck shading parity'});
        const info=await module.getCompilationInfo();const bad=info.messages.filter(m=>m.type==='error').map(m=>m.message);if(bad.length)throw Error(bad.join('\n'));
        const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'efficiencyVS'},fragment:{module,entryPoint:'washFS',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});
        const resources=[{buffer:frame},{buffer:hull},deck.createView(),sampler,env.createView({dimension:'cube'}),trans.createView(),{buffer:sun},sky.createView()];
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
        const shadowGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{buffer:shadow},solid.createView(),compare,canvas.createView(),transmission.createView(),sampler].map((resource,binding)=>({binding,resource}))});
        const fixtureGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[{binding:0,resource:{buffer:counter}},{binding:1,resource:{buffer:params}}]});
        pipelines.push({pipeline,groups:[group,shadowGroup,fixtureGroup]});
      }
      const output=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const read=device.createBuffer({size:W*H*4+256,usage:B.COPY_DST|B.MAP_READ});
      const cases=[
        {name:'dry',depth:()=>0,parameters:[0,0,0,0],expectEmpty:true},
        {name:'partial',depth:(x,y)=>x<DW*.45?0:.0003+.10*(x/DW-.45),parameters:[0,0,0,0]},
        {name:'boarding',depth:(x,y)=>.03+.18*(1-y/DH),parameters:[0,0,0,0]},
        {name:'runoff',depth:()=>.06,flow:x=>x<DW*.45?0:.12,parameters:[1,0,.001,0]},
        {name:'runoff-tail',depth:()=>.06,flow:()=>.12,parameters:[1,0,1,0],expectEmpty:true},
        {name:'cabin-gap',depth:()=>.06,parameters:[0,2,0,0],expectEmpty:true},
        {name:'cabin-boundary',depth:x=>.06,parameters:[0,.099,0,0]},
      ];
      const results=[];
      for(const c of cases){
        const pixels=new Float32Array(DW*DH*4);
        for(let y=0;y<DH;y++)for(let x=0;x<DW;x++)pixels.set([c.depth(x,y),.35,.8,c.flow?.(x,y)??0],(y*DW+x)*4);
        device.queue.writeTexture({texture:deck},pixels,{bytesPerRow:DW*16},[DW,DH]);device.queue.writeBuffer(params,0,new Float32Array(c.parameters));
        const captures=[];
        for(const setup of pipelines){
          device.queue.writeBuffer(counter,0,new Uint32Array(4));const encoder=device.createCommandEncoder();
          const pass=encoder.beginRenderPass({colorAttachments:[{view:output.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
          pass.setPipeline(setup.pipeline);setup.groups.forEach((g,i)=>pass.setBindGroup(i,g));pass.draw(W*H*6);pass.end();
          encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:W*4},[W,H]);encoder.copyBufferToBuffer(counter,0,read,W*H*4,16);
          device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const bytes=new Uint8Array(read.getMappedRange());captures.push({pixels:new Uint8Array(bytes.slice(0,W*H*4)),lighting:new Uint32Array(bytes.buffer,bytes.byteOffset+W*H*4,4)[0]});read.unmap();
        }
        let different=0,maxDifference=0,accepted=0;
        for(let i=0;i<W*H*4;i++){const delta=Math.abs(captures[0].pixels[i]-captures[1].pixels[i]);if(delta)different++;maxDifference=Math.max(maxDifference,delta);if(i%4===3&&captures[1].pixels[i]>0)accepted++;}
        results.push({name:c.name,expectEmpty:!!c.expectEmpty,different,maxDifference,accepted,beforeLighting:captures[0].lighting,afterLighting:captures[1].lighting});
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,results,W,H};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    for(const c of result.results){
      assert.equal(c.different,0,c.name+' must retain byte-identical shaded output');
      if(c.expectEmpty){assert.equal(c.accepted,0,c.name+' must remain transparent');assert.equal(c.afterLighting,0,c.name+' must avoid all material lighting');}
      else assert.ok(c.accepted>100,c.name+' must exercise actual wet output');
      assert.ok(c.beforeLighting>=c.afterLighting,c.name+' cannot add lighting invocations');
    }
    for(const name of ['dry','partial','runoff','runoff-tail','cabin-gap']){
      const c=result.results.find(c=>c.name===name);assert.ok(c.beforeLighting>c.afterLighting,name+' must eliminate proven invisible shading');
    }
    await page.close();
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
