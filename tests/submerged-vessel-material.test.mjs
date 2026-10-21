// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {CARAVEL} from '../js/wgsl/caravel.js';
import {createSubmergedShader} from '../js/water-optics.js';

test('submerged vessel material opts in through one exact marker without changing vertex deformation',()=>{
  const captured=createSubmergedShader(CARAVEL,'fs','in.world');
  assert.ok(CARAVEL.includes('const vesselWaterCapture=false;'));
  assert.ok(captured.includes('const vesselWaterCapture=true;'));
  assert.equal(captured.includes('const vesselWaterCapture=false;'),false);
  const vertex=/@vertex fn vs\([^]*?\n}/.exec(CARAVEL)?.[0];
  assert.ok(vertex&&captured.includes(vertex),'capture uses the unchanged posed vertex/normal path');
  assert.throws(()=>createSubmergedShader(CARAVEL.replace('const vesselWaterCapture=false;','const vesselWaterCapture = false;'),'fs','in.world'),/Unrecognized vessel water capture marker/);
  assert.throws(()=>createSubmergedShader(CARAVEL+'\nconst vesselWaterCapture=false;','fs','in.world'),/Unrecognized vessel water capture marker/);
  const unrelated='struct FStub {screen:vec4f};var<private>F:FStub;@fragment fn fs()->@location(0)vec4f{return vec4f(1);}';
  assert.equal(createSubmergedShader(unrelated,'fs','vec3f(0)').includes('const vesselWaterCapture=true;'),false,'unrelated captures do not acquire vessel material policy');
});

test('native ordinary/captured vessel helpers preserve absorption, share hull/rudder medium optics and remove submerged air films',{timeout:120000},async()=>{
  const port=process.env.SUBMERGED_VESSEL_TEST_PORT||8159;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Submerged vessel fixture server exited '+code);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__submerged-vessel',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`http://localhost:${port}/__submerged-vessel`);
    const result=await page.evaluate(async()=>{
      const {CARAVEL}=await import('/js/wgsl/caravel.js'),{createSubmergedShader}=await import('/js/water-optics.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const tail=`
@group(0)@binding(15)var<storage,read_write>mediumResults:array<vec4f>;
@compute @workgroup_size(8)fn mediumProbe(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=8u){return;}
 let material=select(14u,15u,i.x>=4u);let absorbed=select(0.0,0.7,(i.x&2u)!=0u);let film=f32(i.x&1u);
 let wood=vesselWoodOptics(0.86,absorbed,film,0.24,0.2);
 let iron=vesselIronSurface(vec3f(0.17,0.29,0.43),0.15,vesselAirFilm(film));
 mediumResults[i.x*2u]=wood;
 mediumResults[i.x*2u+1u]=vec4f(iron.film,select(0.0,1.0,vesselWoodMaterial(material,false)),
   select(0.0,1.0,vesselWoodMaterial(3u,false)),select(0.0,1.0,vesselWoodMaterial(8u,false)));
}`;
      const B=GPUBufferUsage,size=8*2*16,rows=[];
      // Both modules include the actual production fragment entry points. The
      // compute entry isolates their shared optical helpers; it is not a scene
      // or refraction-image quality test, which still needs rendered validation.
      for(const source of [CARAVEL,createSubmergedShader(CARAVEL,'fs','in.world')]){
        const module=device.createShaderModule({code:source+tail});
        errors.push(...(await module.getCompilationInfo()).messages.filter(e=>e.type==='error').map(e=>e.message));
        const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'mediumProbe'}});
        const output=device.createBuffer({size,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:15,resource:{buffer:output}}]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        rows.push(Array.from(new Float32Array(read.getMappedRange())));read.unmap();output.destroy();read.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return{errors,rows};
    });
    assert.deepEqual(result.errors,[]);
    const [air,water]=result.rows.map(row=>Array.from({length:8},(_,i)=>row.slice(i*8,i*8+8)));
    const expectedWaterF0=((1.5-1.333)/(1.5+1.333))**2;
    for(let i=0;i<8;i++){
      assert.ok([...air[i],...water[i]].every(Number.isFinite));
      assert.ok(Math.abs(air[i][2]-.04)<1e-7);
      assert.ok(Math.abs(water[i][2]-expectedWaterF0)<1e-7,'relative index sets submerged wood reflectance');
      assert.ok(water[i][2]<air[i][2]/8,'submersion does not keep the air-side dielectric reflection');
      assert.equal(water[i][0],air[i][0],'absorbed moisture darkening survives capture');
      assert.equal(water[i][3],0,'no outer water-air timber film exists when immersed');
      assert.equal(water[i][4],0,'no outer water-air iron film exists when immersed');
      assert.deepEqual(water[i].slice(5),[1,0,0],'hull/rudder remain timber while iron is not misclassified');
      if(i&1)assert.ok(air[i][3]>0&&air[i][4]>0,'ordinary wet surfaces retain their film response');
    }
    for(const base of [0,2,4,6]){
      assert.deepEqual(water[base],water[base+1],'a film-only state change cannot varnish an immersed surface');
      assert.ok(air[base+1][1]<air[base][1],'the same film still smooths an air-side wet surface');
    }
    for(let i=0;i<4;i++)assert.deepEqual(water[i],water[i+4],'material14 rudder and15 hull share medium policy without changing their finish tags');
    assert.ok(water[2][0]<water[0][0],'soaked wood remains darker than dry wood');
    await page.close();
  }finally{await browser?.close();server.kill();}
});
