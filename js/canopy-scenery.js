// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Baked world-space geometry. No runtime growth, species substitution, tiling,
// instance reapplication or claim that this small temperate stand covers Saba.
export const CANOPY_SCENERY_ASSETS=Object.freeze({
  'manifest.json':'assets/canopy-scenery/saba/manifest.json',
  'near.bin':'assets/canopy-scenery/saba/near.bin',
  'leaf.bin':'assets/canopy-scenery/saba/leaf.bin',
  'far.bin':'assets/canopy-scenery/saba/far.bin',
  'instances.bin':'assets/canopy-scenery/saba/instances.bin',
});
export const CANOPY_VERTEX_FLOATS=13;
export const CANOPY_VERTEX_LAYOUT=Object.freeze({arrayStride:52,attributes:[
  {shaderLocation:0,offset:0,format:'float32x3'},
  {shaderLocation:1,offset:12,format:'float32x3'},
  {shaderLocation:2,offset:24,format:'float32x2'},
  {shaderLocation:5,offset:32,format:'float32x2'},
  {shaderLocation:6,offset:40,format:'float32x3'},
]});
const canopyFiniteVector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const canopyStreamNames=['near.bin','leaf.bin','far.bin'];
const canopyRangeNames=['near','leaf','far'];

export function validateCanopyScenery(manifest){
  if(manifest?.format!=='waterworld.canopy-runtime'||manifest.version!==1||manifest.units!=='metres'||manifest.upAxis!=='Y'||
    manifest.vertexLayout?.strideFloats!==13||manifest.vertexLayout?.strideBytes!==52||
    JSON.stringify(manifest.vertexLayout?.attributes)!=='["x","y","z","nx","ny","nz","kind","shade","u","v","linearR","linearG","linearB"]'||
    !Array.isArray(manifest.patches)||!manifest.patches.length)throw Error('Unsupported canopy scenery format');
  const domain=manifest.coverage;
  if(domain?.kind!=='rectangle'||!canopyFiniteVector(domain.boundsXZ,4)||!(domain.boundsXZ[1]>domain.boundsXZ[0]&&domain.boundsXZ[3]>domain.boundsXZ[2]))throw Error('Invalid canopy coverage domain');
  for(const name of canopyStreamNames){
    const file=manifest.files?.[name];
    if(!Number.isSafeInteger(file?.vertexCount)||file.vertexCount<0||file.vertexCount%3||file.bytes!==file.vertexCount*52||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('Invalid canopy stream receipt: '+name);
  }
  if(manifest.files['near.bin'].vertexCount+manifest.files['leaf.bin'].vertexCount===0)throw Error('Canopy detail is empty');
  const ids=new Set(),ranges=canopyRangeNames.map(()=>[]);
  for(const patch of manifest.patches){
    if(ids.has(patch.id)||!canopyFiniteVector(patch.low,3)||!canopyFiniteVector(patch.high,3)||!canopyFiniteVector(patch.centre,3)||
      !(Number.isFinite(patch.radius)&&patch.radius>=0)||patch.low.some((v,i)=>v>patch.high[i]))throw Error('Invalid canopy patch bounds');
    ids.add(patch.id);
    // The sphere bounds all corners, rather than trusting a centre/radius label.
    for(let mask=0;mask<8;mask++)if(Math.hypot(...patch.low.map((v,i)=>(mask&(1<<i)?patch.high[i]:v)-patch.centre[i]))>patch.radius+1e-4)throw Error('Incomplete canopy patch sphere');
    if(patch.geometryErrorSupported&&!(Number.isFinite(patch.geometryErrorMetres)&&patch.geometryErrorMetres>=0))throw Error('Invalid canopy geometry error bound');
    for(let i=0;i<3;i++){
      const range=patch[canopyRangeNames[i]],total=manifest.files[canopyStreamNames[i]].vertexCount;
      if(!Number.isSafeInteger(range?.firstVertex)||!Number.isSafeInteger(range?.vertexCount)||range.firstVertex<0||range.vertexCount<0||
        range.firstVertex%3||range.vertexCount%3||range.firstVertex+range.vertexCount>total)throw Error('Invalid canopy draw range');
      if(range.vertexCount)ranges[i].push([range.firstVertex,range.firstVertex+range.vertexCount]);
    }
  }
  // Every triangle belongs to exactly one patch; duplicate ranges double draw.
  for(let i=0;i<3;i++){
    ranges[i].sort((a,b)=>a[0]-b[0]);let end=0;
    for(const [low,high]of ranges[i]){if(low!==end)throw Error('Non-partitioned canopy ranges');end=high;}
    if(end!==manifest.files[canopyStreamNames[i]].vertexCount)throw Error('Incomplete canopy ranges');
  }
  if(manifest.textureAlphaErrorSupported&&!(Number.isFinite(manifest.textureAlphaErrorMetres)&&manifest.textureAlphaErrorMetres>=0))throw Error('Invalid canopy alpha error bound');
  return manifest;
}

export function decodeCanopyScenery(manifest,streams){
  validateCanopyScenery(manifest);
  const decoded={};
  for(let stream=0;stream<3;stream++){
    const name=canopyStreamNames[stream],raw=streams[name];
    if(!(raw instanceof ArrayBuffer)||raw.byteLength!==manifest.files[name].bytes)throw Error('Incomplete canopy stream: '+name);
    const data=new Float32Array(raw);decoded[canopyRangeNames[stream]]=data;
    for(let i=0;i<data.length;i+=13){
      for(let c=0;c<13;c++)if(!Number.isFinite(data[i+c]))throw Error('Non-finite canopy vertex');
      if(Math.hypot(data[i+3],data[i+4],data[i+5])<1e-8||data[i+7]<0||data[i+7]>1||
        data[i+10]<0||data[i+11]<0||data[i+12]<0)throw Error('Invalid canopy material/normal');
      if(stream===0&&data[i+6]!==3||stream===1&&data[i+6]!==4||stream===2&&data[i+6]!==3&&data[i+6]!==4)throw Error('Incorrect canopy opaque/cutout classification');
    }
    for(const patch of manifest.patches){
      const range=patch[canopyRangeNames[stream]];
      for(let v=range.firstVertex;v<range.firstVertex+range.vertexCount;v++)for(let c=0;c<3;c++){
        const p=data[v*13+c];if(p<patch.low[c]-1e-3||p>patch.high[c]+1e-3)throw Error('Canopy vertex outside its culling bound');
      }
    }
  }
  return{manifest,...decoded};
}

export async function loadCanopyScenery({fetchAsset=fetch,assets=CANOPY_SCENERY_ASSETS}={}){
  const load=async name=>{const response=await fetchAsset(assets[name]);if(!response.ok)throw Error(`Canopy scenery unavailable (${response.status}): ${name}`);return response;};
  const manifest=validateCanopyScenery(await(await load('manifest.json')).json());
  const buffers=await Promise.all(canopyStreamNames.map(async name=>[name,await(await load(name)).arrayBuffer()]));
  if(!globalThis.crypto?.subtle)throw Error('Canopy receipt verification requires Web Crypto');
  for(const [name,bytes]of buffers){
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==manifest.files[name].sha256)throw Error('Canopy stream digest mismatch: '+name);
  }
  return decodeCanopyScenery(manifest,Object.fromEntries(buffers));
}

export function canopyCoversPoint(manifest,x,z){
  const [x0,x1,z0,z1]=manifest.coverage.boundsXZ;
  return x>=x0&&x<=x1&&z>=z0&&z<=z1;
}
export function excludeCanopyRoots(trees,manifest){
  if(!(trees instanceof Float32Array)||trees.length%8)throw Error('Invalid procedural tree instances');
  const retained=[];
  for(let i=0;i<trees.length;i+=8)if(!canopyCoversPoint(manifest,trees[i],trees[i+2]))retained.push(...trees.subarray(i,i+8));
  return new Float32Array(retained);
}

// Perspective Lipschitz bound, including off-axis magnification and the closest
// point of the patch. An unsupported/near-plane projection keeps full detail.
export function canopyProjectedError(errorMetres,patch,camera){
  if(!(Number.isFinite(errorMetres)&&errorMetres>=0))return Infinity;
  const f=camera?.forward,h=camera?.screenHeight,tan=camera?.tanHalfFovY;
  if(!(h>0&&tan>0)||!f||f.length<3||![camera.x,camera.y,camera.z,h,tan,...f].every(Number.isFinite))return Infinity;
  const length=Math.hypot(...f);if(!(length>0))return Infinity;
  const delta=patch.centre.map((v,i)=>v-[camera.x,camera.y,camera.z][i]);
  const depth=delta.reduce((sum,v,i)=>sum+v*f[i]/length,0),distance=Math.hypot(...delta),near=depth-patch.radius;
  if(near<=errorMetres)return Infinity;
  const lateral=Math.sqrt(Math.max(0,distance*distance-depth*depth))+patch.radius;
  return h/(2*tan)*errorMetres*Math.sqrt(1+(lateral/near)**2)/(near-errorMetres);
}
function canopyPatchVisible(patch,camera,matrix){
  if(!matrix||matrix.length<16)return true;
  const p=patch.centre.map((v,i)=>v-[camera.x,camera.y,camera.z][i]);
  for(const [axis,sign]of[[0,-1],[0,1],[1,-1],[1,1],[3,0]]){
    const a=[0,1,2].map(k=>matrix[k*4+3]+(axis===3?0:sign*matrix[k*4+axis]));
    const d=matrix[15]+(axis===3?0:sign*matrix[12+axis]);
    if(a.reduce((sum,v,k)=>sum+v*p[k],d)<-patch.radius*Math.hypot(...a))return false;
  }
  return true;
}
export function selectCanopyPatches(manifest,camera,matrix=null,mode='auto',previous=new Map()){
  if(!['auto','near','far'].includes(mode))throw Error('Unknown canopy detail mode');
  const selected=[];
  for(const patch of manifest.patches){
    if(!canopyPatchVisible(patch,camera,matrix))continue;
    const geometryPixels=patch.geometryErrorSupported?canopyProjectedError(patch.geometryErrorMetres,patch,camera):Infinity;
    const alphaPixels=manifest.textureAlphaErrorSupported?canopyProjectedError(manifest.textureAlphaErrorMetres,patch,camera):Infinity;
    // With no alpha/silhouette proof, only collapse when the entire support of
    // both representations fits three pixels. This does not prove colour error.
    const supportPixels=canopyProjectedError(patch.radius*2,patch,camera);
    // Enter below the strict limit; retain only while still at/below 3px.
    // Hysteresis never licenses an error above the requested render threshold.
    const threshold=previous.get(patch.id)==='far'?3:3*.88;
    const certifiedGeometry=geometryPixels<=threshold,certifiedAppearance=alphaPixels<=threshold;
    const far=!!patch.far.vertexCount&&(mode==='far'||mode==='auto'&&(certifiedGeometry&&certifiedAppearance||supportPixels<=threshold));
    previous.set(patch.id,far?'far':'near');
    selected.push({patch,tier:far?'far':'near',geometryPixels,alphaPixels,supportPixels,
      reason:mode==='far'?'uncertified-debug':far?(certifiedGeometry&&certifiedAppearance?'measured-errors':'collapsed-support'):'detail'});
  }
  return selected;
}

export function canopyInspectionURL(href,manifest){
  const low=[Infinity,Infinity,Infinity],high=low.map(()=>-Infinity);
  for(const patch of manifest.patches)for(let c=0;c<3;c++){low[c]=Math.min(low[c],patch.low[c]);high[c]=Math.max(high[c],patch.high[c]);}
  if(!low.every(Number.isFinite))return null;
  const target=low.map((v,c)=>(v+high[c])*.5),r=Math.max(12,Math.hypot(...high.map((v,c)=>(v-low[c])*.5)));
  const eye=[target[0]+r*.65,high[1]+r*.28,target[2]+r*1.25],delta=target.map((v,c)=>v-eye[c]);
  const yaw=Math.atan2(delta[0],-delta[2])*180/Math.PI,pitch=Math.atan2(delta[1],Math.hypot(delta[0],delta[2]))*180/Math.PI;
  const url=new URL(href);url.searchParams.set('landfall','approach');url.searchParams.set('view','free');url.searchParams.set('boat','0');
  url.searchParams.set('canopy','near');url.searchParams.set('cam',[...eye,yaw,pitch].map(v=>Number(v.toFixed(5))).join(','));
  // Ship coordinates and Wells Bay presets are untouched; only the camera moves.
  return url.href;
}

export async function createCanopyRenderer({device,module,resources,clouds,format,samples,pack,mode='auto'}){
  const allocated=[],buffers={};
  for(const name of canopyRangeNames){
    const data=pack[name],b=device.createBuffer({size:Math.max(4,data.byteLength),usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST,label:'imported canopy '+name});
    allocated.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);buffers[name]=b;
  }
  try{
    const make=fragment=>device.createRenderPipelineAsync({label:'imported canopy '+fragment,layout:'auto',
      vertex:{module,entryPoint:'bakedCanopyVS',buffers:[CANOPY_VERTEX_LAYOUT]},fragment:{module,entryPoint:fragment,targets:[{format}]},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},
      multisample:{count:samples,alphaToCoverageEnabled:fragment==='canopyLeafFS'&&samples>1}});
    const opaque=await make('canopyOpaqueFS'),leaf=await make('canopyLeafFS');
    const bind=(pipe,bindings)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.filter(([id])=>bindings.includes(id)).map(([binding,resource])=>({binding,resource}))});
    const opaqueGroup=bind(opaque,[0,1,2,3,4,5,6]),leafGroup=bind(leaf,[0,1,2,3,4,5,6,8,10]);
    const opaqueCloud=clouds.bindVolume(opaque),leafCloud=clouds.bindVolume(leaf);
    let selected=[];const previous=new Map();
    const stats={loaded:true,mode,patches:pack.manifest.patches.length,near:0,far:0,triangles:0,
      sourceTrees:pack.manifest.stems?.length??pack.manifest.source?.treeCount??null,
      alphaErrorSupported:!!pack.manifest.textureAlphaErrorSupported,colourErrorSupported:false,
      maxGeometryPixels:0,maxSupportPixels:0,uncertifiedDebug:mode==='far'};
    return{
      stats,
      prepare(camera,matrix){
        selected=selectCanopyPatches(pack.manifest,camera,matrix,mode,previous);stats.near=0;stats.far=0;stats.triangles=0;stats.maxGeometryPixels=0;stats.maxSupportPixels=0;
        for(const item of selected){stats[item.tier]++;const p=item.patch;stats.triangles+=(item.tier==='far'?p.far.vertexCount:p.near.vertexCount+p.leaf.vertexCount)/3;
          if(item.tier==='far'){stats.maxGeometryPixels=Math.max(stats.maxGeometryPixels,item.geometryPixels);stats.maxSupportPixels=Math.max(stats.maxSupportPixels,item.supportPixels);}}
      },
      drawOpaque(pass){
        if(!selected.length)return;pass.setPipeline(opaque);pass.setBindGroup(0,opaqueGroup);pass.setBindGroup(1,opaqueCloud);
        for(const {patch,tier}of selected){const range=patch[tier];if(!range.vertexCount)continue;pass.setVertexBuffer(0,buffers[tier]);pass.draw(range.vertexCount,1,range.firstVertex);}
      },
      drawCutout(pass){
        if(!selected.some(v=>v.tier==='near'&&v.patch.leaf.vertexCount))return;
        pass.setPipeline(leaf);pass.setBindGroup(0,leafGroup);pass.setBindGroup(1,leafCloud);pass.setVertexBuffer(0,buffers.leaf);
        for(const {patch,tier}of selected)if(tier==='near'&&patch.leaf.vertexCount)pass.draw(patch.leaf.vertexCount,1,patch.leaf.firstVertex);
      },
      destroy(){for(const b of allocated)b.destroy();},
    };
  }catch(error){for(const b of allocated)b.destroy();throw error;}
}
