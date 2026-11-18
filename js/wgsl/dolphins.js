import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';
import {DOLPHIN_SPLASH_SECONDS} from '../dolphin-state.js';
import {CONTINUUM_CORE_WGSL} from '../continuum-core.js';
import {ANIMAL_TYPE,ANIMAL_CONTINUUM_TYPE} from '../animal-continuum.js';
import {ANIMAL_CONTINUUM_ENTRY,animalContinuumRenderWGSL} from './animal-continuum.js';

export const DOLPHIN_RIPPLE_SEGMENTS=32;
export const DOLPHIN_RIPPLE_RINGS=3;
export const DOLPHIN_RIPPLE_ROWS=2;
export const DOLPHIN_SHEET_SEGMENTS=28;
export const DOLPHIN_SHEET_ROWS=3;
export const DOLPHIN_DROP_COUNT=24;
// Where a sea pass binds the animal continuum's data in its group 0.
export const SEA_CONTINUUM_BINDING=24;

// What every sea animal's pass shares: the scene, the moving sea, the wet skin's light and the water each animal
// throws up. Its bodies are drawn through the animal continuum (seaContinuumBodyWGSL below).
export const DOLPHIN_SEA_WGSL=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(6) var displacement:texture_2d_array<f32>;
@group(0) @binding(7) var seaSampler:sampler;
// root: world xz, age, strength; shape: heading, seed, kind, scale;
// motion: swimming speed. Kind 0=surface trail, 1=emergence, 2=reentry.
struct DolphinSplash {root:vec4f,shape:vec4f,motion:vec4f};
@group(0) @binding(9) var<storage,read> splashes:array<DolphinSplash>;
`+SKY_RENDER_FUNCS+/* wgsl */ `
fn dolphinSea(q:vec2f)->vec3f {
  var d=vec3f(0);
  for(var c=0u;c<${CASCADES}u;c++){d+=textureSampleLevel(displacement,seaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}
  return d;
}
fn dolphinHeight(p:vec2f)->f32 {var q=p;for(var k=0;k<2;k++){q=p-dolphinSea(q).xz;}return dolphinSea(q).y;}
fn dolphinYaw(p:vec3f,heading:f32)->vec3f {let c=cos(heading);let s=sin(heading);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
struct DolphinStroke {position:vec3f,normal:vec3f};
// The peduncle and both flukes share one continuous bend. Its inverse-transpose
// normal keeps the two water-coated skins lit throughout the stroke.
fn dolphinStroke(p:vec3f,normal:vec3f,beat:f32)->DolphinStroke {
  let tail=max(0.0,(p.z-.25)/1.35);
  return DolphinStroke(p+vec3f(0,beat*.24*tail*tail,0),normalize(normal+vec3f(0,0,-normal.y*beat*.48*tail/1.35)));
}
// A continuous water film adds a narrow sunlight glint over the softer skin
// reflection. Both lobes use the scene sun, sky and atmospheric extinction.
// The skin's own roughness is .32 unless its texture says otherwise (the whale's).
fn dolphinSkinRadiance(world:vec3f,normal:vec3f,albedo:vec3f,rough:f32)->vec3f {
  let n=normalize(normal);let eye=normalize(F.camPos.xyz-world);let sun=F.sunDir.xyz;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let f0=vec3f(.035);let coatRough=.11;let coatF0=vec3f(.0204);
  let coatF=vesselFresnel(coatF0,max(dot(n,eye),0.0));
  let diffuse=albedo*(vesselAmbient(n,sky,sea)+direct*max(dot(n,sun),0.0)/PI);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),rough*8.0).rgb*vesselEnvironment(n,eye,rough,f0);
  let spec=vesselSpecular(n,eye,sun,rough,f0)*direct*max(dot(n,sun),0.0);
  let waterReflection=textureSampleLevel(envCube,sampC,reflect(-eye,n),coatRough*8.0).rgb*vesselEnvironment(n,eye,coatRough,coatF0);
  let waterGlint=vesselSpecular(n,eye,sun,coatRough,coatF0)*direct*max(dot(n,sun),0.0);
  let moonSkin=lunarSurface(n,eye,albedo,rough,f0,vec3f(sunVis[1]));
  let moonCoat=lunarSurface(n,eye,vec3f(0),coatRough,coatF0,vec3f(sunVis[1]));
  return (diffuse+reflected+spec+moonSkin)*(1.0-coatF)+waterReflection+waterGlint+moonCoat+lightningSurface(n,eye,albedo,coatRough);
}
fn dolphinCorner(i:u32)->vec2f {return array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i];}
struct DolphinEffect {@builtin(position) pos:vec4f,@location(0) uv:vec2f,@location(1) world:vec3f,@location(2) data:vec4f};
fn dolphinWaterColor(world:vec3f,normal:vec3f,foam:f32)->vec3f {
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.6).rgb;
  let light=skyAtmo(vec3f(0,1,0))*.55+direct*max(F.sunDir.y,.08)*.22+lunarIlluminance()*sunVis[1]*max(lunarDirection().y,.08)*.22+lightningLight()*.25;
  let spec=vesselSpecular(n,eye,F.sunDir.xyz,.19,vec3f(.025))*direct*max(dot(n,F.sunDir.xyz),0.0);
  return mix(reflected*.85+spec+lunarSurface(n,eye,vec3f(0),.19,vec3f(.025),vec3f(sunVis[1])),light,foam);
}
fn dolphinEffectData(s:DolphinSplash)->vec4f {return vec4f(s.root.z,s.root.w,s.shape.y,s.shape.z);}
@vertex fn dolphinRippleVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let trail=s.shape.z<.5;
  let ring=vertex/${DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_ROWS*6}u;
  let row=(vertex/${DOLPHIN_RIPPLE_SEGMENTS*6}u)%${DOLPHIN_RIPPLE_ROWS}u;
  let segment=(vertex/6u)%${DOLPHIN_RIPPLE_SEGMENTS}u;let corner=dolphinCorner(vertex%6u)*.5+.5;
  let angle=(f32(segment)+corner.x)*(2.0*PI)/${DOLPHIN_RIPPLE_SEGMENTS}.0;
  let age=s.root.z-f32(ring)*.24;let grown=max(0.0,age);
  let scale=max(.6,s.shape.w);let cross=(f32(row)+corner.y)/${DOLPHIN_RIPPLE_ROWS}.0*2.0-1.0;
  let radius=(select(.4,.22,trail)*scale+grown*select(1.18,.88,trail))*(1.0+.025*sin(angle*5.0+s.shape.y));
  let width=(.09+grown*.035)*scale;
  let r=radius+cross*width;
  let local=vec3f(cos(angle)*r,0,sin(angle)*r*select(.86,1.18,trail));
  let q=s.root.xy+dolphinYaw(local,s.shape.x).xz;
  let crest=(1.0-cross*cross)*.025*s.root.w*exp(-grown);
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.026+crest,q.y);o.uv=vec2f(cross,angle);
  o.data=dolphinEffectData(s);o.data.x=age;
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinRippleFS(v:DolphinEffect)->@location(0) vec4f {
  var normal=normalize(cross(dpdy(v.world),dpdx(v.world)));if(normal.y<0.0){normal=-normal;}
  let age=v.data.x;if(age<=0.0){discard;}
  let edge=1.0-smoothstep(.35,1.0,abs(v.uv.x));
  let broken=.65+.25*sin(v.uv.y*9.0+v.data.z)+.1*sin(v.uv.y*17.0-v.data.z);
  let fade=smoothstep(0.0,.12,age)*(1.0-smoothstep(.5,${DOLPHIN_SPLASH_SECONDS},age));
  // A surface swimmer leaves a broken, aft-weighted wake, not a spray emitter.
  let aft=select(1.0,.28+.72*smoothstep(-.5,.4,sin(v.uv.y)),v.data.w<.5);
  let foam=clamp(broken*exp(-age*1.2)*v.data.y,0.0,1.0);
  let alpha=edge*fade*aft*(.16+foam*.44)*min(1.0,.45+v.data.y);
  let light=dolphinWaterColor(v.world,normal,foam);
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
// A connected world-space crown expands from the contact footprint. Its rim
// rises ballistically, then breaks up; it is never a camera-facing smoke card.
@vertex fn dolphinSplashVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let corner=dolphinCorner(vertex%6u)*.5+.5;
  let cell=vertex/6u;let segment=cell%${DOLPHIN_SHEET_SEGMENTS}u;let row=cell/${DOLPHIN_SHEET_SEGMENTS}u;
  let angle=(f32(segment)+corner.x)*(2.0*PI)/${DOLPHIN_SHEET_SEGMENTS}.0;
  let t=(f32(row)+corner.y)/${DOLPHIN_SHEET_ROWS}.0;
  let age=s.root.z;let strength=s.root.w;let scale=max(.6,s.shape.w);
  let lobe=.8+.16*sin(angle*7.0+s.shape.y)+.09*sin(angle*13.0-s.shape.y);
  let rise=max(0.0,(2.1+strength*2.9)*age-4.905*age*age);
  let radius=(.23*scale+age*(.75+strength*1.6)*mix(.5,1.0,t))*(1.0+.1*sin(angle*5.0+s.shape.y));
  let drift=s.motion.x*age*.22;
  let q=s.root.xy+dolphinYaw(vec3f(cos(angle)*radius,0,sin(angle)*radius*1.15-drift),s.shape.x).xz;
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.035+rise*t*lobe,q.y);
  o.uv=vec2f(angle,t);o.data=dolphinEffectData(s);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinSplashFS(v:DolphinEffect)->@location(0) vec4f {
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  let life=(2.1+v.data.y*2.9)/4.905;
  let fade=smoothstep(0.0,.045,v.data.x)*(1.0-smoothstep(life*.55,life,v.data.x));
  let lace=.5+.25*sin(v.uv.x*19.0+v.data.z)*sin(v.uv.y*17.0+v.data.z)+.25*sin(v.uv.x*31.0-v.uv.y*13.0);
  let opening=smoothstep(.12,.55,v.data.x)*smoothstep(.1,.75,v.uv.y);
  let film=smoothstep(opening*.65,opening*.65+.18,lace);
  let foam=clamp(.18+smoothstep(.4,1.0,v.uv.y)*.68+opening*.25,0.0,1.0);
  let alpha=fade*film*(.17+foam*.43)*min(1.0,.45+v.data.y);
  if(alpha<.003){discard;}
  return vec4f(surfaceAir(dolphinWaterColor(v.world,n,foam),v.world)*alpha,alpha);
}
@vertex fn dolphinDropVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->DolphinEffect {
  let s=splashes[instance/${DOLPHIN_DROP_COUNT}u];let id=f32(instance%${DOLPHIN_DROP_COUNT}u);let age=s.root.z;
  let angle=id*2.39996+s.shape.y;let random=fract(sin(id*13.71+s.shape.y)*312.6);
  let speed=(.7+random*1.4)*(.6+s.root.w*.7);
  let launch=dolphinYaw(vec3f(cos(angle)*speed,2.0+s.root.w*2.3+random*.8,sin(angle)*speed-s.motion.x*.18),s.shape.x);
  let p=vec3f(s.root.x,dolphinHeight(s.root.xy)+.08,s.root.y)+launch*age+vec3f(0,-4.905*age*age,0);
  let corner=dolphinCorner(vertex);let width=(.018+random*.018)*(.65+s.root.w)*max(.15,1.0-age*.8);
  var o:DolphinEffect;o.world=p;o.uv=corner;o.data=dolphinEffectData(s);
  o.pos=F.viewProj*vec4f(p-F.camPos.xyz+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*width,1);return o;
}
@fragment fn dolphinDropFS(v:DolphinEffect)->@location(0) vec4f {
  let radius=dot(v.uv,v.uv);if(radius>.96){discard;}
  let life=(2.0+v.data.y*2.3+.8)/4.905;
  let alpha=(1.0-smoothstep(.25,1.0,radius))*(1.0-smoothstep(life*.6,life,v.data.x))*.65*min(1.0,.45+v.data.y);
  let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(F.camRight.xyz*v.uv.x+F.camUp.xyz*v.uv.y+eye*sqrt(max(.01,1.0-radius)));
  return vec4f(surfaceAir(dolphinWaterColor(v.world,n,.65),v.world)*alpha,alpha);
}
`;

// The sea's bodies through the animal continuum (js/wgsl/animal-continuum.js). Each animal's place, which its family's
// state writes, stands on the moving sea under it at its depth; its points are bent by its stroke or, the whale's,
// skinned by its rig's bones; and whatever the cut chose (clusters, far body, splat) is lit as wet skin. `marine`
// brings the whale, whose bones and textures js/wgsl/marine-life.js binds.
export function seaContinuumBodyWGSL(marine){
  const T=ANIMAL_CONTINUUM_TYPE,E=ANIMAL_CONTINUUM_ENTRY,A=ANIMAL_TYPE;
  return animalContinuumRenderWGSL(0,SEA_CONTINUUM_BINDING)+/* wgsl */ `
struct SeaContinuumVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) albedo:vec3f,
  @location(3) uv:vec2f,
  @location(4) @interpolate(flat) coverage:vec4u, // what is drawn (1 clusters, 2 far body, 3 splat), handoff | splat << 8, the animal, samples
  @location(5) @interpolate(flat) look:u32,        // 1 the whale's textured skin
};
struct SeaContinuumOut {@location(0) color:vec4f,@builtin(sample_mask) mask:u32};
// Where the waves stand an animal: its root on the sea under it, at its depth; a shark near the surface pitched with
// the wave it rides.
fn seaPlaced(place:AnimalPlace,archetype:u32)->AnimalPlace {
  var p=place;
  p.root.y=dolphinHeight(place.root.xz)+place.root.y;
  if(archetype==${A.shark}u){
    let forward=animalRotY(vec3f(0,0,-4.8*.32),place.root.w).xz;
    let wave=clamp(atan2(dolphinHeight(place.root.xz+forward)-dolphinHeight(place.root.xz-forward),4.8*.64),-.28,.28);
    p.frame.x+=wave*(1.0-smoothstep(-.5,2.0,place.root.y));
  }
  return p;
}
struct SeaPosed {position:vec3f,normal:vec3f};
// A point bent by its animal's stroke (or skinned by the whale's bones), then stood where its place stands it.
fn seaPose(point:AnimalPoint,place:AnimalPlace,archetype:u32)->SeaPosed {
  var p=point.position;var n=point.normal;
  if(archetype==${A.dolphin}u){
    let swim=dolphinStroke(p,n,sin(F.reserved.w*8.0+place.pose.x));p=swim.position;n=swim.normal;
  }else if(archetype==${A.shark}u){
    let tail=clamp((p.z-.15)/2.4,0.0,1.0);let beat=sin(F.reserved.w*4.2+place.pose.x);
    p.x+=beat*.42*tail*tail;n=normalize(n+vec3f(0,0,-n.x*beat*.35*tail));
  }${marine?`else if(archetype==${A.whale}u){
    let j=point.skin.w;let w=unpack4x8unorm(point.skin4);
    let skin=marineBones[j&255u]*w.x+marineBones[(j>>8u)&255u]*w.y+marineBones[(j>>16u)&255u]*w.z+marineBones[j>>24u]*w.w;
    p=(skin*vec4f(p,1.0)).xyz;n=normalize((skin*vec4f(n,0.0)).xyz);
  }`:''}
  return SeaPosed(animalFrame(p,place),normalize(animalFrameTurn(n,place)));
}
fn seaColour(point:AnimalPoint)->vec3f {return vec3f(unpack2x16unorm(point.skin.x),unpack2x16unorm(point.skin.y).x);}
fn seaUV(point:AnimalPoint)->vec2f {return unpack2x16unorm(point.skin.z);}
// One vertex of whatever the cut chose for a sea animal: a cluster's corner or a far-body corner, each end posed and
// the two mixed by the collapse's morph; or a corner of its splat, facing the eye.
@vertex fn seaContinuumVS(@builtin(vertex_index) vertex:u32,listed:AnimalContinuumEntry)->SeaContinuumVertex {
  let touched=animalContinuumBindings();
  let animal=listed.entry.x;let kind=listed.entry.y>>28u;let item=listed.entry.y&0x0fffffffu;
  let given=animalPlaceOf(animal);let archetype=animalTypeOf(given);
  let place=seaPlaced(given,archetype);
  let state=animalState(animal);
  var o:SeaContinuumVertex;
  o.coverage=vec4u(kind,state.x&0xffffu,animal,animalView.counts.y);
  if(kind==${E.splat}u){
    let s=animalSplatCorner(archetype,place,vertex,bitcast<f32>(state.w),F.camPos.xyz);
    o.world=s.world;
    // A dome over the outline: its corners lean out, its middle faces the eye.
    o.normal=normalize(s.right*(s.corner.x*.55)+s.up*(s.corner.y*.65)+s.toward*.2828);
    o.albedo=max(animalTypeV(archetype,${T.splatColour}u),vec3f(0.0));
    ${marine?`if(archetype==${A.whale}u){o.albedo*=textureSampleLevel(marineColor,seaSampler,vec2f(.5),16.0).rgb;}`:''}
  }else{
    var c:AnimalCorner;
    if(kind==${E.cluster}u){c=animalClusterCorner(archetype,item,vertex);}
    else{c=animalFarCorner(archetype,item,vertex,state.y&65535u,bitcast<f32>(state.z));}
    if(!c.shown){o.pos=ANIMAL_CONTINUUM_HIDDEN;return o;}
    let a=seaPose(c.a,place,archetype);let b=seaPose(c.b,place,archetype);
    o.world=mix(a.position,b.position,c.morph);
    o.normal=normalize(mix(a.normal,b.normal,c.morph));
    o.albedo=mix(seaColour(c.a),seaColour(c.b),c.morph);
    o.uv=mix(seaUV(c.a),seaUV(c.b),c.morph);
    o.look=select(0u,1u,archetype==${A.whale}u);
  }
  o.world+=vec3f(touched);
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);
  return o;
}
fn seaContinuumColour(v:SeaContinuumVertex)->vec3f {
  var n=normalize(v.normal);var albedo=v.albedo;var rough=.32;${marine?`
  // The whale's own skin, its colour, relief and roughness, read in uniform control flow.
  let base=textureSample(marineColor,seaSampler,v.uv).rgb;
  let map=textureSample(marineNormal,seaSampler,v.uv).xyz*2.0-1.0;
  let gloss=textureSample(marineRoughness,seaSampler,v.uv).g;
  let dx=dpdx(v.world);let dy=dpdy(v.world);let du=dpdx(v.uv);let dv=dpdy(v.uv);
  let determinant=du.x*dv.y-du.y*dv.x;
  if(v.look==1u){
    albedo*=base;rough=clamp(gloss,.22,.9);
    if(abs(determinant)>1e-9){
      let t=normalize((dx*dv.y-dy*du.y)/determinant);let b=normalize((dy*du.x-dx*dv.x)/determinant);
      n=normalize(t*map.x+b*map.y+n*map.z);
    }
  }`:''}
  return surfaceAir(dolphinSkinRadiance(v.world,n,albedo,rough),v.world);
}
// Every sample of a pixel is drawn by exactly one of an animal's clusters, far body and splat (animalContinuumMask).
@fragment fn seaContinuumFS(v:SeaContinuumVertex)->SeaContinuumOut {
  return SeaContinuumOut(vec4f(seaContinuumColour(v),1.0),animalContinuumMask(v.coverage,v.pos.xy));
}
// The water's picture of what lies under it (js/water-optics.js) has one sample a pixel: it is drawn by whichever of
// the three owns that sample.
@fragment fn seaContinuumCaptureFS(v:SeaContinuumVertex)->@location(0) vec4f {
  let colour=seaContinuumColour(v);
  if((animalContinuumMask(vec4u(v.coverage.xyz,1u),v.pos.xy)&1u)==0u){discard;}
  return vec4f(colour,1.0);
}
`;
}

// The dolphins' pass: the sea, their water, and their bodies through the animal continuum.
export const DOLPHIN_RENDER=DOLPHIN_SEA_WGSL+CONTINUUM_CORE_WGSL+seaContinuumBodyWGSL(false);
