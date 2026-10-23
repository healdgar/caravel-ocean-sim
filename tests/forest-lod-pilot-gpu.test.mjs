// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

for(const meshSegments of [0,2,4,8])test('cluster GPU cover selects parent XOR complete children, grid='+meshSegments,{timeout:120000},async()=>{
 const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-webgpu',...(process.env.WEBGPU_BACKEND==='metal'?['--use-angle=metal']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']),'--disable-gpu-watchdog']});
  const page=await browser.newPage();await page.route('**/__forest-cluster-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-cluster-gpu');
  const report=await page.evaluate(async(meshSegments)=>{
   const {createForestClusterPilotRenderer}=await import('/js/forest-lod-pilot.js');
   const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredFeatures:['indirect-first-instance']}),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
   const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
   const views=directions.map((direction,index)=>{const right=cross(Math.abs(direction[1])>.9?[0,0,1]:[0,1,0],direction);return{index,direction,right,up:cross(direction,right)};});
   const mip={level:0,tilePixels:2,gutter:2,pitchPixels:6,atlasPixels:[36,12],outputs:{}};
   const data={};for(const [channel,colour]of Object.entries({albedo:[40,100,20,255],normalDepth:[128,128,255,128],lighting:[255,150,30,255]})){const pixels=new Uint8Array(36*12*4);for(let i=0;i<pixels.length;i+=4)pixels.set(colour,i);data[channel]=pixels;mip.outputs[channel]={bytes:pixels.byteLength};}
   const pageData={index:0,grid:[6,2],mips:[{...mip,data}]};
   const cluster=(id,firstLeaf,leafCount,centre,extent,firstTile)=>({id,sourceNodeID:firstLeaf+leafCount,firstLeaf,leafCount,centre,extent,views:views.map(v=>({...v,page:0,tile:[(firstTile+v.index)%6,Math.floor((firstTile+v.index)/6)]}))});
   const prototype={id:0,tiers:[{maxLeaves:2,pages:[pageData],clusters:[cluster(0,0,2,[0,.1,0],.6,0)]},{maxLeaves:1,pages:[pageData],clusters:[cluster(0,0,1,[-.2,.1,0],.25,0),cluster(1,1,1,[.2,.1,0],.25,6)]}]};
   const pack={manifest:{prototypes:[prototype]},loadPage:async()=>pageData,releasePage(){}};
   const vertices=new Float32Array(12*15),indices=new Uint32Array(24),nativeClusters=[];
   for(let side=0;side<2;side++){
    const x=side===0?-.2:.2,positions=[[-.12,-.12],[.12,-.12],[-.12,.12],[-.12,.12],[.12,-.12],[.12,.12]];
    for(let i=0;i<6;i++)vertices.set([x+positions[i][0],.1+positions[i][1],0,0,0,1,4,1,.5,.5,.2,.5,.1,side===0?2:5,.7],(side*6+i)*15);
    for(let i=0;i<12;i++)indices[side*12+i]=side*6+i%6;
    nativeClusters.push({sourceNodeID:side+10,firstLeaf:side,leafCount:1,centre:[x,.1,0],extent:.25,firstIndex:side*12,indexCount:12});
   }
   const bitmap=await createImageBitmap(new ImageData(new Uint8ClampedArray([255,255,255,255]),1,1)),normal=await createImageBitmap(new ImageData(new Uint8ClampedArray([128,128,255,255]),1,1));
   const blue=await createImageBitmap(new ImageData(new Uint8ClampedArray([0,0,255,255]),1,1));
   const material={index:2,roughness:.7,underside:0,opacityThreshold:.5,transmission:.1,undersideReference:[.2,.3,.1],albedo:{file:'a',width:1,height:1},normal:{file:'n',width:1,height:1}};
   const inspection={prototype:{id:0,leafCount:2},vertices:new Uint8Array(vertices.buffer),indices,clusters:nativeClusters,materials:[material,{...material,index:5,albedo:{file:'b',width:1,height:1}}],textures:new Map([['a',{bitmap,width:1,height:1,encoding:'srgb'}],['b',{bitmap:blue,width:1,height:1,encoding:'srgb'}],['n',{bitmap:normal,width:1,height:1,encoding:'linear'}]])};
   prototype.leafCount=2;
   const renderer=await createForestClusterPilotRenderer({device,pack,prototypeID:0,inspection,meshSegments,roots:[[5,0,0,1,0],[0,0,0,1,0]]});bitmap.close();normal.close();blue.close();
   if(meshSegments){let rejected=false;try{await createForestClusterPilotRenderer({device,pack,prototypeID:0,inspection,meshSegments,maxTriangles:meshSegments*meshSegments*4-1});}catch(e){rejected=/budget/.test(e.message);}if(!rejected)throw Error('Mixed hierarchy frontier exceeds budget but constructor accepted it');}
   const T=GPUTextureUsage,B=GPUBufferUsage,colour=device.createTexture({size:[64,64],sampleCount:4,format:'rgba8unorm',usage:T.RENDER_ATTACHMENT}),resolved=device.createTexture({size:[64,64],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[64,64],sampleCount:4,format:'depth32float',usage:T.RENDER_ATTACHMENT});
   const read=device.createBuffer({size:256+64*256,usage:B.COPY_DST|B.MAP_READ});
   async function run(force,focal=300){
    const c=new Float32Array(32);c[0]=1;c[5]=1;c[10]=.1;c[14]=.5;c[15]=1;c.set([0,0,3,focal],16);c.set([0,0,1,1],20);c.set([64,64,0,64],24);c.set([force,1,1,4],28);renderer.writeCamera(c);
    const e=device.createCommandEncoder();renderer.encode(e);const p=e.beginRenderPass({colorAttachments:[{view:colour.createView(),resolveTarget:resolved.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,1]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:1}});renderer.draw(p);p.end();
    e.copyBufferToBuffer(renderer.commands,0,read,0,48);e.copyTextureToBuffer({texture:resolved},{buffer:read,offset:256,bytesPerRow:256},[64,64]);device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange());const command=Array.from(new Uint32Array(bytes.buffer,0,11));let covered=0,green=0,blue=0;for(let at=256;at<bytes.length;at+=4){if(bytes[at]+bytes[at+1]+bytes[at+2]>0)covered++;if(bytes[at+1]>bytes[at+2]*1.2)green++;if(bytes[at+2]>bytes[at+1]*1.2)blue++;}read.unmap();return{command,covered,green,blue};
   }
   const coarse=await run(0),fine=await run(1),native=await run(2),repeat=await run(2),coarseAgain=await run(0);await device.queue.onSubmittedWorkDone();renderer.destroy();device.destroy();return{errors,coarse,fine,native,repeat,coarseAgain};
  },meshSegments);
  assert.deepEqual(report.errors,[]);
  const triangles=meshSegments?2*meshSegments*meshSegments:2,vertices=triangles*3;
  assert.deepEqual(report.coarse.command,[vertices,1,0,0,0,1,2,24,0,triangles,0]);
  assert.deepEqual(report.fine.command,[vertices,2,0,0,0,1,2,24,0,triangles*2,0]);assert.deepEqual(report.native.command,[vertices,0,0,0,24,1,2,24,0,8,2]);assert.deepEqual(report.repeat.command,report.native.command);
  assert.deepEqual(report.coarseAgain.command,report.coarse.command);assert.ok(report.native.green>10&&report.native.blue>10,'both original material bins must shade visible geometry for the nonzero root');
  for(const state of [report.coarse,report.fine,report.native,report.repeat,report.coarseAgain])assert.ok(state.covered>20,'selected source clusters must actually render');
 }finally{await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
});
