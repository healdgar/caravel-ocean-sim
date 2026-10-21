// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root owns execution. Isolated GPU signals distinguish filtering from merely
// hiding a complete island behind atmosphere, vegetation or lower resolution.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('terrain procedurals reject unresolved and oblique crack frequencies before bump shading',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__terrain_filtering',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__terrain_filtering');
    const result=await page.evaluate(async()=>{
      const {TERRAIN,TERRAIN_FILTERING}=await import('/js/wgsl/terrain.js'),{NOISE_WGSL}=await import('/js/wgsl/common.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');
      const d=await adapter.requestDevice(),errors=[];d.onuncapturederror=e=>errors.push(e.error.message);
      const compile=async code=>{const module=d.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      // The complete production module must still compile; the fixture below
      // deliberately removes its lighting and captures unclamped linear values.
      await compile(TERRAIN);
      const code=NOISE_WGSL+TERRAIN_FILTERING+`
struct State {origin:vec4f,stepX:vec4f,stepY:vec4f,controls:vec4f};
@group(0) @binding(0) var<uniform> S:State;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) pixel:vec4f)->@location(0) vec4f{
  let q=S.origin.xy+pixel.x*S.stepX.xy+pixel.y*S.stepY.xy;
  let width=landMaterialFootprint(dpdx(q),dpdy(q));
  let noise=landFilteredNoise(q,width);let raw=gnoise(q);
  let crack=landFilteredFissure(q,width,.025,.11);
  let relief=noise*.14-crack*.065;let hx=dpdx(relief);let hy=dpdy(relief);
  let n=normalize(select(vec3f(0,1,0),vec3f(1,.00001,0),S.controls.x>1.5));
  let bump=landFilteredBump(n,vec3f(1,0,0),vec3f(0,0,1),hx,hy);
  if(S.controls.x>.5){return vec4f(bump,1);}
  return vec4f(noise,raw,crack,width);
}`;
      const W=64,H=64,uniform=d.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const pipeline=await d.createRenderPipelineAsync({layout:'auto',vertex:{module:await compile(code),entryPoint:'vs'},fragment:{module:await compile(code),entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      const target=d.createTexture({size:[W,H],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const render=async(stepX,stepY,mode=0,origin=[1.137,4.213])=>{
        const state=new Float32Array(16);state.set(origin);state.set(stepX,4);state.set(stepY,8);state[12]=mode;d.queue.writeBuffer(uniform,0,state);
        const read=d.createBuffer({size:W*H*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=d.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:W*16},[W,H]);d.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=new Float32Array(read.getMappedRange()).slice();read.unmap();read.destroy();
        const low=[Infinity,Infinity,Infinity,Infinity],high=low.map(()=>-Infinity);let difference=0,finite=true;
        for(let i=0;i<values.length;i+=4)for(let c=0;c<4;c++){low[c]=Math.min(low[c],values[i+c]);high[c]=Math.max(high[c],values[i+c]);finite&&=Number.isFinite(values[i+c]);if(c===0)difference=Math.max(difference,Math.abs(values[i]-values[i+1]));}
        return{low,high,difference,finite};
      };
      const resolved=await render([.01,0],[0,.01]),minified=await render([.75,0],[0,.0001]);
      const shifted=await render([.75,0],[0,.0001],0,[39.713,-18.331]);
      // Both screen axes point along the same material axis: taking only the
      // larger individual derivative underestimates the ellipse's major axis.
      const sheared=await render([.36,0],[.36,0]);
      // The noise lattice remains resolved, but its narrow thresholded cracks
      // already exceed the pixel's frequency limit and must disappear first.
      const narrow=await render([.04,0],[0,.04]);
      const normals=await render([.75,0],[0,.0001],1),conditioned=await render([.01,0],[0,.01],2);
      const higherResolution=await render([.75/8,0],[0,.0001/8]);
      d.destroy();return{errors,resolved,minified,shifted,sheared,narrow,normals,conditioned,higherResolution};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    for(const [key,value]of Object.entries(result))if(key!=='errors')assert.equal(value.finite,true,key+' remains finite');
    assert.ok(result.resolved.difference<1e-6,'resolved noise retains its original contrast');
    assert.ok(result.resolved.high[0]-result.resolved.low[0]>.01,'resolved detail is still visible');
    for(const value of[result.minified,result.shifted,result.sheared]){
      assert.equal(value.low[0],0);assert.equal(value.high[0],0,'unresolved noise converges to zero mean independently of sample phase');
      assert.equal(value.low[2],0);assert.equal(value.high[2],0,'unresolved cracks cannot become a dark plateau');
      assert.ok(value.high[1]-value.low[1]>.01,'raw control really contains sampled high-frequency contrast');
    }
    assert.ok(result.sheared.low[3]>.5,'projected footprint includes both screen-axis contributions');
    assert.ok(result.narrow.difference<1e-6&&result.narrow.high[0]-result.narrow.low[0]>.01,'resolved lattice remains while unresolved cracks fade');
    assert.equal(result.narrow.low[2],0);assert.equal(result.narrow.high[2],0);
    for(const value of[result.normals]){assert.ok(Math.abs(value.low[0])+Math.abs(value.high[0])+Math.abs(value.low[2])+Math.abs(value.high[2])<1e-6);assert.ok(Math.abs(value.low[1]-1)<1e-6&&Math.abs(value.high[1]-1)<1e-6,'unresolved relief cannot perturb the geometric normal');}
    assert.ok(result.conditioned.low[0]>.99999&&result.conditioned.high[1]<.00002,'near-singular bump inverses do not amplify relief');
    assert.ok(result.higherResolution.high[0]-result.higherResolution.low[0]>.01,'more actual pixels restore resolved detail');
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
