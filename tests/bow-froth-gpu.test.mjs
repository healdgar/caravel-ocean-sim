// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('wet bow shoulders aerate a beam-scaled connected footprint without changing wave forcing', {timeout:240000},async()=>{
  const port=process.env.BOW_FROTH_TEST_PORT||8099;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error(`Bow froth server exited ${code}`);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__bow-froth',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`http://localhost:${port}/__bow-froth`);
    const result=await page.evaluate(async()=>{
      const {WATER_CONTACTS,WAKE_UPDATE,WAKE_SIZE}=await import('/js/wgsl/interaction.js');
      const {FLEET_FOAM_UPDATE,FOAM_RES}=await import('/js/wgsl/sim.js');
      const {NINA_DESIGN}=await import('/js/models/nina.js');
      const {VICTORY_DESIGN}=await import('/js/models/victory.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(size,usage=B.STORAGE|B.COPY_SRC|B.COPY_DST)=>device.createBuffer({size,usage});
      const ref=buffer=>({buffer});
      const pipeline=async(code,label,entryPoint='main')=>{
        const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();
        const bad=info.messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint}});
      };
      const bind=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const submit=(pipe,group,x=1,y=1,z=1)=>{
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(x,y,z);pass.end();device.queue.submit([enc.finish()]);
      };
      const readBuffer=async(source,size)=>{
        const stage=buffer(size,B.MAP_READ|B.COPY_DST),enc=device.createCommandEncoder();enc.copyBufferToBuffer(source,0,stage,0,size);device.queue.submit([enc.finish()]);
        await stage.mapAsync(GPUMapMode.READ);const values=new Float32Array(stage.getMappedRange().slice(0));stage.unmap();stage.destroy();return values;
      };
      const half=n=>{const e=(n>>10)&31,m=n&1023;return(n&32768?-1:1)*(e===31?Infinity:e?(1+m/1024)*2**(e-15):m*2**-24);};
      const readTexture=async(texture,width,height,layers=1)=>{
        const stage=buffer(width*height*layers*8,B.MAP_READ|B.COPY_DST),enc=device.createCommandEncoder();
        enc.copyTextureToBuffer({texture},{buffer:stage,bytesPerRow:width*8,rowsPerImage:height},[width,height,layers]);device.queue.submit([enc.finish()]);
        await stage.mapAsync(GPUMapMode.READ);const values=Float32Array.from(new Uint16Array(stage.getMappedRange()),half);stage.unmap();stage.destroy();return values;
      };
      // The old foam source is retained only as an independent reference for the
      // displaced height/velocity. It must not be used as a visual acceptance bar.
      const oldReturn='  return WakePressure(vec4f(crest*c.point.w,hollow*c.point.w,pulse,crest*edge*c.point.w*peel/max(width,.1)),c.axis.xz*peel*crest*edge*c.flow.w);';
      const oldFoam='  let foamSource=(source*2.8+pressure.w*.7)*smoothstep(.6,3.5,forwardSpeed)+max(pulse,0.0)*1.4+stern*sternWet*min(4.0,forwardSpeed*.95)*smoothstep(.04,.28,froude)*churn;';
      const reference=WAKE_UPDATE.replace(/  let froth=[^\n]+;\n  return WakePressure[^\n]+;/,oldReturn)
        .replace(/  let bowFroth=[^\n]+;\n  let aftFroth=[^\n]+;\n  let foamSource=[^\n]+;/,oldFoam);
      if(reference===WAKE_UPDATE||reference.includes('let froth=')||reference.includes('let bowFroth='))throw Error('Unsupported old-wake reference reconstruction');
      const audit=WAKE_UPDATE+`
@group(0)@binding(6)var<storage,read_write>audit:array<vec4f>;
@compute @workgroup_size(64)fn footprint(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=512u){return;}
 let width=max(max(.55,H.size.x*.18),I.domain.w*1.5);
 let outside=f32(id.x)*H.size.x/512.0;
 let c=Contact(vec4f(0,0,0,1),vec4f(1,0,0,0),vec4f(1,0,-I.motion.x*.8,1),vec4f(0));
 audit[id.x]=vec4f(outside,wakePressure(vec2f(outside,0),c,width).shape.w,0,0);
}`;
      const [contactPipe,wakePipe,referencePipe,auditPipe]=await Promise.all([
        pipeline(WATER_CONTACTS,'bow contacts'),pipeline(WAKE_UPDATE,'bow froth'),pipeline(reference,'reference wake forcing'),pipeline(audit,'bow froth footprint','footprint')]);
      const frame=buffer(384,B.UNIFORM|B.COPY_DST),control=buffer(64,B.UNIFORM|B.COPY_DST),hull=buffer(96,B.UNIFORM|B.COPY_DST);
      const contacts=buffer(40*64),landings=buffer(WAKE_SIZE*WAKE_SIZE*4),auditValues=buffer(512*16);
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const frameValues=new Float32Array(96);frameValues.fill(1,48,54);device.queue.writeBuffer(frame,0,frameValues);
      const h=new Float32Array(24);h[0]=h[5]=1;h[10]=-1;h[22]=1;
      const u=new Float32Array(16);u[6]=1/30;u[9]=1;
      const contactGroup=bind(contactPipe,[ref(frame),ref(control),ref(hull),sea.createView({dimension:'2d-array'}),sampler,ref(contacts)]);
      const auditGroup=device.createBindGroup({layout:auditPipe.getBindGroupLayout(0),entries:[
        {binding:0,resource:ref(control)},{binding:1,resource:ref(hull)},{binding:6,resource:ref(auditValues)}]});
      const pairs=[wakePipe,referencePipe].map(pipe=>{
        const textures=[0,1].map(()=>device.createTexture({size:[WAKE_SIZE,WAKE_SIZE],format:'rgba16float',usage:T.STORAGE_BINDING|T.TEXTURE_BINDING|T.COPY_SRC}));
        return{pipe,textures,groups:textures.map((tex,i)=>bind(pipe,[ref(control),ref(hull),textures[1-i].createView(),tex.createView(),ref(contacts),ref(landings)]))};
      });
      let current=0,worldZ=0,previousCentre=0,time=0;
      async function advance(speed,count,{dry=false,reset=false}={}){
        for(let i=0;i<count;i++){
          worldZ-=speed*u[6];h[17]=dry?100:0;h[18]=worldZ;
          u[0]=0;u[1]=Math.round(worldZ/u[3])*u[3];u[4]=0;u[5]=previousCentre;u[7]=reset&&i===0?1:0;u[8]=speed;u[12]=time+=u[6];
          device.queue.writeBuffer(hull,0,h);device.queue.writeBuffer(control,0,u);submit(contactPipe,contactGroup);
          current=1-current;for(const pair of pairs)submit(pair.pipe,pair.groups[current],WAKE_SIZE/8,WAKE_SIZE/8);
          previousCentre=u[1];
        }
      }
      const models=[];
      for(const [model,design]of [[0,NINA_DESIGN],[1,VICTORY_DESIGN]]){
        const beam=design.runtime.beam,length=design.runtime.length;
        h[3]=design.frame.verticalScale;h[12]=beam;h[13]=length;h[23]=model;u[2]=Math.max(128,length*4);u[3]=u[2]/WAKE_SIZE;
        const inactive=[];
        for(const [name,speed,dry]of [['stopped',0,false],['astern',-3.1,false],['dry',3.1,true]]){
          worldZ=previousCentre=0;await advance(speed,3,{dry,reset:true});
          const field=await readTexture(pairs[0].textures[current],WAKE_SIZE,WAKE_SIZE);
          inactive.push({name,peak:field.reduce((peak,v)=>Math.max(peak,Math.abs(v)),0)});
        }
        worldZ=previousCentre=0;await advance(3.1,150,{reset:true});
        const field=await readTexture(pairs[0].textures[current],WAKE_SIZE,WAKE_SIZE),old=await readTexture(pairs[1].textures[current],WAKE_SIZE,WAKE_SIZE);
        const c=await readBuffer(contacts,40*64);
        let forceError=0,peak=0,shoulderFresh=0,oldShoulderFresh=0,shoulderArea=0,oldShoulderArea=0,finite=true;
        const connectedCells=new Uint8Array(WAKE_SIZE*WAKE_SIZE);
        // Measure outside the actual wet port/starboard contour, in the middle
        // 60% of the sampled forebody, rather than any ship-attached rectangle.
        for(let cell=0;cell<WAKE_SIZE*WAKE_SIZE;cell++){
          const k=cell*4,x=(cell%WAKE_SIZE+.5-128)*u[3],z=(Math.floor(cell/WAKE_SIZE)+.5-128)*u[3]+u[1];
          for(let j=0;j<2;j++)forceError=Math.max(forceError,Math.abs(field[k+j]-old[k+j]));
          for(let j=0;j<4;j++)finite&&=Number.isFinite(field[k+j]);
          peak=Math.max(peak,field[k+2],field[k+3]);
          const along=worldZ-z,foreLength=length*(model?6:6.4)/12,at=(along/foreLength-.28)/.712;
          if(at<.2||at>.8)continue;
          const index=Math.min(14,Math.floor(at*15)),f=at*15-index,side=x<0?0:16;
          const a=(side+index)*16,b=a+16,mix=j=>c[a+j]*(1-f)+c[b+j]*f;
          const dx=x-mix(0),dz=z-mix(2),nx=mix(4),nz=mix(6),outside=(dx*nx+dz*nz)/Math.max(Math.hypot(nx,nz),.0001);
          if(outside<0||outside>beam*.45)continue;
          shoulderFresh=Math.max(shoulderFresh,field[k+3]);oldShoulderFresh=Math.max(oldShoulderFresh,old[k+3]);
          if(field[k+3]>.45){shoulderArea+=u[3]*u[3];connectedCells[cell]=1;}
          if(old[k+3]>.45)oldShoulderArea+=u[3]*u[3];
        }
        let connectedArea=0;
        for(let cell=0;cell<connectedCells.length;cell++)if(connectedCells[cell]){
          let count=0;const pending=[cell];connectedCells[cell]=0;
          while(pending.length){
            const at=pending.pop(),x=at%WAKE_SIZE,z=Math.floor(at/WAKE_SIZE);count++;
            for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
              const xx=x+dx,zz=z+dz;if(xx<0||xx>=WAKE_SIZE||zz<0||zz>=WAKE_SIZE)continue;
              const next=zz*WAKE_SIZE+xx;if(connectedCells[next]){connectedCells[next]=0;pending.push(next);}
            }
          }
          connectedArea=Math.max(connectedArea,count*u[3]*u[3]);
        }
        submit(auditPipe,auditGroup,8);const footprint=await readBuffer(auditValues,512*16);
        let maximum=0;for(let i=0;i<512;i++)maximum=Math.max(maximum,footprint[i*4+1]);
        let outwardEdge=0;for(let i=0;i<512;i++)if(footprint[i*4+1]>=maximum/Math.E)outwardEdge=footprint[i*4];
        models.push({model,beam,length,inactive,forceError,peak,shoulderFresh,oldShoulderFresh,shoulderArea,oldShoulderArea,connectedArea,outwardEdge,finite});
      }

      // A constant displaced surface makes the expected material coordinate
      // exact. Test the real fleet injection with only the companion enabled:
      // disabling the first vessel must not disable or remap the second wake.
      const foamPipe=await pipeline(FLEET_FOAM_UPDATE,'fleet displaced foam alignment');
      const foamUniform=buffer(144,B.UNIFORM|B.COPY_DST),first=buffer(64,B.UNIFORM|B.COPY_DST),second=buffer(64,B.UNIFORM|B.COPY_DST);
      const foamPrev=device.createTexture({size:[FOAM_RES,FOAM_RES,2],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const foamNext=device.createTexture({size:[FOAM_RES,FOAM_RES,2],format:'rgba16float',usage:T.STORAGE_BINDING|T.COPY_SRC});
      const disp=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const deriv=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING});
      device.queue.writeTexture({texture:disp},new Uint16Array([0x4800,0,0x4200,0]),{bytesPerRow:8},[1,1,1]); // x +8 m, z +3 m
      const empty=device.createTexture({size:[WAKE_SIZE,WAKE_SIZE],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const occupied=device.createTexture({size:[WAKE_SIZE,WAKE_SIZE],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const cells=new Uint16Array(WAKE_SIZE*WAKE_SIZE*4),domain=[30,-15,128,.5];
      for(let z=0;z<WAKE_SIZE;z++)for(let x=0;x<WAKE_SIZE;x++){
        const wx=(x+.5-128)*.5+domain[0],wz=(z+.5-128)*.5+domain[1];
        if(Math.hypot(wx-8,wz-3)<1){const k=(z*WAKE_SIZE+x)*4;cells[k+2]=cells[k+3]=0x3c00;}
      }
      device.queue.writeTexture({texture:occupied},cells,{bytesPerRow:WAKE_SIZE*8},[WAKE_SIZE,WAKE_SIZE]);
      const fu=new Float32Array(36);fu.set([.125,.125,1/30,.85],8);fu.set([.82,0,0,0],12);fu.fill(256,16,24);fu.fill(1/256,24,32);
      device.queue.writeBuffer(foamUniform,0,fu);
      device.queue.writeBuffer(first,0,new Float32Array([0,0,128,.5,0,0,1/30,0,0,0,0,0,0,0,1,0]));
      const secondValues=new Float32Array([...domain,0,0,1/30,0,0,1,0,0,0,0,1,0]);device.queue.writeBuffer(second,0,secondValues);
      const foamGroup=bind(foamPipe,[ref(foamUniform),foamPrev.createView({dimension:'2d-array'}),foamNext.createView({dimension:'2d-array'}),disp.createView({dimension:'2d-array'}),deriv.createView({dimension:'2d-array'}),sampler,sampler,ref(first),empty.createView(),sampler,ref(second),occupied.createView()]);
      submit(foamPipe,foamGroup,FOAM_RES/8,FOAM_RES/8,2);
      let foam=await readTexture(foamNext,FOAM_RES,FOAM_RES,2);
      const sample=(values,x,z,layer=0)=>{
        const ix=((Math.floor(x/.125)%FOAM_RES)+FOAM_RES)%FOAM_RES,iz=((Math.floor(z/.125)%FOAM_RES)+FOAM_RES)%FOAM_RES;
        return Array.from(values.subarray(((layer*FOAM_RES+iz)*FOAM_RES+ix)*4,((layer*FOAM_RES+iz)*FOAM_RES+ix)*4+2));
      };
      const aligned=[sample(foam,0,0),sample(foam,0,0,1)],unshifted=sample(foam,8,3);
      secondValues[9]=0;device.queue.writeBuffer(second,0,secondValues);submit(foamPipe,foamGroup,FOAM_RES/8,FOAM_RES/8,2);
      foam=await readTexture(foamNext,FOAM_RES,FOAM_RES,2);const disabled=sample(foam,0,0);
      device.destroy();return{models,aligned,unshifted,disabled,errors};
    });
    assert.deepEqual(result.errors,[]);
    for(const m of result.models){
      for(const s of m.inactive)assert.equal(s.peak,0,`${s.name} forebody makes no calm-water source: ${JSON.stringify(m)}`);
      assert.equal(m.forceError,0,'foam changes preserve every native height/velocity sample');
      assert.ok(m.finite&&m.peak<=1,'all retained channels stay finite and coverage stays bounded');
      assert.ok(m.shoulderFresh>.55,`moving wet shoulder develops dense fresh foam: ${JSON.stringify(m)}`);
      assert.ok(m.shoulderArea>m.oldShoulderArea*1.5&&m.shoulderArea>m.beam*m.beam*.02,`broad aerated shoulder exceeds the old narrow mask: ${JSON.stringify(m)}`);
      assert.ok(m.connectedArea>m.shoulderArea*.35,'each side reads as a connected shoulder rather than isolated foam dots: '+JSON.stringify(m));
      assert.ok(m.outwardEdge/m.beam>.29&&m.outwardEdge/m.beam<.33,`e-folding footprint is about .31 beam, not a constant-width ribbon: ${JSON.stringify(m)}`);
    }
    for(const s of result.aligned)assert.ok(s[0]>.85&&s[1]>.85,'only-active companion foam follows the actual displaced surface');
    assert.deepEqual(result.unshifted,[0,0],'Eulerian source must not also be painted at the unshifted material coordinate');
    assert.deepEqual(result.disabled,[0,0],'both inactive wake grids remain inactive after coordinate mapping');
  }finally{await browser?.close();server.kill();}
});
