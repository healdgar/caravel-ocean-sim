// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The props' material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how port props, round shot
// and the crews' tools wear their surfaces. Their cut, their shadow, their atlas and their shards are the one cut's;
// this is only how a prop's surface is worn: its pigment, from a layer of one texture array by the UV its points carry
// (its atlas's UV stream) and each far-body triangle carries (its word), refined by the shared neural material bank
// (js/wgsl/neural-pbr.js), and lit as the ships are. It is seen under water too, through the water's own capture.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_SAMPLE } from './shadows.js';
import { createNeuralPbrWGSL } from './neural-pbr.js';
import { PROP_CONTINUUM_MATERIAL, PROP_CONTINUUM_PLAIN } from '../prop-continuum.js';

// The coarse pigment a far body reads, this many levels above the pigment's own one-texel mean (a 32-texel square of
// a 1024 one); a splat reads the mean itself.
const PROP_CONTINUUM_FAR_PIGMENT_LEVELS = 5;

// Group 0: the frame, a ship's hull (for its gun flashes), the sky's light, the pigments and the neural material
// bank. Group 1 is the land's shadow set; group 2 the scene's data.
const propContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + SHADOW_SAMPLE + SKY_RENDER_FUNCS + /* wgsl */`
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(11) var pigment:texture_2d_array<f32>;
@group(0) @binding(12) var pigmentSampler:sampler;
` + createNeuralPbrWGSL({ group: 0, latentBinding: 14, weightBinding: 15 });

const PROP_CONTINUUM_MATERIAL_WGSL = /* wgsl */`
const PROP_CONTINUUM_PLAIN:u32=${PROP_CONTINUUM_PLAIN}u;
// Its pigment's layer and the level a far body or splat reads it at; a plain type's albedo and roughness; its glow
// (its record's identity: 1 for hot iron).
fn propContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let levels=f32(textureNumLevels(pigment));
  (*v).uv=select(select(continuumUV(s.vertex),unpack2x16unorm(s.word),s.what==CONTINUUM_FAR_ENTRY),vec2f(0.5),s.what==CONTINUUM_SPLAT_ENTRY);
  (*v).surface=vec4u(continuumType(s.model,${PROP_CONTINUUM_MATERIAL.layer}u),u32(select(max(levels-1.0-${PROP_CONTINUUM_FAR_PIGMENT_LEVELS}.0,0.0),levels-1.0,s.what==CONTINUUM_SPLAT_ENTRY)),0u,0u);
  (*v).plain=vec4f(continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo + 1}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo + 2}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.roughness}u));
  (*v).glow=bitcast<f32>(s.record.spare.x);
}
// A surface's albedo: its pigment where its own clusters are drawn, a coarse level of it on a far body (whose every
// triangle carries the UV of the surface nearest it) and its one-texel mean on a splat; a plain type's own.
fn propContinuumAlbedo(v:ContinuumVarying)->vec3f {
  let layer=select(v.surface.x,0u,v.surface.x==PROP_CONTINUUM_PLAIN);
  let fine=textureSample(pigment,pigmentSampler,v.uv,layer).rgb;
  let coarse=textureSampleLevel(pigment,pigmentSampler,v.uv,layer,f32(v.surface.y)).rgb;
  return select(select(fine,coarse,v.coverage.x!=CONTINUUM_CLUSTER_ENTRY&&v.coverage.x!=CONTINUUM_SURFEL_ENTRY),v.plain.rgb,v.surface.x==PROP_CONTINUUM_PLAIN);
}
fn propContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  let plain=v.surface.x==PROP_CONTINUUM_PLAIN;
  let weathered=select(1.0,0.0,plain);
  let dx=dpdx(v.world);let dy=dpdy(v.world);
  let eye=continuumEye();
  // The far body is shaded flat, each face by its own plane: its corners' normals are the wrap's, rounded over edges.
  // Clusters are open shells, lit on whichever side is seen; a splat faces the eye whichever way it is wound.
  let plane=cross(dy,dx);
  let faceted=select(v.normal,normalize(plane)*select(-1.0,1.0,dot(plane,eye-v.world)>=0.0),dot(plane,plane)>1e-16);
  let shell=select(normalize(v.normal)*select(-1.0,1.0,front),normalize(v.normal),v.coverage.x==CONTINUUM_SPLAT_ENTRY);
  var n=select(shell,faceted,v.coverage.x==CONTINUUM_FAR_ENTRY);let sun=F.sunDir.xyz;
  var albedo=propContinuumAlbedo(v);
  let luma=dot(albedo,vec3f(0.2126,0.7152,0.0722));
  let sx=cross(dy,n);let sy=cross(n,dx);
  let det=dot(dx,sx);
  let uvFootprint=max(length(dpdx(v.uv)),length(dpdy(v.uv)));
  let bumpFilter=(1.0-smoothstep(0.015,0.08,uvFootprint))*weathered;
  let propBump=luma*0.0045*bumpFilter;
  let propGrad=(dpdx(propBump)*sx+dpdy(propBump)*sy)/max(abs(det),0.000001)*sign(det);
  n=normalize(n-clamp(propGrad,vec3f(-0.26),vec3f(0.26)));
  // The neural material bank: the surface's chromaticity and luminance read as timber, hemp or canvas, stone, or iron
  // hardware, sampled in the world along the face's own plane.
  let npbrHoriz=abs(n.y)>0.65;
  let npbrAlongX=abs(n.z)>=abs(n.x);
  let npbrUV=select(select(vec2f(v.world.z,v.world.y),vec2f(v.world.x,v.world.y),npbrAlongX),v.world.xz,npbrHoriz);
  let npbrDuDx=select(select(vec2f(dx.z,dx.y),vec2f(dx.x,dx.y),npbrAlongX),dx.xz,npbrHoriz);
  let npbrDuDy=select(select(vec2f(dy.z,dy.y),vec2f(dy.x,dy.y),npbrAlongX),dy.xz,npbrHoriz);
  let npbrHint=select(select(vec3f(0.0,0.0,1.0),vec3f(1.0,0.0,0.0),npbrAlongX),vec3f(1.0,0.0,0.0),npbrHoriz);
  let npbrWarmth=(albedo.r-albedo.b)/max(luma,0.04);
  var npbrMat=0u;
  if(luma<0.085&&abs(npbrWarmth)<0.22){npbrMat=8u;}
  else if(luma>0.42&&npbrWarmth<0.32){npbrMat=6u;}
  else if(abs(npbrWarmth)<0.16){npbrMat=3u;}
  let npbrBasis=neuralPbrTangentBasis(n,npbrHint);
  let npbr=evalNeuralPbr(npbrMat,npbrUV,npbrDuDx,npbrDuDy,distance(v.world,eye),0.94);
  albedo=clamp(albedo*npbr.albedoMul*npbr.cavityAO,vec3f(0.015),vec3f(0.96));
  n=applyNeuralPbrNormal(n,npbrBasis,npbr.normalTS);
  let shadowSample=vesselShadow(v.world,n);
  // Far, the sun and sky its optical moments say reach what is seen of the prop; near, all of them.
  let reach=continuumOpticLight(n,sun,v.optics);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample)*clamp(reach.x+reach.y,0.0,1.0);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS - 1}.0).rgb*reach.z;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS - 1}.0).rgb*reach.z;
  let view=normalize(eye-v.world);
  // Timber by the tide: cavity shade, the waterline darkened, edges worn pale where hawsers chafe. Iron in the air
  // wears none of it.
  let tidalWet=(1.0-smoothstep(0.05,1.45,v.world.y))*weathered;
  let curvature=clamp(length(fwidth(n))*0.42*bumpFilter,0.0,1.0);
  let cavityAO=mix(1.0,clamp(0.72+0.28*smoothstep(0.08,0.52,luma)-0.16*tidalWet,0.52,1.0),weathered);
  let edgeChafe=curvature*smoothstep(0.35,1.65,v.world.y)*0.12;
  let weatheredAlbedo=clamp(albedo*cavityAO+vec3f(0.11,0.09,0.07)*edgeChafe,vec3f(0.02),vec3f(0.95));
  let rough=clamp(clamp(select(0.90-luma*0.18-tidalWet*0.18+edgeChafe*0.10,v.plain.w,plain),0.44,0.92)+npbr.roughDelta,0.12,0.94);
  let f0=vec3f(.04);let spec=neuralPbrAnisoSpecular(n,npbrBasis,view,sun,rough,npbr.aniso,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS - 1}.0).rgb;
  let col=lunarSurface(n,view,weatheredAlbedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,weatheredAlbedo,rough)+gunFlashSurface(v.world,n,view,weatheredAlbedo,rough)+worldFireSurface(v.world,n,view,weatheredAlbedo,rough)
    +weatheredAlbedo*(direct*max(dot(n,sun),0.0)/PI+vesselAmbient(n,sky,sea))+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  // Hot shot glows from within, brightest where its face turns to the eye.
  let core=clamp(dot(n,view),0.0,1.0);
  let hot=mix(vec3f(1.6,0.25,0.025),vec3f(3.8,0.95,0.12),core*core)*min(1.0,1.35/max(F.post.x,1e-3));
  return vec4f(continuumAir(select(col,hot,v.glow>0.5),v.world),1.0);
}
`;

// Octahedral G-buffer card bake hook (js/continuum-cards.js): bakes pure unlit prop pigment/plain albedo and local normal.
const PROP_CONTINUUM_CARD_BAKE = Object.freeze({
  prelude: () => /* wgsl */`
@group(0) @binding(0) var propCardPigment:texture_2d_array<f32>;
@group(0) @binding(1) var propCardSampler:sampler;
`,
  varyings: [['uv', 'vec2f'], ['surface', 'vec4u', true], ['plain', 'vec4f', true]],
  wgsl: () => /* wgsl */`
const PROP_CARD_PLAIN:u32=${PROP_CONTINUUM_PLAIN}u;
fn propContinuumCardBakeVarying(s:ContinuumSurface,v:ptr<function,ContinuumCardBakeVarying>) {
  (*v).uv=continuumUV(s.vertex);
  (*v).surface=vec4u(continuumType(s.model,${PROP_CONTINUUM_MATERIAL.layer}u),0u,0u,0u);
  (*v).plain=vec4f(continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo + 1}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.albedo + 2}u),continuumTypeF(s.model,${PROP_CONTINUUM_MATERIAL.roughness}u));
}
fn propContinuumCardBake(v:ContinuumCardBakeVarying,front:bool)->ContinuumCardSample {
  let isPlain=v.surface.x==PROP_CARD_PLAIN;
  let layer=select(v.surface.x,0u,isPlain);
  let sampled=textureSample(propCardPigment,propCardSampler,v.uv,layer).rgb;
  let rawAlbedo=select(sampled,v.plain.rgb,isPlain);
  let luma=dot(rawAlbedo,vec3f(0.2126,0.7152,0.0722));
  let cavityAO=select(clamp(0.72+0.28*smoothstep(0.08,0.52,luma),0.58,1.0),1.0,isPlain);
  let albedo=clamp(rawAlbedo*cavityAO,vec3f(0.02),vec3f(0.95));
  let n=normalize(v.normal+vec3f(0.0,1e-6,0.0))*select(-1.0,1.0,front);
  return ContinuumCardSample(albedo,1.0,n,0.0);
}
`,
});

// The props' material (js/wgsl/continuum-cut.js).
export const PROP_CONTINUUM_MATERIAL_SPEC = Object.freeze({
  name: 'propContinuum', prelude: propContinuumPreludeWGSL, core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['uv', 'vec2f'], ['surface', 'vec4u', true], ['plain', 'vec4f', true], ['glow', 'f32', true]],
  wgsl: () => PROP_CONTINUUM_MATERIAL_WGSL, salt: 3,
  // Planks and cleats are open shells, lit from whichever side is seen.
  cullMode: 'none', air: true, capture: true, visibility: true,
  cardBake: PROP_CONTINUUM_CARD_BAKE,
});
