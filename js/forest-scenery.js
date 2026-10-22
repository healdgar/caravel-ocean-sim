// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Grown temperate specimens are authored visual proxies, not surveyed Saba flora.
import {FRAME_WGSL} from './wgsl/common.js';
import {CANOPY_VERTEX_LAYOUT} from './canopy-scenery.js';

export const FOREST_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/saba/manifest.json',
  'vertices.bin':'assets/forest-scenery/saba/vertices.bin',
  'indices.bin':'assets/forest-scenery/saba/indices.bin',
  'roots.bin':'assets/forest-scenery/saba/roots.bin',
});
export const FOREST_SPECIES=Object.freeze(['oak','maple','birch','elm','chestnut']);
export const FOREST_ROOT_FLOATS=12;
const finite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const uint=n=>Number.isSafeInteger(n)&&n>=0;
export function validateForestScenery(m){
  if(m?.format!=='waterworld.forest-instances'||m.version!==1||m.units!=='metres'||m.upAxis!=='Y'||m.vertexStride!==52||m.rootStride!==48||
    !uint(m.rootCount)||!m.rootCount||m.rootCount>250000||!Array.isArray(m.prototypes)||!m.prototypes.length||m.prototypes.length>32)throw Error('Unsupported instanced forest');
  for(const [name,stride,count]of[['vertices.bin',52,'vertexCount'],['indices.bin',4,'indexCount'],['roots.bin',48,'rootCount']]){
    const f=m.files?.[name];if(!uint(f?.[count])||!f[count]||f.bytes!==f[count]*stride||f.bytes>192*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid forest stream receipt: '+name);
  }
  if(m.files['roots.bin'].rootCount!==m.rootCount)throw Error('Forest root count mismatch');
  const c=m.coverage;
  if(c?.kind!=='occupied-cells'||!finite(c.originXZ,2)||!(c.cellMetres>0)||!finite(c.dimensions,2)||!c.dimensions.every(n=>uint(n)&&n>0)||
    !Array.isArray(c.cells)||new Set(c.cells).size!==c.cells.length||c.cells.some(n=>!uint(n)||n>=c.dimensions[0]*c.dimensions[1]))throw Error('Invalid forest occupied coverage');
  let nextIndex=0,nextRoot=0;
  for(const [i,p]of m.prototypes.entries()){
    if(p.id!==i||!FOREST_SPECIES.includes(p.species)||!finite(p.low,3)||!finite(p.high,3)||p.low.some((v,k)=>v>p.high[k])||
      !finite(p.centre,3)||!(p.radius>0)||!uint(p.firstRoot)||p.firstRoot!==nextRoot||!uint(p.rootCount))throw Error('Invalid forest prototype');
    for(let bits=0;bits<8;bits++)if(Math.hypot(...p.low.map((v,k)=>(bits&(1<<k)?p.high[k]:v)-p.centre[k]))>p.radius+1e-4)throw Error('Forest prototype bound misses geometry');
    for(const key of ['wood','leaf','far']){
      const r=p[key];if(!uint(r?.firstIndex)||r.firstIndex!==nextIndex||!uint(r.indexCount)||r.indexCount%3||r.firstIndex+r.indexCount>m.files['indices.bin'].indexCount)throw Error('Invalid forest index range');
      nextIndex+=r.indexCount;
    }
    if(!p.far.indexCount||!p.leaf.indexCount)throw Error('Forest requires detailed foliage and opaque far canopy');
    nextRoot+=p.rootCount;
  }
  if(nextIndex!==m.files['indices.bin'].indexCount||nextRoot!==m.rootCount)throw Error('Incomplete forest partitions');
  if(m.appearanceErrorSupported!==false)throw Error('Forest appearance LOD is not certified');
  return m;
}
export function decodeForestScenery(manifest,streams){
  validateForestScenery(manifest);
  for(const name of ['vertices.bin','indices.bin','roots.bin'])if(!(streams[name] instanceof ArrayBuffer)||streams[name].byteLength!==manifest.files[name].bytes)throw Error('Incomplete forest stream: '+name);
  const vertices=new Float32Array(streams['vertices.bin']),indices=new Uint32Array(streams['indices.bin']),roots=new Float32Array(streams['roots.bin']);
  for(let i=0;i<vertices.length;i+=13){
    if(!vertices.subarray(i,i+13).every(Number.isFinite)||Math.abs(Math.hypot(...vertices.subarray(i+3,i+6))-1)>.001||![3,4].includes(vertices[i+6])||vertices[i+7]<0||vertices[i+7]>1||vertices.subarray(i+10,i+13).some(v=>v<0))throw Error('Invalid forest vertex');
  }
  for(const p of manifest.prototypes){
    for(const key of ['wood','leaf','far'])for(let j=p[key].firstIndex;j<p[key].firstIndex+p[key].indexCount;j++){
      const v=indices[j]*13;if(v>=vertices.length)throw Error('Forest index outside stream');
      if((key==='wood'&&vertices[v+6]!==3)||(key==='leaf'&&vertices[v+6]!==4))throw Error('Forest material range mismatch');
      for(let k=0;k<3;k++)if(vertices[v+k]<p.low[k]-.001||vertices[v+k]>p.high[k]+.001)throw Error('Forest vertex outside prototype bound');
    }
    for(let i=p.firstRoot;i<p.firstRoot+p.rootCount;i++){
      const r=roots.subarray(i*12,i*12+12);
      if(!r.every(Number.isFinite)||r[3]<=0||r[3]>5||r[8]!==p.id||r[9]<0||r.subarray(5,8).some(v=>v<=0||v>2)||!forestCoversPoint(manifest,r[0],r[2]))throw Error('Invalid forest root transform');
    }
  }
  return {manifest,vertices,indices,roots};
}
export async function loadForestScenery({fetchAsset=fetch,assets=FOREST_ASSETS}={}){
  const load=async n=>{const r=await fetchAsset(assets[n]);if(!r.ok)throw Error('Forest scenery unavailable ('+r.status+'): '+n);return r;};
  const manifest=validateForestScenery(await(await load('manifest.json')).json());
  const pairs=await Promise.all(['vertices.bin','indices.bin','roots.bin'].map(async n=>[n,await(await load(n)).arrayBuffer()]));
  if(!globalThis.crypto?.subtle)throw Error('Forest receipt verification requires Web Crypto');
  for(const [name,raw]of pairs){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');if(hash!==manifest.files[name].sha256)throw Error('Forest digest mismatch: '+name);}
  return decodeForestScenery(manifest,Object.fromEntries(pairs));
}
const coverageSets=new WeakMap();
export function forestCoversPoint(manifest,x,z){
  const c=manifest.coverage,ix=Math.floor((x-c.originXZ[0])/c.cellMetres),iz=Math.floor((z-c.originXZ[1])/c.cellMetres);
  if(ix<0||iz<0||ix>=c.dimensions[0]||iz>=c.dimensions[1])return false;
  let cells=coverageSets.get(manifest);if(!cells){cells=new Set(c.cells);coverageSets.set(manifest,cells);}
  return cells.has(iz*c.dimensions[0]+ix);
}
export function excludeForestRoots(trees,manifest){
  if(!(trees instanceof Float32Array)||trees.length%8)throw Error('Invalid legacy forest roots');
  const out=[];for(let i=0;i<trees.length;i+=8)if(!forestCoversPoint(manifest,trees[i],trees[i+2]))out.push(...trees.subarray(i,i+8));
  return new Float32Array(out);
}

const ROOT_WGSL=/* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
`;
export const FOREST_VERTEX_WGSL=ROOT_WGSL+/* wgsl */`
@group(2)@binding(0)var<storage,read>forestRoots:array<ForestRoot>;
@group(2)@binding(1)var<storage,read>forestVisible:array<u32>;
@group(2)@binding(2)var<uniform>forestBin:vec4u;
@vertex fn forestCanopyVS(@location(0)position:vec3f,@location(1)normal:vec3f,@location(2)kind:vec2f,
 @location(5)leafUV:vec2f,@location(6)colour:vec3f,@builtin(instance_index)instance:u32)->CanopyVertex{
 let r=forestRoots[forestVisible[forestBin.x+instance]];let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let local=vec3f(c*position.x-s*position.z,position.y,s*position.x+c*position.z)*r.rootScale.w;
 var o:CanopyVertex;o.world=r.rootScale.xyz+local;
 o.normal=vec3f(c*normal.x-s*normal.z,normal.y,s*normal.x+c*normal.z);
 o.kind=kind;o.leafUV=leafUV;o.colour=colour*r.yawColour.yzw;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
`;
export const FOREST_CULL_WGSL=FRAME_WGSL+ROOT_WGSL+/* wgsl */`
struct ForestPrototype {bound:vec4f,roots:vec4u,wood:vec4u,leaf:vec4u,far:vec4u};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(2)var<storage,read>prototypes:array<ForestPrototype>;
@group(0)@binding(3)var<storage,read_write>visible:array<u32>;
@group(0)@binding(4)var<storage,read_write>commands:array<atomic<u32>>;
@group(0)@binding(5)var<storage,read_write>previousLod:array<u32>;
@group(0)@binding(6)var<uniform>parameters:vec4f;
@compute @workgroup_size(64)fn forestReset(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.y)*3u){return;}atomicStore(&commands[id.x*5u+1u],0u);
}
@compute @workgroup_size(64)fn forestCull(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.x)){return;}
 let r=roots[id.x];if(r.rootScale.w<=0.0){return;}let pi=u32(r.identity.x);let p=prototypes[pi];let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let b=p.bound.xyz*r.rootScale.w;
 let world=r.rootScale.xyz+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);let relative=world-F.camPos.xyz;let radius=p.bound.w*r.rootScale.w;
 let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){
   let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
   if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}
 }
 if(clip.w<-radius*length(rowW)){return;}
 let depth=dot(relative,normalize(F.camFwd.xyz));let near=depth-radius;
 let lateral=sqrt(max(0.0,dot(relative,relative)-depth*depth))+radius;
 let projected=F.screen.y/max(2.0*length(F.camUp.xyz),.0001)*2.0*radius*sqrt(1.0+lateral*lateral/max(near*near,.0001))/max(near,.0001);
 // No appearance bound is certified. Collapse only when the WHOLE crown's
 // support fits three rendered pixels; far mode is explicitly debug-only.
 let threshold=parameters.z*select(.88,1.0,previousLod[id.x]==0u);
 let nearLod=parameters.w==1.0||(parameters.w!=2.0&&(near<=radius||projected>threshold));
 previousLod[id.x]=select(0u,1u,nearLod);
 let command=(pi*3u+select(2u,0u,nearLod))*5u;
 let slot=atomicAdd(&commands[command+1u],1u);
 let base=p.roots.x*2u+select(p.roots.y,0u,nearLod);
 visible[base+slot]=id.x;
 if(nearLod){atomicAdd(&commands[(pi*3u+1u)*5u+1u],1u);}
}
`;

export async function createForestRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,groundSample,mode='auto',nearPixels=3}){
  if(!['auto','near','far'].includes(mode)||!(nearPixels>0&&nearPixels<=3))throw Error('Invalid forest LOD policy');
  const m=pack.manifest,allocated=[],B=GPUBufferUsage;
  const make=(data,usage,label)=>{const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST,label});allocated.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
  try{
    const rooted=pack.roots.slice();let excludedRoots=0;
    if(groundSample)for(let i=0;i<rooted.length;i+=12){
      const x=rooted[i],z=rooted[i+2],y=groundSample(x,z);
      if(!Number.isFinite(y))throw Error('Non-finite forest ground sampler');
      const sx=(groundSample(x+1,z)-groundSample(x-1,z))*.5,sz=(groundSample(x,z+1)-groundSample(x,z-1))*.5,slope=Math.hypot(sx,sz);
      // A measured near tile can expose a cliff/beach hidden by coarse data.
      // Reject that root once; never leave it floating or grow a replacement.
      if(y<18||y>840||!Number.isFinite(slope)||slope>1.1){rooted[i+3]=0;excludedRoots++;continue;}
      const basal=m.prototypes[rooted[i+8]].basalRadius??0;
      rooted[i+9]=Math.max(rooted[i+9],basal*rooted[i+3]*slope+.08);rooted[i+1]=y-rooted[i+9];
    }
    const roots=make(rooted,B.STORAGE,'forest immutable root transforms'),vertices=make(pack.vertices,B.VERTEX,'forest immutable prototype vertices'),indices=make(pack.indices,B.INDEX,'forest immutable prototype indices');
    const meta=new ArrayBuffer(m.prototypes.length*80),floats=new Float32Array(meta),words=new Uint32Array(meta),draws=new Uint32Array(m.prototypes.length*15);
    for(const p of m.prototypes){const base=p.id*20;floats.set([...p.centre,p.radius],base);words.set([p.firstRoot,p.rootCount,0,0],base+4);
      for(const [i,name]of ['wood','leaf','far'].entries()){const r=p[name];words.set([r.firstIndex,r.indexCount,0,0],base+8+i*4);draws.set([r.indexCount,0,r.firstIndex,0,0],(p.id*3+i)*5);}}
    const prototypes=make(new Uint8Array(meta),B.STORAGE,'forest prototype bounds and ranges');
    const visible=make(new Uint32Array(m.rootCount*2),B.STORAGE,'forest GPU visible root IDs');
    const commands=make(draws,B.STORAGE|B.INDIRECT,'forest GPU indirect draws');
    const previous=make(new Uint32Array(m.rootCount),B.STORAGE,'forest GPU previous LOD');
    const parameters=make(new Float32Array([m.rootCount,m.prototypes.length,nearPixels,['auto','near','far'].indexOf(mode)]),B.UNIFORM,'forest projected size policy');
    const compute=await shader(FOREST_CULL_WGSL,'forest GPU cull and compact');
    const reset=await device.createComputePipelineAsync({label:'forest reset indirect counts',layout:'auto',compute:{module:compute,entryPoint:'forestReset'}});
    const cull=await device.createComputePipelineAsync({label:'forest cull and LOD',layout:'auto',compute:{module:compute,entryPoint:'forestCull'}});
    const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:commands}},{binding:6,resource:{buffer:parameters}}]});
    const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frameUBO,roots,prototypes,visible,commands,previous,parameters].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const pipe=fragment=>device.createRenderPipelineAsync({label:'instanced forest '+fragment,layout:'auto',vertex:{module,entryPoint:'forestCanopyVS',buffers:[CANOPY_VERTEX_LAYOUT]},
      fragment:{module,entryPoint:fragment,targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragment==='canopyLeafFS'&&samples>1}});
    const opaque=await pipe('canopyOpaqueFS'),leaf=await pipe('canopyLeafFS');
    const bind=(p,ids)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.filter(([i])=>ids.includes(i)).map(([binding,resource])=>({binding,resource}))});
    const opaqueGroup=bind(opaque,[0,1,2,3,4,5,6]),leafGroup=bind(leaf,[0,1,2,3,4,5,6,8,10]);
    const opaqueCloud=clouds.bindVolume(opaque),leafCloud=clouds.bindVolume(leaf);
    const bins=m.prototypes.map(p=>[0,1].map(tier=>{
      const offset=make(new Uint32Array([p.firstRoot*2+(tier?p.rootCount:0),0,0,0]),B.UNIFORM,'forest bin offset');
      const group=pipeline=>device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries:[roots,visible,offset].map((buffer,binding)=>({binding,resource:{buffer}}))});
      return {opaque:group(opaque),leaf:tier?null:group(leaf)};
    }));
    const draw=(pass,pipeline,group,cloud,cutout)=>{
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setBindGroup(1,cloud);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');
      for(const p of m.prototypes)for(const slot of cutout?[1]:[0,2]){
        if(!p[['wood','leaf','far'][slot]].indexCount)continue;
        pass.setBindGroup(2,bins[p.id][slot===2?1:0][cutout?'leaf':'opaque']);pass.drawIndexedIndirect(commands,(p.id*3+slot)*20);
      }
    };
    return {stats:{loaded:true,roots:m.rootCount-excludedRoots,excludedRoots,prototypes:m.prototypes.length,gpuCulling:true,nearPixels,appearanceErrorSupported:false,mode,
      species:[...new Set(m.prototypes.map(p=>p.species))],sourceClaim:m.sourceClaim},prepare(){},
      encode(pass){pass.setPipeline(reset);pass.setBindGroup(0,resetGroup);pass.dispatchWorkgroups(Math.ceil(m.prototypes.length*3/64));pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(m.rootCount/64));},
      drawOpaque(pass){draw(pass,opaque,opaqueGroup,opaqueCloud,false);},drawCutout(pass){draw(pass,leaf,leafGroup,leafCloud,true);},destroy(){for(const b of allocated)b.destroy();}};
  }catch(error){for(const b of allocated)b.destroy();throw error;}
}
