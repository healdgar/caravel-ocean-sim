// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Genuine field-derived output is mandatory: set FOREST_MASS_TEST_PACK to a
// bounded stand directory/manifest, or install the production mass assets.
// This proves opaque depth/GPU ownership, not native-leaf appearance equivalence.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('genuine native-field forest mass draws opaque depth without per-frame CPU geometry or root reads',{timeout:240000},async t=>{
  const input=resolve(process.env.FOREST_MASS_TEST_PACK||fileURLToPath(new URL('../assets/forest-scenery/saba/mass',import.meta.url))),folder=(await stat(input)).isDirectory()?input:dirname(input);
  const forestPath=resolve(process.env.FOREST_MASS_TEST_FOREST||fileURLToPath(new URL('../assets/forest-scenery/saba/manifest.json',import.meta.url))),forest=JSON.parse(await readFile(forestPath,'utf8'));
  const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8'));
  assert.equal(manifest.format,'waterworld.native-forest-mass');assert.match(manifest.source.claim,/Original detailed native leaf triangles/);assert.match(manifest.recipe.assembly,/ADD continuous leaf-area density/);
  const allowed=new Set(['manifest.json',...Object.values(manifest.files).map(item=>item.gzip.file)]);
  const diagnostics={phase:'starting servers',pageCrashes:0,browserDisconnected:false,pageErrors:[],failedRequests:[],console:[],assetTransfers:[]};
  // Real HTTP streams avoid CDP/base64 duplication of the regional100MB files.
  // The browser still verifies encoded and decoded receipts through the loader.
  const assetServer=createServer(async(request,response)=>{
    response.setHeader('Access-Control-Allow-Origin','*');
    try{
      if(request.method==='OPTIONS'){response.writeHead(204);response.end();return;}
      const name=decodeURIComponent(new URL(request.url,'http://127.0.0.1').pathname.slice(1));
      if(!['GET','HEAD'].includes(request.method)||!allowed.has(name)||name.includes('/')){response.writeHead(404);response.end();return;}
      const file=join(folder,name),info=await stat(file);if(!info.isFile()){response.writeHead(404);response.end();return;}
      const transfer={name,bytes:info.size,complete:false};diagnostics.assetTransfers.push(transfer);
      response.writeHead(200,{'Content-Type':name==='manifest.json'?'application/json':'application/octet-stream','Content-Length':info.size,'Cache-Control':'no-store'});
      response.once('finish',()=>{transfer.complete=true;});if(request.method==='HEAD'){response.end();return;}
      const stream=createReadStream(file);stream.on('error',error=>{transfer.error=error.message;response.destroy(error);});response.once('close',()=>stream.destroy());stream.pipe(response);
    }catch(error){diagnostics.assetTransfers.push({error:error.message});if(!response.headersSent)response.writeHead(500);response.end();}
  });
  const server=createDevServer();let browser,closing=false;
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');assetServer.listen(0,'127.0.0.1');await once(assetServer,'listening');const assetBase='http://127.0.0.1:'+assetServer.address().port+'/';diagnostics.phase='launching browser';
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    browser.on('disconnected',()=>{if(!closing)diagnostics.browserDisconnected=true;});
    const page=await browser.newPage();
    page.on('crash',()=>{diagnostics.pageCrashes++;});page.on('pageerror',error=>{if(diagnostics.pageErrors.length<20)diagnostics.pageErrors.push(error.message);});
    page.on('requestfailed',request=>{if(diagnostics.failedRequests.length<20)diagnostics.failedRequests.push({url:request.url(),failure:request.failure()?.errorText});});
    page.on('console',message=>{if(['error','warning'].includes(message.type())&&diagnostics.console.length<20)diagnostics.console.push(message.text().slice(0,1000));});
    await page.goto('http://127.0.0.1:'+server.address().port+'/tests/fixtures/forest-gpu.html');
    diagnostics.phase='verifying and rendering actual streamed mass';
    const result=await page.evaluate(async({forest,assetBase})=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{TERRAIN}=await import('/js/wgsl/terrain.js');
      const {FOREST_MASS_ASSETS,FOREST_MASS_VERTEX_WGSL,loadForestMass,createForestMassRenderer}=await import('/js/forest-mass.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[],allocated=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async code=>{const module=device.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      const assets=Object.fromEntries(Object.keys(FOREST_MASS_ASSETS).map(name=>[name,assetBase+name])),pack=await loadForestMass({forest,assets});
      let active=false,rootReads=0;const reads=[];
      const owners=new Proxy(pack.rootChunks,{get(target,key){if(active&&key!=='length'){rootReads++;throw Error('Per-frame CPU root owner read: '+String(key));}const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
      const guarded=new Proxy({...pack,rootChunks:owners},{get(target,key,receiver){if(active&&['vertices','indices','rootChunks'].includes(key)){reads.push(key);throw Error('Per-frame CPU source read: '+key);}return Reflect.get(target,key,receiver);}});
      const writes=[],write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,offset,data,...rest)=>{
        if(active&&buffer.label.startsWith('forest mass '))throw Error('Per-frame CPU mass buffer write: '+buffer.label);
        if(buffer.label.startsWith('forest mass '))writes.push({label:buffer.label,offset,bytes:data.byteLength});return write(buffer,offset,data,...rest);
      };
      const descriptors=[],create=device.createRenderPipelineAsync.bind(device);device.createRenderPipelineAsync=description=>{if(description.label==='forest mass opaque native density surface')descriptors.push({vertex:description.vertex.entryPoint,layout:description.vertex.buffers[0],fragment:description.fragment.entryPoint,depth:description.depthStencil,msaa:description.multisample,blend:description.fragment.targets.map(t=>t.blend??null)});return create(description);};
      const copy=device.createCommandEncoder.bind(device);device.createCommandEncoder=(...args)=>{
        const e=copy(...args),original=e.copyBufferToBuffer.bind(e);e.copyBufferToBuffer=(source,offset,destination,...rest)=>{if(active&&destination.label.startsWith('forest mass immutable'))throw Error('Per-frame immutable mass staging copy');return original(source,offset,destination,...rest);};return e;
      };
      const make=(data,usage,label)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);allocated.push(b);return b;};
      const fd=new Float32Array(96),frame=make(fd,B.UNIFORM,'test field opacity frame'),dummy=make(new Float32Array(4),B.UNIFORM,'test neutral lighting stub');
      const start=TERRAIN.indexOf('struct CanopyVertex'),end=TERRAIN.indexOf('@fragment fn canopyLeafFS',start);if(start<0||end<=start)throw Error('Production opaque canopy functions missing');
      const module=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
@group(1)@binding(0)var<uniform>neutral:vec4f;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(albedo+neutral.xyz,1);}
`+TERRAIN.slice(start,end)+FOREST_MASS_VERTEX_WGSL);
      const clouds={bindVolume:pipeline=>device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:dummy}}]})};
      const renderer=await createForestMassRenderer({device,module,frameUBO:frame,shader,resources:[[0,{buffer:frame}]],clouds,format:'rgba8unorm',samples:4,pack:guarded,mode:'far'});
      const chunk=pack.manifest.chunks.reduce((best,p)=>p.indexCount>best.indexCount?p:best),W=256,H=256;
      const colour=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),msaa=device.createTexture({size:[W,H],format:'rgba8unorm',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});
      const read=device.createBuffer({label:'test field opacity readback',size:W*H*4,usage:B.COPY_DST|B.MAP_READ});allocated.push(read);
      const backModule=await shader(`@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],1e-8,1);}
@fragment fn fs()->@location(0)vec4f{return vec4f(0,0,1,1);}`),backdrop=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:backModule,entryPoint:'vs'},fragment:{module:backModule,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:4}});
      const norm=a=>a.map(v=>v/Math.hypot(...a)),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],witnesses=[];
      active=true;
      for(const [index,direction]of [[1,.15,0],[-.3,.6,1],[0,1,.1]].entries()){
        const d=norm(direction),right=norm(cross([0,1,0],d)),up=cross(d,right);fd.fill(0);for(let k=0;k<3;k++){fd[k*4]=right[k]*2;fd[k*4+1]=up[k]*2;fd[k*4+3]=-d[k];}
        fd[14]=.1;fd.set(chunk.centre.map((v,k)=>v+d[k]*chunk.radius*3),16);fd.set(right.map(v=>v*.5),20);fd.set(up.map(v=>v*.5),24);fd.set(d.map(v=>-v),28);fd.set([0,1,0,1],32);fd.set([W,H,1/W,1/H],36);device.queue.writeBuffer(frame,0,fd);
        let massPasses=0,backdropPasses=0;
        const render=async behind=>{
          const e=device.createCommandEncoder();if(!behind){const compute=e.beginComputePass();renderer.encode(compute);compute.end();}
          // Preserve the SAME multisample colours/depths for the backdrop.
          // A second independent mass raster cannot serve as its own oracle.
          const pass=e.beginRenderPass({colorAttachments:[{view:msaa.createView(),resolveTarget:colour.createView(),loadOp:behind?'load':'clear',storeOp:'store',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:behind?'load':'clear',depthStoreOp:'store',depthClearValue:0}});
          if(behind){pass.setPipeline(backdrop);pass.draw(3);backdropPasses++;}else{renderer.drawOpaque(pass);massPasses++;}
          pass.end();e.copyTextureToBuffer({texture:colour},{buffer:read,bytesPerRow:W*4},[W,H]);device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);const pixels=new Uint8Array(read.getMappedRange()).slice();read.unmap();return pixels;
        };
        const first=await render(false),behind=await render(true);let covered=0,solid=0,solidColour=0,maxDepthError=0,worstPixel=null;
        for(let i=0;i<W*H;i++){
          const at=i*4,a=first[at+3],expected=[first[at],first[at+1],first[at+2]+255-a,255];covered+=a>0?1:0;solid+=a===255?1:0;solidColour+=a===255&&first[at+1]>0?1:0;
          for(let channel=0;channel<4;channel++){const error=Math.abs(behind[at+channel]-expected[channel]);if(worstPixel===null||error>maxDepthError){maxDepthError=error;worstPixel={x:i%W,y:Math.floor(i/W),channel:'RGBA'[channel],error,first:Array.from(first.subarray(at,at+4)),behind:Array.from(behind.subarray(at,at+4)),expected};}}
        }
        const canvas=new OffscreenCanvas(W*2,H),ctx=canvas.getContext('2d'),image=ctx.createImageData(W*2,H);for(let y=0;y<H;y++){image.data.set(first.subarray(y*W*4,(y+1)*W*4),y*W*8);image.data.set(behind.subarray(y*W*4,(y+1)*W*4),y*W*8+W*4);}ctx.putImageData(image,0,0);
        const file='forest-mass-opacity-'+index+'.png',response=await fetch('/__shot?name='+file,{method:'POST',body:await canvas.convertToBlob({type:'image/png'})});if(!response.ok)throw Error('Opacity witness write failed');witnesses.push({file:'shots/'+file,direction:d,chunk:chunk.id,covered,solid,solidColour,maxDepthError,worstPixel,massPasses,backdropPasses});
      }
      active=false;await device.queue.onSubmittedWorkDone();const stats={...renderer.stats};renderer.destroy();for(const b of allocated)b.destroy();for(const texture of [colour,msaa,depth])texture.destroy();device.destroy();
      return {errors,witnesses,descriptors,rootReads,reads,writes,stats,source:pack.manifest.source,sourceSizes:{vertices:pack.manifest.files['vertices.bin'].bytes,indices:pack.manifest.files['indices.bin'].bytes}};
    },{forest,assetBase});
    diagnostics.phase='asserting GPU witnesses';
    assert.deepEqual(result.errors,[]);assert.equal(result.rootReads,0);assert.deepEqual(result.reads,[]);
    assert.equal(result.stats.finiteValidated,true);assert.equal(result.stats.appearanceErrorSupported,false);assert.equal(result.stats.geometryErrorSupported,false);assert.equal(result.stats.mode,'far');assert.equal(result.stats.preview,false);
    assert.equal(result.descriptors.length,1);const d=result.descriptors[0];assert.equal(d.vertex,manifest.version===2?'forestMassVS':'bakedCanopyVS');assert.equal(d.layout.arrayStride,manifest.vertexStride);assert.equal(d.fragment,'canopyOpaqueFS');assert.equal(d.depth.depthWriteEnabled,true);assert.equal(d.depth.depthCompare,'greater');assert.equal(d.msaa.alphaToCoverageEnabled,false);assert.ok(d.blend.every(b=>b===null));
    if(manifest.version===2)assert.deepEqual(d.layout.attributes,[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'snorm8x4'},{shaderLocation:6,offset:16,format:'float16x4'}]);
    for(const name of ['vertices','indices']){const uploads=result.writes.filter(w=>w.label==='forest mass immutable '+name);assert.equal(uploads.length,1);assert.equal(uploads[0].offset,0);assert.equal(uploads[0].bytes,result.sourceSizes[name]);}
    for(const row of result.witnesses){assert.equal(row.massPasses,1);assert.equal(row.backdropPasses,1);assert.ok(row.covered>100&&row.solid>50&&row.solidColour>50,'actual field-derived mass has an opaque coloured interior');assert.ok(row.maxDepthError<=2,'real saved per-sample depth occludes later blue backdrop: '+JSON.stringify(row));}
    t.diagnostic(JSON.stringify({input,source:result.source,qualification:'Actual density geometry alpha/depth/GPU witnesses only; native appearance remains unqualified',witnesses:result.witnesses,diagnostics}));
  }catch(error){t.diagnostic(JSON.stringify({input,diagnostics,error:error.message}));throw error;}
  finally{closing=true;await browser?.close();await Promise.all([server,assetServer].map(s=>new Promise(resolve=>{s.closeAllConnections?.();s.close(resolve);})));}
});
