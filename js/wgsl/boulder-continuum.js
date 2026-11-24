// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The boulders' material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how a fractured coastal
// or hillside rock wears its surface. Its cut, its shadow, its atlas and its lift onto the drawn ground are the one
// cut's; this is its stone: multi-octave triplanar lithology strata, fracture fissure veins (micro-crack AO), mineral
// crystal speckle, grounded soil-skirt blending, warm hillside moss/lichen on sky-facing shelves, salt-spray white
// crust near the tide line, wet dark glossy tidal skirt, and relightable octahedral G-buffer card baking.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_FRAME, LAND_CLOTH_SHADOW } from './shadows.js';
import { createNeuralPbrWGSL } from './neural-pbr.js';
import { BOULDER_CONTINUUM_MATERIAL } from '../boulder-continuum.js';

// Group 0: the land's resources a boulder is shaded by (js/boulder-continuum.js BOULDER_CONTINUUM_BINDINGS of
// js/terrain.js nearResources, including the shared Neural PBR bank at bindings 22 & 23). Group 1 is unused;
// the scene's data is group 2.
const boulderContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + /* wgsl */`
struct BoulderLand { domain:vec4f };
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND:BoulderLand;
@group(0) @binding(7) var landAlbedo:texture_2d<f32>;
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(9) var vegetationMask:texture_2d<f32>;
@group(0) @binding(19) var<uniform> landSH:ShadowFrame;
@group(0) @binding(20) var landSolidShadow:texture_depth_2d;
@group(0) @binding(21) var landShadowCompare:sampler_comparison;
` + LAND_CLOTH_SHADOW + SKY_RENDER_FUNCS + createNeuralPbrWGSL({ group: 0, latentBinding: 22, weightBinding: 23 });

// Shared procedural lithology, triplanar rock strata, fracture fissure micro-crack AO, and mineral speckle used by
// both live cluster shading and octahedral G-buffer card baking so near clusters and distant cards match seamlessly.
const BOULDER_ROCK_PROCEDURAL_WGSL = /* wgsl */`
struct BoulderRockSample {
  albedo:vec3f,
  normal:vec3f,
  roughness:f32,
  crack:f32,
  mossNoise:f32
};

// An archetype's linear lithology palette (tag = (archetype + 0.5) / 6), modulated by per-boulder seed.
// Calibrated to realistic weathered coastal/hillside linear stone reflectance (0.06..0.15, never chalky plaster).
fn boulderContinuumPalette(archTag:f32,seed:f32)->vec3f {
  let idx=clamp(u32(floor(archTag*6.0)),0u,5u);
  var base=vec3f(0.115,0.112,0.104);           // 0: Weathered Coastal Granite
  if(idx==1u){base=vec3f(0.148,0.138,0.114);}  // 1: Weathered Warm Limestone
  else if(idx==2u){base=vec3f(0.142,0.098,0.072);} // 2: Iron-Ochre Sandstone Crag
  else if(idx==3u){base=vec3f(0.058,0.062,0.068);} // 3: Dark Volcanic Coastal Basalt
  else if(idx==4u){base=vec3f(0.088,0.096,0.104);} // 4: Weathered Blue-Grey Slate / Schist
  else if(idx==5u){base=vec3f(0.120,0.108,0.090);} // 5: Moorland Gritstone Outcrop
  let h1=fract(seed*31.7+archTag*5.3);
  let h2=fract(seed*73.1+archTag*11.9);
  let warm=mix(vec3f(0.94,0.97,1.03),vec3f(1.05,0.99,0.93),h2);
  return base*warm*(0.84+0.30*h1);
}

// Precision-safe wrapped trigless 3D hash (stays artifact-free at large world coordinates).
fn boulderRockHash3(p:vec3f)->f32 {
  let w=p-256.0*floor(p*(1.0/256.0));
  var q=fract(w*vec3f(0.1031,0.1030,0.0973));
  q+=vec3f(dot(q,q.yxz+vec3f(33.33)));
  return fract((q.x+q.y)*q.z);
}

fn boulderRockNoise3(p:vec3f)->f32 {
  let i=floor(p);
  let f=fract(p);
  let u=f*f*(3.0-2.0*f);
  let n000=boulderRockHash3(i+vec3f(0.0,0.0,0.0));
  let n100=boulderRockHash3(i+vec3f(1.0,0.0,0.0));
  let n010=boulderRockHash3(i+vec3f(0.0,1.0,0.0));
  let n110=boulderRockHash3(i+vec3f(1.0,1.0,0.0));
  let n001=boulderRockHash3(i+vec3f(0.0,0.0,1.0));
  let n101=boulderRockHash3(i+vec3f(1.0,0.0,1.0));
  let n011=boulderRockHash3(i+vec3f(0.0,1.0,1.0));
  let n111=boulderRockHash3(i+vec3f(1.0,1.0,1.0));
  let nx00=mix(n000,n100,u.x);
  let nx10=mix(n010,n110,u.x);
  let nx01=mix(n001,n101,u.x);
  let nx11=mix(n011,n111,u.x);
  return mix(mix(nx00,nx10,u.y),mix(nx01,nx11,u.y),u.z);
}

fn boulderRockFbm(p:vec3f)->f32 {
  let a=boulderRockNoise3(p);
  let b=boulderRockNoise3(p*2.07+vec3f(13.7,7.3,19.1));
  let c=boulderRockNoise3(p*4.19+vec3f(5.1,23.9,11.3));
  return a*0.54+b*0.30+c*0.16;
}

// Sharp triplanar projection of 2D rock grain slices (prevents vertical cleavage faces from stretching).
fn boulderRockTriplanar(p:vec3f,n:vec3f,freq:f32)->f32 {
  let wRaw=pow(abs(n)+vec3f(1e-4),vec3f(4.0));
  let w=wRaw/(wRaw.x+wRaw.y+wRaw.z);
  let gx=boulderRockNoise3(vec3f(p.y*freq,p.z*freq,1.7));
  let gy=boulderRockNoise3(vec3f(p.x*freq,p.z*freq,5.3));
  let gz=boulderRockNoise3(vec3f(p.x*freq,p.y*freq,9.1));
  return gx*w.x+gy*w.y+gz*w.z;
}

// Pure aperiodic multi-octave granular rock relief with footprint-filtered crisp micro-grain.
fn boulderRockRelief(p:vec3f,strataAxis:vec3f,strataFreq:f32,strataAmp:f32,warp:vec3f,fineWeight:f32,microWeight:f32)->f32 {
  let stretched=p+strataAxis*(dot(p,strataAxis)*strataFreq*0.65);
  let coarse=boulderRockNoise3(stretched*3.1+warp*0.42)-0.5;
  let mid=boulderRockNoise3(p*9.2+vec3f(11.3,5.7,19.1))-0.5;
  var h=coarse*(0.36+strataAmp*0.62)+mid*0.30;
  if(fineWeight>0.01){
    let fine=boulderRockNoise3(p*25.0-vec3f(4.2,13.8,7.6))-0.5;
    h+=fine*(0.18*fineWeight);
  }
  if(microWeight>0.01){
    let micro=boulderRockNoise3(p*56.0+vec3f(7.9,2.3,15.4))-0.5;
    h+=micro*(0.09*microWeight);
  }
  return h;
}

fn boulderRockSurface(p:vec3f,baseN:vec3f,stone:vec4f,facetLight:f32,localY:f32,detailFade:f32,worldFoot:f32)->BoulderRockSample {
  let idx=clamp(u32(floor(stone.w*6.0)),0u,5u);

  // Lithology-specific geological strata orientation, frequency, mineral speckle, and roughness.
  var strataAxis=vec3f(0.18,0.96,0.20);
  var strataFreq=2.6;
  var strataAmp=0.18;
  var speckleAmp=0.30;
  var baseRough=0.78;
  var strataTint=vec3f(0.92,0.91,0.89);

  if(idx==1u){
    // Stratified Limestone: crisp horizontal sedimentary beds & pale chalky seams.
    strataAxis=vec3f(0.08,0.995,-0.05);
    strataFreq=3.8;
    strataAmp=0.36;
    speckleAmp=0.14;
    baseRough=0.80;
    strataTint=vec3f(1.08,1.05,0.98);
  }else if(idx==2u){
    // Jagged Red/Ochre Sandstone: bold dipping cross-bedded iron-oxide strata.
    strataAxis=normalize(vec3f(-0.46,0.85,0.22));
    strataFreq=3.3;
    strataAmp=0.40;
    speckleAmp=0.22;
    baseRough=0.85;
    strataTint=vec3f(1.18,0.88,0.72);
  }else if(idx==3u){
    // Columnar Dark Coastal Basalt: dense volcanic rock with subtle vertical cooling striae.
    strataAxis=normalize(vec3f(0.92,0.14,0.36));
    strataFreq=2.4;
    strataAmp=0.14;
    speckleAmp=0.14;
    baseRough=0.68;
    strataTint=vec3f(0.84,0.88,0.94);
  }else if(idx==4u){
    // Weathered Grey Slate / Schist: tight dipping foliation laminations + silvery mica.
    strataAxis=normalize(vec3f(0.68,0.70,-0.22));
    strataFreq=5.4;
    strataAmp=0.34;
    speckleAmp=0.22;
    baseRough=0.70;
    strataTint=vec3f(0.90,0.94,1.02);
  }else if(idx==5u){
    // Fractured Dolmen / Moorland Gritstone: coarse bedding + heavy weathered joints.
    strataAxis=vec3f(0.06,0.996,0.05);
    strataFreq=2.9;
    strataAmp=0.28;
    speckleAmp=0.28;
    baseRough=0.84;
    strataTint=vec3f(1.04,0.98,0.88);
  }

  let fineWeight=1.0-smoothstep(0.025,0.12,worldFoot);
  let microWeight=1.0-smoothstep(0.008,0.045,worldFoot);

  let macroFbm=boulderRockFbm(p*0.85);
  let warp=vec3f(macroFbm-0.5,boulderRockNoise3(p*0.9+vec3f(17.3,4.1,9.7))-0.5,boulderRockNoise3(p*0.9+vec3f(3.7,19.1,2.9))-0.5)*0.55;

  // Aperiodic anisotropic sedimentary/granite layering (stretched 3D noise along strata axis — zero sine contour rings).
  let stretchedP=p+strataAxis*(dot(p,strataAxis)*strataFreq*0.65);
  let bandNoise=boulderRockFbm(stretchedP*1.95+warp*0.32);
  let triGrain=boulderRockTriplanar(p,baseN,6.2);
  let strataVal=bandNoise*0.68+triGrain*0.32;

  // Crisp jagged hairline fracture fissures (narrow ridged valleys — zero blurry leopard-spot blotches).
  let crackFieldA=abs(boulderRockNoise3(p*2.6+warp*0.85+vec3f(3.7,14.1,8.9))*2.0-1.0);
  let crackFieldB=abs(boulderRockNoise3(p*7.4-warp*0.45-vec3f(9.2,4.6,12.3))*2.0-1.0);
  let seamA=1.0-smoothstep(0.015,0.105+worldFoot*0.35,crackFieldA);
  let seamB=(1.0-smoothstep(0.012,0.085+worldFoot*0.45,crackFieldB))*fineWeight;
  let crack=clamp(max(seamA*0.82,seamB*0.65),0.0,1.0);

  // Multi-scale mineral grain & quartz/feldspar/biotite crystal speckle (footprint-filtered for crisp close-ups).
  let grainMid=boulderRockTriplanar(p,baseN,14.0);
  let fineA=boulderRockNoise3(p*26.0+vec3f(2.1,5.7,8.3));
  let fineB=boulderRockNoise3(p*58.0+vec3f(9.4,1.3,4.6));
  let quartzFleck=smoothstep(0.68,0.92,fineA)*0.30*fineWeight+smoothstep(0.72,0.95,fineB)*0.24*microWeight;
  let micaFleck=smoothstep(0.30,0.06,fineA)*0.32*fineWeight+smoothstep(0.26,0.05,fineB)*0.20*microWeight;
  let speckleMod=mix(1.0,0.78+0.42*grainMid,0.45+0.55*fineWeight)*(1.0+(quartzFleck-micaFleck)*speckleAmp);

  // Crisp close-up micro-bump normal from multi-octave granular rock relief + hairline fissures.
  var n=baseN;
  if(detailFade>0.01){
    let eps=clamp(max(0.008,worldFoot*0.65),0.008,0.045);
    let h0=boulderRockRelief(p,strataAxis,strataFreq,strataAmp,warp,fineWeight,microWeight);
    let hx=boulderRockRelief(p+vec3f(eps,0.0,0.0),strataAxis,strataFreq,strataAmp,warp,fineWeight,microWeight);
    let hy=boulderRockRelief(p+vec3f(0.0,eps,0.0),strataAxis,strataFreq,strataAmp,warp,fineWeight,microWeight);
    let hz=boulderRockRelief(p+vec3f(0.0,0.0,eps),strataAxis,strataFreq,strataAmp,warp,fineWeight,microWeight);
    let grad=vec3f(hx-h0,hy-h0,hz-h0)/eps;
    let tangentGrad=grad-baseN*dot(grad,baseN);
    let bumpStrength=(0.085+0.065*fineWeight)*detailFade;
    n=normalize(baseN-clamp(tangentGrad*bumpStrength,vec3f(-0.40),vec3f(0.40)));
  }

  let facetShade=0.60+facetLight*0.40;
  let heightLift=0.80+0.22*clamp((localY+0.24)/1.04,0.0,1.0);
  var col=stone.rgb*facetShade*heightLift;
  col*=mix(vec3f(1.0-strataAmp*0.58),strataTint*(1.0+strataAmp*0.24),strataVal);
  col*=mix(0.76,1.18,macroFbm);
  col*=speckleMod;
  // Crisp darkened weathering fissure crevices.
  let crackCol=select(vec3f(0.36,0.35,0.34),vec3f(0.50,0.48,0.44),idx==1u);
  col=mix(col,col*crackCol,crack*0.68);

  let roughness=clamp(baseRough+crack*0.14-quartzFleck*0.16+(triGrain-0.5)*0.10,0.44,0.94);

  var out:BoulderRockSample;
  out.albedo=col;
  out.normal=n;
  out.roughness=roughness;
  out.crack=crack;
  out.mossNoise=macroFbm;
  return out;
}
`;

const BOULDER_CONTINUUM_MATERIAL_WGSL = BOULDER_ROCK_PROCEDURAL_WGSL + /* wgsl */`
// Its stone (its archetype's lithology + archTag in stone.w, tinted by seed), facet light, and local height above base.
fn boulderContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let archTag=continuumTypeF(s.model,${BOULDER_CONTINUUM_MATERIAL.archetype}u);
  (*v).stone=vec4f(boulderContinuumPalette(archTag,bitcast<f32>(s.record.spare.x)),archTag);
  (*v).lit=vec2f(select(s.optics.x,bitcast<f32>(s.word),s.what==CONTINUUM_CLUSTER_ENTRY||s.what==CONTINUUM_SURFEL_ENTRY),s.local.y);
}

fn boulderContinuumLandShadow(world:vec3f,normal:vec3f)->vec3f {
  if(landSH.origin.w<0.5){return vec3f(1.0);}
  let facing=select(-1.0,1.0,dot(normal,landSH.sun.xyz)>=0.0);
  let offset=normal*facing*0.032+landSH.sun.xyz*0.025;
  let p=landSH.lightView*vec4f(world-landSH.origin.xyz+offset,1.0);
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  let edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let fade=smoothstep(0.0,0.06,edge)*step(0.0,p.z)*step(p.z,1.0);
  let refZ=min(p.z-0.08/max(landSH.sun.w,1.0),0.99999);
  let at=clamp(uv,vec2f(0.0),vec2f(1.0));
  let s1=textureSampleCompareLevel(landSolidShadow,landShadowCompare,at,refZ);
  return mix(vec3f(1.0),s1*landClothShadow(at,refZ),fade);
}

fn boulderContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  let eye=continuumEye();
  let world=v.world;
  let across=dpdx(world);
  let down=dpdy(world);
  let plane=cross(down,across);
  let unitN=normalize(v.normal+vec3f(0.0,1e-6,0.0));
  let faceted=select(unitN,normalize(plane)*select(-1.0,1.0,dot(plane,eye-world)>=0.0),dot(plane,plane)>1e-16);
  // Keep crisp angular fracture planes on both near clusters and far-body fallback (never round into smooth blobs).
  var base=unitN;
  if(v.coverage.x==CONTINUUM_FAR_ENTRY){
    let agree=dot(faceted,unitN);
    base=normalize(mix(unitN,faceted,smoothstep(0.35,0.68,agree)));
  }else if(v.coverage.x==CONTINUUM_SPLAT_ENTRY){
    base=normalize(vec3f(0.0,1.0,0.0)+unitN*0.6);
  }

  let camDist=distance(world,eye);
  let worldFoot=max(length(across),length(down));
  let detailFade=smoothstep(64.0,8.0,camDist);
  let edgeCurv=clamp(length(fwidth(unitN))*0.42,0.0,1.0)*smoothstep(24.0,3.0,camDist);
  let rock=boulderRockSurface(world,base,v.stone,v.lit.x,v.lit.y,detailFade,worldFoot);
  var n=rock.normal;

  // Shared Neural PBR fractured stone detail (dual-band 64x64 meso + 5.618x rotated micro albedo,
  // tangent-space normal map, cavity AO, and roughness — matching coastal cliffs, masonry, and props).
  let npbrScale=1.45;
  let npbrHoriz=abs(base.y)>0.65;
  let npbrAlongX=abs(base.z)>=abs(base.x);
  let npbrUV=select(select(vec2f(world.z,world.y),vec2f(world.x,world.y),npbrAlongX),world.xz,npbrHoriz)*npbrScale;
  let npbrDuDx=select(select(vec2f(across.z,across.y),vec2f(across.x,across.y),npbrAlongX),across.xz,npbrHoriz)*npbrScale;
  let npbrDuDy=select(select(vec2f(down.z,down.y),vec2f(down.x,down.y),npbrAlongX),down.xz,npbrHoriz)*npbrScale;
  let npbrHint=select(select(vec3f(0.0,0.0,1.0),vec3f(1.0,0.0,0.0),npbrAlongX),vec3f(1.0,0.0,0.0),npbrHoriz);
  let npbrBasis=neuralPbrTangentBasis(n,npbrHint);
  let npbr=evalNeuralPbr(10u,npbrUV,npbrDuDx,npbrDuDy,camDist,1.0);
  n=applyNeuralPbrNormal(n,npbrBasis,npbr.normalTS*1.05);

  let uv=clamp((world.xz-LAND.domain.xy)/LAND.domain.z+0.5,vec2f(0.0),vec2f(1.0));
  let soil=pow(max(textureSampleLevel(landAlbedo,landSampler,uv,1.0).rgb,vec3f(0.005)),vec3f(2.2));
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0.0).r;
  let sunlight=textureSampleLevel(landLight,sampC,uv,0.0);

  // 1. Grounded soil-skirt blending & Neural PBR close-up rock micro-albedo + chipped arris wear.
  let rootMask=1.0-smoothstep(-0.22,0.16,v.lit.y);
  var albedo=mix(rock.albedo,soil,0.14);
  albedo=clamp(albedo*npbr.albedoMul,vec3f(0.008),vec3f(0.95));
  albedo=clamp(albedo*(1.0+edgeCurv*0.26),vec3f(0.008),vec3f(0.95));
  var roughness=clamp(rock.roughness+npbr.roughDelta,0.18,0.96);

  // 2. Warm hillside moss & pale golden-sage lichen on sky-facing shelves above the salt-spray zone.
  let aboveSpray=smoothstep(2.0,5.8,world.y);
  let skyShelf=smoothstep(0.46,0.86,max(n.y,0.0));
  let lichenTone=boulderRockNoise3(world*1.35+vec3f(11.3,2.7,7.9));
  let mossPatch=smoothstep(0.34,0.74,rock.mossNoise*0.75+rock.crack*0.30);
  let mossMask=skyShelf*aboveSpray*smoothstep(0.06,0.42,vegetation)*mossPatch;
  let mossCol=mix(vec3f(0.16,0.21,0.09),vec3f(0.30,0.29,0.16),smoothstep(0.45,0.78,lichenTone))*(0.70+v.lit.x*0.32);
  albedo=mix(albedo,mossCol,mossMask*0.64);
  roughness=mix(roughness,0.92,mossMask*0.64);

  // 3. Salt-spray white mineral crust in the coastal splash belt (world.y 0.3..2.2 m).
  let sprayBand=smoothstep(0.28,0.78,world.y)*(1.0-smoothstep(1.55,2.25,world.y));
  let sprayMask=sprayBand*smoothstep(0.36,0.74,rock.mossNoise*0.62+rock.crack*0.58)*(0.48+0.52*max(n.y,0.0));
  albedo=mix(albedo,vec3f(0.66,0.65,0.61)*(0.74+v.lit.x*0.26),sprayMask*0.56);
  roughness=mix(roughness,0.90,sprayMask*0.56);

  // Grounded soil skirt overrides moss/salt right where the boulder meets dirt/sand.
  albedo=mix(albedo,soil*0.72,rootMask*0.50);
  roughness=mix(roughness,0.93,rootMask*0.50);

  // 4. Wet dark glossy tidal skirt coupled to actual coastal swell & wind-sea splash height.
  let seaSplashH=clamp(select(0.75,F.cascL[1].z,F.cascL[1].w>1.0)+F.windP[0].z*0.05,0.35,3.2);
  let tideTop=mix(0.68,2.35,clamp((seaSplashH-0.35)/2.2,0.0,1.0))+(rock.mossNoise-0.5)*0.28;
  let wet=1.0-smoothstep(0.16,tideTop,world.y);
  albedo*=mix(1.0,0.44,wet);
  roughness=mix(roughness,0.16,wet);

  // 5. Physically based sun, sky, ground bounce, GGX specular, wet sheen, shadow, lunar, and atmospheric lighting.
  let shadowed=boulderContinuumLandShadow(world,n);
  let direct=sunIlluminance()*sunlight.r*solarShadowVisibility(shadowed);
  let valleyAO=clamp(1.0+sunlight.b*0.44,0.70,1.14);
  let skyDir=normalize(vec3f(n.x*0.65,max(n.y,0.14),n.z*0.65));
  let skyIrr=textureSampleLevel(envCube,sampC,skyDir,6.0).rgb;
  let hemiMix=clamp(n.y*0.5+0.5,0.0,1.0);
  let ambient=skyIrr*mix(vec3f(0.46,0.42,0.36),vec3f(1.0),hemiMix);
  let sun=normalize(select(vec3f(0.0,1.0,0.0),F.sunDir.xyz,length(F.sunDir.xyz)>0.001));
  let horizonVis=smoothstep(-0.08,0.16,dot(base,sun));
  let diffuse=max(dot(n,sun),0.0)*horizonVis;
  let cavityAO=clamp((1.0-rock.crack*0.32)*npbr.cavityAO,0.35,1.15);
  let visibility=(0.36+0.34*max(n.y,0.0))*valleyAO*cavityAO;
  let groundBounce=direct*max(sun.y,0.0)*(1.0-max(n.y,0.0))*0.062*soil*visibility;
  let toEye=normalize(eye-world);

  var color=albedo*(direct*diffuse/PI+ambient*visibility)+albedo*groundBounce;

  // Physically based GGX specular: crisp micro-facet glint on dry mineral stone, glossy Fresnel sheen on wet tidal rock.
  let f0=vec3f(mix(0.036,0.062,wet));
  let specBrdf=neuralPbrAnisoSpecular(n,npbrBasis,toEye,sun,roughness,npbr.aniso,f0);
  color+=direct*specBrdf*diffuse*mix(0.75,1.15,wet)*cavityAO;
  if(wet>0.01){
    let ndotv=max(dot(n,toEye),0.0);
    let fresnel=mix(0.035,0.065,wet)+(1.0-mix(0.035,0.065,wet))*pow(1.0-ndotv,5.0);
    let refl=reflect(-toEye,n);
    let envRefl=textureSampleLevel(envCube,sampC,vec3f(refl.x,max(refl.y,0.02),refl.z),mix(4.5,1.2,wet)).rgb;
    color+=envRefl*fresnel*wet*0.55*(0.55+0.45*visibility);
  }

  color+=lunarSurface(n,toEye,albedo,roughness,vec3f(mix(0.035,0.055,wet)),vec3f(sunlight.g)*lunarShadowVisibility(shadowed));
  let shifted=world+continuumShift();
  color+=lightningSurface(n,toEye,albedo,roughness)+worldFireSurface(shifted,n,toEye,albedo,roughness);
  return vec4f(continuumAir(color,shifted),1.0);
}
`;

// Octahedral G-buffer card bake hook (js/continuum-cards.js): bakes pure unlit fractured rock linear albedo and crisp
// local 3D cleavage/micro-relief normals so distant boulders render as 1-triangle relightable cards.
const BOULDER_CONTINUUM_CARD_BAKE = Object.freeze({
  prelude: () => /* wgsl */`
@group(0) @binding(0) var boulderCardLandSamp:sampler;
@group(0) @binding(1) var boulderCardLandAlbedo:texture_2d<f32>;
`,
  varyings: [['stone', 'vec4f', true], ['lit', 'vec2f']],
  wgsl: () => BOULDER_ROCK_PROCEDURAL_WGSL + /* wgsl */`
fn boulderContinuumCardBakeVarying(s:ContinuumSurface,v:ptr<function,ContinuumCardBakeVarying>) {
  let archTag=continuumTypeF(s.model,${BOULDER_CONTINUUM_MATERIAL.archetype}u);
  (*v).stone=vec4f(boulderContinuumPalette(archTag,0.37),archTag);
  (*v).lit=vec2f(bitcast<f32>(s.word),s.local.y);
}
fn boulderContinuumCardBake(v:ContinuumCardBakeVarying,front:bool)->ContinuumCardSample {
  let baseN=normalize(v.normal+vec3f(0.0,1e-6,0.0));
  let rock=boulderRockSurface(v.local*1.5,baseN,v.stone,v.lit.x,v.lit.y,0.85,0.04);
  let meanSoil=pow(max(textureSampleLevel(boulderCardLandAlbedo,boulderCardLandSamp,vec2f(0.5,0.5),6.0).rgb,vec3f(0.01)),vec3f(2.2));
  let rootMask=1.0-smoothstep(-0.22,0.16,v.lit.y);
  let topMoss=smoothstep(0.54,0.88,max(rock.normal.y,0.0))*smoothstep(0.36,0.76,rock.mossNoise)*0.22;
  var albedo=mix(rock.albedo,meanSoil,0.14);
  albedo=mix(albedo,vec3f(0.20,0.23,0.12)*(0.70+v.lit.x*0.30),topMoss);
  albedo=mix(albedo,meanSoil*0.74,rootMask*0.44);
  return ContinuumCardSample(albedo,1.0,rock.normal,0.0);
}
`,
});

// The boulders' material (js/wgsl/continuum-cut.js). Closed bodies wound outward; not seen under water.
export const BOULDER_CONTINUUM_MATERIAL_SPEC = Object.freeze({
  name: 'boulderContinuum', prelude: boulderContinuumPreludeWGSL, core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['stone', 'vec4f', true], ['lit', 'vec2f']],
  wgsl: () => BOULDER_CONTINUUM_MATERIAL_WGSL, salt: 5,
  cullMode: 'back', air: true, capture: false, visibility: true,
  cardBake: BOULDER_CONTINUUM_CARD_BAKE,
});
