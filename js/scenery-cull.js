// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Culls and picks detail for instanced scenery on the GPU, as the forest does. The survivors are
// written straight into the vertex buffer the draws read, so their shaders do not change, and
// JavaScript only uploads an instance when it first comes into use. Used by ground cover and trees.
import { FRAME_WGSL } from './wgsl/common.js';
import { GRASS_VARIANTS, ROCK_ARCHETYPES, TREE_GEOMETRY_ERRORS, TREE_LOD, TREE_VARIANTS } from './vegetation.js';
import { CITY_HOUSE_TYPES, CITY_TYPE } from './old-world-buildings.js';

const INSTANCE_BYTES = 32;
const DRAW_WORDS = 4;
const EMPTY_SLOT = 0xffffffff;

const cullShell = (parts, select) => FRAME_WGSL + /* wgsl */ `
struct SceneryInstance {root:vec4f,shape:vec4f};
@group(0)@binding(0) var<uniform> F:Frame;
@group(0)@binding(1) var<uniform> params:vec4f;
@group(0)@binding(2) var<storage,read> instances:array<SceneryInstance>;
@group(0)@binding(3) var<storage,read> groups:array<u32>;
@group(0)@binding(4) var<storage,read_write> shown:array<SceneryInstance>;
@group(0)@binding(5) var<storage,read_write> draws:array<atomic<u32>>;
@group(0)@binding(6) var<storage,read_write> previous:array<u32>;
@group(0)@binding(7) var<storage,read> bucketFirst:array<u32>;
fn sceneryInFrustum(relative:vec3f,radius:f32)->bool {
  let clip=F.viewProj*vec4f(relative,1);
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  for(var a=0u;a<2u;a++){
    let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
    if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return false;}
  }
  return clip.w>=-radius*length(rowW);
}
const SCENERY_ALWAYS=1e30;
// How many pixels a world-size error covers on screen, for a bound of this radius around the point.
fn sceneryProjected(relative:vec3f,radius:f32,worldError:f32)->f32 {
  let depth=dot(relative,normalize(F.camFwd.xyz));let near=depth-radius;
  if(near<=worldError){return SCENERY_ALWAYS;}
  let lateral=sqrt(max(0.0,dot(relative,relative)-depth*depth))+radius;
  let focal=F.screen.y/(2.0*length(F.camUp.xyz));
  return focal*worldError*sqrt(1.0+lateral*lateral/(near*near))/(near-worldError);
}
${select}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&instances)){return;}
  let group=groups[id.x];
  if(group==${EMPTY_SLOT}u){return;}
  let instance=instances[id.x];
  let bucket=scenerySelect(id.x,group,instance);
  if(bucket<0){return;}
  let first=u32(bucket)*${parts}u;
  let slot=atomicAdd(&draws[first*${DRAW_WORDS}u+1u],1u);
  for(var part=1u;part<${parts}u;part++){atomicAdd(&draws[(first+part)*${DRAW_WORDS}u+1u],1u);}
  shown[bucketFirst[u32(bucket)]+slot]=instance;
}
`;

// Multi-LOD ground cover selection across 6 fractured boulder archetypes x 3 LODs (0..17) and 2 grass variants x 2 LODs (18..21).
export const GROUND_COVER_CULL = cullShell(1, /* wgsl */ `
fn scenerySelect(index:u32,group:u32,instance:SceneryInstance)->i32 {
  let relative=instance.root.xyz-F.camPos.xyz;
  let extent=length(vec2f(instance.root.w*1.41421356,instance.shape.x))*1.2;
  if(!sceneryInFrustum(relative,extent)){previous[index]=0u;return -1;}
  let wasVisible=previous[index]>0u;
  let oldLod=select(2u,previous[index]-1u,wasVisible);
  let threshold=params.x*params.y*select(1.0,0.88,wasVisible);
  let px=sceneryProjected(relative,extent,extent);
  if(px<threshold){previous[index]=0u;return -1;}
  if(group<2u){
    let arch=u32(clamp(floor(fract(instance.shape.y*17.31+f32(group)*0.5)*f32(${ROCK_ARCHETYPES})),0.0,f32(${ROCK_ARCHETYPES-1})));
    let h0=select(1.0,0.85,oldLod==0u);
    let h1=select(1.0,0.85,oldLod<=1u);
    var lod=2u;
    if(px>=threshold*9.5*h0){lod=0u;}
    else if(px>=threshold*3.4*h1){lod=1u;}
    previous[index]=lod+1u;
    return i32(lod*${ROCK_ARCHETYPES}u+arch);
  }
  let gVar=min(group-2u,${GRASS_VARIANTS-1}u);
  let gHold=select(1.0,0.85,oldLod==0u);
  let lod=select(1u,0u,px>=threshold*4.2*gHold);
  previous[index]=lod+1u;
  return i32(${ROCK_ARCHETYPES*3}u+lod*${GRASS_VARIANTS}u+gVar);
}
`);

// Two draws per tree, wood and canopy then leaves. The simplest model whose error stays under the
// pixel target wins. Mirrors selectTreeLods with treeProjectedError.
export const TREE_CULL = cullShell(2, /* wgsl */ `
const TREE_ERRORS=array<array<f32,3>,${TREE_VARIANTS}>(${TREE_GEOMETRY_ERRORS.map((row) => `array<f32,3>(${row.join(',')})`).join(',')});
const TREE_HYSTERESIS=${TREE_LOD.hysteresis};
fn scenerySelect(index:u32,group:u32,instance:SceneryInstance)->i32 {
  let width=instance.root.w;let height=instance.shape.x;
  let relative=instance.root.xyz+vec3f(0.0,height*0.5,0.0)-F.camPos.xyz;
  let radius=length(vec2f(width*1.41421356,height*0.5))+1.0;
  if(!sceneryInFrustum(relative,radius)){return -1;}
  // Stored one up, so a tree not yet seen counts as having had the finest model.
  let old=select(2u,previous[index]-1u,previous[index]>0u);
  var lod=2u;
  for(var tier=0u;tier<2u;tier++){
    let hold=select(1.0-TREE_HYSTERESIS,1.0+TREE_HYSTERESIS,old==tier);
    if(sceneryProjected(relative,radius,TREE_ERRORS[group][tier]*max(width,height)*1.2)<=params.x*hold){lod=tier;break;}
  }
  previous[index]=lod+1u;
  return i32(lod*${TREE_VARIANTS}u+group);
}
`);

// A city's buildings near the camera, each drawn as its Cairn type: one bucket to a type. Farther
// off the building's plain block stands in, and the land shader drops that block inside the same
// distance. A church's towers, a gate's chamber and a wall's merlons are blocks of their own, a
// little way from the building's root, so those types are shown that much farther and none is ever missing.
// params.x is that distance, the one the land shader is given; previous marks who was shown.
export const CITY_CULL = cullShell(1, /* wgsl */ `
fn scenerySelect(index:u32,group:u32,instance:SceneryInstance)->i32 {
  let house=group<${CITY_HOUSE_TYPES}u;
  let compound=(group>=${CITY_TYPE.CHURCH_LEFT}u&&group<=${CITY_TYPE.CHURCH_GREAT}u)||group==${CITY_TYPE.GATE}u||group==${CITY_TYPE.CURTAIN_SHORT}u||group==${CITY_TYPE.CURTAIN_LONG}u;
  let bridge=group==${CITY_TYPE.STONE_BRIDGE}u||group==${CITY_TYPE.FOOTBRIDGE}u;
  let worldRoot=instance.root.xyz+vec3f(params.z,0.0,params.w);
  let relative=worldRoot+vec3f(0.0,6.0,0.0)-F.camPos.xyz;
  let maxDist=select(params.x+select(36.0,52.0,compound),max(params.x+120.0,2800.0),bridge);
  let near=distance(worldRoot,F.camPos.xyz)<maxDist+select(0.0,10.0,previous[index]==1u);
  if(!near||!sceneryInFrustum(relative,select(select(42.0,18.0,house),36.0,bridge))){previous[index]=0u;return -1;}
  previous[index]=1u;
  return i32(group);
}
`);

// `bucketCapacities` is how many instances each bucket could ever show. `vertexCounts[part][bucket]`
// is what each bucket draws per instance, for each part.
export function createSceneryCull({ device, pipeline, frameUBO, label, capacity, bucketCapacities, vertexCounts }) {
  const parts = vertexCounts.length, buckets = bucketCapacities.length;
  const storage = (name, size, usage = 0) => device.createBuffer({ label: `${label} ${name}`, size: Math.max(16, size), usage: GPUBufferUsage.STORAGE | usage });
  const first = new Uint32Array(buckets);
  let total = 0;
  bucketCapacities.forEach((count, bucket) => { first[bucket] = total; total += count; });
  const instances = storage('instances', capacity * INSTANCE_BYTES, GPUBufferUsage.COPY_DST);
  const groups = storage('groups', capacity * 4, GPUBufferUsage.COPY_DST);
  const previous = storage('previous detail', capacity * 4);
  const shown = storage('shown', total * INSTANCE_BYTES, GPUBufferUsage.VERTEX);
  const firstBuffer = storage('bucket starts', first.byteLength, GPUBufferUsage.COPY_DST);
  device.queue.writeBuffer(firstBuffer, 0, first);
  // Instance counts start at zero each frame, and the cull counts them back up.
  const drawArguments = new Uint32Array(buckets * parts * DRAW_WORDS);
  for (let bucket = 0; bucket < buckets; bucket++) for (let part = 0; part < parts; part++) drawArguments[(bucket * parts + part) * DRAW_WORDS] = vertexCounts[part][bucket];
  const draws = storage('draws', drawArguments.byteLength, GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST);
  const params = device.createBuffer({ label: `${label} params`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const paramValues = new Float32Array(4);
  const emptied = new Uint32Array(capacity).fill(EMPTY_SLOT);
  device.queue.writeBuffer(groups, 0, emptied);
  const group = device.createBindGroup({ label: `${label} cull`, layout: pipeline.getBindGroupLayout(0), entries: [frameUBO, params, instances, groups, shown, draws, previous, firstBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  return {
    capacity,
    // First instance and each instance's bucket, for a run of slots coming into use.
    setInstances(slot, floats, slotGroups) {
      if (floats.length) device.queue.writeBuffer(instances, slot * INSTANCE_BYTES, floats);
      device.queue.writeBuffer(groups, slot * 4, slotGroups);
    },
    clearSlots(slot, count) { device.queue.writeBuffer(groups, slot * 4, emptied, 0, count); },
    setPixelError(pixelError, scale = 1) {
      paramValues[0] = pixelError; paramValues[1] = scale;
      device.queue.writeBuffer(params, 0, paramValues);
    },
    setWorldOffset(dx = 0, dz = 0) {
      paramValues[2] = dx; paramValues[3] = dz;
      device.queue.writeBuffer(params, 0, paramValues);
    },
    encode(pass) {
      device.queue.writeBuffer(draws, 0, drawArguments);
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(capacity / 64));
    },
    draw(pass, bucket, part, mesh) {
      if (!bucketCapacities[bucket] || !vertexCounts[part][bucket]) return;
      pass.setVertexBuffer(0, mesh); pass.setVertexBuffer(1, shown, first[bucket] * INSTANCE_BYTES, bucketCapacities[bucket] * INSTANCE_BYTES);
      pass.drawIndirect(draws, (bucket * parts + part) * DRAW_WORDS * 4);
    },
    destroy() { for (const buffer of [instances, groups, previous, shown, firstBuffer, draws, params]) buffer.destroy(); },
  };
}
