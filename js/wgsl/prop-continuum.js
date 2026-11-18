// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How the continuum draws port props and round shot (js/prop-continuum.js for the atlas, js/prop-continuum-draw.js for
// a scene). Their cut, their shadow and how their atlas and shards are read are the one cut's (js/wgsl/city-continuum.js);
// this is only how a prop's surface is worn: its pigment, from a layer of one texture array by the UV each point and
// far-body triangle carries, lit as the ships are.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_SAMPLE } from './shadows.js';
import { CONTINUUM_CORE_WGSL } from '../continuum-core.js';
import {
  cityContinuumCommonWGSL, cityContinuumData, CITY_CONTINUUM_TOUCH, CITY_CONTINUUM_SPLAT,
  CITY_CONTINUUM_CLUSTER_ENTRY, CITY_CONTINUUM_FAR_ENTRY, CITY_CONTINUUM_SPLAT_ENTRY,
} from './city-continuum.js';
import { PROP_CONTINUUM_TYPE, PROP_CONTINUUM_PLAIN } from '../prop-continuum.js';

// The coarse pigment a far body reads, this many levels above the pigment's own one-texel mean (a 32-texel square of
// a 1024 one); a splat reads the mean itself.
const PROP_CONTINUUM_FAR_PIGMENT_LEVELS = 5;

const PROP_CONTINUUM_RENDER = /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(11) var pigment:texture_2d_array<f32>;
@group(0) @binding(12) var pigmentSampler:sampler;
const PROP_CONTINUUM_HIDDEN=vec4f(2.0,2.0,0.0,1.0);
const PROP_CONTINUUM_PLAIN:u32=${PROP_CONTINUUM_PLAIN}u;
struct PropContinuumVertex {
  @builtin(position) position:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) uv:vec2f,
  @location(3) @interpolate(flat) coverage:vec4u, // x the draw (1 clusters, 2 far body, 3 splat), y handoff | splat << 8, z the instance, w samples
  @location(4) @interpolate(flat) surface:vec4u,  // x its pigment's layer (PROP_CONTINUUM_PLAIN for none), y the level a far body or splat reads it at
  @location(5) @interpolate(flat) plain:vec4f,    // a plain type's albedo and roughness
  @location(6) @interpolate(flat) glow:f32,       // 1 for hot iron
};
struct PropContinuumCoverage { @location(0) colour:vec4f, @builtin(sample_mask) mask:u32 };
fn propContinuumHidden()->PropContinuumVertex { var out:PropContinuumVertex;out.position=PROP_CONTINUUM_HIDDEN;return out; }
fn propContinuumClip(world:vec3f)->vec4f { return F.viewProj*vec4f(earthCurve(world-F.camPos.xyz,F.camPos.y),1.0); }
// One vertex of an entry. Coarse: an entry of the shadow map's lists, its far body at the step its shadow takes,
// unmorphed (the under-water capture draws those, as the sea blurs anything finer).
fn propContinuumVertex(vertex:u32,listed:CityContinuumEntry,coarse:bool)->PropContinuumVertex {
  let touched=cityContinuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var state=cityContinuumState(instance);
  if(coarse){state.y=state.y>>16u;state.z=0u;state.x=0u;}
  let place=cityContinuumPlaceOf(instance);
  let archetype=cityContinuumTypeOf(instance);
  let levels=f32(textureNumLevels(pigment));
  var out:PropContinuumVertex;
  if(what==${CITY_CONTINUUM_SPLAT_ENTRY}u){
    let splat=cityContinuumSplatCorner(archetype,place,F.camPos.xyz,vertex,bitcast<f32>(state.w));
    out.world=splat.world;out.normal=splat.toward;out.uv=vec2f(0.5);
  }else{
    // A prop's point and far-body triangle carry their UV where a building's carry its kind.
    var point:CityContinuumFar;
    if(what==${CITY_CONTINUUM_CLUSTER_ENTRY}u){point=cityContinuumClusterPoint(instance,item,vertex);}
    else{point=cityContinuumFarCorner(archetype,item,vertex,state.y&65535u,bitcast<f32>(state.z));}
    if(!point.shown){return propContinuumHidden();}
    out.world=cityContinuumPlace(point.position,place);
    out.normal=cityContinuumTurn(point.normal,place);
    out.uv=unpack2x16unorm(point.surface);
  }
  out.world+=vec3f(touched);
  out.position=propContinuumClip(out.world);
  out.coverage=vec4u(what,state.x&65535u,instance,cityView.counts.y);
  let layer=cityContinuumType(archetype,${PROP_CONTINUUM_TYPE.layer}u);
  out.surface=vec4u(layer,u32(select(max(levels-1.0-${PROP_CONTINUUM_FAR_PIGMENT_LEVELS}.0,0.0),levels-1.0,what==${CITY_CONTINUUM_SPLAT_ENTRY}u)),0u,0u);
  out.plain=vec4f(cityContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo}u),cityContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo + 1}u),cityContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.albedo + 2}u),cityContinuumTypeF(archetype,${PROP_CONTINUUM_TYPE.roughness}u));
  out.glow=place.shape.w;
  return out;
}
@vertex fn propContinuumVS(@builtin(vertex_index) vertex:u32,listed:CityContinuumEntry)->PropContinuumVertex { return propContinuumVertex(vertex,listed,false); }
@vertex fn propContinuumSubmergedVS(@builtin(vertex_index) vertex:u32,listed:CityContinuumEntry)->PropContinuumVertex { return propContinuumVertex(vertex,listed,true); }
// A surface's albedo: its pigment where its own clusters are drawn, a coarse level of it on a far body (whose every
// triangle carries the UV of the surface nearest it) and its one-texel mean on a splat; a plain type's own.
fn propContinuumAlbedo(v:PropContinuumVertex)->vec3f {
  let layer=select(v.surface.x,0u,v.surface.x==PROP_CONTINUUM_PLAIN);
  let fine=textureSample(pigment,pigmentSampler,v.uv,layer).rgb;
  let coarse=textureSampleLevel(pigment,pigmentSampler,v.uv,layer,f32(v.surface.y)).rgb;
  return select(select(fine,coarse,v.coverage.x!=${CITY_CONTINUUM_CLUSTER_ENTRY}u),v.plain.rgb,v.surface.x==PROP_CONTINUUM_PLAIN);
}
fn propContinuumShade(v:PropContinuumVertex,front:bool)->vec3f {
  let plain=v.surface.x==PROP_CONTINUUM_PLAIN;
  let weathered=select(1.0,0.0,plain);
  let dx=dpdx(v.world);let dy=dpdy(v.world);
  // The far body is shaded flat, each face by its own plane: its corners' normals are the wrap's, rounded over edges.
  // Clusters are open shells, lit on whichever side is seen; a splat faces the eye whichever way it is wound.
  let plane=cross(dy,dx);
  let faceted=select(v.normal,normalize(plane)*select(-1.0,1.0,dot(plane,F.camPos.xyz-v.world)>=0.0),dot(plane,plane)>1e-16);
  let shell=select(normalize(v.normal)*select(-1.0,1.0,front),normalize(v.normal),v.coverage.x==${CITY_CONTINUUM_SPLAT_ENTRY}u);
  var n=select(shell,faceted,v.coverage.x==${CITY_CONTINUUM_FAR_ENTRY}u);let sun=F.sunDir.xyz;
  let albedo=propContinuumAlbedo(v);
  let luma=dot(albedo,vec3f(0.2126,0.7152,0.0722));
  let sx=cross(dy,n);let sy=cross(n,dx);
  let det=dot(dx,sx);
  let uvFootprint=max(length(dpdx(v.uv)),length(dpdy(v.uv)));
  let bumpFilter=(1.0-smoothstep(0.015,0.08,uvFootprint))*weathered;
  let propBump=luma*0.0045*bumpFilter;
  let propGrad=(dpdx(propBump)*sx+dpdy(propBump)*sy)/max(abs(det),0.000001)*sign(det);
  n=normalize(n-clamp(propGrad,vec3f(-0.26),vec3f(0.26)));
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS - 1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS - 1}.0).rgb;
  let view=normalize(F.camPos.xyz-v.world);
  // Timber by the tide: cavity shade, the waterline darkened, edges worn pale where hawsers chafe. Iron in the air
  // wears none of it.
  let tidalWet=(1.0-smoothstep(0.05,1.45,v.world.y))*weathered;
  let curvature=clamp(length(fwidth(n))*0.42*bumpFilter,0.0,1.0);
  let cavityAO=mix(1.0,clamp(0.72+0.28*smoothstep(0.08,0.52,luma)-0.16*tidalWet,0.52,1.0),weathered);
  let edgeChafe=curvature*smoothstep(0.35,1.65,v.world.y)*0.12;
  let weatheredAlbedo=clamp(albedo*cavityAO+vec3f(0.11,0.09,0.07)*edgeChafe,vec3f(0.02),vec3f(0.95));
  let rough=clamp(select(0.90-luma*0.18-tidalWet*0.18+edgeChafe*0.10,v.plain.w,plain),0.44,0.92);let f0=vec3f(.04);let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS - 1}.0).rgb;
  let col=lunarSurface(n,view,weatheredAlbedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,weatheredAlbedo,rough)+gunFlashSurface(v.world,n,view,weatheredAlbedo,rough)+worldFireSurface(v.world,n,view,weatheredAlbedo,rough)
    +weatheredAlbedo*(direct*max(dot(n,sun),0.0)/PI+vesselAmbient(n,sky,sea))+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  // Hot shot glows from within, brightest where its face turns to the eye.
  let core=clamp(dot(n,view),0.0,1.0);
  let hot=mix(vec3f(1.6,0.25,0.025),vec3f(3.8,0.95,0.12),core*core)*min(1.0,1.35/max(F.post.x,1e-3));
  return surfaceAir(select(col,hot,v.glow>0.5),v.world);
}
@fragment fn propContinuumFS(v:PropContinuumVertex,@builtin(front_facing) front:bool)->PropContinuumCoverage {
  var out:PropContinuumCoverage;
  out.colour=vec4f(propContinuumShade(v,front),1.0);
  out.mask=cityContinuumMask(v.coverage,v.position.xy,3u);
  return out;
}
// Under water, single-sampled, the water's own capture wrapping it (js/water-optics.js).
@fragment fn propContinuumSubmergedFS(v:PropContinuumVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  return vec4f(propContinuumShade(v,front),1.0);
}
`;

// The view's module: lit as the ships are, with the land's shadow map (group 1), the one cut's data group 2.
export function propContinuumRenderWGSL() {
  return FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + SHADOW_SAMPLE + SKY_RENDER_FUNCS + CONTINUUM_CORE_WGSL + cityContinuumCommonWGSL()
    + cityContinuumData(2, 0, 'read') + CITY_CONTINUUM_TOUCH + CITY_CONTINUUM_SPLAT + PROP_CONTINUUM_RENDER;
}
