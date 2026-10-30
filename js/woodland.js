// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Finished Forestmodeler trees only. No growth, physics or simulation RNG runs.
import { WOODLAND } from './wgsl/woodland.js';

export const WOODLAND_LIMITS=Object.freeze({near:96,middle:512,nearPixels:64,middlePixels:14,
  atlasTexelPixels:3,hysteresis:.12,maximumTextureBytes:18*1024*1024});
// Literal runtime paths let the existing standalone/Pages packager substitute
// embedded or content-addressed URLs. Source provenance manifests are not fetched.
export const WOODLAND_ASSETS=Object.freeze({
  'library.json':'assets/woodland/library.json',
  'colour.png':'assets/woodland/colour.png',
  'normal.png':'assets/woodland/normal.png',
  'depth.png':'assets/woodland/depth.png',
  'oak-101-20-wood-near.json':'assets/woodland/oak-101-20-wood-near.json',
  'oak-101-20-wood-middle.json':'assets/woodland/oak-101-20-wood-middle.json',
  'birch-101-20-wood-near.json':'assets/woodland/birch-101-20-wood-near.json',
  'birch-101-20-wood-middle.json':'assets/woodland/birch-101-20-wood-middle.json',
});
const woodlandSRGB=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
const woodlandFinite=values=>Array.isArray(values)&&values.every(Number.isFinite);
const woodlandYaw=(x,z,angle)=>[x*Math.cos(angle)-z*Math.sin(angle),x*Math.sin(angle)+z*Math.cos(angle)];

export function woodlandValidateLibrary(library){
  const a=library?.atlas;
  if(library?.format!=='waterworld.woodland'||library.version!==1||library.upAxis!=='Y'||library.units!=='metres'||library.rootsIncluded||
    library.seasons?.length!==1||library.seasons[0]!=='leafy'||library.azimuths!==8||
    JSON.stringify(library.elevationsDegrees)!=='[0,35,70]'||library.plants?.length!==2)throw Error('Unsupported woodland library');
  if(!Number.isSafeInteger(a?.width)||!Number.isSafeInteger(a?.height)||a.width<1||a.height<1||
    a.width*a.height*12>WOODLAND_LIMITS.maximumTextureBytes||a.uncompressedBytes!==a.width*a.height*12||
    a.colourSpace!=='sRGB'||a.normalSpace!=='object-y-up'||a.imageOrigin!=='top-left'||
    a.depthEncoding!=='(R*256+G)/65535; near=0, far=1')throw Error('Unsupported woodland atlas');
  const ids=new Set(),boxes=[];
  for(const plant of library.plants){
    if(!plant?.id||ids.has(plant.id)||!woodlandFinite(plant.centre)||plant.centre.length!==3||
      !woodlandFinite(plant.bounds?.[0])||!woodlandFinite(plant.bounds?.[1])||plant.bounds.some(p=>p.length!==3)||
      !(plant.radius>0&&Number.isFinite(plant.radius))||!(plant.sourceHeight>0&&Number.isFinite(plant.sourceHeight))||
      !(plant.horizontalRadius>0&&Number.isFinite(plant.horizontalRadius))||!woodlandFinite(plant.woodColourSRGB)||
      plant.woodColourSRGB.length!==3||plant.woodColourSRGB.some(v=>v<0||v>1)||plant.wood?.length!==2||
      !woodlandFinite(plant.woodDisplacement)||plant.woodDisplacement.length!==2||plant.woodDisplacement.some(v=>v<0)||
      !woodlandFinite(plant.origin)||plant.origin.length!==2||!Number.isSafeInteger(plant.tileSize)||plant.tileSize<32||
      !Number.isSafeInteger(plant.padding)||plant.padding<1||typeof plant.sourceFingerprint!=='string')throw Error('Invalid woodland specimen');
    ids.add(plant.id);
    if(plant.bounds[0].some((v,i)=>v>=plant.bounds[1][i]))throw Error('Invalid woodland bounds');
    const stride=plant.tileSize+plant.padding*2,box=[...plant.origin,8*stride,3*stride];
    if(box.some(v=>!Number.isInteger(v)||v<0)||box[0]+box[2]>a.width||box[1]+box[3]>a.height)throw Error('Woodland tiles exceed atlas');
    for(const [x,y,w,h]of boxes)if(box[0]<x+w&&x<box[0]+box[2]&&box[1]<y+h&&y<box[1]+box[3])throw Error('Woodland banks overlap');
    boxes.push(box);
  }
  return library;
}

// Source-derived canonical sphere plus maximum wind displacement. The same
// formula is used by the GPU proxy and bounds every point of that source sphere.
export function woodlandBounds(tree,plant){
  const scaleXZ=tree[3]/plant.horizontalRadius,scaleY=tree[4]/plant.sourceHeight,angle=tree[5]*Math.PI*2;
  const xz=woodlandYaw(plant.centre[0]*scaleXZ,plant.centre[2]*scaleXZ,angle);
  const centre=[tree[0]+xz[0],tree[1]+plant.centre[1]*scaleY,tree[2]+xz[1]];
  const r=plant.radius,h=plant.sourceHeight,maximumY=Math.abs(plant.centre[1])+r;
  const radius=r*Math.max(scaleXZ,scaleY)+.061*(scaleY*h)*(maximumY/h)**2;
  // A source texel's worst-direction world extent, with the wind Jacobian's
  // shear norm included. This is a sampling bound, not total reconstruction error.
  const sourceStep=2*r/plant.tileSize;
  const sampleStep=sourceStep*Math.max(scaleXZ,scaleY)*(1+.122*maximumY/h);
  return{centre,radius,scaleXZ,scaleY,angle,sampleStep};
}

export function woodlandProjectedFootprint(bounds,camera){
  const forward=camera?.forward,screenHeight=camera?.screenHeight,tan=camera?.tanHalfFovY;
  if(!forward||forward.length!==3||!forward.every(Number.isFinite)||!(screenHeight>0&&tan>0)||
    ![camera.x,camera.y,camera.z,screenHeight,tan].every(Number.isFinite))return null;
  const directionLength=Math.hypot(...forward);if(directionLength<1e-8)return null;
  const delta=bounds.centre.map((v,i)=>v-[camera.x,camera.y,camera.z][i]);
  const distance=Math.hypot(...delta),depth=delta.reduce((sum,v,i)=>sum+v*forward[i]/directionLength,0);
  const near=depth-bounds.radius;
  // Do not centre-cull intersecting/near-plane crowns. The host retains their
  // original geometry by ID until the projection is inside this port's domain.
  if(near<=bounds.sampleStep||distance<=bounds.radius*1.02||Math.max(...delta.map(Math.abs))<=bounds.radius*1.001)
    return{supported:false,distance,depth,texelPixels:Infinity,pixels:Infinity};
  const lateral=Math.sqrt(Math.max(0,distance*distance-depth*depth))+bounds.radius;
  const scale=screenHeight/(2*tan)*Math.sqrt(1+(lateral/near)**2);
  return{supported:true,distance,depth,near,projectScale:scale,texelPixels:scale*bounds.sampleStep/(near-bounds.sampleStep),pixels:scale*2*bounds.radius/near};
}

function woodlandPlanes(view){
  // Callers may pass the complete Frame block. Only its initial column-major
  // viewProjection matrix participates in culling or the instance cache key.
  if(!view||view.length<16)return null;
  for(let i=0;i<16;i++)if(!Number.isFinite(view[i]))return null;
  const row=i=>[view[i],view[i+4],view[i+8],view[i+12]],r=[0,1,2,3].map(row);
  return[[3,0,1],[3,0,-1],[3,1,1],[3,1,-1]].map(([a,b,s])=>r[a].map((v,i)=>v+r[b][i]*s))
    .concat([r[2],r[3].map((v,i)=>v-r[2][i])]).map(p=>({p,length:Math.hypot(p[0],p[1],p[2])}));
}
function woodlandVisible(centre,radius,camera,planes){
  if(!planes)return true;
  const x=centre[0]-camera.x,y=centre[1]-camera.y,z=centre[2]-camera.z;
  return planes.every(({p,length})=>p[0]*x+p[1]*y+p[2]*z+p[3]>=-radius*length);
}
export function woodlandVisibleBounds(bounds,camera,viewProjection){
  return woodlandVisible(bounds.centre,bounds.radius,camera,woodlandPlanes(viewProjection));
}
export function woodlandFallbackIds(candidates,selectedIds){return candidates.filter(id=>!selectedIds.has(id));}
export function woodlandProxyGeometry(kind='volume'){
  if(kind==='far')return new Float32Array([-1,-1,0,1,-1,0,-1,1,0,-1,1,0,1,-1,0,1,1,0]);
  if(kind!=='volume')throw Error('Unsupported woodland proxy');
  const corners=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
  const indices=[0,3,2,0,2,1,4,5,6,4,6,7,0,4,7,0,7,3,1,2,6,1,6,5,0,1,5,0,5,4,3,7,6,3,6,2];
  return new Float32Array(indices.flatMap(i=>corners[i]));
}
function woodlandWoodGeometry(mesh){
  if(!mesh||!Array.isArray(mesh.positions)||!Array.isArray(mesh.normals)||!Array.isArray(mesh.indices)||
    mesh.positions.length!==mesh.normals.length||mesh.indices.length%3||mesh.indices.length/3!==mesh.triangles||mesh.triangles>500)throw Error('Invalid woodland wood mesh');
  const data=new Float32Array(mesh.indices.length*6);
  for(let i=0;i<mesh.indices.length;i++){
    const index=mesh.indices[i],p=mesh.positions[index],n=mesh.normals[index];
    if(!Number.isInteger(index)||index<0||!woodlandFinite(p)||p.length!==3||!woodlandFinite(n)||n.length!==3||Math.hypot(...n)<1e-8)throw Error('Invalid woodland wood vertex');
    data.set(p,i*6);data.set(n,i*6+3);
  }
  return data;
}

export async function createWoodland({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,format,samples,
  trees,landUniform,landLightView,assetBase='assets/woodland/',limits={}}){
  if(!(trees instanceof Float32Array)||trees.length%8||!landUniform||!landLightView)throw Error('Woodland needs canonical tree roots and land lighting');
  const settings={...WOODLAND_LIMITS,...limits};
  if(![settings.near,settings.middle].every(v=>Number.isSafeInteger(v)&&v>=0)||settings.near>WOODLAND_LIMITS.near||settings.middle>WOODLAND_LIMITS.middle||
    !(settings.atlasTexelPixels>0&&settings.atlasTexelPixels<=WOODLAND_LIMITS.atlasTexelPixels)||
    ![settings.nearPixels,settings.middlePixels,settings.hysteresis].every(Number.isFinite)||
    !(settings.nearPixels>settings.middlePixels&&settings.middlePixels>0&&settings.hysteresis>=0&&settings.hysteresis<.5))throw Error('Unsupported woodland detail budget');
  const load=async name=>{if(typeof name!=='string'||!Object.prototype.hasOwnProperty.call(WOODLAND_ASSETS,name))throw Error('Invalid woodland asset path');
    const path=assetBase==='assets/woodland/'?WOODLAND_ASSETS[name]:assetBase+name;
    const response=await fetch(path);if(!response.ok)throw Error(`Woodland asset unavailable (${response.status}): ${name}`);return response;};
  const library=woodlandValidateLibrary(await(await load('library.json')).json());
  const resources=[],textures=[];let disposed=false;
  const buffer=(data,usage,label)=>{
    const result=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    resources.push(result);if(data.byteLength)device.queue.writeBuffer(result,0,data);return result;
  };
  try{
    const atlas=library.atlas;
    async function texture(name,format){
      const response=await load(name),bitmap=await createImageBitmap(await response.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
      try{
        if(bitmap.width!==atlas.width||bitmap.height!==atlas.height)throw Error('Incomplete woodland atlas');
        const result=device.createTexture({label:'woodland '+name,size:[atlas.width,atlas.height],format,
          usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});textures.push(result);
        device.queue.copyExternalImageToTexture({source:bitmap},{texture:result},[atlas.width,atlas.height]);return result;
      }finally{bitmap.close();}
    }
    // Sequential allocation simplifies failure cleanup; these are three small
    // exact banks, with no runtime resampling or automatic packed-atlas mips.
    const colour=await texture(atlas.colour,'rgba8unorm-srgb'),normal=await texture(atlas.normal,'rgba8unorm'),depth=await texture(atlas.depth,'rgba8unorm');
    const information=new Float32Array(4+2*24);information.set([atlas.width,atlas.height,library.plants[0].tileSize,0]);
    for(let i=0;i<2;i++){
      const p=library.plants[i],at=4+i*24;
      information.set([...p.centre,p.radius],at);information.set([...p.bounds[0],0],at+4);information.set([...p.bounds[1],0],at+8);
      information.set([...p.woodColourSRGB.map(woodlandSRGB),1],at+12);information.set([...p.origin,p.tileSize,p.padding],at+16);
      information.set([p.sourceHeight,p.horizontalRadius,...p.woodDisplacement],at+20);
    }
    const info=buffer(information,GPUBufferUsage.UNIFORM,'woodland source metadata');
    const wood=[];
    for(const plant of library.plants){
      const tiers=[];for(const name of plant.wood){const data=woodlandWoodGeometry(await(await load(name)).json());tiers.push({buffer:buffer(data,GPUBufferUsage.VERTEX,'grown '+name),count:data.length/6});}
      wood.push(tiers);
    }
    const cube=buffer(woodlandProxyGeometry('volume'),GPUBufferUsage.VERTEX,'woodland conservative cube proxy');
    const quad=buffer(woodlandProxyGeometry('far'),GPUBufferUsage.VERTEX,'woodland tangent-cone billboard');
    const module=await shader(WOODLAND,'grown woodland surface reconstruction');
    const instanceLayout={arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:2,offset:0,format:'float32x4'},{shaderLocation:3,offset:16,format:'float32x4'}]};
    const makePipe=(wood)=>device.createRenderPipelineAsync({label:wood?'grown solid tree wood':'grown directional canopy',layout:'auto',
      vertex:{module,entryPoint:wood?'woodlandWoodVS':'woodlandCrownVS',buffers:[{arrayStride:wood?24:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},
        ...(wood?[{shaderLocation:1,offset:12,format:'float32x3'}]:[])]},instanceLayout]},
      fragment:{module,entryPoint:wood?'woodlandWoodFS':'woodlandCrownFS',targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'back'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
    const woodPipe=await makePipe(true),crownPipe=await makePipe(false);
    const colourSampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const entries=[{binding:0,resource:{buffer:frameUBO}},{binding:1,resource:transView},{binding:2,resource:skyView},{binding:3,resource:sampler},
      {binding:4,resource:envCubeView},{binding:5,resource:landLightView},{binding:6,resource:{buffer:landUniform}},{binding:7,resource:{buffer:info}},
      {binding:8,resource:colour.createView()},{binding:9,resource:normal.createView()},{binding:10,resource:depth.createView()},{binding:11,resource:colourSampler}];
    const woodGroup=device.createBindGroup({layout:woodPipe.getBindGroupLayout(0),entries:entries.filter(e=>e.binding<8)});
    const crownGroup=device.createBindGroup({layout:crownPipe.getBindGroupLayout(0),entries});
    const woodCloud=clouds.bindVolume(woodPipe),crownCloud=clouds.bindVolume(crownPipe);
    const records=[],patches=new Map();
    for(let id=0;id<trees.length/8;id++){
      const tree=trees.subarray(id*8,id*8+8);
      if(!Array.from(tree).every(Number.isFinite)||!(tree[3]>0&&tree[4]>0))throw Error('Invalid canonical woodland root');
      // Stable existing shape identity; no simulation/random stream is consumed.
      const family=((Math.floor(tree[5]*1048576)>>>0)>>>3)%2,plant=library.plants[family],bounds=woodlandBounds(tree,plant);
      const record={id,family,bounds,instance:[tree[0],tree[1],tree[2],bounds.scaleXZ,bounds.scaleY,bounds.angle,family,0]};records.push(record);
      const key=Math.floor(tree[0]/128)+':'+Math.floor(tree[2]/128);
      if(!patches.has(key))patches.set(key,{records:[],low:[Infinity,Infinity,Infinity],high:[-Infinity,-Infinity,-Infinity]});
      const patch=patches.get(key);patch.records.push(record);
      for(let i=0;i<3;i++){patch.low[i]=Math.min(patch.low[i],bounds.centre[i]-bounds.radius);patch.high[i]=Math.max(patch.high[i],bounds.centre[i]+bounds.radius);}
    }
    for(const patch of patches.values()){
      patch.centre=patch.low.map((v,i)=>(v+patch.high[i])*.5);patch.radius=Math.hypot(...patch.high.map((v,i)=>(v-patch.low[i])*.5));
    }
    const batches=Array.from({length:6},()=>({buffer:null,capacity:0,count:0,data:[]}));
    const selectedIds=new Set(),previous=new Map(),stats={covered:0,near:0,middle:0,far:0,cullPatches:0,cullTrees:0,unsupportedProjection:0,
      tooClose:0,budgetOverflow:0,woodErrorFallback:0,triangles:0,atlasBytes:atlas.uncompressedBytes,maxAtlasTexelPixels:0,maxSourceWoodDisplacementPixels:0,patches:patches.size,
      sampleBound:'atlas texel footprint only; directional reconstruction error unverified',standVolumes:false,
      nearFallback:'existing procedural morphology; transition silhouette error is not certified'};
    let lastCamera=null,lastView=null;
    function update(camera,viewProjection=null){
      if(disposed)return selectedIds;
      const key=[camera?.x,camera?.y,camera?.z,camera?.screenHeight,camera?.tanHalfFovY,...(camera?.forward??[])];
      const sameCamera=lastCamera&&key.length===lastCamera.length&&key.every((v,i)=>v===lastCamera[i]);
      const view=viewProjection?.length>=16?Array.from({length:16},(_,i)=>viewProjection[i]):null;
      const sameView=(!view&&!lastView)||(view&&lastView&&view.every((v,i)=>v===lastView[i]));
      if(sameCamera&&sameView)return selectedIds;
      lastCamera=key;lastView=view;selectedIds.clear();
      for(const k of ['covered','near','middle','far','cullPatches','cullTrees','unsupportedProjection','tooClose','budgetOverflow','woodErrorFallback','triangles','maxAtlasTexelPixels','maxSourceWoodDisplacementPixels'])stats[k]=0;
      for(const batch of batches){batch.count=0;batch.data=[];}
      if(!woodlandProjectedFootprint(records[0]?.bounds??{centre:[0,0,0],radius:1,sampleStep:1},camera))return selectedIds;
      const planes=woodlandPlanes(viewProjection),candidates=[];
      for(const patch of patches.values()){
        if(!woodlandVisible(patch.centre,patch.radius,camera,planes)){stats.cullPatches++;continue;}
        for(const record of patch.records){
          if(!woodlandVisible(record.bounds.centre,record.bounds.radius,camera,planes)){stats.cullTrees++;continue;}
          const footprint=woodlandProjectedFootprint(record.bounds,camera);
          if(!footprint?.supported){stats.unsupportedProjection++;continue;}
          if(footprint.texelPixels>settings.atlasTexelPixels){stats.tooClose++;continue;}
          candidates.push({record,footprint});
        }
      }
      candidates.sort((a,b)=>b.footprint.pixels-a.footprint.pixels||a.record.id-b.record.id);
      const current=new Map();
      for(const {record,footprint}of candidates){
        const old=previous.get(record.id)??0;
        const nearThreshold=settings.nearPixels*(old===2?1-settings.hysteresis:1),middleThreshold=settings.middlePixels*(old>=1?1-settings.hysteresis:1);
        let tier=footprint.pixels>=nearThreshold?2:footprint.pixels>=middleThreshold?1:0;
        if(tier===2&&stats.near>=settings.near){tier=1;stats.budgetOverflow++;}
        if(tier===1&&stats.middle>=settings.middle){tier=0;stats.budgetOverflow++;}
        const sourcePlant=library.plants[record.family],b=record.bounds;
        const woodError=level=>{
          const e=sourcePlant.woodDisplacement[level===2?0:1]*Math.max(b.scaleXZ,b.scaleY)*
            (1+.122*(Math.abs(sourcePlant.centre[1])+sourcePlant.radius)/sourcePlant.sourceHeight);
          return e===0?0:e>=footprint.near?Infinity:footprint.projectScale*e/(footprint.near-e);
        };
        // Only the source's explicitly reported wood reduction displacement is
        // bounded here. An unresolved wood tier falls back to its source atlas;
        // this does not turn that atlas into a certified full-surface metric.
        if(tier&&woodError(tier)>settings.atlasTexelPixels){
          if(tier===1&&stats.near<settings.near&&woodError(2)<=settings.atlasTexelPixels)tier=2;
          else tier=0;
          stats.woodErrorFallback++;
        }
        if(tier)stats.maxSourceWoodDisplacementPixels=Math.max(stats.maxSourceWoodDisplacementPixels,woodError(tier));
        current.set(record.id,tier);selectedIds.add(record.id);stats.covered++;stats[tier===2?'near':tier===1?'middle':'far']++;
        stats.maxAtlasTexelPixels=Math.max(stats.maxAtlasTexelPixels,footprint.texelPixels);
        const batch=batches[record.family*3+tier],instance=record.instance.slice();instance[7]=tier;
        batch.data.push(...instance);batch.count++;
        stats.triangles+=tier===0?2:12+wood[record.family][tier===2?0:1].count/3;
      }
      previous.clear();for(const [id,tier]of current)previous.set(id,tier);
      for(let i=0;i<batches.length;i++){
        const batch=batches[i];if(!batch.count)continue;
        if(batch.count>batch.capacity){
          batch.buffer?.destroy();batch.capacity=Math.max(batch.count,Math.ceil(batch.capacity*1.5),16);
          batch.buffer=device.createBuffer({label:'grown woodland instances '+i,size:batch.capacity*32,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
        }
        device.queue.writeBuffer(batch.buffer,0,new Float32Array(batch.data));
      }
      return selectedIds;
    }
    return{library,selectedIds,stats,limits:settings,sourceBounds:records.map(r=>Object.freeze({id:r.id,family:r.family,specimen:library.plants[r.family].id,
        species:library.plants[r.family].species,...r.bounds,centre:Object.freeze(r.bounds.centre.slice())})),
      update,
      draw(pass,camera,viewProjection=null){
        update(camera,viewProjection);if(!selectedIds.size||disposed)return;
        pass.setPipeline(woodPipe);pass.setBindGroup(0,woodGroup);pass.setBindGroup(1,woodCloud);
        for(let family=0;family<2;family++)for(let tier=1;tier<=2;tier++){
          const batch=batches[family*3+tier];if(!batch.count)continue;const mesh=wood[family][tier===2?0:1];
          pass.setVertexBuffer(0,mesh.buffer);pass.setVertexBuffer(1,batch.buffer);pass.draw(mesh.count,batch.count);
        }
        pass.setPipeline(crownPipe);pass.setBindGroup(0,crownGroup);pass.setBindGroup(1,crownCloud);
        for(let family=0;family<2;family++)for(let tier=0;tier<3;tier++){
          const batch=batches[family*3+tier];if(!batch.count)continue;
          pass.setVertexBuffer(0,tier===0?quad:cube);pass.setVertexBuffer(1,batch.buffer);pass.draw(tier===0?6:36,batch.count);
        }
      },
      destroy(){if(disposed)return;disposed=true;selectedIds.clear();for(const batch of batches)batch.buffer?.destroy();for(const resource of resources)resource.destroy();for(const texture of textures)texture.destroy();},
    };
  }catch(error){disposed=true;for(const resource of resources)resource.destroy();for(const texture of textures)texture.destroy();throw error;}
}
