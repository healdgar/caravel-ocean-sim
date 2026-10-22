// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// CPU recoil evaluation below is an offline oracle, never a runtime backend.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native GPU recoil follows every actual gun, preserves posed cloth/normals and keeps instance state isolated',{timeout:300000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__vessel-recoil',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__vessel-recoil');
    const result=await page.evaluate(async()=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{createShipAssetCache}=await import('/js/ship-mesh.js');
      const {createVesselPose}=await import('/js/vessel-pose.js'),{createVesselRecoil}=await import('/js/vessel-recoil.js');
      const {createGunDefinitions,createGunRecoilMap,updateGunRecoilVertices}=await import('/js/gunnery-models.js');
      const {createLateenPoses,writeLateenUniform}=await import('/js/lateen.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[],cache=createShipAssetCache(),rows=[],absent=[];
      device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const computePipe=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});};
      const upload=(data,usage,label)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const digest=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
      const read=async buffer=>{const copy=device.createBuffer({size:buffer.size,usage:B.MAP_READ|B.COPY_DST}),encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,copy,0,buffer.size);device.queue.submit([encoder.finish()]);await copy.mapAsync(GPUMapMode.READ);const values=new Float32Array(copy.getMappedRange()).slice();copy.unmap();copy.destroy();return values;};
      const writes=[],nativeWrite=device.queue.writeBuffer.bind(device.queue);
      device.queue.writeBuffer=(buffer,offset,data,start=0,count)=>{const unit=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT??1:1;writes.push({buffer,offset,bytes:count===undefined?data.byteLength-start*unit:count*unit});return nativeWrite(buffer,offset,data,start,count);};
      for(const model of Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry)){
        const asset=cache.get(model.id),definitions=createGunDefinitions(model.id),map=createGunRecoilMap(asset),count=asset.vertices.length/9;
        if(!definitions.length){
          const dummy=device.createBuffer({size:32,usage:B.STORAGE}),value=await createVesselRecoil({device,computePipe,posedBuffer:dummy,recoilMap:map});absent.push({id:model.id,null:value===null});dummy.destroy();continue;
        }
        const metadata=JSON.stringify({definitions,nodes:model.nodes}),sourceHash=await digest(asset.vertices),source=upload(asset.vertices,B.STORAGE|B.VERTEX|B.COPY_SRC,'recoil immutable source');
        const hullA=upload(new Float32Array(52),B.UNIFORM,'recoil hull A'),hullB=upload(new Float32Array(52),B.UNIFORM,'recoil hull B');
        const canonicalA=await createVesselPose({device,computePipe,sourceBuffer:source,vertexCount:count,hullUBO:hullA,rigData:asset.rigGPUData??null});
        const canonicalB=await createVesselPose({device,computePipe,sourceBuffer:source,vertexCount:count,hullUBO:hullB,rigData:asset.rigGPUData??null,shared:canonicalA.assets});
        const posedA=device.createBuffer({label:'recoil posed A',size:count*32,usage:B.STORAGE|B.COPY_SRC|B.COPY_DST}),posedB=device.createBuffer({label:'recoil posed B',size:count*32,usage:B.STORAGE|B.COPY_SRC|B.COPY_DST});
        const recoilA=await createVesselRecoil({device,computePipe,posedBuffer:posedA,recoilMap:map}),recoilB=await createVesselRecoil({device,computePipe,posedBuffer:posedB,recoilMap:map,shared:recoilA.assets});
        const owned=new Set(map.guns.flatMap(g=>Array.from(g.indices))),allIDs=map.guns.map(g=>g.id).sort((a,b)=>a-b),definitionIDs=definitions.map(g=>g.id).sort((a,b)=>a-b);
        const makeBoat=scaled=>{
          const set=[.75,1,.5],rig=createLateenPoses(set,-1);rig.forEach(p=>Object.assign(p,{opening:.6,fill:.8,pressure:.7}));
          return {modelId:model.id,model,length:model.runtime.length*(scaled?1.13:1),beam:model.runtime.beam*(scaled?.87:1),rudder:14,hatchesClosed:.4,
            sailState:{set,groupYaw:[.2,-.3,.4],squareYaw:.31,lateenYaw:-.3,windSide:4,windForward:6,rig}};
        };
        const prepare=(canonical,hull,boat)=>{
          const h=new Float32Array(52);h[0]=1;h[5]=1;h[10]=-1;h[3]=model.designFrame.verticalScale;h[12]=boat.beam;h[13]=boat.length;h[15]=boat.rudder;h[19]=3.2;h[21]=9;h[22]=1;h[23]=model.modelCode;h[27]=boat.hatchesClosed;h[28]=.31;h[29]=-.3;h[30]=.8;h[31]=.7;h[32]=4;h[33]=-6;h[34]=8;h[35]=1;writeLateenUniform(h,boat.sailState);device.queue.writeBuffer(hull,0,h);canonical.update(boat,3.2,9);
        };
        const seed=async(canonical,posed,hull,boat)=>{
          prepare(canonical,hull,boat);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();canonical.encode(pass);pass.end();encoder.copyBufferToBuffer(canonical.buffer,0,posed,0,posed.size);device.queue.submit([encoder.finish()]);return read(canonical.buffer);
        };
        const compare=(actual,baseline,boat,guns)=>{
          const expected=new Float32Array(asset.vertices);updateGunRecoilVertices(createGunRecoilMap(asset),expected,guns,boat);
          const physical=[boat.beam/3.6,model.designFrame.verticalScale,boat.length/12],bits=new Uint32Array(actual.buffer),baseBits=new Uint32Array(baseline.buffer);
          let maxPositionError=0,boreError=0,normalChanges=0,staticChanges=0,wChanges=0,changed=0,finite=true,worst=null;
          for(let vertex=0;vertex<count;vertex++){
            if(owned.has(vertex)){
              const error=Math.hypot(...[0,1,2].map(k=>(actual[vertex*8+k]-expected[vertex*9+k])*physical[k]));
              if(error>maxPositionError){maxPositionError=error;worst={vertex,material:asset.vertices[vertex*9+6],error};}
              if([0,1,2].some(k=>bits[vertex*8+k]!==baseBits[vertex*8+k]))changed++;
            }else for(let k=0;k<3;k++)if(bits[vertex*8+k]!==baseBits[vertex*8+k])staticChanges++;
            for(let k=4;k<7;k++)if(bits[vertex*8+k]!==baseBits[vertex*8+k])normalChanges++;
            for(const k of [3,7])if(bits[vertex*8+k]!==baseBits[vertex*8+k])wChanges++;
            for(let k=0;k<8;k++)if(!Number.isFinite(actual[vertex*8+k]))finite=false;
          }
          // Independently derive the physical bore displacement from immutable
          // attachment metadata, rather than sharing the new GPU math helper.
          for(const gun of definitions){
            const live=guns.find(g=>g.id===gun.id),offset=live?.offset??0,axis=gun.directionDesign.map((v,k)=>v*physical[k]),length=Math.hypot(...axis),expectedDelta=axis.map(v=>-v*offset/length),indices=map.guns.find(g=>g.id===gun.id).indices;
            for(const vertex of [indices[0],indices.at(-1)])boreError=Math.max(boreError,Math.hypot(...[0,1,2].map(k=>(actual[vertex*8+k]-baseline[vertex*8+k])*physical[k]-expectedDelta[k])));
          }
          return {maxPositionError,boreError,normalChanges,staticChanges,wChanges,changed,finite,worst};
        };
        const cases=[];
        for(const c of [{name:'zero',fraction:0},{name:'half',fraction:.5},{name:'full',fraction:1},{name:'return-zero',fraction:0},{name:'scaled-half',fraction:.5,scaled:true},{name:'scaled-full',fraction:1,scaled:true},{name:'staggered',fraction:1,staggered:true},{name:'disabled',fraction:1,disabled:true}]){
          const boat=makeBoat(c.scaled),baseline=await seed(canonicalA,posedA,hullA,boat),guns=definitions.map((g,i)=>({...g,offset:g.recoilLength*c.fraction*(c.staggered?(i%3+1)/3:1)}));
          const inputState=JSON.stringify({guns,boat});writes.length=0;recoilA.update(guns,boat);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass(),encoded=recoilA.encode(pass,!c.disabled);pass.end();device.queue.submit([encoder.finish()]);const updates=writes.map(w=>({offset:w.offset,bytes:w.bytes,source:w.buffer===source,posed:w.buffer===posedA||w.buffer===posedB})),actual=await read(posedA);
          cases.push({name:c.name,encoded,expectedEncoded:c.fraction>0&&!c.disabled,inputStable:JSON.stringify({guns,boat})===inputState,updates,...compare(actual,baseline,boat,c.disabled?definitions.map(g=>({...g,offset:0})):guns)});
        }
        // Model descriptors/record ownership may be shared; delta state and
        // computed output must remain specific to each vessel.
        const boatA=makeBoat(false),boatB=makeBoat(true),baselineA=await seed(canonicalA,posedA,hullA,boatA),baselineB=await seed(canonicalB,posedB,hullB,boatB),gunsA=definitions.map(g=>({...g,offset:g.recoilLength*.25})),gunsB=definitions.map(g=>({...g,offset:g.recoilLength*.8}));
        recoilA.update(gunsA,boatA);let encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();recoilA.encode(pass);pass.end();device.queue.submit([encoder.finish()]);const before=await read(posedA);
        recoilB.update(gunsB,boatB);encoder=device.createCommandEncoder();pass=encoder.beginComputePass();recoilB.encode(pass);pass.end();device.queue.submit([encoder.finish()]);const other=await read(posedB),after=await read(posedA);
        const isolation=before.every((v,i)=>Object.is(v,after[i])),separateOutputs=posedA!==posedB,sharedAssets=recoilA.assets===recoilB.assets;
        recoilA.destroy();const disabledAfterDestroy=recoilA.encode({setPipeline(){throw Error('Destroyed recoil dispatched');},setBindGroup(){throw Error('Destroyed recoil dispatched');},dispatchWorkgroups(){throw Error('Destroyed recoil dispatched');}})===false;
        await seed(canonicalB,posedB,hullB,boatB);encoder=device.createCommandEncoder();pass=encoder.beginComputePass();const siblingSurvives=recoilB.encode(pass);pass.end();device.queue.submit([encoder.finish()]);const survivor=await read(posedB);
        const sourceGPU=await read(source),sourceGPUHash=await digest(sourceGPU),sourceCPUHash=await digest(asset.vertices);
        rows.push({id:model.id,allIDs,definitionIDs,gunCount:definitions.length,owned:owned.size,sharedAssets,separateOutputs,isolation,disabledAfterDestroy,siblingSurvives,metadataStable:JSON.stringify({definitions,nodes:model.nodes})===metadata,cases,instanceA:compare(after,baselineA,boatA,gunsA),instanceB:compare(other,baselineB,boatB,gunsB),survivor:compare(survivor,baselineB,boatB,gunsB),sourceHash,sourceCPUHash,sourceGPUHash});
        recoilB.destroy();canonicalA.destroy();canonicalB.destroy();source.destroy();hullA.destroy();hullB.destroy();posedA.destroy();posedB.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,rows,absent};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.ok(result.rows.length>=4);assert.ok(result.absent.every(r=>r.null),'ships without guns allocate no recoil renderer');
    for(const r of result.rows){
      assert.deepEqual(r.allIDs,r.definitionIDs,r.id+' every actual gun owns records');assert.ok(r.owned>0&&r.gunCount>0);assert.ok(r.sharedAssets&&r.separateOutputs&&r.isolation&&r.disabledAfterDestroy&&r.siblingSurvives,r.id+' shares only static model resources');assert.equal(r.metadataStable,true,r.id+' muzzle and crew attachment metadata stay unchanged');assert.equal(r.sourceCPUHash,r.sourceHash,r.id+' CPU geometry stays immutable');assert.equal(r.sourceGPUHash,r.sourceHash,r.id+' original GPU geometry stays immutable');
      for(const c of [...r.cases,r.instanceA,r.instanceB,r.survivor]){
        assert.ok(c.finite);assert.equal(c.normalChanges,0,r.id+' recoil cannot alter a normal');assert.equal(c.staticChanges,0,r.id+' recoil cannot alter posed cloth, ropes, hull or other fixed vertices');assert.equal(c.wChanges,0,r.id+' padding/normal channels remain unchanged');assert.ok(c.maxPositionError<=2e-5,r.id+' gun displacement error '+c.maxPositionError+' '+JSON.stringify(c.worst));assert.ok(c.boreError<=2e-5,r.id+' physical bore direction/magnitude error '+c.boreError);
        if(c.name){assert.equal(c.inputStable,true,r.id+' recoil cannot change physical gun/ship commands');assert.equal(c.encoded,c.expectedEncoded,r.id+'/'+c.name+' dispatch gating');assert.ok(c.updates.every(w=>!w.source&&!w.posed&&w.bytes<=r.gunCount*16),r.id+' uploads compact gun state only');if(c.expectedEncoded)assert.ok(c.changed>0,r.id+'/'+c.name+' kernel must move actual gun vertices');else assert.equal(c.changed,0,r.id+'/'+c.name+' canonical pose restores zero recoil');}
      }
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
