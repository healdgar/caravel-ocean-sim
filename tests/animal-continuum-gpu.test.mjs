// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal is drawn through the one continuum (AGENTS.md rule 3): the herds' step and the sea's stand write each
// animal's record (16 words, of the SKINNED kind) and its joints, and the one cut (js/continuum-scene.js) chooses its
// clusters, far body or splat; the families keep no select, list or pipeline of their own. Read back on the GPU: what
// the sea's stand wrote, what the cut chose for each animal, that every entry is of its list's kind, and that the
// census counts exactly what the lists hold. Every animal program (the herds' step and view, the sea's stands, views
// and under-water captures, and their water) compiles and builds its pipeline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const root=new URL('..',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root),'utf8');

test('animal families have no cut or draw of their own: their bodies are scenes of the one cut',()=>{
  for(const file of ['js/herds.js','js/dolphins.js','js/marine-life.js']){
    const source=read(file);
    assert.doesNotMatch(source,/drawIndexed|setIndexBuffer|setVertexBuffer|drawIndirect/,`${file} draws a body itself`);
    assert.match(source,/createAnimalScene\(/,`${file} makes a scene of the one cut`);
    assert.match(source,/requestContinuumView\(/,`${file} draws through its material's view of the one cut`);
  }
  for(const file of ['js/wgsl/animal-continuum.js','js/animal-continuum-draw.js'])assert.ok(!fs.existsSync(new URL(file,root)),`${file} remains`);
  // The herds' old ladder is gone with its buckets, morph and fade, and the sea's own body pass with it.
  const herds=read('js/wgsl/herds.js');
  for(const name of ['HERD_BUCKETS','HERD_SPLAT_BUCKET','HERD_FADE_BUCKET','HERD_MORPH_HI_PX','HERDS_RESET_WGSL','herdMeshKeep','herdsSplatVS','herdsFadeFS','HERDS_RENDER_WGSL','HERDS_SHADOW_WGSL'])assert.ok(!herds.includes(name),`${name} remains`);
  for(const file of ['js/wgsl/dolphins.js','js/wgsl/marine-life.js'])for(const name of ['fn dolphinVS(','seaContinuumVS','seaContinuumBodyWGSL'])assert.ok(!read(file).includes(name),`${file}: ${name} remains`);
  // No discard in an animal's main pass: the handoff is the cut's sample mask.
  for(const file of ['js/wgsl/herds.js'])assert.doesNotMatch(read(file).slice(read(file).indexOf('HERD_CONTINUUM_MATERIAL_WGSL')),/\bdiscard\b/);
});

test('the sea\'s animals are stood and cut on the GPU into the one cut\'s lists, and only those are drawn and counted',{timeout:600000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__animal_continuum',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__animal_continuum');
    const result=await page.evaluate(async()=>{
      const {requestHerdsPipelines}=await import('/js/herds.js');
      const D=await import('/js/wgsl/dolphins.js');
      const {MARINE_LIFE_RENDER,MARINE_EFFECT_INIT}=await import('/js/wgsl/marine-life.js');
      const {seaSource}=await import('/js/dolphins.js');
      const {requestAnimalContinuumAtlas,createAnimalScene}=await import('/js/animal-scene.js');
      const {requestContinuumPrograms,requestContinuumView}=await import('/js/continuum-scene.js');
      const {continuumModuleWGSL,CONTINUUM_ENTRY_LAYOUT,CONTINUUM_ENTRY_VERTICES}=await import('/js/wgsl/continuum-cut.js');
      const {CONTINUUM_LISTS,CONTINUUM_VIEW_LISTS,CONTINUUM_RECORD_WORDS,CONTINUUM_KIND,CONTINUUM_KIND_SHIFT,CONTINUUM_SEA,CONTINUUM_IMPORTANT_FLAG,CONTINUUM_CLUSTER_ENTRY,CONTINUUM_SPLAT_ENTRY,CONTINUUM_FAR_ENTRY}=await import('/js/continuum-format.js');
      const {WATER_CAPTURE_DIRECTIVE,waterCaptureWGSL}=await import('/js/water-optics.js');
      const {surfaceWaveSource}=await import('/js/wgsl/surface-coupling.js');
      const {ANIMAL_TYPE}=await import('/js/animal-continuum.js');
      const {LAND_SHADOW_FORMAT}=await import('/js/shadows.js');
      const {setContinuumPixelError,continuumPixelError}=await import('/js/continuum-core.js');
      const {createContinuumCensus}=await import('/js/continuum-census.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));return module;};
      const B=GPUBufferUsage;
      const make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
      const compute=async(code,label,entryPoint)=>device.createComputePipelineAsync({label,layout:'auto',compute:{module:await shader(code,label),entryPoint}});

      // Every animal program builds: the one cut's, the herds' step and view, each sea family's stand, view and
      // capture, still and on the surface's waves, and their water.
      const built=[];
      const programs=await requestContinuumPrograms({device,shader,shadowFormat:LAND_SHADOW_FORMAT});built.push('continuum programs');
      await requestHerdsPipelines({device,shader,format:'rgba16float',samples:4});built.push('herds step and view');
      const views={};
      for(const [name,material] of [['dolphins',D.DOLPHIN_CONTINUUM_MATERIAL_SPEC],['marine life',D.MARINE_CONTINUUM_MATERIAL_SPEC]]){
        views[name]=await requestContinuumView({device,shader,material,format:'rgba16float',samples:4});built.push(`${name} view`);
        for(const waves of [false,true]){
          const source=continuumModuleWGSL({pass:'capture',material,capture:{directive:WATER_CAPTURE_DIRECTIVE,tail:o=>(waves?surfaceWaveSource(3,2,3,'captureSeaSampler'):'')+waterCaptureWGSL({...o,surfaceWaves:waves,land:false})}});
          const module=await shader(source,`${name} capture${waves?' on the waves':''}`);
          await device.createRenderPipelineAsync({label:`${name} capture`,layout:'auto',vertex:{module,entryPoint:'continuumCaptureVS',buffers:CONTINUUM_ENTRY_LAYOUT},fragment:{module,entryPoint:'submergedFS',targets:[{format:'rgba16float'}]},
            primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:1}});
          built.push(`${name} capture${waves?' on the waves':''}`);
        }
      }
      const stands={};
      for(const waves of [null,{current:0}])for(const marine of [false,true]){
        const stand=await compute(seaSource(D.seaStandWGSL(marine),waves),'sea stand','seaStandCS');built.push(`${marine?'marine':'dolphin'} stand${waves?' coupled':''}`);
        if(!waves)stands[marine?'marine':'dolphins']=stand;
      }
      const water=await shader(D.DOLPHIN_RENDER,'dolphin water'),marineWater=await shader(MARINE_LIFE_RENDER,'marine water');
      const blend={color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
      for(const [module,kinds] of [[water,['dolphinRipple','dolphinSplash','dolphinDrop']],[marineWater,['dolphinRipple','marineImpactSheet','marineImpactDrop','marineBlow','marineBreathDrop','marineFallout']]])for(const kind of kinds){
        await device.createRenderPipelineAsync({label:kind,layout:'auto',vertex:{module,entryPoint:kind+'VS'},fragment:{module,entryPoint:kind+'FS',targets:[{format:'rgba16float',blend}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:4}});
        built.push(kind);
      }
      for(const entryPoint of ['marineBirthCS','marineImpactContactCS']){await compute(MARINE_EFFECT_INIT,'marine emission height',entryPoint);built.push(entryPoint);}

      // A camera at 1.47 m looking down +z: clip = (x, y, 0.1, z); focal 1000 px; the sea's cascades 100 m across.
      const frame=new Float32Array(96);
      frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,1.465,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
      frame.fill(100,40,48);frame.fill(0.01,48,56);
      const frameUBO=make(frame,B.UNIFORM);
      // The land's shadow map: 200 m across, 1000 m deep about the origin.
      const shadowFrame=new Float32Array(28);
      shadowFrame.set([0.01,0,0,0, 0,0.01,0,0, 0,0,0.001,0, 0,0,0.5,1],0);shadowFrame.set([0,0,0,1],16);shadowFrame.set([0,1,0,1],20);shadowFrame.set([0.05,0.05,0,0],24);
      const shadowUBO=make(shadowFrame,B.UNIFORM);
      const atlas=await requestAnimalContinuumAtlas(device);
      // A still sea: every cascade flat.
      const sea=device.createTexture({size:[2,2,8],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      const seaSampler=device.createSampler({magFilter:'linear',minFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const bones=new Float32Array(32*16);for(let j=0;j<32;j++)bones.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],j*16);

      // Two dolphins (near, and at 400 m), a shark at 1500 m and the whale at 200 m, as the sea's state writes them.
      const families={
        dolphins:{types:[ANIMAL_TYPE.dolphin],animals:[[0,-0.5,10,ANIMAL_TYPE.dolphin],[2,-0.5,400,ANIMAL_TYPE.dolphin]]},
        'marine life':{types:[ANIMAL_TYPE.shark,ANIMAL_TYPE.whale],animals:[[0,-0.5,1500,ANIMAL_TYPE.shark],[0,-1,200,ANIMAL_TYPE.whale]]},
      };
      for(const [name,family] of Object.entries(families)){
        const count=family.animals.length,words=new Uint32Array(count*D.SEA_PLACE_VEC4S*4),floats=new Float32Array(words.buffer);
        family.animals.forEach(([x,depth,z,type],i)=>{floats.set([x,depth,z,0, 0,0,1,0, type],i*12);words[i*12+9]=i+1;});
        const scene=createAnimalScene({device,atlas,programs,view:views[name],count,types:family.types,frame:frameUBO,shadowUniform:shadowUBO,samples:4,label:`test ${name}`});
        scene.setCount(count);
        const marine=name!=='dolphins',stand=stands[marine?'marine':'dolphins'];
        const entries=[[0,{buffer:frameUBO}],[1,{buffer:make(floats,B.STORAGE)}],[2,{buffer:scene.records}],[3,{buffer:scene.poses}],[4,{buffer:atlas.rig}],...(marine?[[5,{buffer:make(bones,B.STORAGE)}]]:[]),[6,sea.createView({dimension:'2d-array'})],[7,seaSampler]];
        Object.assign(family,{count,scene,stand,group:device.createBindGroup({layout:stand.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))})});
      }

      const readBack=async(buffer,size)=>{
        const staging=device.createBuffer({size,usage:B.MAP_READ|B.COPY_DST}),encoder=device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const words=new Uint32Array(staging.getMappedRange().slice(0));staging.unmap();staging.destroy();return words;
      };
      // What the cut chose: for each list, its draw and its entries; for each animal, the kinds it was entered as.
      const chosen=async scene=>{
        const draws=await readBack(scene.draws,scene.draws.size),list=await readBack(scene.list,scene.list.size);
        const lists=CONTINUUM_LISTS.map((name,index)=>{
          const [first]=scene.lists[index],instances=draws[index*4+1];
          return {name,vertices:draws[index*4],instances,entries:Array.from({length:instances},(_,k)=>[list[(first+k)*2],list[(first+k)*2+1]])};
        });
        const animals=Array.from({length:scene.count},()=>({view:[],shadow:0})),wrong=[];
        lists.forEach(({entries},index)=>{
          const kind=index===2||index===4?CONTINUUM_FAR_ENTRY:index===3?CONTINUUM_SPLAT_ENTRY:CONTINUUM_CLUSTER_ENTRY;
          for(const [animal,word] of entries){
            if(word>>>28!==kind||animal>=scene.count)wrong.push([index,animal,word]);
            if(index>=CONTINUUM_VIEW_LISTS)animals[animal].shadow++;
            else if(!animals[animal].view.includes(kind))animals[animal].view.push(kind);
          }
        });
        for(const a of animals)a.view.sort();
        return {draws:Array.from(draws),lists:lists.map(({name,vertices,instances})=>({name,vertices,instances})),animals,wrong};
      };
      const encodeCut=(pixels,census=null)=>{
        setContinuumPixelError(pixels);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        for(const family of Object.values(families)){pass.setPipeline(family.stand);pass.setBindGroup(0,family.group);pass.dispatchWorkgroups(1);family.scene.encode(pass);}
        pass.end();
        if(census)census.encode(encoder,Object.entries(families).map(([name,family])=>({name,draws:family.scene.continuumDraws()})));
        device.queue.submit([encoder.finish()]);census?.afterSubmit();
      };
      const base=continuumPixelError(),census=createContinuumCensus(device);
      encodeCut(1,census);
      const records={};
      for(const [name,family] of Object.entries(families)){
        const words=await readBack(family.scene.records,family.count*CONTINUUM_RECORD_WORDS*4),floats=new Float32Array(words.buffer);
        records[name]=Array.from({length:family.count},(_,i)=>{const at=i*CONTINUUM_RECORD_WORDS,packed=words[at+8];return {at:[floats[at],floats[at+1],floats[at+2]],scale:floats[at+3],type:packed&0xffff,kind:(packed>>>CONTINUUM_KIND_SHIFT)&15,sea:(packed&CONTINUUM_SEA)!==0,important:(packed&CONTINUUM_IMPORTANT_FLAG)!==0};});
      }
      const fine={};for(const [name,family] of Object.entries(families))fine[name]=await chosen(family.scene);
      for(let i=0;i<200&&!census.latest;i++){await new Promise(r=>setTimeout(r,10));census.afterSubmit();}
      const counted=census.latest;
      setContinuumPixelError(base);
      census.destroy();for(const family of Object.values(families))family.scene.destroy();
      const expected=draws=>draws.slice(0,CONTINUUM_VIEW_LISTS*4).reduce((sum,_,k,all)=>k%4?sum:sum+Math.floor(all[k]/3)*all[k+1],0);
      const triangles=Object.fromEntries(Object.keys(families).map(name=>[name,expected(fine[name].draws)]));
      device.destroy();
      return {errors,built,records,fine,counted,triangles,entryVertices:Array.from(CONTINUUM_ENTRY_VERTICES),skinned:CONTINUUM_KIND.SKINNED,
        entry:{cluster:CONTINUUM_CLUSTER_ENTRY,far:CONTINUUM_FAR_ENTRY,splat:CONTINUUM_SPLAT_ENTRY},types:{dolphin:ANIMAL_TYPE.dolphin,shark:ANIMAL_TYPE.shark,whale:ANIMAL_TYPE.whale}};
    });
    t.diagnostic(JSON.stringify({built:result.built,records:result.records,fine:result.fine,counted:result.counted,triangles:result.triangles}));
    assert.deepEqual(result.errors,[]);
    assert.equal(result.built.length,2+2+4+4+9+2,'every animal program builds');
    // The stand set every animal on the still sea at its depth, of the SKINNED kind, afloat and important.
    const want={dolphins:[[10,-0.5,result.types.dolphin],[400,-0.5,result.types.dolphin]],'marine life':[[1500,-0.5,result.types.shark],[200,-1,result.types.whale]]};
    for(const [name,list] of Object.entries(want))list.forEach(([z,y,type],i)=>{
      const r=result.records[name][i];
      assert.equal(r.type,type,`${name} ${i} type`);assert.equal(r.kind,result.skinned,`${name} ${i} is skinned`);
      assert.ok(r.sea&&r.important,`${name} ${i} is afloat and important`);
      assert.ok(Math.abs(r.at[1]-y)<1e-3&&Math.abs(r.at[2]-z)<1e-3&&r.scale===1,`${name} ${i} stands where it swims`);
    });
    for(const name of Object.keys(want)){
      assert.deepEqual(result.fine[name].wrong,[],`every ${name} entry is of its list's kind and its animal`);
      result.fine[name].lists.forEach((list,i)=>assert.equal(list.vertices,result.entryVertices[i],`${name} ${list.name} draws whole entries`));
    }
    const {cluster:C,splat:S}=result.entry;
    // Near, a dolphin is its clusters; at 1500 m the shark is its splat; the whale at 200 m is drawn.
    assert.deepEqual(result.fine.dolphins.animals[0].view,[C]);
    assert.deepEqual(result.fine['marine life'].animals[0].view,[S]);
    assert.ok(result.fine['marine life'].animals[1].view.length>0,'the whale is drawn');
    // The census counts exactly the triangles the cut put in the view's lists.
    assert.ok(result.counted,'the census reported');
    for(const name of Object.keys(want))assert.equal(result.counted.families[name],result.triangles[name]);
    assert.ok(result.triangles.dolphins>0&&result.triangles['marine life']>0);
  }finally{await browser?.close();server.close();}
});
