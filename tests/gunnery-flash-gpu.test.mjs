// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('native muzzle flash lights actual hull and crew fragments locally, follows both model attachments and stays per vessel',{timeout:120000},async()=>{
  const port=process.env.GUNNERY_FLASH_TEST_PORT||8141;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Flash fixture server exited '+code);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gun-flash',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__gun-flash`);
    const result=await page.evaluate(async()=>{
      const {CREW_RENDER}=await import('/js/wgsl/crew.js'),{CARAVEL}=await import('/js/wgsl/caravel.js');
      const {createGunDefinitions,gunMuzzlePose}=await import('/js/gunnery-models.js'),{boatRotate}=await import('/js/boat.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(size,usage)=>device.createBuffer({size,usage:usage|B.COPY_DST});
      const frame=buffer(384,B.UNIFORM),fixture=buffer(48,B.UNIFORM),sun=buffer(16,B.STORAGE),shadow=buffer(112,B.UNIFORM);
      const hulls=[buffer(208,B.UNIFORM),buffer(208,B.UNIFORM)],sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),compare=device.createSampler({compare:'less-equal'});
      const texture=(color,layers=1)=>{
        const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});
        for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;
      };
      const trans=texture([220,220,220]),sky=texture([8,10,13]),env=texture([8,10,13],6),water=texture([8,10,13]);
      const oak=texture([128,128,128]),disp=texture([0,0,0],6),deck=texture([0,0,0]),cloth=texture([102,66,36]);
      const depths=[0,1].map(()=>device.createTexture({size:[4,4],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}));
      const output=device.createTexture({size:[4,4],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),read=buffer(1024,B.COPY_DST|B.MAP_READ);
      const common=`struct FlashFixture {world:vec4f,normal:vec4f,color:vec4f};
@group(0)@binding(15)var<uniform>Q:FlashFixture;
fn fixturePosition(i:u32)->vec4f{return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`;
      const crewVS=`@vertex fn fixtureVS(@builtin(vertex_index)i:u32)->CrewVertex{var o:CrewVertex;
o.position=fixturePosition(i);o.world=Q.world.xyz;o.normal=Q.normal.xyz;o.color=Q.color.xyz;o.helm=0;o.wet=vec2f(0);o.skin=0;return o;}`;
      const boatVS=`@vertex fn fixtureVS(@builtin(vertex_index)i:u32)->BoatVertex{var o:BoatVertex;
o.pos=fixturePosition(i);o.world=Q.world.xyz;o.normal=Q.normal.xyz;o.local=vec3f(0,2,0);o.normalLocal=Q.normal.xyz;
o.uv=vec2f(.2,.3);o.wet=vec2f(0);o.material=4u;return o;}`;
      // Only the fixture vertex stage supplies controlled fragment inputs. Both
      // production fs entry points and shared flash function remain untouched.
      // Caulk matches linen's albedo/roughness, isolating shader consistency.
      const pipes=await Promise.all([[CREW_RENDER,crewVS],[CARAVEL,boatVS]].map(async([code,vs])=>{
        const module=device.createShaderModule({code:code+common+vs});errors.push(...(await module.getCompilationInfo()).messages.filter(e=>e.type==='error').map(e=>e.message));
        return device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'fixtureVS'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      }));
      const buf=b=>({buffer:b}),view=t=>t.createView();
      const groups=hulls.map(hull=>[
        [[0,buf(frame)],[1,buf(hull)],[4,view(trans)],[5,sampler],[6,env.createView({dimension:'cube'})],[7,buf(sun)],[9,view(sky)],[15,buf(fixture)]],
        [[0,buf(frame)],[1,view(trans)],[2,view(sky)],[3,sampler],[4,env.createView({dimension:'cube'})],[5,buf(sun)],[6,buf(hull)],[7,view(water)],
          [8,disp.createView({dimension:'2d-array'})],[9,sampler],[10,view(oak)],[11,sampler],[12,view(deck)],[15,buf(fixture)]],
      ].map((entries,i)=>device.createBindGroup({layout:pipes[i].getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))})));
      const shadowGroups=pipes.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(1),entries:[buf(shadow),view(depths[0]),compare,view(depths[1]),view(cloth),sampler].map((resource,binding)=>({binding,resource}))}));
      async function render(world,normal,receiver=0){
        const f=new Float32Array(96);f.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);f.set(world.map((x,i)=>x+normal[i]*10),16);
        f.set([0,1,0,0],32);f.set([4,4,.25,.25],36);f.fill(.01,48,54);f[63]=1;f[72]=1;f[73]=.002;
        device.queue.writeBuffer(frame,0,f);device.queue.writeBuffer(fixture,0,new Float32Array([...world,0,...normal,0,.012,.009,.006,0]));
        device.queue.writeBuffer(sun,0,new Float32Array(4));device.queue.writeBuffer(shadow,0,new Float32Array(28));
        const colors=[];
        for(let i=0;i<2;i++){
          const encoder=device.createCommandEncoder();for(const depth of depths)encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:view(depth),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}}).end();
          const pass=encoder.beginRenderPass({colorAttachments:[{view:view(output),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}]});
          pass.setPipeline(pipes[i]);pass.setBindGroup(0,groups[receiver][i]);pass.setBindGroup(1,shadowGroups[i]);pass.draw(3);pass.end();
          encoder.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow:256},[4,4]);device.queue.submit([encoder.finish()]);
          await read.mapAsync(GPUMapMode.READ);colors.push(Array.from(new Float32Array(read.getMappedRange()).slice(0,3)));read.unmap();
        }
        return colors;
      }
      const report=[];
      for(const[modelId,gunId]of[['nina',0],['nina',3],['victory',0],['victory',103]]){
        const boat={modelId,length:modelId==='victory'?56.6928:20,beam:modelId==='victory'?15.8496:6,x:120,heave:2,z:-80,heading:37,pitch:.12,roll:-.17,surgeVelocity:0};
        const gun=createGunDefinitions(modelId)[gunId],pose=gunMuzzlePose(gun,boat),normal=pose.direction;
        const h=new Float32Array(52),heading=boat.heading*Math.PI/180;
        boatRotate(h.subarray(0,3),1,0,0,heading,boat.pitch,boat.roll);h[3]=boat.length/12;
        boatRotate(h.subarray(4,7),0,1,0,heading,boat.pitch,boat.roll);boatRotate(h.subarray(8,11),0,0,-1,heading,boat.pitch,boat.roll);
        h[11]=gunId;h.set([boat.beam,boat.length,0,0],12);h.set([boat.x,boat.heave,boat.z,0],16);h[23]=modelId==='victory'?1:0;
        const near=pose.position.map((x,i)=>x-normal[i]),far=pose.position.map((x,i)=>x-normal[i]*12);
        device.queue.writeBuffer(hulls[0],0,h);device.queue.writeBuffer(hulls[1],0,h);
        const base=await render(near,normal),companionBase=await render(near,normal,1);
        h[7]=gun.sideSign;device.queue.writeBuffer(hulls[0],0,h);const full=await render(near,normal),distant=await render(far,normal),companion=await render(near,normal,1);
        h[7]=gun.sideSign*.5;device.queue.writeBuffer(hulls[0],0,h);const half=await render(near,normal);
        h[7]=0;device.queue.writeBuffer(hulls[0],0,h);const farBase=await render(far,normal),backBase=await render(near,normal.map(x=>-x));
        h[7]=gun.sideSign;device.queue.writeBuffer(hulls[0],0,h);const back=await render(near,normal.map(x=>-x));
        h[7]=0;device.queue.writeBuffer(hulls[0],0,h);const extinguished=await render(near,normal);
        report.push({modelId,gunId,base,full,half,far:distant,farBase,back,backBase,companion,companionBase,extinguished});
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,report};
    });
    assert.deepEqual(result.errors,[],JSON.stringify(result));
    for(const r of result.report){
      const delta=r.full.map((col,i)=>col.map((v,j)=>v-r.base[i][j]));
      for(let material=0;material<2;material++){
        const d=delta[material];assert.ok(d.every(Number.isFinite));assert.ok(d[0]>.1,JSON.stringify(r));
        assert.ok(d[0]>d[1]*1.5&&d[1]>d[2]*2,'warm flash spectrum');
        assert.ok(d[0]>(r.far[material][0]-r.farBase[material][0])*20,'strong local attenuation');
        assert.ok(Math.abs(r.half[material][0]-r.base[material][0]-d[0]*.5)<2e-6,'flash envelope controls actual radiance');
        assert.ok(Math.abs(r.back[material][0]-r.backBase[material][0])<1e-6,'back faces do not acquire flash diffuse');
      }
      for(let channel=0;channel<3;channel++)assert.ok(Math.abs(delta[0][channel]-delta[1][channel])<2e-5,'same optical inputs in crew and hull receive same flash');
      assert.deepEqual(r.companion,r.companionBase,'another ship Hull UBO cannot inherit the firing flag');
      assert.deepEqual(r.extinguished,r.base,'zero flash restores the exact original material shading');
    }
  }finally{await browser?.close();server.kill();}
});
