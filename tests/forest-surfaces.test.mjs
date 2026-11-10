// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {FOREST_SURFACE_ASSETS,FOREST_SURFACE_CODECS,PORTUGAL_FOREST_SURFACE_ASSETS,SUBTROPICAL_FOREST_SURFACE_ASSETS,chooseForestSurfaceCodec,createForestSurfaceTextures,forestSurfaceFeatures,loadForestSurfaceSet} from '../js/forest-surfaces.js';

const PACKS=[['saba',FOREST_SURFACE_ASSETS],['subtropical',SUBTROPICAL_FOREST_SURFACE_ASSETS],['portugal',PORTUGAL_FOREST_SURFACE_ASSETS]];
const root=new URL('../',import.meta.url);
const json=async file=>JSON.parse(await readFile(new URL(file,root),'utf8'));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const packMaterials=forest=>forest.prototypes.flatMap(p=>p.nativeMaterials);

test('each pack\'s compressed set describes its exact maps and holds a complete chain for each format',async()=>{
  for(const [pack,assets]of PACKS){
    const forest=await json(`assets/forest-scenery/${pack}/manifest.json`),set=await json(assets['manifest.json']),materials=packMaterials(forest);
    assert.equal(set.format,'waterworld.forest-surfaces');
    assert.ok(set.families.length<=4,'the renderer binds four texture families');
    // A layer serves the material it was baked from and any that share its maps.
    const placed=set.families.flatMap(f=>f.layers.flatMap(l=>[l.material,...(l.shares??[])])).sort((a,b)=>a-b);
    assert.deepEqual(placed,materials.map((_,i)=>i),pack+' places every material once');
    for(const family of set.families){
      assert.equal(family.levels,1+Math.floor(Math.log2(Math.max(family.width,family.height))),'a full mip chain');
      for(const layer of family.layers)for(const index of [layer.material,...(layer.shares??[])]){
        const material=materials[index];
        for(const kind of ['albedo','normal','roughnessMap'])assert.equal(layer.sources[kind]??null,material[kind]?.sha256??null,
          `${pack} ${material.name} ${kind} changed since the bake; run: python3 scripts/prepare-forest-surfaces.py ${pack}`);
      }
      let expected=0;for(let level=0;level<family.levels;level++)expected+=Math.ceil(Math.max(1,family.width>>level)/4)*Math.ceil(Math.max(1,family.height>>level)/4)*16*family.layers.length;
      for(const codec of Object.keys(FOREST_SURFACE_CODECS))for(const kind of ['albedo','detail']){
        const file=family.files[codec][kind];
        assert.ok(assets[file.gzip.file],`${file.gzip.file} is registered, so build.mjs publishes it`);
        const packed=await readFile(new URL(assets[file.gzip.file],root));
        assert.equal(sha256(packed),file.gzip.sha256);assert.equal(packed.length,file.gzip.bytes);
        const raw=gunzipSync(packed);assert.equal(raw.length,file.bytes);assert.equal(sha256(raw),file.sha256);
        assert.equal(raw.length,expected,'the bytes the runtime copies, level by level');
      }
    }
  }
});

test('cohorts that wear the same maps share one layer, and each still gets its own row of optics',async()=>{
  const forest=await json('assets/forest-scenery/portugal/manifest.json'),materials=packMaterials(forest);
  const fetchAsset=async file=>new Response(await readFile(new URL(file,root)));
  const set=await loadForestSurfaceSet({assets:PORTUGAL_FOREST_SURFACE_ASSETS,materials,codec:'bc7',fetchAsset});
  assert.ok(set,'Lisbon\'s pack has a compressed set; without one its bark and leaves load as 96 MiB of half floats');
  const layers=set.families.reduce((sum,family)=>sum+family.layers.length,0);
  assert.equal(materials.length,60);assert.equal(layers,30,'veteran and canopy trees of a species share their layers');
  let bytes=0;for(const family of set.families)bytes+=family.albedo.data.byteLength+family.detail.data.byteLength;
  assert.ok(bytes<13*1048576,`the set holds ${(bytes/1048576).toFixed(1)} MiB`);
  // The textures themselves need a GPU; the table of optics does not.
  const writes=[],device={createTexture:d=>({destroy(){},d}),queue:{writeTexture:(...a)=>writes.push(a)}};
  globalThis.GPUTextureUsage??={TEXTURE_BINDING:4,COPY_DST:2};
  const surfaces=createForestSurfaceTextures({device,set,materials});
  for(const [index,material]of materials.entries()){
    const row=Array.from(surfaces.optics.subarray(index*12,index*12+12)),layer=set.families[row[8]]?.layers[row[9]];
    assert.ok(layer&&[layer.material,...(layer.shares??[])].includes(index),`material ${index} points at a layer baked from other maps`);
    assert.ok(Math.abs(row[0]-material.roughness)<1e-6);
  }
});

test('the best available format is chosen, and a device with neither uses the maps',()=>{
  const device=(...features)=>({features:new Set(features)}),{bc7,astc}=FOREST_SURFACE_CODECS;
  assert.equal(chooseForestSurfaceCodec(device(bc7.feature)),'bc7');
  assert.equal(chooseForestSurfaceCodec(device(astc.feature)),'astc');
  assert.equal(chooseForestSurfaceCodec(device(bc7.feature,astc.feature)),'bc7');
  assert.equal(chooseForestSurfaceCodec(device()),null);
  assert.equal(chooseForestSurfaceCodec(device(bc7.feature,astc.feature),'astc'),'astc');
  assert.equal(chooseForestSurfaceCodec(device(astc.feature),'bc7'),null,'forcing a format the device lacks falls back');
  assert.equal(chooseForestSurfaceCodec(device(bc7.feature),'png'),null);
  assert.deepEqual(forestSurfaceFeatures({features:new Set([astc.feature,'timestamp-query'])}),[astc.feature]);
});

test('edited maps fall back instead of showing a stale set, and corrupt blocks are refused',async()=>{
  const forest=await json('assets/forest-scenery/saba/manifest.json'),materials=packMaterials(forest);
  const fetchAsset=async file=>new Response(await readFile(new URL(file,root)));
  const fine=await loadForestSurfaceSet({assets:FOREST_SURFACE_ASSETS,materials,codec:'bc7',fetchAsset});
  assert.equal(fine.families.length,2);
  const edited=materials.map((m,i)=>i?m:{...m,albedo:{...m.albedo,sha256:'0'.repeat(64)}});
  assert.equal(await loadForestSurfaceSet({assets:FOREST_SURFACE_ASSETS,materials:edited,codec:'bc7',fetchAsset}),null);
  const corrupt=async file=>{const bytes=await readFile(new URL(file,root));if(file.endsWith('.gz'))bytes[bytes.length>>1]^=255;return new Response(bytes);};
  await assert.rejects(loadForestSurfaceSet({assets:FOREST_SURFACE_ASSETS,materials,codec:'bc7',fetchAsset:corrupt}),/failed verification/);
  await assert.rejects(loadForestSurfaceSet({assets:FOREST_SURFACE_ASSETS,materials,codec:'bc7',fetchAsset:async()=>new Response('',{status:404})}),/unavailable/);
});

test('decoded blocks keep each level\'s leaf coverage and linear pigment on a real GPU',{timeout:240000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-surfaces',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-surfaces');
    const result=await page.evaluate(async()=>{
      const {FOREST_SURFACE_ASSETS,PORTUGAL_FOREST_SURFACE_ASSETS,FOREST_SURFACE_CODECS,createForestSurfaceTextures,forestSurfaceFeatures,loadForestSurfaceSet}=await import('/js/forest-surfaces.js');
      const adapter=await navigator.gpu.requestAdapter();
      const device=await adapter.requestDevice({requiredFeatures:forestSurfaceFeatures(adapter)}),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const module=device.createShaderModule({code:`
        @group(0)@binding(0)var surface:texture_2d_array<f32>;
        @group(0)@binding(1)var<uniform>at:vec2i;
        @vertex fn cover(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{return vec4f(array(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
        @fragment fn read(@builtin(position)p:vec4f)->@location(0)vec4f{return textureLoad(surface,vec2i(p.xy),at.x,at.y);}`});
      const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'cover'},fragment:{module,entryPoint:'read',targets:[{format:'rgba32float'}]}});
      const mean=async(texture,layer,level,width,height)=>{
        const target=device.createTexture({size:[width,height],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
        const bytesPerRow=Math.ceil(width*16/256)*256,read=device.createBuffer({size:bytesPerRow*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const at=device.createBuffer({size:8,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(at,0,new Int32Array([layer,level]));
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({dimension:'2d-array'})},{binding:1,resource:{buffer:at}}]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store'}]});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow},[width,height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const pixels=new Float32Array(read.getMappedRange()),totals=[0,0,0,0];
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<4;c++)totals[c]+=pixels[y*bytesPerRow/4+x*4+c];
        read.unmap();read.destroy();target.destroy();at.destroy();return totals.map(v=>v/(width*height));
      };
      const out=[];
      // Portugal's set is the one baked with the plainer built-in encoders; its sample takes in rows of both kinds.
      for(const [pack,assets]of [['saba',FOREST_SURFACE_ASSETS],['portugal',PORTUGAL_FOREST_SURFACE_ASSETS]])
      for(const codec of Object.keys(FOREST_SURFACE_CODECS).filter(c=>device.features.has(FOREST_SURFACE_CODECS[c].feature))){
        const forest=await(await fetch(`/assets/forest-scenery/${pack}/manifest.json`)).json(),manifest=await(await fetch(`/assets/forest-scenery/${pack}/surfaces/manifest.json`)).json();
        const materials=forest.prototypes.flatMap(p=>p.nativeMaterials);
        const set=await loadForestSurfaceSet({assets,materials,codec});
        const surfaces=createForestSurfaceTextures({device,set,materials});
        for(const [f,family]of manifest.families.entries())for(const [l,layer]of family.layers.entries()){
          if(l%5)continue; // A sample across species keeps this quick on a software GPU.
          for(let level=0;level<family.levels;level+=2){
            const width=Math.max(1,family.width>>level),height=Math.max(1,family.height>>level);
            out.push({codec,name:layer.name,family:f,level,expected:layer.coverage[level],actual:(await mean(surfaces.families[f].albedo,l,level,width,height))[3]});
          }
          const last=family.levels-1,pigment=await mean(surfaces.families[f].albedo,l,last,1,1);
          out.push({codec,name:layer.name,family:f,terminal:pigment,expectedTerminal:layer.terminal});
        }
        await device.queue.onSubmittedWorkDone();surfaces.destroy();
      }
      device.destroy();return{errors,out};
    });
    assert.deepEqual(result.errors,[]);
    const levels=result.out.filter(r=>r.terminal===undefined),codecs=new Set(result.out.map(r=>r.codec));
    if(!codecs.size)return;
    for(const row of levels)assert.ok(Math.abs(row.actual-row.expected)<.012,`${row.codec} ${row.name} level ${row.level} coverage ${row.actual} versus ${row.expected}`);
    for(const row of result.out.filter(r=>r.terminal))for(let c=0;c<4;c++)assert.ok(Math.abs(row.terminal[c]-row.expectedTerminal[c])<.02,`${row.codec} ${row.name} terminal ${row.terminal} versus ${row.expectedTerminal}`);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
