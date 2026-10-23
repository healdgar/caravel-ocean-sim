// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Diagnostic, not a density correction: the four source masks are disjoint,
// so their true union is1 although every terminal mip has identical alpha.25.
// Identical aligned masks instead have true union.25 and are a separate control.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native leaf complementary cutouts diagnose layered hardware alpha-to-coverage against binary area reference',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest_coverage',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__forest_coverage');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js');
      const {createForestLeafSurfaces,FOREST_VERTEX_WGSL,FOREST_VERTEX_LAYOUT,FOREST_SURFACE_MIPS_WGSL}=await import('/js/forest-scenery.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[],buffers=[],textures=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,S=GPUShaderStage;
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);buffers.push(b);return b;};
      const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      const sourceTextures={};
      async function png(file,layer,normal=false){
        const canvas=new OffscreenCanvas(4,4),context=canvas.getContext('2d'),image=context.createImageData(4,4);
        for(let y=0;y<4;y++)for(let x=0;x<4;x++)image.data.set(normal?[128,128,255,255]:[255,255,255,layer===4||layer<4&&x===layer?255:0],(y*4+x)*4);
        context.putImageData(image,0,0);const raw=await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer();sourceTextures[file]=raw;
        return {file,bytes:raw.byteLength,sha256:await digest(raw),width:4,height:4,encoding:normal?'linear':'srgb'};
      }
      const nativeMaterials=[];
      for(let i=0;i<6;i++)nativeMaterials.push({name:'foliage_'+i,index:i,albedo:await png('coverage-'+i+'-albedo.png',i),normal:await png('coverage-'+i+'-normal.png',i,true),
        roughness:.7,underside:0,transmission:0,opacityThreshold:.35,undersideReference:[0,0,0],wrap:'repeat'});
      const surfaces=await createForestLeafSurfaces({device,shader,pack:{manifest:{prototypes:[{nativeMaterials}]},textures:sourceTextures}});
      if(surfaces.families.length!==1||surfaces.families[0].levels!==3)throw Error('Expected exact4×4 source family with1×1 terminal mip');
      const inspectCode=await shader(`@group(0)@binding(0)var pigment:texture_2d_array<f32>;
@group(0)@binding(1)var<storage,read_write>result:array<vec4f>;
@compute @workgroup_size(1)fn main(@builtin(global_invocation_id)i:vec3u){if(i.x<6u){result[i.x]=textureLoad(pigment,vec2i(0),i32(i.x),2);}}`,'inspect actual native terminal mips');
      const inspect=await device.createComputePipelineAsync({layout:'auto',compute:{module:inspectCode,entryPoint:'main'}}),terminal=make(new Float32Array(24),B.STORAGE|B.COPY_SRC),terminalRead=device.createBuffer({size:96,usage:B.COPY_DST|B.MAP_READ});buffers.push(terminalRead);
      {const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(inspect);pass.setBindGroup(0,device.createBindGroup({layout:inspect.getBindGroupLayout(0),entries:[{binding:0,resource:surfaces.families[0].albedo.createView({dimension:'2d-array'})},{binding:1,resource:{buffer:terminal}}]}));pass.dispatchWorkgroups(6);pass.end();encoder.copyBufferToBuffer(terminal,0,terminalRead,0,96);device.queue.submit([encoder.finish()]);await terminalRead.mapAsync(GPUMapMode.READ);}
      const terminalMips=Array.from(new Float32Array(terminalRead.getMappedRange()));terminalRead.unmap();

      const code=FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(1);}
`+FOREST_VERTEX_WGSL,module=await shader(code,'actual native leaf coverage shader');
      const W=64,H=16,SCALE=4,frameData=new Float32Array(96);for(let i=0;i<4;i++)frameData[i*5]=1;frameData.set([0,0,1,1],32);
      const frame=make(frameData,B.UNIFORM),roots=make(new Float32Array([0,-2,0,1,0,1,1,1,0,0,-1,0]),B.STORAGE),visible=make(new Uint32Array([0]),B.STORAGE),bin=make(new Uint32Array([0,0,6,0]),B.UNIFORM),materials=make(surfaces.optics,B.STORAGE);
      const rows=[],indexRows=[];
      //0..3: complementary source masks.4..7: identical masks at distinct depths.
      //8: opaque control.9: empty control. Every card covers every raster sample.
      for(let layer=0;layer<10;layer++){
        const material=layer<4?layer:layer<8?0:layer-4,z=layer<8?.15+(layer%4)*.05:.4,base=rows.length/14;
        // Local Y1..3 remains entirely above the collar at worldY-2 while
        // preserving the original world/clip Y-1..1 coverage reference.
        for(const [x,y,u,v]of [[-1,-1,0,H],[1,-1,W,H],[1,1,W,0],[-1,1,0,0]])rows.push(x,y+2,z,0,0,1,4,.72,u,v,1,1,1,material);
        indexRows.push(base,base+1,base+2,base,base+2,base+3);
      }
      const vertices=make(new Float32Array(rows),B.VERTEX),indices=make(new Uint32Array(indexRows),B.INDEX);
      const layout0=device.createBindGroupLayout({entries:[{binding:0,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform'}}]}),layout1=device.createBindGroupLayout({entries:[]});
      const entries=[{binding:0,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:1,visibility:S.VERTEX,buffer:{type:'read-only-storage'}},{binding:2,visibility:S.VERTEX|S.FRAGMENT,buffer:{type:'uniform'}},
        {binding:5,visibility:S.FRAGMENT,sampler:{}},{binding:6,visibility:S.FRAGMENT,buffer:{type:'read-only-storage'}},{binding:13,visibility:S.FRAGMENT,sampler:{}}];
      for(const binding of [3,4,7,8,9,10,11,12])entries.push({binding,visibility:S.FRAGMENT,texture:{viewDimension:'2d-array'}});
      const layout2=device.createBindGroupLayout({entries}),layout=device.createPipelineLayout({bindGroupLayouts:[layout0,layout1,layout2]});
      const pipeline=await device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:'forestCanopyVS',buffers:[FOREST_VERTEX_LAYOUT]},fragment:{module,entryPoint:'forestNativeLeafFS',targets:[{format:'rgba16float'}]},
        primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4,alphaToCoverageEnabled:true}});
      const group0=device.createBindGroup({layout:layout0,entries:[{binding:0,resource:{buffer:frame}}]}),group1=device.createBindGroup({layout:layout1,entries:[]});
      const sampler=device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4}),repeat=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4});
      const bindings=[roots,visible,bin].map((buffer,binding)=>({binding,resource:{buffer}}));bindings.push({binding:5,resource:sampler},{binding:6,resource:{buffer:materials}},{binding:13,resource:repeat});
      for(let family=0;family<4;family++){const first=family?5+family*2:3,f=surfaces.families[0];bindings.push({binding:first,resource:f.albedo.createView({dimension:'2d-array'})},{binding:first+1,resource:f.normal.createView({dimension:'2d-array'})});}
      const group2=device.createBindGroup({layout:layout2,entries:bindings});
      const target=scale=>{const size=[W*scale,H*scale],resolve=device.createTexture({size,format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING|T.COPY_SRC}),msaa=device.createTexture({size,format:'rgba16float',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size,format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});textures.push(resolve,msaa,depth);return {resolve,msaa,depth};};
      const low=target(1),high=target(SCALE);
      const averageModule=await shader(`@group(0)@binding(0)var source:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
@fragment fn fs(@builtin(position)pixel:vec4f)->@location(0)vec4f{let p=vec2i(pixel.xy)*4;var sum=vec4f(0);for(var y=0;y<4;y++){for(var x=0;x<4;x++){sum+=textureLoad(source,p+vec2i(x,y),0);}}return sum/16.;}`,'binary reference GPU4×4 linear area average');
      const average=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:averageModule,entryPoint:'vs'},fragment:{module:averageModule,entryPoint:'fs',targets:[{format:'rgba16float'}]}}),averageGroup=device.createBindGroup({layout:average.getBindGroupLayout(0),entries:[{binding:0,resource:high.resolve.createView()}]});
      const read=device.createBuffer({size:W*H*8,usage:B.COPY_DST|B.MAP_READ});buffers.push(read);
      const half=(view,at)=>{const h=view.getUint16(at,true),s=h&32768?-1:1,e=(h>>10)&31,m=h&1023;return e===0?s*m*2**-24:e===31?(m?NaN:s*Infinity):s*(1+m/1024)*2**(e-15);};
      async function render(layers,scale){
        const output=scale===1?low:high;frameData.set([W*scale,H*scale,1/(W*scale),1/(H*scale)],36);device.queue.writeBuffer(frame,0,frameData);
        const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:output.msaa.createView(),resolveTarget:output.resolve.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:output.depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:0}});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.setBindGroup(2,group2);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');for(const layer of layers)pass.drawIndexed(6,1,layer*6);pass.end();
        if(scale===SCALE){const p=encoder.beginRenderPass({colorAttachments:[{view:low.resolve.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});p.setPipeline(average);p.setBindGroup(0,averageGroup);p.draw(3);p.end();}
        encoder.copyTextureToBuffer({texture:low.resolve},{buffer:read,bytesPerRow:W*8},[W,H]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const bytes=new DataView(read.getMappedRange());let coverage=0,alpha=0,min=1,max=0;
        for(let i=0;i<W*H;i++){const r=half(bytes,i*8);coverage+=r;alpha+=half(bytes,i*8+6);min=Math.min(min,r);max=Math.max(max,r);}read.unmap();return {coverage:coverage/(W*H),resolvedAlpha:alpha/(W*H),min,max};
      }
      const cases=[{name:'empty',layers:[9],expected:0},{name:'opaque',layers:[8],expected:1},{name:'single-quarter',layers:[0],expected:.25},{name:'identical-quarter',layers:[4,5,6,7],expected:.25},{name:'complementary-quarter',layers:[0,1,2,3],expected:1}],results=[];
      for(const fixture of cases)for(const reverse of [false,true]){
        const layers=reverse?[...fixture.layers].reverse():fixture.layers,runtime=await render(layers,1),reference=await render(layers,SCALE);
        results.push({name:fixture.name,order:reverse?'near-to-far':'far-to-near',layers,expectedBinaryUnion:fixture.expected,runtime,reference,coverageDeficit:reference.coverage-runtime.coverage});
      }
      const sourceSHA256=await digest(new TextEncoder().encode(FOREST_VERTEX_WGSL+FOREST_SURFACE_MIPS_WGSL));
      await device.queue.onSubmittedWorkDone();surfaces.destroy();for(const b of buffers)b.destroy();for(const texture of textures)texture.destroy();device.destroy();
      return {errors,terminalMips,results,sourceSHA256,adapter:Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,adapter.info?.[k]??''])),policy:{geometry:'Ten immutable full-screen cards; four complementary4×4 binary source masks; no geometric subpixel loss',logical:[W,H],reference:[W*SCALE,H*SCALE],referenceSamples:64,measurement:'White linear R; resolved alpha reported separately',runtime:'Actual native surface mip generator and actual forestNativeLeafFS; hardware MSAA4 alpha-to-coverage/depth; no production change',groundTruth:'Reference resolves original binary source texels at level0, equivalent to their MASK.35 law; complementary union1, identical union.25'}};
    });
    assert.deepEqual(result.errors,[]);
    for(let layer=0;layer<6;layer++){const expected=layer<4?.25:layer===4?1:0;assert.ok(Math.abs(result.terminalMips[layer*4+3]-expected)<.001,'actual terminal source alpha '+layer);}
    for(const row of result.results){
      assert.ok(Math.abs(row.reference.coverage-row.expectedBinaryUnion)<.002,'independent binary area reference '+JSON.stringify(row));
      assert.ok(Number.isFinite(row.runtime.coverage)&&row.runtime.coverage>=0&&row.runtime.coverage<=1,'bounded measured runtime coverage');
      if(row.name==='opaque'||row.name==='empty')assert.ok(Math.abs(row.runtime.coverage-row.expectedBinaryUnion)<.002,'runtime opaque/empty control');
    }
    for(const name of ['empty','opaque','single-quarter','identical-quarter','complementary-quarter']){
      const rows=result.results.filter(row=>row.name===name);assert.ok(Math.abs(rows[0].reference.coverage-rows[1].reference.coverage)<.001,'binary reference independent of draw order '+name);
    }
    t.diagnostic(JSON.stringify({...result,interpretation:'Runtime complementary deficit is reported, not hidden by an opacity correction or a passing fidelity claim. Hardware mask correlation remains a measured device-specific conclusion.'}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
