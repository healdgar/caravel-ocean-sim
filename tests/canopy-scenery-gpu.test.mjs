// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Native production entry points/resources; root owns all execution.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import test from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('real528B canopy draws preserve linear material, world placement and separate opaque/cutout alpha paths',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__canopy_gpu',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__canopy_gpu');
    const result=await page.evaluate(async()=>{
      const {TERRAIN}=await import('/js/wgsl/terrain.js'),{withCelestialFrame}=await import('/js/wgsl/celestial.js'),{createCanopyRenderer}=await import('/js/canopy-scenery.js'),{createLandShadows}=await import('/js/shadows.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[],B=GPUBufferUsage,T=GPUTextureUsage;device.addEventListener('uncapturederror',event=>errors.push(event.error.message));
      const buffers=[],textures=[],pipes=new Map(),makePipe=device.createRenderPipelineAsync.bind(device);
      device.createRenderPipelineAsync=async descriptor=>{const pipeline=await makePipe(descriptor);pipes.set(descriptor.label,pipeline);return pipeline;};
      const buffer=(values,usage,label)=>{const b=device.createBuffer({size:Math.max(4,values.byteLength),usage:usage|B.COPY_DST,label});if(values.byteLength)device.queue.writeBuffer(b,0,values);buffers.push(b);return b;};
      const tex=(dimension='2d',layers=1,one=true)=>{const t=device.createTexture({size:[1,1,layers],dimension,format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});textures.push(t);for(let z=0;z<layers;z++)device.queue.writeTexture({texture:t,origin:[0,0,z]},new Uint16Array(one?[15360,15360,15360,15360]:[0,0,0,0]),{bytesPerRow:8},[1,1,1]);return t;};
      const frameData=new Float32Array(132);frameData[0]=frameData[5]=frameData[15]=1;frameData[14]=.5;frameData.set([0,1,0,0],32);frameData.set([64,64,1/64,1/64],36);frameData[72]=3;frameData[73]=.01;
      const frame=buffer(frameData,B.UNIFORM,'actual528B canopy test Frame'),land=buffer(new Float32Array([0,0,128,1]),B.UNIFORM,'canopy land domain'),cloudFrame=buffer(new Float32Array(32),B.UNIFORM,'inactive production CloudFrame');
      const trans=tex(),sky=tex('2d',1,false),env=tex('2d',6),light=tex(),density=tex('3d',1,false),cloudLight=tex('3d',1,false),sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const leaf=device.createTexture({size:[1,1],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});textures.push(leaf);
      // The canopy takes the land shadow map since 6ecec5c. The production map is bound and left switched
      // off, as ?shadows=0 leaves it, so the crowns stand in the full light the oracle below assumes.
      const landShadows=createLandShadows(device,64);landShadows.update({x:0,y:0,z:0,forward:[0,0,-1]},0,[0,1,0],72,false);
      const resources=[[0,{buffer:frame}],[1,trans.createView()],[2,sky.createView()],[3,sampler],[4,env.createView({dimension:'cube'})],[5,light.createView()],[6,{buffer:land}],[8,sampler],[10,leaf.createView()],...landShadows.terrainResources];
      const clouds={bindVolume:pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[{buffer:cloudFrame},density.createView(),cloudLight.createView(),sampler].map((resource,binding)=>({binding,resource}))})};
      const module=device.createShaderModule({code:withCelestialFrame(TERRAIN),label:'complete production canopy/terrain528B'});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const colours={wood:[.18,.30,.07],leaf:[.05,.30,.09],far:[.60,.04,.12]};
      const vertex=(points,kind,colour,shift=[0,0,0])=>new Float32Array(points.flatMap((p,i)=>[...p.map((v,k)=>v+shift[k]),0,0,1,kind,.5,...[[0,0],[1,0],[.5,1]][i],...colour]));
      // Dyadic coordinates retain identical Float32 camera-relative positions
      // after a large world translation; this gives an exact image oracle.
      const positions={near:[[-.875,-.75,-10],[-.125,-.75,-10],[-.5,.75,-10]],leaf:[[.125,-.75,-10],[.875,-.75,-10],[.5,.75,-10]],far:[[-.875,-.75,-10],[.875,-.75,-10],[0,.75,-10]]};
      // farScale widens the crown so one pixel spans 2 m when the frame zooms out by
      // the same factor: unresolved relief is then filtered away, leaving an exact oracle.
      const pack=(shift=[0,0,0],farScale=1)=>({near:vertex(positions.near,3,colours.wood,shift),leaf:vertex(positions.leaf,4,colours.leaf,shift),far:vertex(positions.far.map(([x,y,z])=>[x*farScale,y*farScale,z]),4,colours.far,shift),
        manifest:{textureAlphaErrorSupported:false,stems:[{}],patches:[{id:'fixture',centre:[shift[0],shift[1],-10+shift[2]],radius:2*farScale,
          low:[-.875*farScale+shift[0],-.75*farScale+shift[1],-10+shift[2]],high:[.875*farScale+shift[0],.75*farScale+shift[1],-10+shift[2]],geometryErrorSupported:false,
          near:{firstVertex:0,vertexCount:3},leaf:{firstVertex:0,vertexCount:3},far:{firstVertex:0,vertexCount:3}}]}});
      const near=await createCanopyRenderer({device,module,resources,clouds,format:'rgba32float',samples:1,pack:pack(),mode:'near'}),far=await createCanopyRenderer({device,module,resources,clouds,format:'rgba32float',samples:1,pack:pack(),mode:'far'}),unresolvedFar=await createCanopyRenderer({device,module,resources,clouds,format:'rgba32float',samples:1,pack:pack([0,0,0],64),mode:'far'});
      const shifted=await createCanopyRenderer({device,module,resources,clouds,format:'rgba32float',samples:1,pack:pack([100,200,30]),mode:'near'});
      const colour=device.createTexture({size:[64,64],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[64,64],format:'depth32float',usage:T.RENDER_ATTACHMENT});textures.push(colour,depth);
      const render=async(renderer,{alpha=255,leafRGB=[255,0,0],eye=[0,0,0],time=0,wind=0,zoom=1}={})=>{
        device.queue.writeTexture({texture:leaf},new Uint8Array([...leafRGB,alpha]),{bytesPerRow:4},[1,1]);frameData[0]=frameData[5]=1/zoom;frameData.set([...eye,time],16);frameData.set([1,0,wind,0],56);device.queue.writeBuffer(frame,0,frameData);
        renderer.prepare({x:eye[0],y:eye[1],z:eye[2],forward:[0,0,-1],screenHeight:64,tanHalfFovY:1});
        const read=device.createBuffer({size:64*64*16,usage:B.COPY_DST|B.MAP_READ}),encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:colour.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});
        renderer.drawOpaque(pass);renderer.drawCutout(pass);pass.end();encoder.copyTextureToBuffer({texture:colour},{buffer:read,bytesPerRow:64*16},[64,64]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const pixels=Array.from(new Float32Array(read.getMappedRange()));read.unmap();read.destroy();return {pixels,wood:pixels.slice((32*64+16)*4,(32*64+16)*4+4),leaf:pixels.slice((32*64+48)*4,(32*64+48)*4+4),centre:pixels.slice((32*64+32)*4,(32*64+32)*4+4),stats:{...renderer.stats}};
      };
      const visible=await render(near),changedImageRGB=await render(near,{leafRGB:[0,0,255]}),cutout=await render(near,{alpha:0}),wind=await render(near,{time:93,wind:70}),translated=await render(shifted,{eye:[100,200,30]}),opaqueFar=await render(unresolvedFar,{alpha:0,zoom:64}),resolvedFar=await render(far,{alpha:0});
      const opaque=pipes.get('imported canopy canopyOpaqueFS');device.pushErrorScope('validation');device.createBindGroup({layout:opaque.getBindGroupLayout(0),entries:resources.filter(([id])=>[0,1,2,3,4,5,6,10].includes(id)).map(([binding,resource])=>({binding,resource}))});const extraneousLeafBinding=await device.popErrorScope();
      const exactImages={borrowedRGB:JSON.stringify(visible.pixels)===JSON.stringify(changedImageRGB.pixels),wind:JSON.stringify(visible.pixels)===JSON.stringify(wind.pixels),translated:JSON.stringify(visible.pixels)===JSON.stringify(translated.pixels)};
      const result={errors,visible:{wood:visible.wood,leaf:visible.leaf,stats:visible.stats},cutout:{wood:cutout.wood,leaf:cutout.leaf},opaqueFar:{centre:opaqueFar.centre,stats:opaqueFar.stats},resolvedFar:{centre:resolvedFar.centre},exactImages,opaqueOmitsLeafTexture:!!extraneousLeafBinding,colours};
      near.destroy();far.destroy();unresolvedFar.destroy();shifted.destroy();landShadows.destroy();for(const b of buffers)b.destroy();for(const texture of textures)texture.destroy();await device.queue.onSubmittedWorkDone();device.destroy();return result;
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.equal(result.opaqueOmitsLeafTexture,true,'opaque native layout actually excludes leaf texture access');
    const near=(a,b)=>assert.ok(Math.abs(a-b)<2e-6,a+' != '+b);
    // Exact landFinish terms under the fixture's unit environment and dark sun:
    // e91c94d mixes sky with tinted ground bounce by normal; 514b716 retuned the
    // canopy ambient terms and added leaf-card curvature and crown pigment/relief.
    const hemisphere=(ny,c)=>{const sky=.5+.5*ny;return [.88,.80,.68][c]*.54*(1-sky)+sky;};
    const leafU=(2*48.5/64-1-.125)/.75,leafV=(1-2*32.5/64+.75)/1.5,leafLength=Math.hypot((leafU-.5)*.22,(leafV-.5)*.18,1),leafNY=(leafV-.5)*.18/leafLength,leafBacklit=Math.max(-leafNY,0)*.5;
    const leafAmbient=.12+.5*.56+Math.abs(leafNY)*.09,leafWarm=[1.10,1.14,.82];
    for(let c=0;c<3;c++){
      near(result.visible.wood[c],result.colours.wood[c]*.36*hemisphere(0,c));
      near(result.visible.leaf[c],result.colours.leaf[c]*(1+(leafWarm[c]-1)*leafBacklit*.5)*leafAmbient*hemisphere(leafNY,c));
      near(result.opaqueFar.centre[c],result.colours.far[c]*(.88+.22*.5)*(.14+.5*.48)*hemisphere(0,c));
      // Once a pixel resolves it, the same crown carries its bounded relief.
      assert.notEqual(result.resolvedFar.centre[c],result.opaqueFar.centre[c]);assert.ok(Math.abs(result.resolvedFar.centre[c]/result.opaqueFar.centre[c]-1)<.25);
    }
    assert.equal(result.visible.wood[3],1);assert.equal(result.visible.leaf[3],1);assert.deepEqual(result.cutout.wood,result.visible.wood);assert.deepEqual(result.cutout.leaf,[0,0,0,0]);
    assert.equal(result.opaqueFar.centre[3],1,'opaque crown survives a completely transparent borrowed leaf image');assert.equal(result.opaqueFar.stats.uncertifiedDebug,true);
    assert.deepEqual(result.exactImages,{borrowedRGB:true,wind:true,translated:true},'native source placement/colour are not scaled, yawed, swayed, or gamma transformed again');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
