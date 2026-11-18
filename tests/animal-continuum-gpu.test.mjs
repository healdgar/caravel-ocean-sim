// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal is drawn through the one continuum (AGENTS.md rule 3): the herds' step writes each beast's place, the
// sea's state writes each dolphin's, shark's and whale's, and the shared cut reads them back into the lists the
// families draw, and nothing else. Read back on the GPU: what each animal's cut chose at the scene's pixel error and
// at a coarser one; that a felled beast keeps to its clusters, a hidden one is not drawn and one behind the eye is
// not drawn but still casts its shadow; that every entry is of its list's kind; and that the census counts exactly
// what the lists hold. Every animal program (the cut, the herds' step, view and shadow, the sea's bodies and their
// water captures) compiles and builds its pipeline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const root=new URL('..',import.meta.url);
const read=file=>fs.readFileSync(new URL(file,root),'utf8');

test('animal families have no draw of their own: their bodies are drawn only from the continuum lists',()=>{
  for(const file of ['js/herds.js','js/dolphins.js','js/marine-life.js']){
    const source=read(file);
    assert.doesNotMatch(source,/drawIndexed|setIndexBuffer|setVertexBuffer|drawIndirect/,`${file} draws a body itself`);
    assert.match(source,/ANIMAL_CONTINUUM_ENTRY_LAYOUT/,`${file} reads the continuum's lists`);
    assert.match(source,/drawView\(pass\)/,`${file} draws the continuum's view lists`);
  }
  // The sets draw each list with one indirect call, the list bound as its instance buffer.
  assert.match(read('js/animal-continuum-draw.js'),/pass\.setVertexBuffer\(0, list, at \* 8, n \* 8\);\s*pass\.drawIndirect\(draws, index \* 16\);/);
  // The herds' old ladder is gone with its buckets, morph and fade.
  const herds=read('js/wgsl/herds.js');
  for(const name of ['HERD_BUCKETS','HERD_SPLAT_BUCKET','HERD_FADE_BUCKET','HERD_MORPH_HI_PX','HERDS_RESET_WGSL','herdMeshKeep','herdsSplatVS','herdsFadeFS'])assert.ok(!herds.includes(name),`${name} remains`);
  assert.ok(!read('js/wgsl/dolphins.js').includes('fn dolphinVS('),'the dolphins\' own mesh pass remains');
  assert.ok(!read('js/wgsl/marine-life.js').includes('fn dolphinVS('),'the marine animals\' own mesh pass remains');
});

test('animals are cut on the GPU into the continuum lists, and only those are drawn and counted',{timeout:600000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__animal_continuum',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__animal_continuum');
    const result=await page.evaluate(async()=>{
      const {requestHerdsPipelines}=await import('/js/herds.js');
      const {HERD_SEED_FLOATS,HERD_FATE_FLOATS,HERD_SHOTS_WORDS}=await import('/js/wgsl/herds.js');
      const {DOLPHIN_RENDER}=await import('/js/wgsl/dolphins.js');
      const {MARINE_LIFE_RENDER,MARINE_EFFECT_INIT}=await import('/js/wgsl/marine-life.js');
      const {createSubmergedShader}=await import('/js/water-optics.js');
      const {coupleSurfaceHeight}=await import('/js/wgsl/surface-coupling.js');
      const {createAnimalContinuumSet,requestAnimalContinuumAtlas,requestAnimalContinuumPipelines}=await import('/js/animal-continuum-draw.js');
      const {ANIMAL_CONTINUUM_ENTRY_LAYOUT,ANIMAL_CONTINUUM_LISTS,ANIMAL_CONTINUUM_INSTANCE_VERTICES,ANIMAL_CONTINUUM_VIEW_LISTS,ANIMAL_CONTINUUM_ENTRY}=await import('/js/wgsl/animal-continuum.js');
      const {ANIMAL_PLACE_FLOATS,ANIMAL_PLACE_SEA,ANIMAL_PLACE_EXACT,ANIMAL_PLACE_CODE,ANIMAL_TYPE,ANIMAL_CONTINUUM_TYPE,ANIMAL_CONTINUUM_TYPE_WORDS,ANIMAL_CONTINUUM_HEADER,animalPlaceCode}=await import('/js/animal-continuum.js');
      const {setContinuumPixelError,continuumPixelError}=await import('/js/continuum-core.js');
      const {createContinuumCensus}=await import('/js/continuum-census.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));return module;};
      const B=GPUBufferUsage;
      const make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};

      // Every animal program builds.
      const herdPipes=await requestHerdsPipelines({device,shader,format:'rgba16float',samples:4});
      const cut=await requestAnimalContinuumPipelines({device,shader});
      const built=['herds view','herds shadow','herds step','continuum reset','continuum cut'];
      const seaPipeline=async(code,label,vertex,fragment,targets,samples,stage)=>{
        const module=await shader(code,label);
        return device.createRenderPipelineAsync({label,layout:'auto',vertex:{module,entryPoint:vertex,buffers:ANIMAL_CONTINUUM_ENTRY_LAYOUT},fragment:{module,entryPoint:fragment,targets},
          primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}}).then(()=>built.push(stage));
      };
      const coupled=code=>coupleSurfaceHeight(code,'dolphinSea(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'seaSampler'});
      for(const [name,code] of [['dolphins',DOLPHIN_RENDER],['marine life',MARINE_LIFE_RENDER]]){
        for(const [variant,source,waves] of [['still',code,false],['coupled',coupled(code),true]]){
          await seaPipeline(source,`${name} ${variant}`,'seaContinuumVS','seaContinuumFS',[{format:'rgba16float'}],4,`${name} ${variant} view`);
          await seaPipeline(createSubmergedShader(source,'seaContinuumCaptureFS','v.world',waves),`${name} ${variant} capture`,'seaContinuumVS','submergedFS',[{format:'rgba16float'}],1,`${name} ${variant} capture`);
        }
      }
      const effectModule=await shader(MARINE_EFFECT_INIT,'marine emission height');
      for(const entryPoint of ['marineBirthCS','marineImpactContactCS']){await device.createComputePipelineAsync({layout:'auto',compute:{module:effectModule,entryPoint}});built.push(entryPoint);}

      // A camera at 1.47 m looking down +z: clip = (x, y, 0.1, z); focal 1000 px.
      const frame=new Float32Array(96);
      frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,1.465,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
      const frameUBO=make(frame,B.UNIFORM);
      // The land's shadow map: 200 m across, 1000 m deep about the origin.
      const shadowFrame=new Float32Array(28);
      shadowFrame.set([0.01,0,0,0, 0,0.01,0,0, 0,0,0.001,0, 0,0,0.5,1],0);shadowFrame.set([0,0,0,1],16);shadowFrame.set([0,1,0,1],20);shadowFrame.set([0.05,0.05,0,0],24);
      const shadowUBO=make(shadowFrame,B.UNIFORM);
      const atlas=await requestAnimalContinuumAtlas(device);
      const typeWord=(type,field)=>atlas.words[atlas.words[ANIMAL_CONTINUUM_HEADER.typesAt]+type*ANIMAL_CONTINUUM_TYPE_WORDS+field];

      // Six sheep through the herds' own step: near, at 38 m, felled at 40 m, at 300 m, at 600 m, behind the eye.
      const herdZ=[8,38,40,300,600,-200],count=herdZ.length;
      const herdSet=createAnimalContinuumSet({device,atlas,pipelines:cut,frame:frameUBO,shadowUniform:shadowUBO,capacity:count,samples:4,label:'test herd'});
      herdSet.setCount(count);
      const seeds=new Float32Array(count*HERD_SEED_FLOATS),fates=new Float32Array(count*HERD_FATE_FLOATS);
      herdZ.forEach((z,i)=>seeds.set([0,z,0,0.1*i,0.42,1,0,0],i*HERD_SEED_FLOATS));
      fates.set([2,0,0,1, 0,40,0,0],2*HERD_FATE_FLOATS);
      const ground=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture:ground},new Uint8Array(16).fill(255),{bytesPerRow:8},[2,2]);
      const cfg=new ArrayBuffer(16);new Uint32Array(cfg,0,1)[0]=count;
      const stepEntries=[[0,frameUBO],[1,make(new Float32Array([0,0,4000,0]),B.UNIFORM)],[2,make(new Float32Array(8),B.UNIFORM)],[3,null],[4,make(new Uint8Array(cfg),B.UNIFORM)],[5,make(seeds,B.STORAGE)],[6,herdSet.places],
        [9,make(new Float32Array(4),B.STORAGE)],[10,make(new Uint32Array(HERD_SHOTS_WORDS),B.UNIFORM)],[11,make(fates,B.STORAGE)]];
      const stepGroup=device.createBindGroup({layout:herdPipes.step.getBindGroupLayout(0),entries:stepEntries.map(([binding,buffer])=>({binding,resource:buffer?{buffer}:ground.createView()}))});

      // A dolphin near, a shark at 1500 m, the whale at 200 m and a hidden dolphin, written as the sea's state writes them.
      const seaSet=createAnimalContinuumSet({device,atlas,pipelines:cut,frame:frameUBO,capacity:4,samples:4,label:'test sea'});
      const seaPlaces=new Float32Array(4*ANIMAL_PLACE_FLOATS);
      seaPlaces.set([0,-0.5,10,0, 0,0,1,animalPlaceCode(ANIMAL_TYPE.dolphin,ANIMAL_PLACE_SEA,1), 0],0);
      seaPlaces.set([0,-0.5,1500,0.3, 0,0,1,animalPlaceCode(ANIMAL_TYPE.shark,ANIMAL_PLACE_SEA,2), 0],ANIMAL_PLACE_FLOATS);
      seaPlaces.set([0,-1,200,0, 0,0,1,animalPlaceCode(ANIMAL_TYPE.whale,ANIMAL_PLACE_SEA,3), 0],2*ANIMAL_PLACE_FLOATS);
      seaPlaces.set([0,-0.5,12,0, 0,0,0,animalPlaceCode(ANIMAL_TYPE.dolphin,ANIMAL_PLACE_SEA,4), 0],3*ANIMAL_PLACE_FLOATS);
      seaSet.writePlaces(seaPlaces,4);

      const readBack=async(buffer,size)=>{
        const staging=device.createBuffer({size,usage:B.MAP_READ|B.COPY_DST}),encoder=device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const words=new Uint32Array(staging.getMappedRange().slice(0));staging.unmap();staging.destroy();return words;
      };
      // What the cut chose: for each list, its draw and its entries; for each animal, the kinds it was entered as.
      const chosen=async(set,typeOf)=>{
        const draws=await readBack(set.draws,set.draws.size),list=await readBack(set.list,set.list.size);
        const lists=ANIMAL_CONTINUUM_LISTS.map((name,index)=>{
          const [first]=set.lists[index],instances=draws[index*4+1];
          const entries=Array.from({length:instances},(_,k)=>[list[(first+k)*2],list[(first+k)*2+1]]);
          return {name,vertices:draws[index*4],instances,entries};
        });
        const animals=Array.from({length:set.count},()=>({view:[],shadow:0}));
        const wrong=[];
        lists.forEach(({entries},index)=>{
          const kind=index<2?ANIMAL_CONTINUUM_ENTRY.cluster:index===3?ANIMAL_CONTINUUM_ENTRY.splat:ANIMAL_CONTINUUM_ENTRY.far;
          for(const [animal,word] of entries){
            const item=word&0x0fffffff;
            if(word>>>28!==kind||animal>=set.count)wrong.push([index,animal,word]);
            else if(kind===ANIMAL_CONTINUUM_ENTRY.cluster){
              const type=typeOf(animal),first=typeWord(type,ANIMAL_CONTINUUM_TYPE.clusterFirst);
              if(item<first||item>=first+typeWord(type,ANIMAL_CONTINUUM_TYPE.clusterCount))wrong.push([index,animal,word]);
            }
            if(index===4)animals[animal].shadow++;
            else if(!animals[animal].view.includes(kind))animals[animal].view.push(kind);
          }
        });
        for(const a of animals)a.view.sort();
        return {draws:Array.from(draws),lists:lists.map(({name,vertices,instances})=>({name,vertices,instances})),animals,wrong};
      };

      const encodeCut=(pixels,{step=false,census=null}={})=>{
        setContinuumPixelError(pixels);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        if(step){pass.setPipeline(herdPipes.step);pass.setBindGroup(0,stepGroup);pass.dispatchWorkgroups(Math.ceil(count/64));}
        herdSet.encode(pass);seaSet.encode(pass);pass.end();
        if(census)census.encode(encoder,[{name:'herds',draws:herdSet.continuumDraws()},{name:'sea',draws:seaSet.continuumDraws()}]);
        device.queue.submit([encoder.finish()]);census?.afterSubmit();
      };
      const base=continuumPixelError();
      const census=createContinuumCensus(device);
      encodeCut(1,{step:true,census});
      const placeWords=await readBack(herdSet.places,count*ANIMAL_PLACE_FLOATS*4),placeFloats=new Float32Array(placeWords.buffer);
      const herdPlaces=herdZ.map((_,i)=>{const p=placeFloats.subarray(i*ANIMAL_PLACE_FLOATS,(i+1)*ANIMAL_PLACE_FLOATS),code=Math.round(p[7]);return {at:[p[0],p[1],p[2]],scale:p[6],type:code%ANIMAL_PLACE_CODE,flags:Math.floor(code/ANIMAL_PLACE_CODE)&15};});
      const sheepType=()=>ANIMAL_TYPE.sheep,seaType=animal=>[ANIMAL_TYPE.dolphin,ANIMAL_TYPE.shark,ANIMAL_TYPE.whale,ANIMAL_TYPE.dolphin][animal];
      const fine={herds:await chosen(herdSet,sheepType),sea:await chosen(seaSet,seaType)};
      for(let i=0;i<200&&!census.latest;i++){await new Promise(r=>setTimeout(r,10));census.afterSubmit();}
      const counted=census.latest;
      encodeCut(8);
      const coarse={herds:await chosen(herdSet,sheepType),sea:await chosen(seaSet,seaType)};
      setContinuumPixelError(base);
      census.destroy();herdSet.destroy();seaSet.destroy();
      const expected=draws=>draws.slice(0,ANIMAL_CONTINUUM_VIEW_LISTS*4).reduce((sum,_,k,all)=>k%4?sum:sum+Math.floor(all[k]/3)*all[k+1],0);
      const instanceVertices=Array.from(ANIMAL_CONTINUUM_INSTANCE_VERTICES);
      device.destroy();
      return {errors,built,herdPlaces,fine,coarse,counted,triangles:{herds:expected(fine.herds.draws),sea:expected(fine.sea.draws)},instanceVertices,exact:ANIMAL_PLACE_EXACT};
    });
    t.diagnostic(JSON.stringify({built:result.built,herdPlaces:result.herdPlaces,fine:result.fine,coarse:result.coarse,counted:result.counted,triangles:result.triangles}));
    assert.deepEqual(result.errors,[]);
    assert.equal(result.built.length,5+8+2,'every animal program builds');
    const C=1,F=2,S=3;
    // The herds' step wrote every sheep's place: a sheep, standing but for the felled one, which is exact.
    for(const [i,p] of result.herdPlaces.entries()){
      assert.equal(p.type,0,`sheep ${i} is a sheep`);
      assert.ok(p.scale>0,`sheep ${i} is placed`);
      assert.equal(p.flags,i===2?result.exact:0,`sheep ${i} flags`);
      assert.ok(Math.abs(p.at[2]-[8,38,40,300,600,-200][i])<3,`sheep ${i} stands at its anchor`);
    }
    for(const cut of [result.fine,result.coarse])for(const family of ['herds','sea']){
      assert.deepEqual(cut[family].wrong,[],`every ${family} entry is of its list's kind, its animal and its type's clusters`);
      cut[family].lists.forEach((list,i)=>assert.equal(list.vertices,result.instanceVertices[i],`${family} ${list.name} draws whole entries`));
    }
    const view=(cut,family)=>cut[family].animals.map(a=>a.view);
    // At the scene's pixel error: clusters near and at 38 m; the felled sheep its clusters alone; at 300 m clusters
    // handing over to the splat; at 600 m the splat; none behind the eye.
    assert.deepEqual(view(result.fine,'herds'),[[C],[C],[C],[C,S],[S],[]]);
    // Eight times coarser: the sheep at 38 m is in the band where its clusters hand over to its far body; the felled
    // one still keeps to its clusters; past 300 m only splats.
    assert.deepEqual(view(result.coarse,'herds'),[[C],[C,F],[C],[S],[S],[]]);
    // The shadow map takes the far body of every sheep in its reach, seen or not, the felled one too.
    assert.deepEqual(result.fine.herds.animals.map(a=>a.shadow>0),[true,true,true,true,false,true]);
    // The sea: the near dolphin and the whale whole in their clusters, the far shark a splat, the hidden one nothing;
    // eight times coarser, the whale is past its handoff to its far body.
    assert.deepEqual(view(result.fine,'sea'),[[C],[S],[C],[]]);
    assert.deepEqual(view(result.coarse,'sea'),[[C],[S],[F],[]]);
    assert.ok(result.fine.sea.animals.every(a=>a.shadow===0),'the sea casts no land shadow');
    // The census counts exactly the triangles the cut put in the view's lists.
    assert.ok(result.counted,'the census reported');
    assert.equal(result.counted.families.herds,result.triangles.herds);
    assert.equal(result.counted.families.sea,result.triangles.sea);
    assert.ok(result.triangles.herds>0&&result.triangles.sea>0);
  }finally{await browser?.close();server.close();}
});
