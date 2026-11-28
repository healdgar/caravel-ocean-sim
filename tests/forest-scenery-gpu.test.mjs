// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

// The stand (js/wgsl/forest-continuum.js) lists each tree in view or in the light box for the one cut, which chooses
// what a listed tree draws; so neither the rendered resolution nor the scene's pixel error moves a tree off the list,
// and no tree, however far, is handed to another surface. Its passes build on the layouts the renderer gives them.
test('the forest stand compiles as the game prepares it, and its passes build on their own layout',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-gpu');
    const result=await page.evaluate(async()=>{
      const {withCelestialFrame}=await import('/js/wgsl/celestial.js');
      const {pruneWGSLFunctions}=await import('/js/wgsl-prune.js');
      const {withSceneShadowCount}=await import('/js/wgsl/shadows.js');
      const {forestContinuumStandWGSL,forestContinuumBlocksWGSL,forestWindStepWGSL}=await import('/js/wgsl/forest-continuum.js');
      const {createForestComputeLayouts}=await import('/js/forest-scenery.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      // As the game compiles every shader (js/main.js): its sky frame and shadow count written in.
      const compile=async code=>{
        const module=device.createShaderModule({code:pruneWGSLFunctions(withSceneShadowCount(withCelestialFrame(code),1))});
        errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
        return module;
      };
      // The stand, the root blocks it culls by, and the wind's step, which steps the skeletons the stand hands each tree,
      // each on the layout the renderer binds it with.
      const [stand,blocks,wind]=await Promise.all([forestContinuumStandWGSL(),forestContinuumBlocksWGSL(),forestWindStepWGSL()].map(compile));
      const layouts=createForestComputeLayouts(device);
      const build=(layout,module,entryPoints)=>entryPoints.map(entryPoint=>device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint}}).catch(e=>errors.push(String(e.message??e))));
      device.pushErrorScope('validation');
      await Promise.all([
        ...build(layouts.stand,stand,['forestStandReset','forestStandRoots','forestStandFinish']),
        ...build(layouts.blocks,blocks,['forestBuildBlocks','forestStandBlockReset','forestStandBlocks','forestStandBlockArgs']),
        ...build(layouts.wind,wind,['forestWindHead','forestWindLanes','forestWindOwn']),
      ]);
      const scope=await device.popErrorScope();if(scope)errors.push(scope.message);
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors};
    });
    assert.deepEqual(result.errors,[]);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

test('native surface arrays preserve source size, linear pigment and fractional leaf coverage through GPU minification',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-surfaces',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-surfaces');
    const result=await page.evaluate(async()=>{
      const {createForestLeafSurfaces}=await import('/js/forest-scenery.js'),device=await(await navigator.gpu.requestAdapter()).requestDevice();
      const errors=[],uploads=[],created=[],write= device.queue.copyExternalImageToTexture.bind(device.queue),create=device.createTexture.bind(device);
      device.onuncapturederror=e=>errors.push(e.error.message);
      device.createTexture=description=>{
        created.push({label:description.label,size:description.size});
        return create(description.label.startsWith('forest immutable')?{...description,usage:description.usage|GPUTextureUsage.COPY_SRC}:description);
      };
      device.queue.copyExternalImageToTexture=(source,target,size)=>{uploads.push({label:target.texture.label,origin:target.origin,size});return write(source,target,size);};
      const textures={};
      async function png(name,width,height,colour,checker=false){
        const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d'),image=context.createImageData(width,height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const a=checker&&(x+y)%2?0:255;image.data.set(a?[...colour,a]:[0,255,255,0],(y*width+x)*4);
        }
        context.putImageData(image,0,0);const raw=await(await canvas.convertToBlob({type:'image/png'})).arrayBuffer();textures[name]=raw;
        const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
        return{file:name,bytes:raw.byteLength,sha256,encoding:name.endsWith('albedo.png')?'srgb':'linear'};
      }
      const leaf={name:'foliage_0',albedo:await png('leaf-oak-0-albedo.png',4,4,[128,64,32],true),
        normal:await png('leaf-oak-0-normal.png',4,4,[128,128,255]),roughness:.7,underside:.3,transmission:.13,opacityThreshold:.35,undersideReference:[.62,.7,.58]};
      const bark={name:'bark',albedo:await png('oak-bark-albedo.png',8,4,[32,64,128]),
        normal:await png('oak-bark-normal.png',8,4,[128,128,255]),roughnessMap:await png('oak-bark-roughness.png',8,4,[64,64,64]),
        roughness:.9,underside:0,transmission:0,opacityThreshold:0,undersideReference:[0,0,0],wrap:'repeat'};
      const pack={manifest:{prototypes:[{nativeMaterials:[leaf,bark]}]},textures},before=JSON.stringify(pack.manifest);
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return module;};
      const surfaces=await createForestLeafSurfaces({device,shader,pack});
      function half(bits){const s=bits&32768?-1:1,e=(bits>>10)&31,f=bits&1023;return e?s*Math.pow(2,e-15)*(1+f/1024):s*Math.pow(2,-14)*(f/1024);}
      async function lastPixel(texture,level){
        const read=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture,mipLevel:level},{buffer:read,bytesPerRow:256},[1,1,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const result=Array.from(new Uint16Array(read.getMappedRange(),0,4),half);read.unmap();read.destroy();return result;
      }
      const rows=[];for(const family of surfaces.families)rows.push({width:family.width,height:family.height,layers:family.rows.length,
        pigment:await lastPixel(family.albedo,family.levels-1),normal:await lastPixel(family.normal,family.levels-1)});
      const metadata=Array.from(surfaces.optics);await device.queue.onSubmittedWorkDone();surfaces.destroy();device.destroy();
      return{errors,rows,metadata,uploads,created,unchanged:before===JSON.stringify(pack.manifest)};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.unchanged,true);
    assert.deepEqual(result.rows.map(r=>[r.width,r.height,r.layers]),[[4,4,1],[8,4,1]],'native size families avoid upscaling every leaf to bark resolution');
    const linear=byte=>{const c=byte/255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);};
    const close=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.001,`${message}: ${actual} versus ${expected}`);
    for(let c=0;c<3;c++)close(result.rows[0].pigment[c],.5*linear([128,64,32][c]),'transparent pixels do not bleed colour into foliage');
    close(result.rows[0].pigment[3],.5,'unresolved leaves retain integrated area instead of disappearing at an alpha threshold');
    close(result.rows[0].normal[3],.5*.7,'native leaf roughness remains scalar');
    for(let c=0;c<3;c++)close(result.rows[1].pigment[c],linear([32,64,128][c]),'native bark pigment survives minification');
    close(result.rows[1].normal[3],64/255,'native roughness map overrides its scalar fallback');
    assert.equal(result.uploads.length,5,'each actual map uploads once');
    assert.deepEqual(result.metadata.slice(8,12),[0,0,0,0]);assert.deepEqual(result.metadata.slice(20,24),[1,0,1,0]);
    assert.equal(result.created.filter(t=>t.label.startsWith('forest immutable')).length,4);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
