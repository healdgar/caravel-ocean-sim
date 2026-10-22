// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Closed volumes use same-tree authored opaque far crowns, not transparent
// per-tree impostors. Their error scope excludes actual native leaf alpha and
// the unresolved native-leaves -> authored-crown approximation.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {FOREST_CANOPY_ASSETS,decodeForestCanopy,loadForestCanopy} from '../js/forest-canopy.js';

const readAsset=async path=>new Response(await readFile(new URL('../'+path,import.meta.url)));
let actual;
async function actualCanopy(){
  if(!actual)actual=(async()=>{
    const forest=JSON.parse(await readFile(new URL('../assets/forest-scenery/saba/manifest.json',import.meta.url),'utf8'));
    return {forest,pack:await loadForestCanopy({forest,fetchAsset:readAsset})};
  })();
  return actual;
}
function streamsFor(pack){return Object.fromEntries([['vertices.bin',pack.vertices],['indices.bin',pack.indices],['root-chunks.bin',pack.rootChunks]].map(([name,a])=>[name,a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength)]));}

test('actual opaque canopy chunks are closed, outward wound and retain native root ownership',async()=>{
  const {forest,pack}=await actualCanopy(),{manifest,vertices,indices,rootChunks}=pack;
  assert.equal(manifest.format,'waterworld.forest-canopy');assert.equal(manifest.version,1);assert.equal(manifest.vertexStride,52);
  assert.equal(rootChunks.length,forest.rootCount);assert.ok(manifest.chunks.length>1);assert.ok(manifest.source,'native source provenance required');
  for(const flag of ['appearanceErrorSupported','textureAlphaErrorSupported','colourErrorSupported'])assert.equal(manifest[flag],false,'authored solid forest must not certify native leaf appearance');
  const ownership=new Uint32Array(manifest.chunks.length),ownerIDs=Array.from({length:manifest.chunks.length},()=>[]);
  for(const [id,owner]of rootChunks.entries()){assert.ok(owner===0xffffffff||owner<ownership.length,'original root owner is a real chunk or terrain-ineligible');if(owner!==0xffffffff){ownership[owner]++;ownerIDs[owner].push(id);}}
  let triangles=0;
  for(const chunk of manifest.chunks){
    assert.equal(chunk.rootCount,ownership[chunk.id]);assert.ok(chunk.rootCount>0);
    const own=Uint32Array.from(ownerIDs[chunk.id]),ownBytes=new Uint8Array(own.buffer);
    assert.equal(chunk.sourceRoots.bytes,ownBytes.byteLength);assert.equal(chunk.sourceRoots.sha256,createHash('sha256').update(ownBytes).digest('hex'),'each full crown halo derives only from that chunk\'s owner roots');
    assert.match(chunk.geometryErrorScope,/NOT native leaf alpha/i,'measured error scope is the authored solid crown envelope');
    assert.deepEqual(chunk.geometryErrorSource.sourceRoots,chunk.sourceRoots);
    for(const name of ['vertices.bin','indices.bin'])for(const key of ['bytes','sha256'])assert.equal(chunk.geometryErrorSource.packedStreams[name][key],manifest.files[name][key],'certificate follows actual packed geometry');
    const edges=new Map(),point=index=>Array.from(vertices.subarray(index*13,index*13+3));let volume=0;
    for(let at=chunk.firstIndex;at<chunk.firstIndex+chunk.indexCount;at+=3){
      const ids=Array.from(indices.subarray(at,at+3)),points=ids.map(point),keys=points.map(p=>p.join(','));
      assert.equal(new Set(keys).size,3,'nondegenerate welded triangle');
      for(const index of ids){
        const v=vertices.subarray(index*13,index*13+13);assert.equal(v[6],4,'solid crown classification');
        assert.ok(Math.abs(Math.hypot(...v.subarray(3,6))-1)<.001);assert.ok(v.subarray(10,13).every(c=>Number.isFinite(c)&&c>=0),'native linear pigment');
      }
      for(let k=0;k<3;k++){
        const a=keys[k],b=keys[(k+1)%3],forward=a<b,key=forward?a+'|'+b:b+'|'+a;
        const edge=edges.get(key)??{count:0,balance:0};edge.count++;edge.balance+=forward?1:-1;edges.set(key,edge);
      }
      const [a,b,c]=points.map(p=>p.map((v,k)=>v-chunk.centre[k]));
      volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;triangles++;
    }
    const open=[...edges].filter(([,edge])=>edge.count!==2||edge.balance!==0);
    assert.equal(open.length,0,'closed roof/side/bottom; chunk '+chunk.id+' first defects '+JSON.stringify(open.slice(0,3)));
    assert.ok(volume>0,'outward wound positive closed volume; chunk '+chunk.id);
  }
  assert.equal(triangles*3,indices.length,'every triangle belongs to a checked closed chunk');
});

test('opaque canopy receipt and decoder reject corrupted bytes and invalid GPU addresses',async()=>{
  const {forest,pack}=await actualCanopy(),streams=streamsFor(pack),badIndices=new Uint32Array(streams['indices.bin'].slice(0));
  badIndices[0]=pack.vertices.length/13;
  assert.throws(()=>decodeForestCanopy(pack.manifest,{...streams,'indices.bin':badIndices.buffer},forest),/index|outside|range|vertex/i);
  const badVertices=new Float32Array(streams['vertices.bin'].slice(0));badVertices[0]=NaN;
  assert.throws(()=>decodeForestCanopy(pack.manifest,{...streams,'vertices.bin':badVertices.buffer},forest),/finite|vertex|bound/i);
  const badOwners=new Uint32Array(streams['root-chunks.bin'].slice(0));badOwners[0]=pack.manifest.chunks.length;
  assert.throws(()=>decodeForestCanopy(pack.manifest,{...streams,'root-chunks.bin':badOwners.buffer},forest),/owner|chunk|root|range/i);
  const asset=FOREST_CANOPY_ASSETS[pack.manifest.files['vertices.bin'].gzip?.file??'vertices.bin'];assert.ok(asset);
  let corrupted=false;
  await assert.rejects(()=>loadForestCanopy({forest,fetchAsset:async path=>{
    const response=await readAsset(path);if(path!==asset)return response;
    const bytes=new Uint8Array(await response.arrayBuffer());bytes[bytes.length>>1]^=1;corrupted=true;return new Response(bytes);
  }}),/digest|hash|receipt|mismatch|gzip|decompress/i);
  assert.equal(corrupted,true,'the negative witness reached the actual immutable geometry transport');
});

test('native canopy GPU selects only qualified distant closed chunks and preserves opaque depth',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest_closed',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest_closed');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL}=await import('/js/wgsl/common.js'),{TERRAIN}=await import('/js/wgsl/terrain.js'),{CANOPY_VERTEX_LAYOUT}=await import('/js/canopy-scenery.js');
      const {FOREST_CANOPY_CULL_WGSL,loadForestCanopy}=await import('/js/forest-canopy.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[],allocated=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      const shader=async code=>{const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return module;};
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);allocated.push(b);return b;};
      const frameData=new Float32Array(96);frameData[0]=1/.8;frameData[5]=1/.45;frameData[11]=-1;frameData[14]=.1;frameData.set([.8,0,0],20);frameData.set([0,.45,0],24);frameData.set([0,0,-1],28);frameData.set([1920,1080,1/1920,1/1080],36);
      const frame=make(frameData,B.UNIFORM),meta=new ArrayBuffer(4*64),f=new Float32Array(meta),u=new Uint32Array(meta);
      for(const [i,c]of [[0,[0,1,-20]],[1,[0,1,-2000]],[2,[0,1,20]],[3,[1000,1,-20]]]){
        f.set([...c,4],i*16);f.set(c.map(v=>v-2).concat(2),i*16+4);f.set(c.map(v=>v+2).concat(Math.sqrt(8)),i*16+8);u.set([i*36,36,1,1],i*16+12);
      }
      const chunks=make(new Uint8Array(meta),B.STORAGE),commands=make(new Uint32Array(Array.from({length:4},(_,i)=>[36,999,i*36,0,0]).flat()),B.STORAGE|B.INDIRECT|B.COPY_SRC),state=make(new Uint32Array(4).fill(999),B.STORAGE|B.COPY_SRC),policyData=new Float32Array([4,3,0,0]),policy=make(policyData,B.UNIFORM);
      const residency=make(new Uint32Array([1,0,0,0]),B.UNIFORM);
      const module=await shader(FOREST_CANOPY_CULL_WGSL),cull=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'forestCanopyCull'}});
      const group=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frame,chunks,commands,state,policy,residency].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const read=device.createBuffer({size:96,usage:B.COPY_DST|B.MAP_READ});allocated.push(read);
      async function run(height=1080,mode=0,qualified=true,resident=true){
        frameData.set([height*16/9,height,9/(height*16),1/height],36);policyData[2]=mode;for(let i=0;i<4;i++)u[i*16+15]=qualified?1:0;
        device.queue.writeBuffer(frame,0,frameData);device.queue.writeBuffer(policy,0,policyData);device.queue.writeBuffer(chunks,0,new Uint8Array(meta));
        device.queue.writeBuffer(residency,0,new Uint32Array([resident?1:0,0,0,0]));
        const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(cull);p.setBindGroup(0,group);p.dispatchWorkgroups(1);p.end();e.copyBufferToBuffer(commands,0,read,0,80);e.copyBufferToBuffer(state,0,read,80,16);device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();return {commands:values.slice(0,20),selected:values.slice(20)};
      }
      const normal=await run(),repeat=await run(),high=await run(4320),forced=await run(1080,2),near=await run(1080,1),unsupported=await run(1080,0,false),loading=await run(1080,0,false,false),loadingNear=await run(1080,1,false,false),residentAgain=await run();

      // Use the exact production vertex/opaque fragment functions. Isolate
      // source pigment from atmospheric lighting without changing alpha/depth.
      const start=TERRAIN.indexOf('struct CanopyVertex'),end=TERRAIN.indexOf('@fragment fn canopyLeafFS',start);if(start<0||end<=start)throw Error('Production opaque canopy shader missing');
      const renderModule=await shader(FRAME_WGSL+`@group(0)@binding(0)var<uniform>F:Frame;
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambient:f32,wet:f32,roughness:f32)->vec4f{return vec4f(albedo,1);}
`+TERRAIN.slice(start,end));
      const opaque=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:renderModule,entryPoint:'bakedCanopyVS',buffers:[CANOPY_VERTEX_LAYOUT]},fragment:{module:renderModule,entryPoint:'canopyOpaqueFS',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:4}});
      const renderGroup=device.createBindGroup({layout:opaque.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]});
      const backModule=await shader(`@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],1e-8,1);}
@fragment fn fs()->@location(0)vec4f{return vec4f(0,0,1,1);}`);
      const backdrop=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:backModule,entryPoint:'vs'},fragment:{module:backModule,entryPoint:'fs',targets:[{format:'rgba8unorm'}]},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:4}});
      const forest=await(await fetch('/assets/forest-scenery/saba/manifest.json')).json(),pack=await loadForestCanopy({forest}),vertices=make(pack.vertices,B.VERTEX),indices=make(pack.indices,B.INDEX);
      const chunk=pack.manifest.chunks.reduce((best,c)=>c.indexCount>best.indexCount?c:best),W=256,H=256;
      const colour=device.createTexture({size:[W,H],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),msaa=device.createTexture({size:[W,H],format:'rgba8unorm',sampleCount:4,usage:T.RENDER_ATTACHMENT}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});
      const pixels=device.createBuffer({size:W*H*4,usage:B.COPY_DST|B.MAP_READ});allocated.push(pixels);
      const norm=a=>a.map(v=>v/Math.hypot(...a)),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
      const witnesses=[];
      for(const requested of [[1,.15,0],[-.3,.6,1],[0,1,.1]]){
        const d=norm(requested),right=norm(cross([0,1,0],d)),up=cross(d,right);frameData.fill(0);
        for(let k=0;k<3;k++){frameData[k*4]=right[k]*2;frameData[k*4+1]=up[k]*2;frameData[k*4+3]=-d[k];}
        frameData[14]=.1;frameData.set(chunk.centre.map((v,k)=>v+d[k]*chunk.radius*3),16);frameData.set(right.map(v=>v*.5),20);frameData.set(up.map(v=>v*.5),24);frameData.set(d.map(v=>-v),28);frameData.set([0,1,0,1],32);frameData.set([W,H,1/W,1/H],36);device.queue.writeBuffer(frame,0,frameData);
        const draw=async after=>{
          const e=device.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:msaa.createView(),resolveTarget:colour.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'discard',depthClearValue:0}});
          p.setPipeline(opaque);p.setBindGroup(0,renderGroup);p.setVertexBuffer(0,vertices);p.setIndexBuffer(indices,'uint32');p.drawIndexed(chunk.indexCount,1,chunk.firstIndex);
          if(after){p.setPipeline(backdrop);p.draw(3);}p.end();e.copyTextureToBuffer({texture:colour},{buffer:pixels,bytesPerRow:W*4},[W,H]);device.queue.submit([e.finish()]);await pixels.mapAsync(GPUMapMode.READ);const out=new Uint8Array(pixels.getMappedRange()).slice();pixels.unmap();return out;
        };
        const first=await draw(false),behind=await draw(true);let covered=0,solid=0,solidColour=0,maxDepthError=0;
        for(let i=0;i<W*H;i++){
          const at=i*4,a=first[at+3];covered+=a>0?1:0;solid+=a===255?1:0;if(a===255&&first[at+1]>0)solidColour++;
          maxDepthError=Math.max(maxDepthError,Math.abs(behind[at]-first[at]),Math.abs(behind[at+1]-first[at+1]),Math.abs(behind[at+2]-(first[at+2]+255-a)),Math.abs(behind[at+3]-255));
        }
        witnesses.push({direction:d,chunk:chunk.id,covered,solid,solidColour,maxDepthError});
      }
      await device.queue.onSubmittedWorkDone();for(const b of allocated)b.destroy();for(const texture of [colour,msaa,depth])texture.destroy();device.destroy();
      return {errors,normal,repeat,high,forced,near,unsupported,loading,loadingNear,residentAgain,witnesses};
    });
    assert.deepEqual(result.errors,[]);
    for(const name of ['normal','repeat'])assert.deepEqual(result[name].selected,[0,1,0,0],name+' chooses qualified distant mass only');
    assert.deepEqual(result.high.selected,[0,0,0,0],'higher rendered resolution retains source geometry');
    assert.deepEqual(result.near.selected,[0,0,0,0]);assert.deepEqual(result.unsupported.selected,[0,0,0,0],'unqualified error never permits mass replacement');
    assert.deepEqual(result.forced.selected,[1,1,0,0],'far debug forcing retains frustum visibility');
    assert.deepEqual(result.loading.selected,[1,1,0,0],'only temporary native nonresidency permits unqualified visible mass');assert.deepEqual(result.loadingNear.selected,[0,0,0,0],'explicit near policy never invents a substitute');
    assert.deepEqual(result.residentAgain.selected,[0,1,0,0],'native residency restores the measured-error policy');
    for(const row of ['normal','repeat','high','forced','near','unsupported','loading','loadingNear','residentAgain'])for(let i=0;i<4;i++){
      const command=result[row].commands.slice(i*5,i*5+5);assert.deepEqual(command,[36,result[row].selected[i],i*36,0,0],'actual indirect topology/count reset '+row);
    }
    for(const row of result.witnesses){assert.ok(row.covered>100&&row.solid>50&&row.solidColour>50,'closed mass has genuinely opaque interior');assert.ok(row.maxDepthError<=2,'opaque per-sample depth occludes later far geometry: '+JSON.stringify(row));}
    t.diagnostic(JSON.stringify({qualification:'Three actual closed-chunk opaque/depth witnesses, not global appearance certification',witnesses:result.witnesses}));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
