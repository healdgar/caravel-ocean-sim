// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {withCachedOceanLighting} from '../js/wgsl/ocean-lighting.js';
import {OCEAN,createOpticalOcean} from '../js/wgsl/ocean.js';
import {COASTAL_WATER} from '../js/wgsl/terrain.js';

// Match build.mjs's shader-template compaction, including block comments.
const compactOceanWGSL=source=>source.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/\/\/[^\n]*/g,' ')
  .replace(/\s+/g,' ').replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g,'$1').trim();

test('ocean lighting specialization changes only frame-wide values and survives WGSL minification',()=>{
  const sources=[OCEAN,createOpticalOcean('',true,true,true)];
  for(const depthFirst of [false,true])for(const surfaceWaves of [false,true])for(const cameraProbe of [false,true])
    sources.push(createOpticalOcean(COASTAL_WATER,depthFirst,surfaceWaves,cameraProbe));
  for(const original of sources)for(const compact of [false,true]){
    const source=compact?compactOceanWGSL(original):original;
    const cached=withCachedOceanLighting(source);
    assert.match(cached,/sunVis:array<f32,16>/);
    assert.ok(cached.includes('let sunlight=vec3f(sunVis[4],sunVis[5],sunVis[6]);'));
    assert.ok(cached.includes('let skyUp=vec3f(sunVis[8],sunVis[9],sunVis[10]);'));
    assert.ok(cached.includes('let skyHemi=vec3f(sunVis[12],sunVis[13],sunVis[14]);'));
    assert.ok(cached.includes('let skyN = textureSampleLevel(envCube')||cached.includes('let skyN=textureSampleLevel(envCube'),'normal-dependent irradiance stays per fragment');
    assert.equal((cached.match(/sunVis\[0\]/g)||[]).length,(source.match(/sunVis\[0\]/g)||[]).length-1,'all other solar visibility uses stay unchanged');
    if(original.includes(COASTAL_WATER))assert.ok(cached.includes(compact?compactOceanWGSL(COASTAL_WATER):COASTAL_WATER),'coastal helper lighting and bindings remain byte-identical');
  }
  assert.throws(()=>withCachedOceanLighting(OCEAN.replace('skyUp * 0.4','skyUp * 0.5')),/skyHemi/);
  assert.throws(()=>withCachedOceanLighting(OCEAN.replace('sunVis: array<f32, 4>','sunVis: array<f32, 8>')),/visibility/);
  assert.throws(()=>withCachedOceanLighting(withCachedOceanLighting(OCEAN)),/visibility/);
});

test('ocean light specialization ignores helper names and comment braces but guards fragment formulas',()=>{
  const helper='fn unrelatedOceanLight()->vec3f{let sunlight=sunIlluminance()*sunVis[0];return sunlight;}';
  const coast=createOpticalOcean(COASTAL_WATER,true,true,true);
  const source=helper+'\n'+coast.replace('@fragment fn fs(',
    '// @fragment fn fs(in:VSOut)->@location(0) vec4f {\n@fragment fn fs(')
    .replace('let sunlight = sunIlluminance()',
      '/* unmatched } { { ; let sunlight=0; */ let sunlight = sunIlluminance()');
  for(const original of [source,compactOceanWGSL(source)]){
    const cached=withCachedOceanLighting(original);
    assert.ok(cached.includes(helper),'unrelated canonical-looking helper remains unchanged');
    const changed=original.replace(/let\s+sunlight\s*=\s*sunIlluminance\(\)\s*\*\s*sunVis\[0\];/g,
      (match,offset)=>offset<original.indexOf('@fragment')?match:match.replace('sunVis[0]','sunVis[0]*.9'));
    assert.throws(()=>withCachedOceanLighting(changed),/sunlight/,'helper cannot conceal a changed fragment formula');
  }
  assert.throws(()=>withCachedOceanLighting(OCEAN.replace('@fragment fn fs(', '@fragment fn other(')),/fragment/);
  assert.throws(()=>withCachedOceanLighting(OCEAN+'\n@fragment fn fs(in:VSOut)->@location(0) vec4f{return vec4f(0);}'),/fragment/);
});

test('native frame-wide light cache matches original atmosphere/environment formulas and complete ocean pixels',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__ocean-lighting',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__ocean-lighting');
    const result=await page.evaluate(async()=>{
      const {OCEAN_LIGHTING,withCachedOceanLighting}=await import('/js/wgsl/ocean-lighting.js');
      const {OCEAN}=await import('/js/wgsl/ocean.js');
      const {FRAME_WGSL,ATMO_CORE_WGSL,ENV_MIPS}=await import('/js/wgsl/common.js');
      const {SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,W=64,H=64,GRID=8;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);if(bad.length)throw Error(label+': '+bad.join('\n'));return module;};
      const frame=buffer(new Float32Array(96),B.UNIFORM),sun=buffer(new Float32Array(16),B.STORAGE|B.COPY_SRC);
      const answer=buffer(new Float32Array(16),B.STORAGE|B.COPY_SRC),valueRead=device.createBuffer({size:128,usage:B.COPY_DST|B.MAP_READ});
      const half=value=>{
        const scratch=new Float32Array([value]),bits=new Uint32Array(scratch.buffer)[0],sign=(bits>>>16)&0x8000;
        const exponent=((bits>>>23)&255)-127+15,mantissa=bits&0x7fffff;
        if(exponent<=0)return sign;if(exponent>=31)return sign|0x7c00;
        return sign|(exponent<<10)|((mantissa+0x1000)>>>13);
      };
      const texture=(w,h,layers=1,mips=1)=>device.createTexture({size:[w,h,layers],mipLevelCount:mips,format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const write=(texture,w,h,face,mip,colour)=>{
        const values=new Uint16Array(w*h*4);
        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
          const rgb=colour(x,y);for(let c=0;c<4;c++)values[(y*w+x)*4+c]=half(rgb[c]);
        }
        device.queue.writeTexture({texture,origin:[0,0,face],mipLevel:mip},values,{bytesPerRow:w*8},[w,h]);
      };
      const trans=texture(32,16),sky=texture(16,16),environment=texture(256,256,6,ENV_MIPS);
      const displacement=texture(2,2,6),derivatives=texture(2,2,6),moments=texture(2,2,6),foam=texture(16,16),worldFoam=texture(2,2,2),wake=texture(2,2);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});
      const repeat=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const envView=environment.createView({dimension:'cube'}),transView=trans.createView(),skyView=sky.createView();
      write(sky,16,16,0,0,(x,y)=>[.1+x*.003,.15+y*.004,.21+(x+y)*.002,1]);
      write(foam,16,16,0,0,(x,y)=>[.2+x*.02,.25+y*.025,.35+(x+y)*.005,.8]);
      for(let layer=0;layer<6;layer++){
        write(displacement,2,2,layer,0,()=>[0,0,0,0]);
        write(derivatives,2,2,layer,0,()=>[.01*(layer-2),.007*(layer-2),-.015,-.01]);
        write(moments,2,2,layer,0,()=>[.002,.002,0,.004]);
      }
      for(let layer=0;layer<2;layer++)write(worldFoam,2,2,layer,0,()=>[.06,.02,0,0]);
      write(wake,2,2,0,0,()=>[0,0,0,0]);
      const cachePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(OCEAN_LIGHTING,'frame-wide ocean lighting'),entryPoint:'main'}});
      const referenceCode=FRAME_WGSL+ATMO_CORE_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var sampC:sampler;
@group(0)@binding(3)var envCube:texture_cube<f32>;
@group(0)@binding(4)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(5)var<storage,read_write>answer:array<vec4f,4>;
@group(0)@binding(6)var skyLUT:texture_2d<f32>;
`+SKY_RENDER_FUNCS+`
const ENV_MAXMIP:f32=${ENV_MIPS-1}.0;
@compute @workgroup_size(1)fn main(){
 let sunlight=sunIlluminance()*sunVis[0];
 let skyUp=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),ENV_MAXMIP).rgb;
 let skyHemi=skyUp*0.4+0.15*(
  textureSampleLevel(envCube,sampC,vec3f(0.94,0.34,0.0),ENV_MAXMIP-1.0).rgb+
  textureSampleLevel(envCube,sampC,vec3f(-0.94,0.34,0.0),ENV_MAXMIP-1.0).rgb+
  textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,0.94),ENV_MAXMIP-1.0).rgb+
  textureSampleLevel(envCube,sampC,vec3f(0.0,0.34,-0.94),ENV_MAXMIP-1.0).rgb);
 answer[0]=vec4f(sunVis[0],sunVis[1],sunVis[2],sunVis[3]);
 answer[1]=vec4f(sunlight,0);answer[2]=vec4f(skyUp,0);answer[3]=vec4f(skyHemi,0);
}`;
      const referencePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(referenceCode,'original ocean lighting formulas'),entryPoint:'main'}});
      const cacheResources=[{buffer:frame},transView,sampler,envView,{buffer:sun}];
      const group=(pipeline,resources)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const cacheGroup=group(cachePipeline,cacheResources),referenceGroup=group(referencePipeline,[...cacheResources,{buffer:answer}]);
      const shadowFrames=buffer(new Float32Array(56),B.UNIFORM),hulls=buffer(new Float32Array(48),B.UNIFORM),interaction=buffer(new Float32Array(16),B.UNIFORM);
      const shadowDepth=()=>device.createTexture({size:[2,2,2],format:'depth32float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const solid=shadowDepth(),cloth=shadowDepth(),shadowTint=texture(2,2,2);
      for(let layer=0;layer<2;layer++)write(shadowTint,2,2,layer,0,()=>[1,1,1,1]);
      const compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'});
      const indices=[];for(let y=0;y<GRID;y++)for(let x=0;x<GRID;x++){const a=y*(GRID+1)+x,b=a+GRID+1;indices.push(a,b,a+1,a+1,b,b+1);}
      const indexBuffer=buffer(new Uint16Array(indices),B.INDEX),instance=buffer(new Float32Array([-32,-32,64,0]),B.VERTEX);
      const color=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),pixelRead=device.createBuffer({size:W*H*8,usage:B.COPY_DST|B.MAP_READ});
      const renderPipelines=[];
      for(const code of [OCEAN,withCachedOceanLighting(OCEAN)]){
        const module=await shader(code,'complete ocean lighting pixel parity');
        const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:16,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x4'}]}]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'}});
        const resources=[{buffer:frame},transView,skyView,sampler,displacement.createView({dimension:'2d-array'}),derivatives.createView({dimension:'2d-array'}),moments.createView({dimension:'2d-array'}),foam.createView(),envView,repeat,worldFoam.createView({dimension:'2d-array'}),{buffer:sun},{buffer:hulls},{buffer:interaction},wake.createView(),sampler,{buffer:interaction},wake.createView()];
        const mainGroup=group(pipeline,resources);
        const shadowGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{buffer:shadowFrames},solid.createView({dimension:'2d-array'}),compare,cloth.createView({dimension:'2d-array'}),shadowTint.createView({dimension:'2d-array'}),sampler].map((resource,binding)=>({binding,resource}))});
        renderPipelines.push({pipeline,mainGroup,shadowGroup});
      }
      const states=[{elevation:.04,height:.004,visibility:1,strength:1.2},{elevation:.8,height:.02,visibility:.37,strength:.9},{elevation:-.04,height:.8,visibility:0,strength:1.1},{elevation:.2,height:2.3,visibility:.91,strength:1.6}];
      const results=[];
      for(const [stateIndex,state]of states.entries()){
        // Each face and mip differs, including gradients within the sampled
        // 2x2 penultimate mip; no constant-cube shortcut can pass this fixture.
        for(let face=0;face<6;face++)for(let mip=0;mip<ENV_MIPS;mip++){
          const n=256>>mip;write(environment,n,n,face,mip,(x,y)=>[.12+face*.031+mip*.011+stateIndex*.023+x/n*.013,.18+face*.021+mip*.017+y/n*.019,.25+face*.014+mip*.009+(x+y)/n*.01,1]);
        }
        write(trans,32,16,0,0,(x,y)=>[.12+x*.018+stateIndex*.01,.2+y*.027,.3+(x+y)*.012,1]);
        const f=new Float32Array(96);f[0]=1/32;f[6]=.001;f[9]=1/32;f[14]=.5;f[15]=1;f.set([0,4,0,3.7],16);
        f.set([Math.sqrt(1-state.elevation**2)*.6,state.elevation,Math.sqrt(1-state.elevation**2)*.8,state.strength],32);f.set([W,H,1/W,1/H],36);
        const sizes=[1103,211.3,39.7,7.43,1.393,.2617];f.set(sizes,40);f.set(sizes.map(x=>1/x),48);f.set([1,0,7,0],56);f.set([1000,GRID,128,1024],64);
        f.set([3,state.height,0,0],72);f.set([.035,.17,.14,.004],76);f.set([.08,.32,.29,.05],80);f.set([.2,1,.8,1],84);f.set([.0002,.00025,.0003,0],88);
        const visibility=new Float32Array([state.visibility,.7-stateIndex*.1,.23,.61]);const initial=new Float32Array(16);initial.set(visibility);initial.fill(-10,4);
        device.queue.writeBuffer(frame,0,f);device.queue.writeBuffer(sun,0,initial);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(cachePipeline);pass.setBindGroup(0,cacheGroup);pass.dispatchWorkgroups(1);
        pass.setPipeline(referencePipeline);pass.setBindGroup(0,referenceGroup);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(sun,0,valueRead,0,64);encoder.copyBufferToBuffer(answer,0,valueRead,64,64);
        for(const [index,{pipeline,mainGroup,shadowGroup}]of renderPipelines.entries()){
          const rp=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});rp.setPipeline(pipeline);rp.setBindGroup(0,mainGroup);rp.setBindGroup(1,shadowGroup);rp.setVertexBuffer(0,instance);rp.setIndexBuffer(indexBuffer,'uint16');rp.drawIndexed(indices.length,1);rp.end();
          encoder.copyTextureToBuffer({texture:color},{buffer:pixelRead,offset:index*W*H*4,bytesPerRow:W*4},[W,H]);
        }
        device.queue.submit([encoder.finish()]);await valueRead.mapAsync(GPUMapMode.READ);const values=new Float32Array(valueRead.getMappedRange()).slice();valueRead.unmap();
        let maxValueError=0;for(let i=0;i<16;i++)maxValueError=Math.max(maxValueError,Math.abs(values[i]-values[16+i]));
        const preserved=Array.from(values.slice(0,4)).every((x,i)=>x===visibility[i]);
        await pixelRead.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(pixelRead.getMappedRange());let different=0,maxPixelError=0,covered=0;
        for(let i=0;i<W*H*4;i++){const delta=Math.abs(pixels[i]-pixels[W*H*4+i]);if(delta)different++;maxPixelError=Math.max(maxPixelError,delta);if(i%4===3&&pixels[i])covered++;}
        pixelRead.unmap();results.push({stateIndex,maxValueError,preserved,different,maxPixelError,covered,sunlight:Array.from(values.slice(4,7)),skyUp:Array.from(values.slice(8,11)),skyHemi:Array.from(values.slice(12,15))});
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,results,W,H};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    for(const r of result.results){
      assert.equal(r.preserved,true,'visibility producer retains ownership of all four original floats');
      assert.ok(r.maxValueError<2e-7,'cached values must match the original native formulas: '+r.maxValueError);
      assert.equal(r.different,0,'all complete-ocean fragment pixels must match');assert.equal(r.covered,result.W*result.H);
    }
    assert.ok(result.results[0].sunlight.some(x=>x>0));assert.deepEqual(result.results[2].sunlight,[0,0,0]);
    assert.notDeepEqual(result.results[0].skyUp,result.results[1].skyUp,'cache must observe changing environment mips');
    assert.notDeepEqual(result.results[0].skyUp,result.results[0].skyHemi,'directional/mip fixture must distinguish the two lighting integrals');
    await page.close();
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
