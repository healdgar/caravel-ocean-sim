// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native anchor expansion preserves physical iron, catenary, splashes and actual Victory bow clearance',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__anchor-expand-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__anchor-expand-gpu');
    const result=await page.evaluate(async()=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{getShipParts}=await import('/js/ship-parts.js');
      const {createAnchorGPUTemplate,writeAnchorGPUState,ANCHOR_GPU_STATE_FLOATS}=await import('/js/anchor.js'),{ANCHOR_GPU_RENDER}=await import('/js/wgsl/anchor.js');
      const {createAnchorCPUReference}=await import('/tests/helpers/anchor-cpu-reference.mjs');
      const {anchorFairlead,anchorEquipment,anchorEyeOffset,createAnchorState,anchorRodePoints}=await import('/js/anchor-state.js'),{boatRotate}=await import('/js/boat.js'),{victoryHullHalfWidth}=await import('/js/models/victory.js');
      let legacyGeometry,legacyPose;
      const referenceDevice={createBuffer:({label})=>({label,destroy(){}}),createRenderPipelineAsync:async()=>({getBindGroupLayout(){}}),createBindGroup:()=>({}),queue:{writeBuffer(buffer,offset,data,start=0,count=data.length){if(buffer.label==='anchor dynamic geometry')legacyGeometry=data.slice(start,start+count);if(buffer.label==='anchor pose')legacyPose=data.slice(start,start+count);}}};
      const reference=await createAnchorCPUReference({device:referenceDevice,shader:async()=>({}),shadows:{bind(){}}}),template=createAnchorGPUTemplate(),unitBoat={modelId:'nina',length:20,beam:6,x:0,z:0,heave:0,heading:0,pitch:0,roll:0};
      reference.update({phase:'anchored',worldHeading:0,position:{x:0,y:0,z:0},rode:0,bed:-16,time:0,splash:null},unitBoat);const unitIron=legacyGeometry.slice(0,template.ironCount*8);
      let unitPosition=0,unitNormal=0;for(let i=0;i<unitIron.length;i+=8){unitPosition=Math.max(unitPosition,Math.hypot(...[0,1,2].map(k=>unitIron[i+k]-template.vertices[i+k])));unitNormal=Math.max(unitNormal,Math.hypot(...[0,1,2].map(k=>unitIron[i+3+k]-template.vertices[i+3+k])));}
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[],rows=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const upload=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const input=upload(template.vertices,B.STORAGE),stateBuffer=upload(new Float32Array(ANCHOR_GPU_STATE_FLOATS),B.STORAGE),poseBuffer=upload(new Float32Array(16),B.UNIFORM),output=device.createBuffer({size:template.totalCount*48,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:output.size,usage:B.COPY_DST|B.MAP_READ});
      const module=device.createShaderModule({code:ANCHOR_GPU_RENDER+`
@group(0)@binding(8)var<storage,read>anchorProbeTemplates:array<f32>;
struct AnchorAnswer{position:vec4f,normal:vec4f,kind:vec4f};
@group(0)@binding(9)var<storage,read_write>anchorAnswers:array<AnchorAnswer>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&anchorAnswers)){return;}let at=id.x*8u;
 let expanded=anchorGPUExpand(vec3f(anchorProbeTemplates[at],anchorProbeTemplates[at+1u],anchorProbeTemplates[at+2u]),vec3f(anchorProbeTemplates[at+3u],anchorProbeTemplates[at+4u],anchorProbeTemplates[at+5u]),vec2f(anchorProbeTemplates[at+6u],anchorProbeTemplates[at+7u]));
 anchorAnswers[id.x]=AnchorAnswer(vec4f(anchorGPUWorld(expanded.position),0),vec4f(anchorGPUNormal(expanded.normal),0),vec4f(expanded.kind,0,0));
}`});
      const compilation=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);if(compilation.length)throw Error(compilation.join('\n'));const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
      for(const model of Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry&&getShipParts(m.id).equipment.anchor!==null)){
        const base={modelId:model.id,model,...model.runtime,x:12,z:-9,heave:.4,heading:27,pitch:0,roll:0},stowed=createAnchorState(base),anchored={phase:'anchored',worldHeading:27,position:{x:9,y:-8,z:-7},rode:35,bed:-8,time:4,splash:null};
        const splash={...anchored,phase:'lowering',position:{x:9,y:0,z:-7},splash:{x:9,y:0,z:-7,at:3.7}},cases=[
          {name:'housed',boat:base,state:stowed},{name:'housed-heeling',boat:{...base,heading:217,pitch:.18,roll:-.21},state:stowed},
          {name:'anchored-a',boat:base,state:anchored},{name:'anchored-b',boat:{...base,heading:154,pitch:.12,roll:-.07},state:anchored},
          {name:'weighing',boat:base,state:{...anchored,phase:'weighing'}},{name:'splash-droplets',boat:base,state:splash},
          {name:'splash-ring',boat:base,state:{...splash,time:4.6}},{name:'splash-expired',boat:base,state:{...splash,time:5.4}},
        ];
        for(const c of cases){
          reference.update(c.state,c.boat);const expected=new Float32Array(legacyGeometry),pose=new Float32Array(legacyPose),commands=new Float32Array(ANCHOR_GPU_STATE_FLOATS),splashCount=writeAnchorGPUState(c.state,c.boat,commands),drawCount=template.solidCount+splashCount,stowed=c.state.phase==='stowed',scale=anchorEquipment(c.boat).renderScale;
          const localBoat=stowed?{...c.boat,x:0,z:0,heave:0,heading:0,pitch:0,roll:0}:c.boat,fairlead=anchorFairlead(localBoat),origin=stowed?[fairlead.x,fairlead.y-anchorEyeOffset(c.boat),fairlead.z]:Object.values(c.state.position),angle=(stowed?0:c.state.worldHeading??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
          // The original unit iron is now a rigid object. Unlike the old CPU
          // tube builder, its circular facet basis rotates with the stock and
          // flukes. Preserve that complete unit shape under one physical pose.
          for(let i=0;i<template.ironCount*8;i+=8){
            const p=[unitIron[i]*scale,unitIron[i+1]*scale,unitIron[i+2]*scale],n=Array.from(unitIron.subarray(i+3,i+6));
            expected.set([cos*p[0]-sin*p[2]+origin[0],p[1]+origin[1],sin*p[0]+cos*p[2]+origin[2],cos*n[0]-sin*n[2],n[1],sin*n[0]+cos*n[2]],i);
          }
          const active=[],knots=anchorRodePoints(stowed?{...c.state,position:{x:origin[0],y:origin[1],z:origin[2]},splash:null}:c.state,localBoat);
          for(let vertex=0;vertex<drawCount;vertex++){
            const at=vertex*8,kind=template.vertices[at+6],segment=Math.round(template.vertices[at]);
            if(kind===4&&Math.hypot(knots[segment+1].x-knots[segment].x,knots[segment+1].y-knots[segment].y,knots[segment+1].z-knots[segment].z)<1e-6)continue;
            active.push(vertex);
          }
          if(active.length!==expected.length/8)throw Error('GPU draw topology differs from physical CPU reference '+model.id+'/'+c.name+': '+active.length+' vs '+expected.length/8);
          device.queue.writeBuffer(stateBuffer,0,commands);device.queue.writeBuffer(poseBuffer,0,pose);
          const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:6,resource:{buffer:poseBuffer}},{binding:7,resource:{buffer:stateBuffer}},{binding:8,resource:{buffer:input}},{binding:9,resource:{buffer:output,size:drawCount*48}}]}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(drawCount/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,drawCount*48);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange()).slice(0,drawCount*12);read.unmap();
          let position=0,normal=0,kindError=0,worstPosition=null,worstNormal=null,minimumBowClearance=null;const transformed=[0,0,0],transformedNormal=[0,0,0],basis=[[1,0,0],[0,1,0],[0,0,1]].map(axis=>{const out=[0,0,0];boatRotate(out,...axis,c.boat.heading*Math.PI/180,c.boat.pitch??0,c.boat.roll??0);return out;});
          for(const [index,vertex]of active.entries()){
            const e=index*8,a=vertex*12;let p=Array.from(expected.subarray(e,e+3)),n=Array.from(expected.subarray(e+3,e+6));
            if(stowed){boatRotate(transformed,...p,c.boat.heading*Math.PI/180,c.boat.pitch??0,c.boat.roll??0);boatRotate(transformedNormal,...n,c.boat.heading*Math.PI/180,c.boat.pitch??0,c.boat.roll??0);p=transformed.map((v,k)=>v+[c.boat.x,c.boat.heave,c.boat.z][k]);n=[...transformedNormal];}
            const dp=Math.hypot(...p.map((v,k)=>actual[a+k]-v)),dn=Math.hypot(...n.map((v,k)=>actual[a+4+k]-v));if(dp>position){position=dp;worstPosition={vertex,kind:template.vertices[vertex*8+6],error:dp};}if(dn>normal){normal=dn;worstNormal={vertex,kind:template.vertices[vertex*8+6],error:dn};}kindError=Math.max(kindError,Math.abs(actual[a+8]-expected[e+6]),Math.abs(actual[a+9]-expected[e+7]));
            if(model.id==='victory'&&stowed&&vertex<template.ironCount){const q=[0,1,2].map(k=>actual[a+k]-[c.boat.x,c.boat.heave,c.boat.z][k]),local=basis.map(axis=>axis.reduce((sum,v,k)=>sum+v*q[k],0)),width=victoryHullHalfWidth(local[2]/(c.boat.length/12),local[1]/model.designFrame.verticalScale)*c.boat.beam/3.6;if(width>0)minimumBowClearance=Math.min(minimumBowClearance??Infinity,Math.abs(local[0])-width);}
          }
          rows.push({model:model.id,name:c.name,drawCount,compared:active.length,position,normal,kindError,worstPosition,worstNormal,minimumBowClearance,finite:actual.every(Number.isFinite),ironHash:await digest(actual.subarray(0,template.ironCount*12))});
        }
      }
      reference.destroy();for(const b of [input,stateBuffer,poseBuffer,output,read])b.destroy();device.destroy();return {errors,unitPosition,unitNormal,rows};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.ok(result.unitPosition<1e-8&&result.unitNormal<1e-8,'static iron must retain the frozen original shape');assert.ok(result.rows.length>=64);
    for(const row of result.rows){assert.ok(row.finite);assert.ok(row.position<=2e-5,row.model+'/'+row.name+' GPU anchor position '+row.position+' '+JSON.stringify(row.worstPosition));assert.ok(row.normal<=1e-4,row.model+'/'+row.name+' GPU anchor normal '+row.normal+' '+JSON.stringify(row.worstNormal));assert.ok(row.kindError<=1e-6);if(row.minimumBowClearance!==null)assert.ok(row.minimumBowClearance>.02,'actual GPU housed iron/stock must clear Victory bow by original 2cm minimum');}
    for(const model of new Set(result.rows.map(row=>row.model)))assert.equal(result.rows.find(row=>row.model===model&&row.name==='anchored-a').ironHash,result.rows.find(row=>row.model===model&&row.name==='anchored-b').ironHash,'deployed '+model+' iron orientation cannot follow the yawing moored hull');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
