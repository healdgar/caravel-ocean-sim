// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Relightable depth-aware octahedral G-buffer cards in the One Continuum (AGENTS.md rule 3).
// Lives once here and in js/continuum-cards.js; every family (forest, city, ships) shares this single card pipeline,
// cell-isolated mipmap chain, biased hemi-octahedral projection, 1-step depth parallax reprojection, exact 3D
// frag_depth intersection, and zero-discard MSAA @builtin(sample_mask) handoff.
import { TERRAIN_FINISH_ONLY } from './terrain.js';
import { CONTINUUM_TYPE } from '../continuum-format.js';
import { continuumKindsWGSL } from './continuum-kinds.js';
import { continuumDataWGSL, continuumCommonWGSL, continuumTouchWGSL, continuumMaterialWGSL, CONTINUUM_SPLAT, CONTINUUM_SINGLE_PAGE } from './continuum-cut.js';

export const CONTINUUM_CARD_GRID = 6;
export const CONTINUUM_CARD_VIEWS = CONTINUUM_CARD_GRID * CONTINUUM_CARD_GRID;
export const CONTINUUM_CARD_ELEV_BIAS = -0.22;
export const CONTINUUM_CARD_PAD = 1.03;

export const CONTINUUM_CARD_TINT_NONE = 0;
export const CONTINUUM_CARD_TINT_FOREST = 1;
export const CONTINUUM_CARD_TINT_CITY = 2;
export const CONTINUUM_CARD_TINT_VESSEL = 3;

// Exact JS mirror of WGSL continuumCardDirFromUV for baking view directions on the biased hemi-octahedral grid.
export function continuumCardDirJS(ix, iy, grid = CONTINUUM_CARD_GRID, bias = CONTINUUM_CARD_ELEV_BIAS) {
  const u = grid > 1 ? ix / (grid - 1) : 0.5;
  const v = grid > 1 ? iy / (grid - 1) : 0.5;
  const ox = u * 2 - 1, oy = v * 2 - 1;
  const x = 0.5 * (ox + oy), z = 0.5 * (ox - oy);
  const yHemi = Math.max(0, 1 - Math.abs(x) - Math.abs(z));
  const b = bias;
  const y = yHemi * (1 - b) + b;
  const h2 = Math.max(0, 1 - y * y);
  const r = Math.hypot(x, z);
  const s = r > 1e-6 ? Math.sqrt(h2) / r : 0;
  const dx = x * s, dz = z * s;
  const len = Math.hypot(dx, y, dz) || 1;
  return [dx / len, y / len, dz / len];
}

// Exact JS mirror of WGSL continuumCardBasis(dir) -> { right, up }.
export function continuumCardBasisJS(dir) {
  const [dx, dy, dz] = dir;
  const ref = Math.abs(dy) > 0.999 ? [0, 0, -1] : [0, 1, 0];
  let rx = ref[1] * dz - ref[2] * dy;
  let ry = ref[2] * dx - ref[0] * dz;
  let rz = ref[0] * dy - ref[1] * dx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = dy * rz - dz * ry;
  const uy = dz * rx - dx * rz;
  const uz = dx * ry - dy * rx;
  return { right: [rx, ry, rz], up: [ux, uy, uz] };
}

// Analytic bijective biased hemi-octahedral projection covering elevation [-12.7 deg .. +90 deg] with zero pinching.
export const CONTINUUM_CARD_OCT_WGSL = /* wgsl */`
const CONTINUUM_CARD_ELEV_BIAS:f32=${CONTINUUM_CARD_ELEV_BIAS.toFixed(4)};
const CONTINUUM_CARD_PAD:f32=${CONTINUUM_CARD_PAD.toFixed(4)};
// The grid's views run from the zenith down to the elevation whose sine is 'bias'.
fn continuumCardDirBiased(uv:vec2f,bias:f32)->vec3f {
  let o=uv*2.0-1.0;
  let x=0.5*(o.x+o.y);
  let z=0.5*(o.x-o.y);
  let yHemi=max(1.0-abs(x)-abs(z),0.0);
  let y=yHemi*(1.0-bias)+bias;
  let h2=max(1.0-y*y,0.0);
  let r=length(vec2f(x,z));
  let h=select(vec2f(0.0),vec2f(x,z)*(sqrt(h2)/r),r>1e-6);
  return normalize(vec3f(h.x,y,h.y));
}
fn continuumCardUVBiased(dir:vec3f,bias:f32)->vec2f {
  let y=clamp(dir.y,bias,1.0);
  let yHemi=(y-bias)/(1.0-bias);
  let l1=max(1.0-yHemi,0.0);
  let s=abs(dir.x)+abs(dir.z);
  let x=select(0.0,dir.x*(l1/s),s>1e-6);
  let z=select(0.0,dir.z*(l1/s),s>1e-6);
  let o=vec2f(x+z,x-z);
  return clamp(o*0.5+0.5,vec2f(0.0),vec2f(1.0));
}
fn continuumCardDirFromUV(uv:vec2f)->vec3f { return continuumCardDirBiased(uv,CONTINUUM_CARD_ELEV_BIAS); }
fn continuumCardUVFromDir(dir:vec3f)->vec2f { return continuumCardUVBiased(dir,CONTINUUM_CARD_ELEV_BIAS); }
fn continuumCardBasis(dir:vec3f)->mat2x3<f32> {
  let refUp=select(vec3f(0.0,1.0,0.0),vec3f(0.0,0.0,-1.0),abs(dir.y)>0.999);
  let right=normalize(cross(refUp,dir));
  let up=cross(dir,right);
  return mat2x3<f32>(right,up);
}
`;

// Packs a 4x MSAA resolved rgba16float G-buffer pair (albedoPremul, geoPremul) into rgba8unorm mip 0 with 5x5
// cell-isolated edge dilation so silhouette filtering never pulls dark background color, normal, or depth.
export const CONTINUUM_CARD_DILATE_WGSL = /* wgsl */`
@group(0) @binding(0) var cardBakeAlbedoIn:texture_2d<f32>;
@group(0) @binding(1) var cardBakeGeoIn:texture_2d<f32>;
@group(0) @binding(2) var cardAlbedoOut:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(3) var cardGeoOut:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(4) var<uniform> cardPackParams:vec4u; // x=cellSize (a cell's width | its height << 16 where it is not square), y=gridSize, z=dstOffsetX, w=dstOffsetY
@compute @workgroup_size(8,8) fn continuumCardPackDilate(@builtin(global_invocation_id) id:vec3u) {
  let srcDim=textureDimensions(cardBakeAlbedoIn);
  if(any(id.xy>=srcDim)){return;}
  let p=vec2i(id.xy);
  let dst=p+vec2i(i32(cardPackParams.z),i32(cardPackParams.w));
  let cellWide=i32(cardPackParams.x&65535u);
  let cell=vec2i(cellWide,select(cellWide,i32(cardPackParams.x>>16u),(cardPackParams.x>>16u)!=0u));
  let cellMin=(p/cell)*cell;
  let cellMax=cellMin+cell-vec2i(1);
  let a=textureLoad(cardBakeAlbedoIn,p,0);
  let g=textureLoad(cardBakeGeoIn,p,0);
  var rgb=vec3f(0.0);
  var nxy=vec2f(0.0);
  var depth=0.5;
  var flag=0.0;
  let cov=clamp(a.a,0.0,1.0);
  if(cov>0.01){
    let inv=1.0/cov;
    rgb=clamp(a.rgb*inv,vec3f(0.0),vec3f(1.0));
    nxy=clamp(g.rg*inv,vec2f(-1.0),vec2f(1.0));
    depth=clamp(g.b*inv,0.0,1.0);
    flag=clamp(g.a*inv,0.0,1.0);
  }else{
    var wSum=0.0;
    var rSum=vec3f(0.0);
    var nSum=vec2f(0.0);
    var dSum=0.0;
    var fSum=0.0;
    for(var dy=-2;dy<=2;dy++){
      for(var dx=-2;dx<=2;dx++){
        if(dx==0&&dy==0){continue;}
        let q=clamp(p+vec2i(dx,dy),cellMin,cellMax);
        let qa=textureLoad(cardBakeAlbedoIn,q,0);
        if(qa.a>0.01){
          let qg=textureLoad(cardBakeGeoIn,q,0);
          let qInv=1.0/qa.a;
          let w=qa.a/f32(dx*dx+dy*dy);
          rSum+=clamp(qa.rgb*qInv,vec3f(0.0),vec3f(1.0))*w;
          nSum+=clamp(qg.rg*qInv,vec2f(-1.0),vec2f(1.0))*w;
          dSum+=clamp(qg.b*qInv,0.0,1.0)*w;
          fSum+=clamp(qg.a*qInv,0.0,1.0)*w;
          wSum+=w;
        }
      }
    }
    if(wSum>0.0){
      let invW=1.0/wSum;
      rgb=rSum*invW;nxy=nSum*invW;depth=dSum*invW;flag=fSum*invW;
    }
  }
  textureStore(cardAlbedoOut,dst,vec4f(sqrt(clamp(rgb,vec3f(0.0),vec3f(1.0))),cov));
  textureStore(cardGeoOut,dst,vec4f(nxy*0.5+0.5,depth,flag));
}
`;

// Coverage-weighted linear-space 2x2 downsample. Because cellSize is a power of two (32 or 64), every 2x2 block lies
// strictly inside a single octahedral cell at every mip level down to 1x1 per cell — zero cross-view bleeding.
export const CONTINUUM_CARD_MIP_WGSL = /* wgsl */`
@group(0) @binding(0) var cardMipAlbedoIn:texture_2d<f32>;
@group(0) @binding(1) var cardMipGeoIn:texture_2d<f32>;
@group(0) @binding(2) var cardMipAlbedoOut:texture_storage_2d<rgba8unorm,write>;
@group(0) @binding(3) var cardMipGeoOut:texture_storage_2d<rgba8unorm,write>;
@compute @workgroup_size(8,8) fn continuumCardMip(@builtin(global_invocation_id) id:vec3u) {
  let dim=textureDimensions(cardMipAlbedoOut);
  if(any(id.xy>=dim)){return;}
  let srcMax=vec2i(textureDimensions(cardMipAlbedoIn))-vec2i(1);
  let base=vec2i(id.xy)*2;
  var covSum=0.0;
  var wSum=0.0;
  var rgbSum=vec3f(0.0);
  var nxySum=vec2f(0.0);
  var dSum=0.0;
  var fSum=0.0;
  var rawRgb=vec3f(0.0);
  var rawNxy=vec2f(0.0);
  var rawD=0.0;
  var rawF=0.0;
  for(var dy=0;dy<2;dy++){
    for(var dx=0;dx<2;dx++){
      let q=min(base+vec2i(dx,dy),srcMax);
      let a=textureLoad(cardMipAlbedoIn,q,0);
      let g=textureLoad(cardMipGeoIn,q,0);
      let lin=a.rgb*a.rgb;
      let nxy=g.rg*2.0-1.0;
      covSum+=a.a;
      rawRgb+=lin;rawNxy+=nxy;rawD+=g.b;rawF+=g.a;
      if(a.a>0.01){
        rgbSum+=lin*a.a;nxySum+=nxy*a.a;dSum+=g.b*a.a;fSum+=g.a*a.a;wSum+=a.a;
      }
    }
  }
  let cov=clamp(covSum*0.25,0.0,1.0);
  let rgb=select(rawRgb*0.25,rgbSum/max(wSum,1e-4),wSum>0.01);
  let nxy=clamp(select(rawNxy*0.25,nxySum/max(wSum,1e-4),wSum>0.01),vec2f(-1.0),vec2f(1.0));
  let depth=clamp(select(rawD*0.25,dSum/max(wSum,1e-4),wSum>0.01),0.0,1.0);
  let flag=clamp(select(rawF*0.25,fSum/max(wSum,1e-4),wSum>0.01),0.0,1.0);
  textureStore(cardMipAlbedoOut,vec2i(id.xy),vec4f(sqrt(clamp(rgb,vec3f(0.0),vec3f(1.0))),cov));
  textureStore(cardMipGeoOut,vec2i(id.xy),vec4f(nxy*0.5+0.5,depth,flag));
}
`;

// The ONE shared relightable octahedral G-buffer card pipeline for list 3 (CONTINUUM_SPLAT_ENTRY).
// Group 0: TERRAIN_FINISH_ONLY; Group 1: CLOUD_SHADOW_BINDINGS; Group 2: continuumData; Group 3: card atlas + params.
export function continuumCardViewWGSL(paging = CONTINUUM_SINGLE_PAGE) {
  const sphereAt = CONTINUUM_TYPE.sphere;
  return TERRAIN_FINISH_ONLY + continuumDataWGSL(2, 0, 'read', paging) + continuumCommonWGSL(paging) + continuumKindsWGSL()
    + continuumTouchWGSL(paging) + CONTINUUM_SPLAT + CONTINUUM_CARD_OCT_WGSL + /* wgsl */`
@group(3) @binding(0) var cardAlbedoTex:texture_2d_array<f32>;
@group(3) @binding(1) var cardGeoTex:texture_2d_array<f32>;
@group(3) @binding(2) var cardSampler:sampler;
@group(3) @binding(3) var<storage,read> cardLayers:array<u32>;
@group(3) @binding(4) var<uniform> cardParams:vec4u; // x=gridSize|(tilesPerSide<<16), y=cellSize, z=tintMode, w=salt
@group(3) @binding(5) var<storage,read> cardSpheres:array<vec4f>;

struct ContinuumCardVarying {
  @builtin(position) position:vec4f,
  @location(0) worldOnPlane:vec3f,
  @location(1) corner:vec2f,
  @location(2) @interpolate(flat) centreRadius:vec4f,
  @location(3) @interpolate(flat) turn:vec4f,
  @location(4) @interpolate(flat) viewDirLocal:vec3f,
  @location(5) @interpolate(flat) cardRightLocal:vec3f,
  @location(6) @interpolate(flat) cardUpLocal:vec3f,
  @location(7) @interpolate(flat) coverage:vec4u,
  @location(8) @interpolate(flat) info:vec4u, // layer, model, spareX, 0
  @location(9) @interpolate(flat) place:vec3f
};

struct ContinuumCardOut {
  @location(0) colour:vec4f,
  @builtin(sample_mask) mask:u32
};

fn continuumCardCityWash(tint:f32)->vec3f {
  let idx=floor(tint);
  var wash=vec3f(0.98,0.98,0.96);
  if(idx>9.5){wash=vec3f(0.085,0.075,0.068);}
  else if(idx>8.5){wash=vec3f(0.24,0.165,0.105);}
  else if(idx>7.5){wash=vec3f(0.095,0.185,0.045);}
  else if(idx>6.5){wash=vec3f(0.48,0.36,0.14);}
  else if(idx>5.5){wash=vec3f(0.060,0.135,0.300);}
  else if(idx>4.5){wash=vec3f(0.38,0.085,0.055);}
  else if(idx>3.5){wash=vec3f(0.80,0.79,0.76);}
  else if(idx>2.5){wash=vec3f(0.90,0.83,0.80);}
  else if(idx>1.5){wash=vec3f(0.91,0.86,0.77);}
  else if(idx>0.5){wash=vec3f(0.95,0.93,0.88);}
  return wash*(0.72+0.28*fract(tint));
}

fn continuumCardClipPulled(world:vec3f,pull:f32)->vec4f {
  let relative=world+continuumShift()-F.camPos.xyz;
  return F.viewProj*vec4f(earthCurve(relative*max(1.0-pull/max(length(relative),1e-3),0.05),F.camPos.y),1.0);
}

// Lean physical card finish matching landFinishShadowed without wasted GGX/env-reflection/moon/shadow taps on distant matte cards.
fn continuumCardFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,roughness:f32,shadowVis:vec3f)->vec4f {
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let edgeDist=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let isPrimary=select(0.0,1.0,LAND.domain.w>0.05);
  let inPrimaryDomain=isPrimary*smoothstep(0.0,0.08,edgeDist);
  var bakedLight=vec3f(1.0,1.0,0.0);
  if(inPrimaryDomain>0.001){
    bakedLight=textureSampleLevel(landLight,sampC,clamp(uv,vec2f(0.0),vec2f(1.0)),0.0).rgb;
  }
  let cloudSun=solarShadowVisibility(vec3f(cloudShadowAt(world*0.001,F.sunDir.xyz))).x;
  let sunlight=mix(1.0,bakedLight.r,inPrimaryDomain)*cloudSun;
  let valleyAO=clamp(1.0+bakedLight.b*inPrimaryDomain*0.48,0.70,1.14);
  let effAmbVis=ambientVisibility*valleyAO;
  let direct=sunIlluminance()*sunlight*solarShadowVisibility(shadowVis);
  let skyDir=normalize(vec3f(n.x*0.65,max(n.y,0.12),n.z*0.65));
  let skyIrr=textureSampleLevel(envCube,sampC,skyDir,6.0).rgb;
  let hemiMix=clamp(n.y*0.5+0.5,0.0,1.0);
  let ambient=skyIrr*mix(vec3f(0.48,0.44,0.38),vec3f(1.0),hemiMix);
  let archShadow=smoothstep(0.14,0.58,effAmbVis);
  let sunGroundBounce=direct*max(F.sunDir.y,0.0)*(1.0-max(n.y,0.0))*0.068*vec3f(0.84,0.74,0.58)*effAmbVis;
  let diffuseTerm=direct*diffuse*(0.30+0.70*archShadow)/PI+ambient*effAmbVis+sunGroundBounce;
  var col=albedo*diffuseTerm;
  if(F.sunDir.y<=0.05){
    let v=normalize(F.camPos.xyz-world);
    let cloudMoon=lunarShadowVisibility(vec3f(cloudShadowAt(world*0.001,lunarDirection()))).x;
    col+=lunarSurface(n,v,albedo,roughness,vec3f(0.04),vec3f(mix(1.0,bakedLight.g,inPrimaryDomain)*cloudMoon)*lunarShadowVisibility(shadowVis));
  }
  col=surfaceAir(col,world);
  let cloudBaseM=CF.shape.x*1000.0;
  let mountainVeil=smoothstep(max(320.0,cloudBaseM-260.0),max(580.0,cloudBaseM+320.0),world.y)*step(0.5,CF.screen.w);
  if(mountainVeil>0.001){
    let mSh=textureSampleLevel(cloudShadowMap,cloudShadowSampler,(world.xz*0.001+CF.advection.xy)/16.0+0.5,0.0).rg;
    let veilAlpha=clamp(1.0-mSh.r,0.0,0.82)*mountainVeil;
    let veilCol=skyAtmo(vec3f(0,1,0))*0.45+sunIlluminance()*0.20*mSh.r;
    return vec4f(mix(col,veilCol,veilAlpha),1.0);
  }
  return vec4f(col,1.0);
}

@vertex fn continuumCardVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumCardVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;
  let what=listed.entry.y>>28u;
  var out:ContinuumCardVarying;
  if(what!=CONTINUUM_SPLAT_ENTRY){out.position=CONTINUUM_HIDDEN;return out;}
  let state=continuumState(instance);
  let thinned=unpack2x16float(state.w).x;
  if(thinned<=0.0){out.position=CONTINUUM_HIDDEN;return out;}
  let record=continuumRecords[instance];
  let model=continuumTypeOf(record);
  let lift=continuumLift(state,false);
  let rawSphere=vec4f(continuumTypeF(model,${sphereAt}u),continuumTypeF(model,${sphereAt + 1}u),continuumTypeF(model,${sphereAt + 2}u),continuumTypeF(model,${sphereAt + 3}u));
  let cardSp=select(rawSphere,cardSpheres[model],model<arrayLength(&cardSpheres)&&cardSpheres[model].w>0.0);
  let bound=continuumSphere(record,CONTINUUM_WHOLE,cardSp);
  if(bound.w<=0.0){out.position=CONTINUUM_HIDDEN;return out;}
  let scale=continuumScale(record);
  // The card's picture is baked of the body at rest and framed to its rest sphere, so the card is that size. The
  // kind's bound is where the body may go (a tree's bones swaying, a pose's slack), not how big it is: sized by it, a
  // tree is drawn the larger the harder the wind blows.
  let baseR=cardSp.w*scale*CONTINUUM_CARD_PAD;
  let centre=continuumPlace(record,bound.xyz)+lift;
  let toEyeVec=(F.camPos.xyz-continuumShift())-centre;
  let dist=max(length(toEyeVec),1e-3);
  let toEye=toEyeVec/dist;
  let invTurn=vec4f(-record.turn.xyz,record.turn.w);
  let viewDirLocal=normalize(continuumQuat(invTurn,toEye));
  let basis=continuumCardBasis(viewDirLocal);
  let rightW=normalize(continuumQuat(record.turn,basis[0]));
  let upW=normalize(continuumQuat(record.turn,basis[1]));
  let perspBoost=clamp(dist/max(dist-baseR,0.25*baseR),1.0,1.18);
  let triR=baseR*thinned*perspBoost;
  let triCorner=array<vec2f,3>(vec2f(0.0,2.0),vec2f(-1.7320508,-1.0),vec2f(1.7320508,-1.0))[min(vertex,2u)];
  let worldOnPlane=centre+rightW*(triCorner.x*triR)+upW*(triCorner.y*triR)+vec3f(touched);
  let layer=select(0xffffffffu,cardLayers[model],model<arrayLength(&cardLayers));
  // Analytic front-pulled depth without frag_depth preserves full GPU Early-Z rejection while tight framing prevents plinth overhang.
  out.position=continuumCardClipPulled(worldOnPlane,baseR*0.14);
  out.worldOnPlane=worldOnPlane;
  out.corner=triCorner*perspBoost;
  out.centreRadius=vec4f(centre,baseR);
  out.turn=record.turn;
  out.viewDirLocal=viewDirLocal;
  out.cardRightLocal=basis[0];
  out.cardUpLocal=basis[1];
  out.coverage=vec4u(CONTINUUM_SPLAT_ENTRY,state.x&65535u,record.tag.z,continuumView.counts.y);
  out.info=vec4u(layer,model,record.spare.x,0u);
  out.place=record.place.xyz;
  return out;
}

struct ContinuumCardTap { albedo:vec3f, alpha:f32, normalLocal:vec3f, zLocal:f32, matFlag:f32 };

fn continuumCardSampleCell(cell:vec2u,layer:i32,tileOffset:vec2f,invTiles:f32,p0:vec3f,rayLocal:vec3f,mipF:f32,halfTexel:f32,invGrid:f32,invGridM1:f32,doParallax:bool)->ContinuumCardTap {
  let dirK=continuumCardDirFromUV(vec2f(cell)*invGridM1);
  let basisK=continuumCardBasis(dirK);
  let rightK=basisK[0];
  let upK=basisK[1];
  let uv0=vec2f(0.5+0.5*dot(p0,rightK),0.5-0.5*dot(p0,upK));
  let atlasUV0=(tileOffset+(vec2f(cell)+clamp(uv0,vec2f(halfTexel),vec2f(1.0-halfTexel)))*invGrid)*invTiles;
  var a=textureSampleLevel(cardAlbedoTex,cardSampler,atlasUV0,layer,mipF);
  var g=textureSampleLevel(cardGeoTex,cardSampler,atlasUV0,layer,mipF);
  var zK=1.0-2.0*g.b;
  let denom=max(dot(rayLocal,dirK),0.28);
  var tHit=clamp((zK-dot(p0,dirK))/denom,-0.9,0.9);
  if(doParallax){
    let p1=p0+rayLocal*tHit;
    let uv1=vec2f(0.5+0.5*dot(p1,rightK),0.5-0.5*dot(p1,upK));
    let inCell=all(uv1>=vec2f(-0.02))&&all(uv1<=vec2f(1.02));
    let atlasUV1=(tileOffset+(vec2f(cell)+clamp(uv1,vec2f(halfTexel),vec2f(1.0-halfTexel)))*invGrid)*invTiles;
    let a1=textureSampleLevel(cardAlbedoTex,cardSampler,atlasUV1,layer,mipF);
    let g1=textureSampleLevel(cardGeoTex,cardSampler,atlasUV1,layer,mipF);
    if(inCell){a=a1;g=g1;zK=1.0-2.0*g1.b;tHit=clamp((zK-dot(p0,dirK))/denom,-0.9,0.9);}
  }
  let nxy=g.rg*2.0-1.0;
  let nz=sqrt(max(1.0-dot(nxy,nxy),0.01));
  var out:ContinuumCardTap;
  out.albedo=a.rgb*a.rgb;
  out.alpha=a.a;
  out.normalLocal=normalize(rightK*nxy.x+upK*nxy.y+dirK*nz);
  out.zLocal=tHit;
  out.matFlag=g.a;
  return out;
}

@fragment fn continuumCardFS(v:ContinuumCardVarying)->ContinuumCardOut {
  let dcx=dpdx(v.corner);
  let dcy=dpdy(v.corner);
  let grid=max(cardParams.x&65535u,2u);
  let tilesPerSide=max(cardParams.x>>16u,1u);
  let invTiles=1.0/f32(tilesPerSide);
  let cellSize=max(cardParams.y,4u);
  let tintMode=cardParams.z;
  let salt=cardParams.w;
  let maxMip=log2(f32(cellSize));
  let texelFoot=sqrt(max(length(dcx)*length(dcy),1e-12))*0.5*f32(cellSize);
  let mipF=clamp(log2(max(texelFoot,1e-4))-0.55,0.0,maxMip);
  let ceilMip=min(ceil(mipF),maxMip);
  let halfTexel=min(0.5*exp2(ceilMip)/f32(cellSize),0.5);
  let invGrid=1.0/f32(grid);
  let invGridM1=1.0/f32(grid-1u);

  let handoffMask=continuumMask(v.coverage,v.position.xy,salt);
  let r2=dot(v.corner,v.corner);
  if(handoffMask==0u||r2>1.12){
    return ContinuumCardOut(vec4f(0.0),0u);
  }

  let centre=v.centreRadius.xyz;
  let baseR=v.centreRadius.w;
  let layerU=v.info.x;
  let p0=v.cardRightLocal*v.corner.x+v.cardUpLocal*v.corner.y;
  let invTurn=vec4f(-v.turn.xyz,v.turn.w);
  let eyeToFrag=(F.camPos.xyz-continuumShift())-v.worldOnPlane;
  let rayLocal=normalize(continuumQuat(invTurn,eyeToFrag));

  var albedo=vec3f(0.28,0.26,0.22);
  var alpha=0.0;
  var nLocal=normalize(v.viewDirLocal*0.7+p0*0.5);
  var zLocal=sqrt(max(1.0-min(r2,1.0),0.0))*0.6;
  var matFlag=0.0;

  if(layerU!=0xffffffffu){
    let layer=i32(layerU>>8u);
    let tileOffset=vec2f(f32(layerU&15u),f32((layerU>>4u)&15u));
    let gridCoord=continuumCardUVFromDir(v.viewDirLocal)*f32(grid-1u);
    let baseCell=min(vec2u(floor(gridCoord)),vec2u(grid-2u));
    let f=clamp(gridCoord-vec2f(baseCell),vec2f(0.0),vec2f(1.0));
    let upper=f.y>f.x;
    let c0=baseCell;
    let c1=baseCell+vec2u(1u,1u);
    let c2=baseCell+select(vec2u(1u,0u),vec2u(0u,1u),upper);
    let w0=1.0-select(f.x,f.y,upper);
    let w1=select(f.y,f.x,upper);
    let w2=abs(f.x-f.y);
    // Far horizon cards (<= 22 px, mipF >= 1.8, where parallax is already off) sample the single dominant octahedral view (2 taps vs 6).
    if(mipF>=1.8){
      let bestCell=select(select(c2,c1,w1>=w2),c0,w0>=w1&&w0>=w2);
      let tb=continuumCardSampleCell(bestCell,layer,tileOffset,invTiles,p0,rayLocal,mipF,halfTexel,invGrid,invGridM1,false);
      albedo=tb.albedo;alpha=tb.alpha;nLocal=tb.normalLocal;zLocal=tb.zLocal;matFlag=tb.matFlag;
    }else{
      // Sharpened barycentric weights prevent cross-view ghosting: cubic on rigid gables/masts, quadratic on foliage boughs.
      let sharpRigid=tintMode==${CONTINUUM_CARD_TINT_CITY}u||tintMode==${CONTINUUM_CARD_TINT_VESSEL}u;
      let rw0=select(w0*w0,w0*w0*w0,sharpRigid);
      let rw1=select(w1*w1,w1*w1*w1,sharpRigid);
      let rw2=select(w2*w2,w2*w2*w2,sharpRigid);
      let rwInv=1.0/max(rw0+rw1+rw2,1e-4);
      let bw0=rw0*rwInv;let bw1=rw1*rwInv;let bw2=rw2*rwInv;
      let doParallax=mipF<1.8;
      let t0=continuumCardSampleCell(c0,layer,tileOffset,invTiles,p0,rayLocal,mipF,halfTexel,invGrid,invGridM1,doParallax);
      let t1=continuumCardSampleCell(c1,layer,tileOffset,invTiles,p0,rayLocal,mipF,halfTexel,invGrid,invGridM1,doParallax);
      let t2=continuumCardSampleCell(c2,layer,tileOffset,invTiles,p0,rayLocal,mipF,halfTexel,invGrid,invGridM1,doParallax);
      alpha=bw0*t0.alpha+bw1*t1.alpha+bw2*t2.alpha;
      if(tintMode==${CONTINUUM_CARD_TINT_VESSEL}u){
        let maxA=max(t0.alpha,max(t1.alpha,t2.alpha));
        alpha=mix(alpha,maxA,0.35*(1.0-smoothstep(1.2,2.5,mipF)));
      }
      let wa0=bw0*max(t0.alpha,1e-4);
      let wa1=bw1*max(t1.alpha,1e-4);
      let wa2=bw2*max(t2.alpha,1e-4);
      let waInv=1.0/max(wa0+wa1+wa2,1e-4);
      albedo=(t0.albedo*wa0+t1.albedo*wa1+t2.albedo*wa2)*waInv;
      nLocal=normalize(t0.normalLocal*wa0+t1.normalLocal*wa1+t2.normalLocal*wa2+vec3f(0.0,1e-5,0.0));
      zLocal=(t0.zLocal*wa0+t1.zLocal*wa1+t2.zLocal*wa2)*waInv;
      matFlag=(t0.matFlag*wa0+t1.matFlag*wa1+t2.matFlag*wa2)*waInv;
    }
  }else if(r2<=0.78){
    alpha=1.0;
  }

  // Solid architectural & vessel cards sharpen interior coverage at low mip levels to avoid MSAA stipple on walls/hulls,
  // while preserving smooth anti-aliased edges and exact area-preserving coverage at far mip levels.
  var effAlpha=alpha;
  let crispW=1.0-smoothstep(1.0,2.8,mipF);
  if(tintMode==${CONTINUUM_CARD_TINT_CITY}u){
    effAlpha=mix(alpha,smoothstep(0.16,0.68,alpha),crispW);
  }else if(tintMode==${CONTINUUM_CARD_TINT_VESSEL}u){
    effAlpha=mix(alpha,smoothstep(0.08,0.45,alpha),crispW);
  }else if(tintMode==${CONTINUUM_CARD_TINT_FOREST}u){
    effAlpha=mix(alpha,smoothstep(0.10,0.56,alpha),crispW*0.78);
  }
  let cardSeed=continuumHash(v.coverage.z^0x4cf5ad43u);
  let cardMask=select(0u,continuumSamples(effAlpha,v.position.xy,v.coverage.w,cardSeed),effAlpha>0.03);
  let finalMask=handoffMask&cardMask;
  if(finalMask==0u){
    return ContinuumCardOut(vec4f(0.0),0u);
  }

  // True 3D surface point for accurate lighting, shadows, and atmospheric perspective.
  let localHit=p0+rayLocal*clamp(zLocal,-0.95,0.95);
  let worldPos=centre+continuumQuat(v.turn,localHit*baseR);
  let nWorld=normalize(continuumQuat(v.turn,nLocal));
  let nDotL=dot(nWorld,F.sunDir.xyz);

  var diffuse=max(nDotL,0.0);
  var ambient=0.46+0.35*max(nWorld.y,0.0);
  var roughness=0.84;
  var shadowVis=vec3f(1.0);

  if(tintMode==${CONTINUUM_CARD_TINT_FOREST}u){
    let tint=unpack4x8unorm(v.info.z).rgb*2.0;
    albedo*=tint;
    let isLeaf=clamp(matFlag,0.0,1.0);
    let backlit=max(-nDotL,0.0)*0.30*isLeaf;
    let leafCol=albedo*mix(vec3f(1.0),vec3f(1.12,1.18,0.72),backlit);
    albedo=mix(albedo,leafCol,isLeaf);
    // Exact vertex canopy & exposure AO are baked into albedo during forestContinuumCardBake.
    let barkDiff=max(nDotL,0.0)*0.78;
    let barkAmb=(0.30+max(nWorld.y,0.0)*0.20)*0.76;
    let leafDiff=(max(nDotL,0.0)+backlit)*0.82;
    let leafAmb=(0.24+abs(nWorld.y)*0.16)*0.82;
    diffuse=mix(barkDiff,leafDiff,isLeaf);
    ambient=mix(barkAmb,leafAmb,isLeaf);
    roughness=mix(0.88,0.68,isLeaf);
    let shAt=worldPos+F.sunDir.xyz*0.45;
    if(landShadowCoverage(shAt)>0.001){shadowVis=landShadowVisibility(shAt,nWorld);}
  }else if(tintMode==${CONTINUUM_CARD_TINT_CITY}u){
    let tint=bitcast<f32>(v.info.z);
    if(tint>=-150.0){
      // matFlag is a linear limewash-wall weight [0..1] (0 on windows/stone/timber/roofs) so linear mip averaging
      // across wall-window borders never triggers false roof classification or bleaches dark window openings.
      let washW=clamp(matFlag,0.0,1.0);
      albedo*=mix(vec3f(1.0),continuumCardCityWash(tint),washW);
      let roofW=smoothstep(0.35,0.65,nWorld.y)*(1.0-washW);
      if(roofW>0.001){
        let roofShade=0.62+0.38*fract(fract(tint)*7.31+v.place.x*0.137+v.place.z*0.071);
        albedo*=mix(1.0,roofShade/0.81,roofW);
      }
    }
    ambient=0.38+0.30*max(nWorld.y,0.0);
    roughness=0.84;
    if(landShadowCoverage(worldPos)>0.001){shadowVis=landShadowVisibility(worldPos,nWorld);}
  }else if(tintMode==${CONTINUUM_CARD_TINT_VESSEL}u){
    let isSail=clamp(matFlag,0.0,1.0);
    let backlit=max(-nDotL,0.0)*0.45*isSail;
    diffuse=max(nDotL,0.0)+backlit;
    ambient=mix(0.55+0.30*max(nWorld.y,0.0),0.65+0.25*abs(nWorld.y),isSail);
    roughness=mix(0.76,0.88,isSail);
  }

  let finished=continuumCardFinish(worldPos,nWorld,albedo,diffuse,ambient,roughness,shadowVis);
  return ContinuumCardOut(finished,finalMask);
}
`;
}

// ------------------------------------------------------------------------------------------------ cell cards
// A type with a card grid (js/continuum-format.js computeContinuumCardGrid) stands, between its clusters and its far
// body, as its cells' cards: each cell's true clusters drawn once at load from a grid of views into a picture that
// holds, a texel, their colour, the share of the texel they cover, their normal, their depth along the view and a
// flag of their material's (js/continuum-cards.js bakeContinuumCellCards). A card is one quad facing the eye over its
// cell's box, drawn where the box's near side lies; a fragment finds where the eye's ray meets the sward in the three
// views about its line of sight, carries that back by how far the sward has swayed there, and is shaded by the
// material's own shading as the point of a cluster it stands for, at that point's own depth: what stands in the sward
// is hidden by what grows before it and by no more. It keeps the samples the cut gives its cards (continuumCardState),
// of those its picture covers: no discard, no blending, no second draw.
// A material brings (its `cards`: { group, binding, salt?, wgsl() }), in its own WGSL:
//   <name>CardSway(record:ContinuumRecord, rest:vec3f, flag:f32)->vec3f  how far the point of its type at `rest`
//             (its type's metres), whose picture holds `flag`, has moved by its pose
//   <name>CardVarying(s:ContinuumSurface, flag:f32, v:ptr<function,ContinuumVarying>)  its varyings for the point a
//             fragment found (s.albedo: the picture's colour and cover; s.world, s.normal, s.local: where it is)
//   <name>CardShade(v:ContinuumVarying, dx:vec2f, dy:vec2f)->vec4f  that point shaded, a pixel's steps across the
//             ground given (no derivative is taken past the fragment's first lines)
// and, where its surface cuts (`coverage`), its <name>Coverage as its view has it.
export const CONTINUUM_CELL_CARD_BINDINGS = 5;
export function continuumCellCardWGSL(material, paging = CONTINUUM_SINGLE_PAGE) {
  const hook = material.cards, name = material.name;
  if (!hook) throw Error(`The ${name} material has no cell cards`);
  const g = hook.group, b = hook.binding ?? 0;
  return continuumMaterialWGSL(material, 'view', paging) + CONTINUUM_CARD_OCT_WGSL + hook.wgsl() + /* wgsl */`
struct ContinuumCellCards {
  sheet:vec4u,    // views a side, tiles a side of a layer, a view's cell in texels across and up
  levels:vec4u,   // cards a type, then where each level's cards begin among a type's
  look:vec4f      // the sine of the lowest views' elevation
};
@group(${g}) @binding(${b}) var cellCardAlbedo:texture_2d_array<f32>;
@group(${g}) @binding(${b + 1}) var cellCardGeo:texture_2d_array<f32>;
@group(${g}) @binding(${b + 2}) var cellCardSampler:sampler;
@group(${g}) @binding(${b + 3}) var<storage,read> cellCardFrames:array<vec4f>;  // a card: its box's centre and its top's sway weight; its half-extents and its layer (bits)
@group(${g}) @binding(${b + 4}) var<uniform> cellCards:ContinuumCellCards;
struct ContinuumCellVarying {
  @invariant @builtin(position) position:vec4f,
  @location(0) world:vec3f,                        // on the card's plane, in the scene's frame
  @location(1) plane:vec3f,                        // the same point from the card's centre, in its type's metres
  @location(2) @interpolate(flat) eye:vec3f,       // the eye, so
  @location(3) @interpolate(flat) coverage:vec4u,  // instance, far share | cards' share << 8 | next level's << 16 | of the next level << 24, seed, samples
  @location(4) @interpolate(flat) card:vec2u       // its card, its layer bits
};
struct ContinuumCellOut { @location(0) colour:vec4f, @builtin(frag_depth) depth:f32, @builtin(sample_mask) mask:u32 };
// How far toward the eye a card's point is drawn (metres): its picture's depth is a texel's mean, so what touches the
// ground would else lie in it.
const CONTINUUM_CELL_PULL=0.03;
// A point of its type as its kind poses it without a vertex's own words (a sward: stood and draped, unswayed), placed.
fn continuumCellPlaced(record:ContinuumRecord,p:vec3f)->vec3f { return continuumPlace(record,continuumPose(record,0u,CONTINUUM_NO_VERTEX,continuumUnposed(p,vec3f(0.0,1.0,0.0))).position); }
@vertex fn continuumCellVS(@builtin(vertex_index) vertex:u32,listed:ContinuumEntry)->ContinuumCellVarying {
  let touched=continuumBindings();
  let instance=listed.entry.x;let what=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  var out:ContinuumCellVarying;
  out.position=CONTINUUM_HIDDEN;
  if(what!=CONTINUUM_CARD_ENTRY){return out;}
  let level=(item>>16u)&3u;let cell=item&65535u;
  let state=continuumState(instance);let cards=continuumCardState(instance);
  let record=continuumRecords[instance];let model=continuumTypeOf(record);
  let index=model*cellCards.levels.x+cellCards.levels[1u+level]+cell;
  let centre=cellCardFrames[index*2u];let box=cellCardFrames[index*2u+1u];
  if(box.x<=0.0){return out;}
  let half=box.xyz;
  // Its type's metres about the card's centre to the scene's frame, as its kind poses and its record places them,
  // measured along the box's three axes (a sward's standing, its drape over the ground, its record's stretch and turn).
  let lift=continuumLift(state,false);
  let o=continuumCellPlaced(record,centre.xyz);
  let a=(continuumCellPlaced(record,centre.xyz+vec3f(half.x,0.0,0.0))-o)/half.x;
  let u=(continuumCellPlaced(record,centre.xyz+vec3f(0.0,half.y,0.0))-o)/half.y;
  let c=(continuumCellPlaced(record,centre.xyz+vec3f(0.0,0.0,half.z))-o)/half.z;
  let det=dot(a,cross(u,c));
  if(abs(det)<1e-9){return out;}
  let back=transpose(mat3x3f(cross(u,c),cross(c,a),cross(a,u)))*(1.0/det);
  let eye=back*(continuumEye()-o-lift);
  let dist=max(length(eye),1e-3);let dir=eye/dist;
  let basis=continuumCardBasis(dir);
  // The quad covers the box as the eye sees it, and as far past it as its top can sway.
  let reach=length(${name}CardSway(record,centre.xyz+vec3f(0.0,half.y,0.0),1.0))*1.3;
  let depth=dot(abs(dir),half)+reach;
  let near=clamp(dist/max(dist-depth,0.25*dist),1.0,1.6);
  let wide=(dot(abs(basis[0]),half)+reach)*near;let tall=(dot(abs(basis[1]),half)+reach)*near;
  let corner=array<vec2f,6>(vec2f(-1.0,-1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0),vec2f(-1.0,-1.0),vec2f(1.0,1.0),vec2f(-1.0,1.0))[min(vertex,5u)];
  let plane=basis[0]*(corner.x*wide)+basis[1]*(corner.y*tall);
  let world=o+a*plane.x+u*plane.y+c*plane.z+lift+vec3f(touched);
  out.world=world;out.plane=plane;out.eye=eye;
  // Drawn at the box's near side: no point of it lies under the ground the box stands on.
  out.position=continuumClipPulled(world,depth*length(a*dir.x+u*dir.y+c*dir.z));
  let later=select(0u,1u,level!=((cards>>16u)&3u));
  out.coverage=vec4u(instance,(state.x&255u)|((cards&255u)<<8u)|(((cards>>8u)&255u)<<16u)|(later<<24u),record.tag.z,continuumView.counts.y);
  out.card=vec2u(index,bitcast<u32>(box.w));
  return out;
}
// One view of a card's grid: its axes (its right, its up, toward its eye) and the box's half-width, half-height and
// half-depth as it sees them, which its picture spans.
struct ContinuumCellView { right:vec3f, up:vec3f, dir:vec3f, extent:vec3f };
fn continuumCellViewOf(cell:vec2u,half:vec3f)->ContinuumCellView {
  var f:ContinuumCellView;
  f.dir=continuumCardDirBiased(vec2f(cell)/f32(max(cellCards.sheet.x,2u)-1u),cellCards.look.x);
  let basis=continuumCardBasis(f.dir);
  f.right=basis[0];f.up=basis[1];
  f.extent=max(vec3f(dot(abs(f.right),half),dot(abs(f.up),half),dot(abs(f.dir),half)),vec3f(1e-4));
  return f;
}
// Where a point (from the card's centre) lies in a view's picture: its place in the atlas, and 1 inside the picture.
fn continuumCellUV(cell:vec2u,layer:u32,f:ContinuumCellView,q:vec3f,mip:f32)->vec3f {
  let size=vec2f(f32(cellCards.sheet.z),f32(cellCards.sheet.w));
  let edge=min(vec2f(0.5*exp2(ceil(mip)))/size,vec2f(0.5));
  let raw=vec2f(0.5+0.5*dot(q,f.right)/f.extent.x,0.5-0.5*dot(q,f.up)/f.extent.y);
  let inside=select(0.0,1.0,all(raw>=vec2f(0.0))&&all(raw<=vec2f(1.0)));
  let tile=vec2f(f32(layer&15u),f32((layer>>4u)&15u));
  return vec3f((tile+(vec2f(cell)+clamp(raw,edge,vec2f(1.0)-edge))/f32(cellCards.sheet.x))/f32(max(cellCards.sheet.y,1u)),inside);
}
struct ContinuumCellTap { albedo:vec3f, alpha:f32, normal:vec3f, t:f32, flag:f32 };
// A view's picture where the eye's ray through q (ray: toward the eye) meets what it holds: read where q lies, then
// again where the ray meets the depth read there. t: how far along the ray from q the surface lies.
fn continuumCellTap(cell:vec2u,layer:u32,half:vec3f,q:vec3f,ray:vec3f,foot:f32)->ContinuumCellTap {
  let f=continuumCellViewOf(cell,half);
  let size=vec2f(f32(cellCards.sheet.z),f32(cellCards.sheet.w));
  let texel=2.0*sqrt(f.extent.x*f.extent.y/(size.x*size.y));
  let mip=clamp(log2(max(foot/texel,1e-4))-0.5,0.0,log2(min(size.x,size.y)));
  let page=i32(layer>>8u);
  let bound=length(half);let facing=max(dot(ray,f.dir),0.28);
  let first=textureSampleLevel(cellCardGeo,cellCardSampler,continuumCellUV(cell,layer,f,q,mip).xy,page,mip);
  let reached=q+ray*clamp(((1.0-2.0*first.b)*f.extent.z-dot(q,f.dir))/facing,-bound,bound);
  let at=continuumCellUV(cell,layer,f,reached,mip);
  let colour=textureSampleLevel(cellCardAlbedo,cellCardSampler,at.xy,page,mip);
  let geo=textureSampleLevel(cellCardGeo,cellCardSampler,at.xy,page,mip);
  let n=geo.rg*2.0-1.0;
  var out:ContinuumCellTap;
  out.albedo=colour.rgb*colour.rgb;
  out.alpha=colour.a*at.z;
  out.normal=normalize(f.right*n.x+f.up*n.y+f.dir*sqrt(max(1.0-dot(n,n),0.01)));
  out.t=clamp(((1.0-2.0*geo.b)*f.extent.z-dot(q,f.dir))/facing,-bound,bound);
  out.flag=geo.a;
  return out;
}
@fragment fn continuumCellFS(v:ContinuumCellVarying)->ContinuumCellOut {
  // A pixel's steps across the ground and its side on the card's plane, before any branch.
  let dx=dpdx(v.world.xz);let dy=dpdy(v.world.xz);
  let foot=sqrt(max(length(dpdx(v.plane))*length(dpdy(v.plane)),1e-12));
  var out:ContinuumCellOut;
  out.colour=vec4f(0.0);out.mask=0u;out.depth=v.position.z;
  // The samples the cut gives this card: past its clusters', short of its far body's, and its level's side of the
  // crossfade to the next (continuumMask splits the same samples by the same seed).
  let samples=clamp(v.coverage.w,1u,8u);
  let seed=v.coverage.z*0x9e3779b9u+${material.salt}u;
  let shares=v.coverage.y;
  let far=continuumSamples(f32(shares&255u)/255.0,v.position.xy,samples,seed);
  let mine=continuumSamples(f32((shares>>8u)&255u)/255.0,v.position.xy,samples,seed);
  let next=continuumSamples(f32((shares>>16u)&255u)/255.0,v.position.xy,samples,seed+13u);
  var mask=mine&~far&select(~next,next,(shares>>24u)!=0u)&((1u<<samples)-1u);
  if(mask==0u){return out;}
  let layer=v.card.y;
  let centre=cellCardFrames[v.card.x*2u].xyz;let half=cellCardFrames[v.card.x*2u+1u].xyz;
  let record=continuumRecords[v.coverage.x];
  let ray=normalize(v.eye-v.plane);
  // The three views about the card's line of sight, the nearest weighing most.
  let grid=max(cellCards.sheet.x,2u);
  let coord=continuumCardUVBiased(normalize(v.eye),cellCards.look.x)*f32(grid-1u);
  let base=min(vec2u(floor(coord)),vec2u(grid-2u));
  let f=clamp(coord-vec2f(base),vec2f(0.0),vec2f(1.0));
  // A cell of the grid is halved along the diagonal that runs toward the zenith (the grid's middle), so the eye's
  // height over the ground weighs the views alike from every bearing.
  let off=vec2f(base)+vec2f(0.5)-vec2f(0.5*f32(grid-1u));
  var cells:array<vec2u,3>;var w:vec3f;
  if(off.x*off.y>0.0){
    cells=array<vec2u,3>(base,base+vec2u(1u,1u),base+select(vec2u(1u,0u),vec2u(0u,1u),f.y>f.x));
    w=vec3f(1.0-max(f.x,f.y),min(f.x,f.y),abs(f.x-f.y));
  }else{
    let low=f.x+f.y<1.0;
    cells=array<vec2u,3>(base+vec2u(1u,0u),base+vec2u(0u,1u),base+select(vec2u(1u,1u),vec2u(0u,0u),low));
    w=select(vec3f(1.0-f.y,1.0-f.x,f.x+f.y-1.0),vec3f(f.x,f.y,1.0-f.x-f.y),low);
  }
  w=w*w;w=w/max(w.x+w.y+w.z,1e-4);
  // Where the ray meets the sward at rest, by the nearest view's depth, and how far what stands there has swayed: the
  // picture is read that far back, so its sward moves as the wind moves its blades.
  var lead=0u;
  if(w.y>w.x&&w.y>=w.z){lead=1u;}else if(w.z>w.x&&w.z>w.y){lead=2u;}
  let front=continuumCellViewOf(cells[lead],half);
  let size=vec2f(f32(cellCards.sheet.z),f32(cellCards.sheet.w));
  let frontMip=clamp(log2(max(foot/(2.0*sqrt(front.extent.x*front.extent.y/(size.x*size.y))),1e-4))-0.5,0.0,log2(min(size.x,size.y)));
  let met=textureSampleLevel(cellCardGeo,cellCardSampler,continuumCellUV(cells[lead],layer,front,v.plane,frontMip).xy,i32(layer>>8u),frontMip);
  let reached=v.plane+ray*clamp(((1.0-2.0*met.b)*front.extent.z-dot(v.plane,front.dir))/max(dot(ray,front.dir),0.28),-length(half),length(half));
  let sway=${name}CardSway(record,centre+reached,met.a);
  let q=v.plane-sway;
  var albedo=vec3f(0.0);var alpha=0.0;var normal=vec3f(0.0);var t=0.0;var flag=0.0;var held=0.0;var weighed=0.0;
  for(var k=0u;k<3u;k++){
    // Far enough off that its texels are well under a pixel, the nearest view alone is read.
    if(w[k]<0.03||(frontMip>=1.8&&k!=lead)){continue;}
    let tap=continuumCellTap(cells[k],layer,half,q,ray,foot);
    let share=w[k]*max(tap.alpha,1e-4);
    alpha+=w[k]*tap.alpha;weighed+=w[k];
    albedo+=tap.albedo*share;normal+=tap.normal*share;t+=tap.t*share;flag+=tap.flag*share;held+=share;
  }
  alpha/=max(weighed,1e-4);
  if(alpha<=0.02){return out;}
  mask&=continuumSamples(alpha,v.position.xy,samples,continuumHash(v.coverage.z^0x4cf5ad43u^(v.card.x*0x9e3779b9u)));
  if(mask==0u){return out;}
  albedo/=held;t/=held;flag/=held;
  // The point found, where the eye's ray through the fragment meets it, as a corner of a cluster would hand it on.
  let along=t/max(length(v.eye-v.plane),1e-3);
  let world=v.world+(continuumEye()-v.world)*along;
  let drawn=continuumClipPulled(world,CONTINUUM_CELL_PULL);
  out.depth=clamp(drawn.z/max(drawn.w,1e-6),0.0,1.0);
  var s:ContinuumSurface;
  s.instance=v.coverage.x;s.what=CONTINUUM_CLUSTER_ENTRY;s.model=continuumTypeOf(record);s.vertex=CONTINUUM_NO_VERTEX;s.record=record;
  s.local=centre+v.plane+ray*t;s.world=world;s.normal=continuumTurnNormal(record,normalize(normal+vec3f(0.0,1e-5,0.0)));
  s.high=0u;s.word=0u;s.wear=0.0;s.corner=vec2f(0.0);s.optics=CONTINUUM_NEAR_OPTICS;s.albedo=vec4f(albedo,alpha);
  var shaded:ContinuumVarying;
  shaded.position=v.position;shaded.world=world;shaded.normal=s.normal;shaded.optics=s.optics;
  shaded.coverage=vec4u(CONTINUUM_CLUSTER_ENTRY,0u,v.coverage.z,v.coverage.w);
  ${name}CardVarying(s,flag,&shaded);
  ${material.coverage ? `mask&=${name}Coverage(shaded,true);\n  if(mask==0u){return out;}` : ''}
  out.mask=mask;
  out.colour=${name}CardShade(shaded,dx,dy);
  return out;
}
`;
}
