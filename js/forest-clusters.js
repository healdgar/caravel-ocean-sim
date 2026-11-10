// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Trees as cluster hierarchies, cut per tree on the GPU so each stays within a pixel error at any
// distance. Built offline by scripts/prepare-forest-clusters.mjs with the builder from threejs-nanites.
export const FOREST_CLUSTER_VERTEX_WORDS = 5;
export const FOREST_CLUSTER_WORDS = 16;
export const FOREST_LEAF_VERTICES = 6;

const unit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const unit8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
// Octahedral normal, so two 16-bit values hold a whole direction.
function octahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * .5 + .5, v * .5 + .5];
}
// One vertex as five 32-bit words. Colour is stored as its square root, which keeps dark values distinct.
export function packForestClusterVertex({ position, normal, uv, colour, material, shade, canopy }, { low, posScale, uvLow, uvScale }) {
  const p = position.map((v, a) => unit16((v - low[a]) / posScale)), n = octahedral(normal);
  return [
    (p[0] | (p[1] << 16)) >>> 0,
    (p[2] | (Math.max(0, material) << 16) | (unit8(shade) << 24)) >>> 0,
    (unit16(n[0]) | (unit16(n[1]) << 16)) >>> 0,
    (unit16((uv[0] - uvLow[0]) / uvScale[0]) | (unit16((uv[1] - uvLow[1]) / uvScale[1]) << 16)) >>> 0,
    (unit8(Math.sqrt(colour[0])) | (unit8(Math.sqrt(colour[1])) << 8) | (unit8(Math.sqrt(colour[2])) << 16) | (unit8(canopy) << 24)) >>> 0,
  ];
}

// Literal paths: build.mjs finds what to publish by reading them from the source.
export const FOREST_CLUSTER_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/saba/clusters/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/saba/clusters/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/saba/clusters/indices.bin.gz',
  'clusters.bin.gz': 'assets/forest-scenery/saba/clusters/clusters.bin.gz',
});
export const SUBTROPICAL_FOREST_CLUSTER_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/clusters/manifest.json',
  'vertices.bin.gz': 'assets/forest-scenery/subtropical/clusters/vertices.bin.gz',
  'indices.bin.gz': 'assets/forest-scenery/subtropical/clusters/indices.bin.gz',
  'clusters.bin.gz': 'assets/forest-scenery/subtropical/clusters/clusters.bin.gz',
});

export async function loadForestClusters({ assets = FOREST_CLUSTER_ASSETS, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest clusters unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = await (await get('manifest.json')).json();
  if (manifest?.format !== 'waterworld.forest-clusters' || manifest.version !== 1 || manifest.vertexWords !== FOREST_CLUSTER_VERTEX_WORDS || manifest.clusterWords !== FOREST_CLUSTER_WORDS) throw Error('Invalid forest cluster manifest');
  const stream = async (name) => {
    const receipt = manifest.files[name], response = await get(receipt.gzip.file);
    const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if (bytes.byteLength !== receipt.bytes) throw Error(`Forest cluster stream has the wrong size: ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error(`Forest cluster stream failed verification: ${name}`);
    return bytes;
  };
  const [vertices, indices, clusters] = await Promise.all(['vertices.bin', 'indices.bin', 'clusters.bin'].map(stream));
  return { manifest, vertices, indices, clusters };
}

// The cut one tree draws, as the GPU picks it: a cluster is drawn when its own error is within the
// limit and its parent's is not. Used by tests; the game does this in FOREST_CLUSTER_SELECT.
export function forestClusterIsDrawn({ error, parentError, lodDistance, parentDistance }, pixelsPerMetre, limit) {
  const projected = (e, d) => (e * pixelsPerMetre) / Math.max(d, 1e-3);
  return projected(error, lodDistance) <= limit && projected(parentError, parentDistance) > limit;
}

// Trees already culled and sorted into near, mid and far lists by the forest's own pass. This takes
// each near or mid tree's cut and lists its clusters for one indirect draw per species and kind.
export const FOREST_CLUSTER_SELECT = (FRAME) => FRAME + /* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
struct ForestCluster {lod:vec4f,parentLod:vec4f,cull:vec4f,err:f32,parentErr:f32,first:u32,shape:u32};
struct ForestClusterBucket {
 firstCluster:u32,clusterCount:u32,listWood:u32,listLeaf:u32,
 near:vec2u,mid:vec2u,far:vec2u,drawWood:u32,drawLeaf:u32,
 centre:vec4f,capacity:vec4u,
};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(2)var<storage,read>visible:array<u32>;
@group(0)@binding(3)var<storage,read>commands:array<u32>;
@group(0)@binding(4)var<storage,read>clusters:array<ForestCluster>;
@group(0)@binding(5)var<storage,read_write>list:array<vec2u>;
@group(0)@binding(6)var<storage,read_write>draws:array<atomic<u32>>;
@group(0)@binding(7)var<uniform>parameters:vec4f;
@group(0)@binding(8)var<uniform>bucket:ForestClusterBucket;
// Shares of the forest's pixel error each kind may use. A leaf's error is its size, which stays
// visible as a card, so leaves need the tighter limit. Wood is thin and hides among them.
const FOREST_CLUSTER_LEAF_LIMIT=.2;
const FOREST_CLUSTER_WOOD_LIMIT=.5;
fn forestClusterTree(index:u32)->u32{
 let nearCount=commands[bucket.near.y*5u+1u];
 if(index<nearCount){return visible[bucket.near.x+index];}
 let midCount=commands[bucket.mid.y*5u+1u];
 if(index-nearCount<midCount){return visible[bucket.mid.x+index-nearCount];}
 let farCount=commands[bucket.far.y*5u+1u];
 if(index-nearCount-midCount<farCount){return visible[bucket.far.x+index-nearCount-midCount];}
 return 0xffffffffu;
}
@compute @workgroup_size(64)fn forestClusterSelect(@builtin(global_invocation_id)id:vec3u){
 let tree=forestClusterTree(id.x);if(tree==0xffffffffu){return;}
 let r=roots[tree];let scale=r.rootScale.w;let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let origin=r.rootScale.xyz-F.camPos.xyz;
 let focal=F.screen.y/max(2.0*length(F.camUp.xyz),.0001);
 let limitLeaf=parameters.z*FOREST_CLUSTER_LEAF_LIMIT;let limitWood=parameters.z*FOREST_CLUSTER_WOOD_LIMIT;let limit=min(limitLeaf,limitWood);
 let b=bucket.centre.xyz*scale;
 let centre=origin+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);
 let nearest=max(length(centre)-bucket.centre.w*scale,.25);
 // Clusters run from coarsest parent to finest, so only a prefix can be drawn at this distance.
 let finest=limit*nearest/(scale*focal);
 var low=0u;var high=bucket.clusterCount;
 while(low<high){let middle=(low+high)/2u;if(clusters[bucket.firstCluster+middle].parentErr>finest){low=middle+1u;}else{high=middle;}}
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 let rowX=vec3f(F.viewProj[0].x,F.viewProj[1].x,F.viewProj[2].x);
 let rowY=vec3f(F.viewProj[0].y,F.viewProj[1].y,F.viewProj[2].y);
 let planeL=rowW+rowX;let planeR=rowW-rowX;let planeB=rowW+rowY;let planeT=rowW-rowY;
 let lengthL=length(planeL);let lengthR=length(planeR);let lengthB=length(planeB);let lengthT=length(planeT);
 for(var i=0u;i<low;i++){
  let index=bucket.firstCluster+i;let k=clusters[index];
  let isLeaf=(k.shape&1u)==1u;let allowed=select(limitWood,limitLeaf,isLeaf);
  let parentAt=origin+vec3f(c*k.parentLod.x-s*k.parentLod.z,k.parentLod.y,s*k.parentLod.x+c*k.parentLod.z)*scale;
  if(k.parentErr*scale*focal/max(length(parentAt)-k.parentLod.w*scale,.001)<=allowed){continue;}
  let ownAt=origin+vec3f(c*k.lod.x-s*k.lod.z,k.lod.y,s*k.lod.x+c*k.lod.z)*scale;
  if(k.err*scale*focal/max(length(ownAt)-k.lod.w*scale,.001)>allowed){continue;}
  let at=origin+vec3f(c*k.cull.x-s*k.cull.z,k.cull.y,s*k.cull.x+c*k.cull.z)*scale;
  // Wind carries leaves past the shapes they were baked from.
  let reach=k.cull.w*scale+.2+F.windP[0].z*.07;
  // A felled tree no longer stands where its clusters were baked.
  if(r.identity.w>=0.&&(dot(planeL,at)<-reach*lengthL||dot(planeR,at)<-reach*lengthR||dot(planeB,at)<-reach*lengthB||dot(planeT,at)<-reach*lengthT||dot(rowW,at)<-reach*length(rowW))){continue;}
  let draw=select(bucket.drawWood,bucket.drawLeaf,isLeaf);
  let slot=atomicAdd(&draws[draw*5u+1u],1u);
  if(slot<bucket.capacity.x){list[select(bucket.listWood,bucket.listLeaf,isLeaf)+slot]=vec2u(tree,index);}
 }
}
@compute @workgroup_size(64)fn forestClusterReset(@builtin(global_invocation_id)id:vec3u){
 if(id.x<u32(parameters.y)*2u){atomicStore(&draws[id.x*5u+1u],0u);}
}
`;

// Shares forestPlace with the ordinary tree shader, so clusters light and sway exactly alike.
export const FOREST_CLUSTER_VERTEX_WGSL = /* wgsl */`
struct ForestCluster {lod:vec4f,parentLod:vec4f,cull:vec4f,err:f32,parentErr:f32,first:u32,shape:u32};
@group(3)@binding(0)var<storage,read>forestClusterList:array<vec2u>;
@group(3)@binding(1)var<storage,read>forestClusters:array<ForestCluster>;
@group(3)@binding(2)var<storage,read>forestClusterVertices:array<u32>;
@group(3)@binding(3)var<storage,read>forestClusterIndices:array<u32>;
@group(3)@binding(4)var<uniform>forestClusterBounds:array<vec4f,2>;
fn forestClusterOctahedral(e:vec2f)->vec3f{
 var n=vec3f(e,1.-abs(e.x)-abs(e.y));
 if(n.z<0.){let x=n.x;n.x=(1.-abs(n.y))*select(-1.,1.,x>=0.);n.y=(1.-abs(x))*select(-1.,1.,n.y>=0.);}
 return normalize(n);
}
fn forestClusterVertex(tree:u32,vertex:u32,kindValue:f32)->ForestVertex{
 let at=vertex*${FOREST_CLUSTER_VERTEX_WORDS}u;
 let w0=forestClusterVertices[at];let w1=forestClusterVertices[at+1u];let w2=forestClusterVertices[at+2u];let w3=forestClusterVertices[at+3u];let w4=forestClusterVertices[at+4u];
 let unit=vec3f(f32(w0&65535u),f32(w0>>16u),f32(w1&65535u))/65535.;
 var position=forestClusterBounds[0].xyz+unit*forestClusterBounds[0].w;
 let r=forestRoots[tree];
 var normal=forestClusterOctahedral(vec2f(f32(w2&65535u),f32(w2>>16u))/65535.*2.-1.);
 let uv=forestClusterBounds[1].xy+vec2f(f32(w3&65535u),f32(w3>>16u))/65535.*forestClusterBounds[1].zw;
 if(kindValue>=3.5){
  let dist=length(r.rootScale.xyz-F.camPos.xyz);
  let midBlend=smoothstep(55.,320.,dist);
  if(midBlend>0.){
   let upRef=select(vec3f(0.,1.,0.),vec3f(1.,0.,0.),abs(normal.y)>.9);
   let t1=normalize(cross(normal,upRef));let t2=cross(normal,t1);
   let isSubBroadleaf=(forestBin.z&256u)!=0u;
   let baseInflate=select(.18,.48,isSubBroadleaf)*midBlend/max(r.rootScale.w,.85);
   let uvOff=clamp(uv-vec2f(.5,.5),vec2f(-.65),vec2f(.65));
   position+=t1*(uvOff.x*baseInflate)+t2*(uvOff.y*baseInflate);
   normal=normalize(normal+(t1*uvOff.x+t2*uvOff.y)*(.10*midBlend));
  }
 }
 let root=vec3f(f32(w4&255u),f32((w4>>8u)&255u),f32((w4>>16u)&255u))/255.;
 return forestPlace(r,tree,position,normal,vec2f(kindValue,f32(w1>>24u)/255.),uv,root*root,f32((w1>>16u)&255u),vertex,f32(w4>>24u)/255.);
}
// A cluster with fewer triangles than the draw's fixed count collapses the rest to a point.
@vertex fn forestClusterWoodVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(index>=(cluster.shape>>1u)*3u){var o:ForestVertex;return o;}
 return forestClusterVertex(item.x,forestClusterIndices[cluster.first+index],3.);
}
@vertex fn forestClusterLeafVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->ForestVertex{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(index>=(cluster.shape>>1u)/4u*${FOREST_LEAF_VERTICES}u){var o:ForestVertex;return o;}
 return forestClusterVertex(item.x,cluster.first+index,4.);
}
`;
export const FOREST_CLUSTER_SHADOW_WGSL = /* wgsl */ `
@vertex fn forestClusterWoodShadowVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->@builtin(position)vec4f{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(index>=(cluster.shape>>1u)*3u){return vec4f(2.,2.,0.,1.);}
 let r=forestRoots[item.x];
 let dCam=r.rootScale.xyz-F.camPos.xyz;
 if(dot(dCam,dCam)>24025.){return vec4f(2.,2.,0.,1.);}
 let rc=landSH.lightView*vec4f(r.rootScale.xyz+vec3f(0.,8.*r.rootScale.w,0.)-landSH.origin.xyz,1.);
 if(abs(rc.x)>1.12||abs(rc.y)>1.12||rc.z<-0.05||rc.z>1.05){return vec4f(2.,2.,0.,1.);}
 let v=forestClusterVertex(item.x,forestClusterIndices[cluster.first+index],3.);
 return landSH.lightView*vec4f(v.world-landSH.origin.xyz,1.);
}
@vertex fn forestClusterLeafShadowVS(@builtin(instance_index)instance:u32,@builtin(vertex_index)index:u32)->@builtin(position)vec4f{
 let item=forestClusterList[forestBin.x+instance];let cluster=forestClusters[item.y];
 if(index>=(cluster.shape>>1u)/4u*${FOREST_LEAF_VERTICES}u){return vec4f(2.,2.,0.,1.);}
 let r=forestRoots[item.x];
 let dCam=r.rootScale.xyz-F.camPos.xyz;
 let dCam2=dot(dCam,dCam);
 if(dCam2>24025.){return vec4f(2.,2.,0.,1.);}
 let rc=landSH.lightView*vec4f(r.rootScale.xyz+vec3f(0.,8.*r.rootScale.w,0.)-landSH.origin.xyz,1.);
 if(abs(rc.x)>1.12||abs(rc.y)>1.12||rc.z<-0.05||rc.z>1.05){return vec4f(2.,2.,0.,1.);}
 let v=forestClusterVertex(item.x,cluster.first+index,4.);
 return landSH.lightView*vec4f(v.world-landSH.origin.xyz,1.);
}
`;

const CLUSTER_TRIANGLES = 128;
const CLUSTER_INDICES = CLUSTER_TRIANGLES * 3;
const CLUSTER_LEAVES = CLUSTER_TRIANGLES / 4;
// How many clusters one species and kind may draw: about 25 million triangles.
const CLUSTERS_PER_DRAW = 200000;
const LEAF_PATTERN = [0, 1, 2, 0, 2, 3, 3, 2, 4, 3, 4, 5];

export async function createForestClusters({ device, shader, module, frame, source, prototypes, roots, visible, commands, parameters, format, samples, sceneEntries, cloudEntries, surfaceEntries, firstMaterials, bind, hasLandShadow = false }) {
  const B = GPUBufferUsage, owned = [], count = prototypes.length;
  const make = (data, usage, label) => {
    const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | B.COPY_DST });
    owned.push(buffer);
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const vertices = make(source.vertices, B.STORAGE, 'forest cluster vertices'), indices = make(source.indices, B.STORAGE, 'forest cluster indices'), clusters = make(source.clusters, B.STORAGE, 'forest clusters');
  const list = device.createBuffer({ label: 'forest clusters to draw', size: count * 2 * CLUSTERS_PER_DRAW * 8, usage: B.STORAGE });
  owned.push(list);
  const draws = make(new Uint32Array(Array.from({ length: count * 2 }, () => [CLUSTER_INDICES, 0, 0, 0, 0]).flat()), B.STORAGE | B.INDIRECT, 'forest cluster indirect draws');
  const leafIndices = make(Uint32Array.from({ length: CLUSTER_LEAVES * LEAF_PATTERN.length }, (_, i) => Math.floor(i / LEAF_PATTERN.length) * FOREST_LEAF_VERTICES + LEAF_PATTERN[i % LEAF_PATTERN.length]), B.INDEX, 'forest cluster leaf pattern');

  const compute = await shader(FOREST_CLUSTER_SELECT(frame), 'forest cluster cut');
  const render = (entryPoint, fragment, target, depthStencil) => device.createRenderPipelineAsync({
    label: `forest clusters ${fragment}`, layout: 'auto', vertex: { module, entryPoint },
    fragment: { module, entryPoint: fragment, targets: [target] }, primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', ...depthStencil }, multisample: { count: samples, alphaToCoverageEnabled: false },
  });
  const renderShadow = (entryPoint) => device.createRenderPipelineAsync({
    label: `forest clusters ${entryPoint}`, layout: 'auto', vertex: { module, entryPoint },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
  });
  const lay = { depthWriteEnabled: true, depthCompare: 'greater' };
  const [select, reset, woodPipeline, leafDepthPipeline, leafPipeline, woodShadowPipeline, leafShadowPipeline] = await Promise.all([
    device.createComputePipelineAsync({ label: 'forest cluster cut', layout: 'auto', compute: { module: compute, entryPoint: 'forestClusterSelect' } }),
    device.createComputePipelineAsync({ label: 'forest cluster reset', layout: 'auto', compute: { module: compute, entryPoint: 'forestClusterReset' } }),
    render('forestClusterWoodVS', 'forestNativeOpaqueFS', { format }, lay),
    render('forestClusterLeafVS', 'forestNativeLeafDepthFS', { format, writeMask: 0 }, lay),
    render('forestClusterLeafVS', 'forestNativeLeafFS', { format }, { depthWriteEnabled: false, depthCompare: 'equal' }),
    hasLandShadow ? renderShadow('forestClusterWoodShadowVS') : null,
    hasLandShadow ? renderShadow('forestClusterLeafShadowVS') : null,
  ]);
  const resetGroup = device.createBindGroup({ layout: reset.getBindGroupLayout(0), entries: [{ binding: 6, resource: { buffer: draws } }, { binding: 7, resource: { buffer: parameters } }] });
  const groups = {
    wood: { zero: bind(woodPipeline), cloud: cloudEntries(woodPipeline) },
    leafDepth: { zero: bind(leafDepthPipeline, [0]) },
    leaf: { zero: bind(leafPipeline), cloud: cloudEntries(leafPipeline) },
    woodShadow: woodShadowPipeline ? { zero: bind(woodShadowPipeline, [0, 19]), empty1: device.createBindGroup({ layout: woodShadowPipeline.getBindGroupLayout(1), entries: [] }) } : null,
    leafShadow: leafShadowPipeline ? { zero: bind(leafShadowPipeline, [0, 19]), empty1: device.createBindGroup({ layout: leafShadowPipeline.getBindGroupLayout(1), entries: [] }) } : null,
  };
  const species = prototypes.map((p, id) => {
    const info = source.manifest.prototypes.find((q) => q.id === id);
    if (!info) throw Error(`Forest clusters lack species ${p.species}`);
    const words = new ArrayBuffer(80), bucket = make(words, B.UNIFORM, 'forest cluster bucket');
    const boundsData = new Float32Array([...info.low, info.posScale, ...info.uvLow, ...info.uvScale]);
    const bounds = make(boundsData, B.UNIFORM, 'forest cluster bounds');
    const subRoot = (p.species === 'ceiba' || p.species === 'mangrove') ? 256 : 0;
    const uniform = (listBase) => make(new Uint32Array([listBase, firstMaterials[id], subRoot | p.nativeMaterials.length, samples]), B.UNIFORM, 'forest cluster bin');
    const wood = uniform(id * 2 * CLUSTERS_PER_DRAW), leaf = uniform((id * 2 + 1) * CLUSTERS_PER_DRAW);
    const clusterGroup = (pipeline, hasIndices) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(3),
      entries: [{ binding: 0, resource: { buffer: list } }, { binding: 1, resource: { buffer: clusters } }, { binding: 2, resource: { buffer: vertices } }, ...(hasIndices ? [{ binding: 3, resource: { buffer: indices } }] : []), { binding: 4, resource: { buffer: bounds } }],
    });
    const shadowSurface = (pipeline, offset) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(2),
      entries: [{ binding: 0, resource: { buffer: roots } }, { binding: 2, resource: { buffer: offset } }],
    });
    return {
      info, bucket, rootCount: p.rootCount,
      select: device.createBindGroup({ layout: select.getBindGroupLayout(0), entries: [frameEntry(0), ...[roots, visible, commands, clusters, list, draws, parameters, bucket].map((buffer, k) => ({ binding: k + 1, resource: { buffer } }))] }),
      wood: { surface: surfaceEntries(woodPipeline, p.id, wood, true), cluster: clusterGroup(woodPipeline, true) },
      leafDepth: { surface: surfaceEntries(leafDepthPipeline, p.id, leaf, false), cluster: clusterGroup(leafDepthPipeline, false) },
      leaf: { surface: surfaceEntries(leafPipeline, p.id, leaf, true), cluster: clusterGroup(leafPipeline, false) },
      woodShadow: woodShadowPipeline ? { surface: shadowSurface(woodShadowPipeline, wood), cluster: clusterGroup(woodShadowPipeline, true) } : null,
      leafShadow: leafShadowPipeline ? { surface: shadowSurface(leafShadowPipeline, leaf), cluster: clusterGroup(leafShadowPipeline, false) } : null,
    };
  });
  function frameEntry(binding) { return { binding, resource: { buffer: bind.frameUBO } }; }
  function placeTrees() {
    prototypes.forEach((p, id) => {
      const s = species[id], slots = count * 4 + id * 4;
      s.rootCount = p.rootCount;
      const data = new ArrayBuffer(80), u = new Uint32Array(data), f = new Float32Array(data);
      u.set([s.info.firstCluster, s.info.clusterCount, id * 2 * CLUSTERS_PER_DRAW, (id * 2 + 1) * CLUSTERS_PER_DRAW,
        p.firstRoot * 4, id * 4, p.firstRoot * 4 + p.rootCount * 2, slots, p.firstRoot * 4 + p.rootCount * 3, slots + 2, id * 2, id * 2 + 1]);
      f.set([...p.centre, p.radius], 12);
      u[16] = CLUSTERS_PER_DRAW;
      device.queue.writeBuffer(s.bucket, 0, data);
    });
  }
  placeTrees();
  const drawWith = (pass, pipeline, group, cloud, part, leafDraw) => {
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (cloud) pass.setBindGroup(1, cloud);
    if (leafDraw) pass.setIndexBuffer(leafIndices, 'uint32');
    species.forEach((s, id) => {
      pass.setBindGroup(2, s[part].surface);
      pass.setBindGroup(3, s[part].cluster);
      if (leafDraw) pass.drawIndexedIndirect(draws, (id * 2 + 1) * 20);
      else pass.drawIndirect(draws, id * 2 * 20);
    });
  };
  return {
    placeTrees,
    encode(pass) {
      pass.setPipeline(reset);
      pass.setBindGroup(0, resetGroup);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(select);
      species.forEach((s) => {
        if (!s.rootCount) return;
        pass.setBindGroup(0, s.select);
        pass.dispatchWorkgroups(Math.ceil(s.rootCount / 64));
      });
    },
    drawOpaque(pass) { drawWith(pass, woodPipeline, groups.wood.zero, groups.wood.cloud, 'wood', false); },
    drawLeafDepth(pass) { drawWith(pass, leafDepthPipeline, groups.leafDepth.zero, null, 'leafDepth', true); },
    drawLeaves(pass) { drawWith(pass, leafPipeline, groups.leaf.zero, groups.leaf.cloud, 'leaf', true); },
    drawShadow(pass) {
      if (woodShadowPipeline && groups.woodShadow) {
        drawWith(pass, woodShadowPipeline, groups.woodShadow.zero, groups.woodShadow.empty1, 'woodShadow', false);
      }
      if (leafShadowPipeline && groups.leafShadow) {
        drawWith(pass, leafShadowPipeline, groups.leafShadow.zero, groups.leafShadow.empty1, 'leafShadow', true);
      }
    },
    destroy() { for (const buffer of owned) buffer.destroy(); },
  };
}
