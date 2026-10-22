// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('actual wetness compute separates dry open interiors, wet external shells and x-aware yacht floors',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__crew-wetness',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__crew-wetness');
    const result=await page.evaluate(async()=>{
      const {WET_UPDATE,WET_GRID,WET_SEA_SIZE}=await import('/js/wgsl/wetness.js');
      const {DECK_PROFILE,DECK_UPDATE}=await import('/js/wgsl/deck.js');
      const {INTERACTION_TYPES}=await import('/js/wgsl/interaction.js');
      const {proceduralDesign,proceduralDeck,proceduralHullDeck,proceduralHullWidth}=await import('/js/models/procedural.js');
      const {requirePlayableShipModel}=await import('/js/ship-models.js');
      const {modelDeck,modelHullDeck}=await import('/js/hull.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No actual WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,resources=[];
      const buffer=(size,usage)=>{const b=device.createBuffer({size,usage});resources.push(b);return b;};
      const texture=(size,format)=>{const tex=device.createTexture({size,format,usage:T.TEXTURE_BINDING|T.COPY_DST});resources.push(tex);return tex;};
      const compile=async(code,label,entryPoint='main')=>{
        const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint}});
      };
      const production=await compile(WET_UPDATE,'production variable-crew moisture');
      // Execute the original wetness decision against the same production hull
      // helpers for the four qualified models; compare exact GPU state values.
      const start=WET_UPDATE.indexOf('  let p=rig.position;'),end=WET_UPDATE.indexOf('  var water=',start);
      if(start<0||end<start)throw Error('Missing production wetness decision region');
      const original=WET_UPDATE.slice(0,start)+`
  let p=rig.position;let world=wetWorld(p);let floor=deckFloor(p.z);
  let inFootprint=p.z>deckMinZ() && p.z<deckMinZ()+deckLength() && abs(p.x)<deckWidth(p.z)-.10 && p.y>=modelHullDeck(p.z,hull.rig.w)-.08;
  let sheltered=inFootprint && p.z>=wetShelteredStart() && p.y<floor-.08;
`+WET_UPDATE.slice(end).replace('p.y<=floor+rail','p.y<=floor+deckRail(p.z)');
      const reference=await compile(original,'original four-model moisture reference');
      const hull=buffer(256,B.UNIFORM|B.COPY_DST),interaction=buffer(64,B.UNIFORM|B.COPY_DST),mist=buffer(WET_GRID.reduce((a,b)=>a*b)*4,B.STORAGE);
      const levels=texture([WET_SEA_SIZE,WET_SEA_SIZE],'r32float'),wash=texture([1,1],'rgba32float');
      const makeHull=(model,boat)=>{const h=new Float32Array(64);h[0]=h[5]=1;h[10]=-1;h[3]=model.designFrame.verticalScale;h[12]=boat.beam;h[13]=boat.length;h[23]=model.modelCode;device.queue.writeBuffer(hull,0,h);return h;};
      const run=async(pipe,probes,{sea=0,depth=0,rain=0}={})=>{
        const source=new Float32Array(probes.flat()),n=probes.length,points=buffer(source.byteLength,B.STORAGE|B.COPY_DST),state=buffer(n*8,B.STORAGE|B.COPY_SRC),read=buffer(n*8,B.COPY_DST|B.MAP_READ);
        device.queue.writeBuffer(points,0,source);const u=new Float32Array(16);u[6]=.1;u[9]=1;u[15]=rain;device.queue.writeBuffer(interaction,0,u);
        device.queue.writeTexture({texture:levels},new Float32Array(WET_SEA_SIZE*WET_SEA_SIZE).fill(sea),{bytesPerRow:WET_SEA_SIZE*4},[WET_SEA_SIZE,WET_SEA_SIZE]);
        device.queue.writeTexture({texture:wash},new Float32Array([depth,0,0,0]),{bytesPerRow:16},[1,1]);
        const values=[{buffer:hull},{buffer:interaction},{buffer:points},{buffer:state},{buffer:mist},levels.createView(),wash.createView()],bind=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:values.map((resource,binding)=>({binding,resource}))});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(n/64));pass.end();encoder.copyBufferToBuffer(state,0,read,0,n*8);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const result=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return result;
      };
      const ships=[];
      for(const id of ['oseberg','lusoria','taino-canoe','flying-cloud','gipsy-moth-iv']){
        const model=requirePlayableShipModel(id),d=proceduralDesign(id),boat={modelId:id,...model.runtime},sy=model.designFrame.verticalScale,z=d.cockpit?3.4:0;
        makeHull(model,boat);const floor=proceduralDeck(id,z,0),rim=proceduralHullDeck(id,z),y= floor<rim?(floor+rim)/2:floor-.15/sy,x=proceduralHullWidth(id,z,y);
        const probe=(x,y,kind)=>[x,y,z,kind===3?20:1,0,0,kind,1];
        const probes=[probe(0,floor+.02/sy,3),probe(0,floor+.02/sy,0),probe(x,y,0)],sea=Math.max(floor,y)*sy+.12;
        const dry=await run(production,probes,{sea}),flooded=await run(production,probes,{sea,depth:.08}),rain=await run(production,probes,{sea:-10,rain:1});
        ships.push({id,dry,flooded,rain});
      }
      const parity=[];
      for(const id of ['nina','victory','pinta','santa-maria']){
        const model=requirePlayableShipModel(id),boat={modelId:id,...model.runtime},sy=model.designFrame.verticalScale;makeHull(model,boat);
        const probes=[];for(const z of [-3,0,3])for(const x of [-.4,0,.4])for(const height of [-.12,.02,.5])probes.push([x,modelDeck(boat,z)+height/sy,z,1,0,0,0,1]);
        const sea=modelHullDeck(boat,0)*sy+.15,actual=await run(production,probes,{sea,depth:.03,rain:.4}),old=await run(reference,probes,{sea,depth:.03,rain:.4});parity.push({id,equal:actual.every((v,i)=>Object.is(v,old[i]))});
      }
      // Probe production deck functions, including the real internal coaming
      // and stair-opening predicate, rather than duplicating those equations.
      const a=DECK_UPDATE.indexOf('fn deckWorld('),b=DECK_UPDATE.indexOf('const DECK_SIZE=',a);if(a<0||b<a)throw Error('Missing production deck transform functions');
      const helper=INTERACTION_TYPES+DECK_PROFILE+`
@group(0)@binding(0)var<uniform>hull:InteractionHull;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
`+DECK_UPDATE.slice(a,b)+`
@compute @workgroup_size(1)fn fixture(){
 answers[0]=vec4f(deckFloorAt(3.4,0),deckFloorAt(3.4,1),deckRailAt(3.4,0),deckRailAt(3.4,1));
 answers[1]=vec4f(deckInteriorCrest(vec3f(.65,0,3.4),vec3f(.72,0,3.4)),deckInteriorCrest(vec3f(0,0,1.98),vec3f(0,0,2.02)),deckFloorAt(2.1,0),deckWidth(3.4));
}`;
      const pipe=await compile(helper,'production cockpit deck probes','fixture'),model=requirePlayableShipModel('gipsy-moth-iv'),d=proceduralDesign(model.id);makeHull(model,model.runtime);
      const output=buffer(32,B.STORAGE|B.COPY_SRC),read=buffer(32,B.COPY_DST|B.MAP_READ),bind=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:hull}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,read,0,32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const cockpit=Array.from(new Float32Array(read.getMappedRange()));read.unmap();
      const expected={floor:proceduralDeck(d.id,3.4,0),walkway:proceduralDeck(d.id,3.4,1),coaming:d.cockpit.coamingHeight-d.cockpit.floorHeight};
      await device.queue.onSubmittedWorkDone();for(const r of resources)r.destroy();device.destroy();return {ships,parity,cockpit,expected,errors};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    for(const s of result.ships){
      assert.equal(s.dry[0],0,s.id+' dry inner floor never wets boots from external sea');assert.equal(s.dry[2],0,s.id+' inner floorboards remain dry');assert.ok(s.dry[4]>.5,s.id+' external shell still receives sea contact');
      assert.ok(s.flooded[0]>.5&&s.flooded[2]>.5,s.id+' actual deck wash wets crew and floorboards');assert.ok(s.rain[0]>.01,s.id+' exposed actors receive rain');assert.ok(s.dry.concat(s.flooded,s.rain).every(Number.isFinite));
    }
    assert.ok(result.parity.every(s=>s.equal),'legacy four-model wetness GPU outputs remain exact');
    const c=result.cockpit,e=result.expected;assert.ok(Math.abs(c[0]-e.floor)<2e-5&&Math.abs(c[1]-e.walkway)<2e-5);assert.ok(c[1]>c[0]+.3,'side walkway stays above the recessed floor');
    assert.ok(Math.abs(c[2]-e.coaming)<2e-5);assert.ok(c[4]>c[0]+.3&&c[5]< -9999,'side coaming blocks flow while the actual forward stairs remain open');assert.ok(c[6]>c[0]&&c[6]<c[1],'stairs interpolate the authored landing heights');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
