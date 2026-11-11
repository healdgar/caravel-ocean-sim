// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The land up close: grass, soil, sand and rock in place of a smooth wash, none of it past the distance cut.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {GROUND_DETAIL_BAKE,GROUND_DETAIL_CUT_M,GROUND_DETAIL_FADE_M,GROUND_DETAIL_FINE_CUT_M,GROUND_DETAIL_MEAN,GROUND_DETAIL_RENDER} from '../js/wgsl/ground-detail.js';
import {TERRAIN} from '../js/wgsl/terrain.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});
const blank=async()=>{
  const page=await browser.newPage();
  await page.route('**/__ground_detail',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto(base+'__ground_detail');
  return page;
};

test('the land shader never discards, fetches nothing before its cut, and crater tiles shade through the same material',()=>{
  assert.doesNotMatch(GROUND_DETAIL_RENDER,/\bdiscard\b/);
  const body=(name,from=TERRAIN)=>{const at=from.indexOf(`fn ${name}(`);assert.ok(at>=0,name);let depth=0;for(let i=from.indexOf('{',at);i<from.length;i++){if(from[i]==='{')depth++;if(from[i]==='}'&&!--depth)return from.slice(at,i+1);}throw Error(name);};
  assert.doesNotMatch(body('landSurface'),/\bdiscard\b/);
  assert.doesNotMatch(body('landOpaque'),/\bdiscard\b/);
  assert.doesNotMatch(body('landFinish'),/\bdiscard\b/);
  // The cut comes first. Past it not one fetch happens, on any path.
  const at=body('groundDetailAt',GROUND_DETAIL_RENDER);
  assert.ok(at.indexOf(`if(away>=${GROUND_DETAIL_CUT_M}.0){return d;}`)>=0);
  assert.ok(at.indexOf(`if(away>=${GROUND_DETAIL_CUT_M}.0){return d;}`)<at.indexOf('groundDetailTexel('));
  assert.match(GROUND_DETAIL_RENDER,/if\(near<=0\.0\)\{return w;\}/);
  assert.match(body('landSurface'),/if\(gd\.near>0\.0\)\{\s*let look=groundDetailLook\(/);
  // A crater's fragments run the land's own material with the same world position, so its edge cannot show.
  assert.match(body('landCraterFS'),/landSurface\(LandVertex\(v\.pos,v\.world,/);
  assert.match(GROUND_DETAIL_BAKE,/@compute/);
});

test('the bake tiles, keeps its stated mean at every mip, and has contrast to spend',{timeout:120000},async()=>{
  const page=await blank();
  try{
    const result=await page.evaluate(async()=>{
      const {createGroundDetail}=await import('/js/ground-detail.js'),{RGBA8_MIPS}=await import('/js/wgsl/sim.js'),{GROUND_DETAIL_SIZE}=await import('/js/wgsl/ground-detail.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const computePipe=async code=>{const module=device.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});};
      const detail=await createGroundDetail({device,computePipe,mipPipe:await computePipe(RGBA8_MIPS)});
      const read=async mip=>{
        const size=GROUND_DETAIL_SIZE>>mip,row=Math.ceil(size*4/256)*256,buffer=device.createBuffer({size:row*size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture:detail.texture,mipLevel:mip},{buffer,bytesPerRow:row},[size,size]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const raw=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8Array(size*size*4);for(let y=0;y<size;y++)pixels.set(raw.subarray(y*row,y*row+size*4),y*size*4);
        buffer.unmap();buffer.destroy();return{size,pixels};
      };
      const stats=[];
      for(const mip of [0,3,6,10]){
        const {size,pixels}=await read(mip);
        const means=[0,1,2,3].map(c=>{let sum=0;for(let i=c;i<pixels.length;i+=4)sum+=pixels[i];return sum/(size*size)/255;});
        const spread=[0,1,2,3].map((c,k)=>{let sum=0;for(let i=c;i<pixels.length;i+=4)sum+=(pixels[i]/255-means[k])**2;return Math.sqrt(sum/(size*size));});
        stats.push({mip,means,spread});
      }
      // Across the wrap, neighbouring texels differ no more than neighbours inside the tile do.
      const {size,pixels}=await read(0);
      const seams=[0,1,2,3].map(c=>{
        let across=0,inside=0;
        for(let i=0;i<size;i++){
          across+=Math.abs(pixels[(i*size)*4+c]-pixels[(i*size+size-1)*4+c])+Math.abs(pixels[i*4+c]-pixels[((size-1)*size+i)*4+c]);
          inside+=Math.abs(pixels[(i*size+200)*4+c]-pixels[(i*size+201)*4+c])+Math.abs(pixels[(200*size+i)*4+c]-pixels[(201*size+i)*4+c]);
        }
        return {across,inside};
      });
      device.destroy();
      return {errors,stats,seams};
    });
    assert.deepEqual(result.errors,[]);
    for(const {mip,means} of result.stats)means.forEach((mean,c)=>assert.ok(Math.abs(mean-GROUND_DETAIL_MEAN[c])<.012,`channel ${c} at mip ${mip} averages ${mean}, not ${GROUND_DETAIL_MEAN[c]}`));
    result.stats[0].spread.forEach((spread,c)=>assert.ok(spread>.1,`channel ${c} has contrast: ${spread}`));
    // Blades and stones are gone from the coarse mips, or far ground would still be speckled.
    for(const c of [0,1])assert.ok(result.stats[2].spread[c]<result.stats[0].spread[c]*.15,`channel ${c} flattens with distance: ${result.stats[2].spread[c]}`);
    result.seams.forEach(({across,inside},c)=>assert.ok(across<inside*1.25,`channel ${c} tiles: ${across} across the wrap, ${inside} inside`));
  }finally{await page.close();}
});

test('every signal is zero on the far side of the cut, and the fine size is gone long before',{timeout:120000},async()=>{
  const page=await blank();
  try{
    const rows=await page.evaluate(async()=>{
      const {GROUND_DETAIL_RENDER}=await import('/js/wgsl/ground-detail.js'),{TERRAIN_FILTERING}=await import('/js/wgsl/terrain.js'),{NOISE_WGSL}=await import('/js/wgsl/common.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const code=NOISE_WGSL+TERRAIN_FILTERING+`
struct Frame{camPos:vec4f};
struct NearLand{domain:vec4f,grid:vec4f};
struct Probe{world:vec4f,step:vec4f,which:vec4f};
@group(0)@binding(0) var<uniform> F:Frame;
@group(0)@binding(1) var<uniform> nearTerrain:NearLand;
@group(0)@binding(2) var<uniform> probe:Probe;
`+GROUND_DETAIL_RENDER+`
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0) vec4f{
  let dx=vec3f(probe.step.x,0.0,0.0);let dy=vec3f(0.0,0.0,probe.step.x);
  let d=groundDetailAt(probe.world.xyz,dx,dy,vec2f(.1,-.2),vec2f(-.1,.2));
  if(probe.which.x>.5){return vec4f(abs(d.mid.r)+abs(d.mid.g)+abs(d.mid.b)+abs(d.mid.a),abs(d.big.r)+abs(d.big.g)+abs(d.big.b)+abs(d.big.a),0.0,1.0);}
  return vec4f(d.near,d.closeBy,abs(d.fine.r)+abs(d.fine.g)+abs(d.fine.b)+abs(d.fine.a),1.0);
}`;
      const module=device.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      const uniform=size=>device.createBuffer({size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const frame=uniform(16),near=uniform(32),probe=uniform(48);
      device.queue.writeBuffer(frame,0,new Float32Array([0,2,0,0]));
      const texture=device.createTexture({size:[4,4],format:'rgba8unorm',mipLevelCount:1,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture},Uint8Array.from({length:64},(_,i)=>i*17%256),{bytesPerRow:16},[4,4]);
      const sampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',minFilter:'nearest',magFilter:'nearest'});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:1,resource:{buffer:near}},{binding:2,resource:{buffer:probe}},{binding:16,resource:texture.createView()},{binding:17,resource:sampler}]});
      const target=device.createTexture({size:[1,1],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const read=async(away,which)=>{
        device.queue.writeBuffer(probe,0,new Float32Array([away+.37,2,.41,0,.01,0,0,0,which,0,0,0]));
        const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:256},[1,1]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const values=[...new Float32Array(buffer.getMappedRange(),0,4)];buffer.unmap();buffer.destroy();return values;
      };
      const out=[];
      for(const away of [1,20,60,140,180,239,240,300,1000,5000]){const [near,closeBy,fine]=await read(away,0),[mid,big]=await read(away,1);out.push({away,near,closeBy,fine,mid,big});}
      device.destroy();
      return {errors,out};
    });
    assert.deepEqual(rows.errors,[]);
    for(const r of rows.out){
      const distance=r.away+.37;
      if(distance<GROUND_DETAIL_FADE_M)assert.equal(r.near,1,`full detail at ${distance} m`);
      if(distance<GROUND_DETAIL_CUT_M)assert.ok(r.near>0&&r.mid+r.big>0,`some detail at ${distance} m`);
      if(distance>=GROUND_DETAIL_CUT_M)for(const key of ['near','closeBy','fine','mid','big'])assert.equal(r[key],0,`${key} is nothing at ${distance} m`);
      if(distance>=GROUND_DETAIL_FINE_CUT_M)assert.equal(r.fine,0,`no fine size at ${distance} m`);
    }
  }finally{await page.close();}
});

// A low camera over each ground and a high one over all of them, in one page. Flattening the texture to its own mean
// shows what the land would be without it, with everything else in the frame the same.
test('in the game, ground is not a smooth wash up close, and past the cut the texture makes no difference at all',{timeout:420000},async t=>{
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:1024,h:576,polygons:'fixed',view:'free',sunElev:45,sunAzim:140,clouds:0,paused:1,t:100,crew:0,ship:'nina',cam:'1560,55,-7400,0,-20'}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:1024,height:576}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.route('**/js/main.js',async route=>{
    const response=await route.fetch();const text=await response.text();
    const find='const cam = { x: 0, y: 2.4';assert.ok(text.includes(find),'the free camera is where this test expects it');
    await route.fulfill({response,body:text.replace(find,'const cam = window.groundDetailCam = { x: 0, y: 2.4')});
  });
  try{
    await page.goto(url.toString());
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:240000,polling:200});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
    await page.addStyleTag({content:'*{visibility:hidden!important}canvas{visibility:visible!important}'});
    await page.waitForTimeout(5000);
    // Luminance of the picture, and how much it changes from each pixel to the next across the lower half.
    const look=async(spot)=>{
      await page.evaluate(({x,z,eye,yaw,pitch})=>{
        const c=window.groundDetailCam;c.x=x;c.z=z;c.y=window.oceanFleet.terrain.groundSample(x,z)+eye;c.yaw=yaw*Math.PI/180;c.pitch=pitch*Math.PI/180;
      },spot);
      await page.waitForTimeout(1500);
      const data=(await page.screenshot()).toString('base64');
      return page.evaluate(async b64=>{
        const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
        const {data,width,height}=context.getImageData(0,0,bitmap.width,bitmap.height),light=new Float32Array(width*height);
        for(let i=0;i<light.length;i++)light[i]=.2126*data[i*4]+.7152*data[i*4+1]+.0722*data[i*4+2];
        let step=0,count=0;
        for(let y=height>>1;y<height;y++)for(let x=0;x<width-1;x++){step+=Math.abs(light[y*width+x+1]-light[y*width+x]);count++;}
        return {light:Array.from(light),width,height,contrast:step/count};
      },data);
    };
    // Pasture and a fallow field a mile outside Lisbon's walls, and the beach to the west. (The town's streets are
    // paved stone by stone by the town's own shader, not by this texture.)
    const GROUNDS={grass:{x:1560,z:-7400,eye:1.7,yaw:40,pitch:-20},soil:{x:1040,z:-7500,eye:1.7,yaw:40,pitch:-20},shore:{x:-2182.2,z:-5349.8,eye:1.7,yaw:150,pitch:-30}};
    const HIGH={x:1560,z:-7400,eye:420,yaw:20,pitch:-50};
    const with_={},flat={};
    for(const [name,spot] of Object.entries(GROUNDS))with_[name]=(await look(spot)).contrast;
    await look(HIGH);
    await page.waitForTimeout(5000);
    const settled=await look(HIGH),highBefore=await look(HIGH);
    // Every mip of the texture at the mean every channel is measured against.
    await page.evaluate(()=>window.oceanFleet.terrain.groundDetail.flatten());
    const highFlat=await look(HIGH);
    for(const [name,spot] of Object.entries(GROUNDS))flat[name]=(await look(spot)).contrast;
    const difference=(a,b)=>{let worst=0;a.light.forEach((value,i)=>{worst=Math.max(worst,Math.abs(value-b.light[i]));});return {worst};};
    const {worst}=difference(highBefore,highFlat),idle=difference(settled,highBefore);
    t.diagnostic(JSON.stringify({with_,flat,worst,idle}));
    for(const [name,value] of Object.entries(with_)){
      assert.ok(value>2.2,`${name} has grain and blades up close: ${value} levels from pixel to pixel`);
      assert.ok(value>flat[name]*2.2,`and that is the detail: ${value} with it, ${flat[name]} without`);
      assert.ok(flat[name]<2.2,`the smooth wash would fail this: ${flat[name]}`);
    }
    // The picture is dithered, so two frames of nothing differ by a level or two. The detail would show in tens.
    assert.ok(worst<=idle.worst+1,`from ${HIGH.eye} m up, past the ${GROUND_DETAIL_CUT_M} m cut, the texture changes nothing: pixels moved by up to ${worst} levels, against ${idle.worst} between two frames with no change`);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
