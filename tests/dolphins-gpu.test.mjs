import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('dolphin bodies and surface effects follow ocean height, reverse depth, and event lifetime',{timeout:120000},async()=>{
  const server=spawn(process.execPath,['server.mjs','8094'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    await once(server.stdout,'data');
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__dolphin',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://localhost:8094/__dolphin');
    const report=await page.evaluate(async()=>{
      const {createDolphins}=await import('/js/dolphins.js');
      const {CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const f=new Float32Array(96);f[0]=1/60;f[9]=1/60;f[6]=.02;f[14]=.7;f[15]=1;f[17]=10;
      f.set([1,0,0,0],20);f.set([0,1,0,0],24);f.set([0,.8,.6,12],32);f.set([128,128,1/128,1/128],36);
      f.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);f[72]=1;f[73]=.01;
      const frame=buffer(f,B.UNIFORM),sun=buffer(new Float32Array([1,0,0,0]),B.STORAGE);
      const texture=(layers,color)=>{const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;};
      const sky=texture(1,[80,110,140]),trans=texture(1,[220,180,140]),env=texture(6,[40,70,100]);
      const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),repeat=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const shader=async(code,label)=>{const m=device.createShaderModule({code,label}),info=await m.getCompilationInfo();for(const v of info.messages)if(v.type==='error')errors.push(v.message);return m;};
      const dolphins=await createDolphins({device,frameUBO:frame,transView:trans.createView(),skyView:sky.createView(),sampler,envView:env.createView({dimension:'cube'}),sunVis:sun,seaView:sea.createView({dimension:'2d-array'}),seaSampler:repeat,shader,format:'rgba8unorm',samples:1,random:()=>.45});
      const target=device.createTexture({size:[128,128],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[128,128],format:'depth32float',usage:T.RENDER_ATTACHMENT});
      const read=device.createBuffer({size:128*128*4,usage:B.COPY_DST|B.MAP_READ}),boat={x:0,z:0,length:20,beam:6,heading:0,surgeVelocity:2};
      async function readFrame(waterDepth=.5){
        const enc=device.createCommandEncoder(),p=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[.02,.06,.08,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:waterDepth,depthLoadOp:'clear',depthStoreOp:'store'}});
        dolphins.draw(p);p.end();enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:128*4},[128,128]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const out=Array.from(new Uint8Array(read.getMappedRange()));read.unmap();return out;
      }
      async function render(phase,waterDepth=.5){
        // Body-only snapshots: neither an old event nor a crossing manufactured
        // by changing phase at dt=0 may contribute water-effect pixels.
        for(const s of dolphins.state.splashes){s.strength=0;s.age=10;}
        for(const a of dolphins.state.animals){a.phase=phase;a.previousDepth=phase>.2?3:-3;}
        dolphins.update(0,boat,{});return readFrame(waterDepth);
      }
      const empty=await render(0);dolphins.state.trigger(boat);const visible=await render(.45),underwater=await render(0);
      const changed=(a,b)=>a.reduce((n,v,i)=>n+(v!==b[i]?1:0),0);
      const result={errors,count:dolphins.state.count,visible:changed(empty,visible),submerged:changed(empty,underwater)};
      // Raising both the real wave and its depth surface must carry the animals
      // upward; a flat-height renderer would now leave every body underwater.
      for(let i=0;i<3;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},new Uint16Array([0,0x3c00,0,0]),{bytesPerRow:8},[1,1]);
      const raised=await render(.45,.56);result.raised=changed(empty,raised);

      // A close, top-down view isolates the water effects. With no active
      // animals, any changed pixel must come from the injected surface event.
      dolphins.state.clear();f[0]=1/6;f[9]=1/6;device.queue.writeBuffer(frame,0,f);
      for(let i=0;i<CASCADES;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},new Uint16Array(4),{bytesPerRow:8},[1,1]);
      dolphins.update(0,boat,{});const surfaceEmpty=await readFrame();
      const event=async(kind,age,waterDepth=.5)=>{
        for(const s of dolphins.state.splashes){s.strength=0;s.age=10;}
        Object.assign(dolphins.state.splashes[0],{x:0,z:0,age,strength:1,heading:.35,seed:3.71,kind,speed:5,scale:1});
        dolphins.update(0,boat,{});return readFrame(waterDepth);
      };
      const footprint=(pixels)=>{
        let count=0,minX=128,maxX=-1,minY=128,maxY=-1;
        for(let p=0;p<128*128;p++)if([0,1,2].some(c=>pixels[p*4+c]!==surfaceEmpty[p*4+c])){
          const x=p%128,y=Math.floor(p/128);count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
        }
        return {count,width:count?maxX-minX+1:0,height:count?maxY-minY+1:0};
      };
      const trailEarly=await event('trail',.12),entry=await event('entry',.12),emerge=await event('emerge',.12),ripple=await event('trail',1.8);
      result.effects={inactive:!dolphins.state.active,early:footprint(trailEarly),entry:footprint(entry),emerge:footprint(emerge),late:footprint(ripple),entryVsTrail:changed(entry,trailEarly),emergeVsTrail:changed(emerge,trailEarly)};
      result.effects.occluded=changed(surfaceEmpty,await event('entry',.12,.95));
      result.effects.expired=changed(surfaceEmpty,await event('entry',5));
      // Only the highest-frequency cascade carries this three-metre surface.
      // Sampling just the first three wave bands would hide every effect here.
      for(let i=0;i<CASCADES;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},new Uint16Array(4),{bytesPerRow:8},[1,1]);
      device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array([0,0x4200,0,0]),{bytesPerRow:8},[1,1]);
      result.effects.raised=footprint(await event('entry',.12,.56));
      dolphins.state.clear();dolphins.update(0,boat,{});result.effects.cleared=changed(surfaceEmpty,await readFrame(.56));
      dolphins.destroy();device.destroy();return result;
    });
    assert.deepEqual(report.errors,[]);assert.ok(report.count>=5&&report.count<=7);assert.ok(report.visible>30,JSON.stringify(report));assert.equal(report.submerged,0,JSON.stringify(report));
    assert.ok(report.raised>30,JSON.stringify(report));
    const fx=report.effects;
    assert.equal(fx.inactive,true);assert.ok(fx.early.count>5,JSON.stringify(fx));assert.ok(fx.entry.count>5,JSON.stringify(fx));assert.ok(fx.emerge.count>5,JSON.stringify(fx));
    assert.ok(fx.entryVsTrail>5,JSON.stringify(fx));assert.ok(fx.emergeVsTrail>5,JSON.stringify(fx));
    assert.ok(fx.late.count>5,JSON.stringify(fx));assert.ok(fx.late.width>fx.early.width+4,JSON.stringify(fx));
    assert.equal(fx.occluded,0,JSON.stringify(fx));assert.equal(fx.expired,0,JSON.stringify(fx));assert.equal(fx.cleared,0,JSON.stringify(fx));assert.ok(fx.raised.count>5,JSON.stringify(fx));
  }finally{await browser?.close();server.kill();}
});
