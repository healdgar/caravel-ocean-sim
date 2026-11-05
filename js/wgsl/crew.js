import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_SAMPLE, SHADOW_FRAME } from './shadows.js';
import { DRESS_MASK_SCALE } from '../indigenous-dress.js';

export const CREW_SKIN = /* wgsl */ `
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(2) var<storage,read> joints:array<mat4x4f>;
struct CrewActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
@group(0) @binding(3) var<storage,read> actors:array<CrewActor>;
struct CrewInput {
  @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) color:vec3f, @location(3) bones:vec4u, @location(4) weights:vec4f,
  @builtin(instance_index) instance:u32
};
fn crewSkin(v:CrewInput)->mat4x4f {
  let b=v.bones+vec4u(v.instance*65u);
  return actors[v.instance].transform*(joints[b.x]*v.weights.x+joints[b.y]*v.weights.y+
    joints[b.z]*v.weights.z+joints[b.w]*v.weights.w);
}
struct CrewSurface { position:vec3f, normal:vec3f };
// Smooth local morphs before skinning keep eyes, brows and hair attached during
// animation. Analytic derivatives give the inverse-transpose normal without
// extra mesh copies, textures or per-person draw calls.
fn crewRamp(lo:f32,hi:f32,x:f32)->vec2f {
  let t=clamp((x-lo)/(hi-lo),0.0,1.0);
  return vec2f(t*t*(3.0-2.0*t),6.0*t*(1.0-t)/(hi-lo));
}
// Optional pieces of a body carry their number in the red channel of their colour, and each person's
// look says which they wear, in the fraction of hair.w. Anyone else's fraction is zero and they have no pieces.
fn crewDressOf(hairW:f32)->u32 {return u32(fract(hairW)*${DRESS_MASK_SCALE}.0+.5);}
fn crewPieceHidden(color:vec3f,dress:u32)->bool {
  let piece=u32(color.r*.5);
  return piece>0u&&((dress>>(piece-1u))&1u)==0u;
}
const CREW_PIECE_OUT=vec3f(0.0,1.62,0.0);
fn crewSurface(v:CrewInput)->CrewSurface {
  let actor=actors[v.instance];
  if(crewPieceHidden(v.color,crewDressOf(actor.hair.w))){return CrewSurface(CREW_PIECE_OUT,v.normal);}
  return crewMorph(v.position,v.normal,actor.face,actor.skin.w);
}
fn crewMorph(p:vec3f,normal:vec3f,f:vec4f,sex:f32)->CrewSurface {
  let headY=select(1.5998,1.5496,sex>.5);
  if(p.y<=headY+.015){return CrewSurface(p,normal);}
  let eyeY=select(1.699,1.656,sex>.5);
  let head=crewRamp(headY+.015,headY+.065,p.y);
  let jaw=vec2f(1,0)-crewRamp(headY+.06,headY+.13,p.y);
  let width=1.0+head.x*((f.x-1.0)+(f.y-1.0)*jaw.x);
  let widthY=head.y*((f.x-1.0)+(f.y-1.0)*jaw.x)+head.x*(f.y-1.0)*jaw.y;
  let nx=vec2f(1,0)-crewRamp(.012,.045,abs(p.x));
  let ny0=crewRamp(eyeY-.065,eyeY-.025,p.y);
  let ny1=vec2f(1,0)-crewRamp(eyeY+.005,eyeY+.04,p.y);
  let nz=crewRamp(.07,.10,p.z);
  let nose=nx.x*ny0.x*ny1.x*nz.x;
  let noseD=vec3f(nx.y*sign(p.x)*ny0.x*ny1.x*nz.x,
    nx.x*(ny0.y*ny1.x+ny0.x*ny1.y)*nz.x,nx.x*ny0.x*ny1.x*nz.y);
  let ex0=crewRamp(.015,.026,abs(p.x));
  let ex1=vec2f(1,0)-crewRamp(.058,.080,abs(p.x));
  let ey=vec2f(1,0)-crewRamp(.016,.040,abs(p.y-eyeY));
  let ez=crewRamp(.025,.060,p.z);
  let eye=ex0.x*ex1.x*ey.x*ez.x;
  let eyeD=vec3f((ex0.y*ex1.x+ex0.x*ex1.y)*sign(p.x)*ey.x*ez.x,
    ex0.x*ex1.x*ey.y*sign(p.y-eyeY)*ez.x,ex0.x*ex1.x*ey.x*ez.y);
  let eyeOpen=select(f.w,f.w-2.0,f.w>1.5);
  let eyeShift=(p.y-eyeY)*(eyeOpen-1.0);
  let eyeGradient=eyeShift*eyeD+vec3f(0,(eyeOpen-1.0)*eye,0);
  // Columns of the deformation Jacobian; cofactor columns transform normals.
  let dx=vec3f(width,eyeGradient.x,f.z*noseD.x);
  let dy=vec3f(p.x*widthY,1.0+eyeGradient.y,f.z*noseD.y);
  let dz=vec3f(0,eyeGradient.z,1.0+f.z*noseD.z);
  let morphed=normalize(cross(dy,dz)*normal.x+cross(dz,dx)*normal.y+cross(dx,dy)*normal.z);
  return CrewSurface(vec3f(p.x*width,p.y+eyeShift*eye,p.z+f.z*nose),morphed);
}
`;
// Shading never discards, so the GPU shades only what shows. Anyone with something to cut away,
// someone fading out of a first-person sightline or in torn clothes, lays depth with `surviving`
// after the opaque scene, then shades what is left.
export const CREW_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + CREW_SKIN + SHADOW_SAMPLE + SKY_RENDER_FUNCS + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(8) var<storage,read> moisture:array<vec2f>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
struct CrewVertex {
  @invariant @builtin(position) position:vec4f, @location(0) world:vec3f,
  @location(1) normal:vec3f, @location(2) color:vec3f, @location(3) @interpolate(flat) helm:f32,
  @location(4) wet:vec2f, @location(5) skin:f32,
  @location(6) bodyPos:vec3f, @location(7) @interpolate(flat) damage:vec3f,
  @location(8) @interpolate(flat) paint:u32
};
// The model's colours are placeholders for what this person wears: rgb, and whether it is skin.
fn crewClothed(tagged:vec3f,p:vec3f,shirt:vec3f,trousers:vec3f,skin:vec3f,hair:vec3f,isIndigenous:bool,dress:u32)->vec4f {
  let color=vec3f(tagged.r-2.0*f32(u32(tagged.r*.5)),tagged.gb);
  let isShirt=distance(color,vec3f(.55,.47,.31))<.001;
  let isLower=distance(color,vec3f(.095,.12,.15))<.001;
  let isHair=distance(color,vec3f(.045,.019,.009))<.001;
  let isArmSkin=isIndigenous && isShirt && abs(p.x)>0.155 && p.y>0.86 && p.y<1.48;
  let isCalfSkin=isIndigenous && isLower && p.y>0.21 && p.y<0.62;
  let bareTorso=isShirt && (dress&${1 << 14}u)!=0u;
  let bareLeg=isLower && (dress&${1 << 15}u)!=0u && p.y<0.87;
  let shavedHair=isHair && u32(tagged.r*.5)==0u && ((dress&${1 << 12}u)!=0u||((dress&${1 << 13}u)!=0u&&p.z>-.02));
  var worn=color;
  if(isShirt){worn=select(shirt,skin,isArmSkin||bareTorso);}
  if(isLower){worn=select(trousers,skin,isCalfSkin||bareLeg);}
  if(distance(color,vec3f(.36,.18,.10))<.001){worn=skin;}
  if(isHair){worn=select(hair,skin,shavedHair);}
  return vec4f(worn,select(0.0,1.0,distance(color,vec3f(.36,.18,.10))<.001 || isArmSkin || isCalfSkin || bareTorso || bareLeg || shavedHair));
}
@vertex fn vs(v:CrewInput)->CrewVertex {
  let skin=crewSkin(v);let surface=crewSurface(v);let p=rotateHull((skin*vec4f(surface.position,1)).xyz)+hull.origin.xyz;
  var out:CrewVertex;out.position=F.viewProj*vec4f(p-F.camPos.xyz,1);
  out.world=p;out.normal=normalize(rotateHull((skin*vec4f(surface.normal,0)).xyz));
  let actor=actors[v.instance];out.helm=floor(actor.trousers.w+0.01);
  out.bodyPos=v.position;
  let woundAmt=select(clamp(actor.shirt.w/0.45,0.0,1.0),0.0,actor.shirt.w>0.5);
  let scorchAmt=clamp(fract(actor.trousers.w)/0.42,0.0,1.0);
  let bandageSeed=fract(actor.skin.w);
  out.damage=vec3f(woundAmt,scorchAmt,bandageSeed);
  let base=u32(actor.hair.w);let y=v.position.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.5,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.08,1.55,y));
  out.wet=mix(lower,upper,smoothstep(.5,1.08,y));
  let dress=crewDressOf(actor.hair.w);
  let clothed=crewClothed(v.color,v.position,actor.shirt.rgb,actor.trousers.rgb,actor.skin.rgb,actor.hair.rgb,actor.face.w>1.5,dress);
  out.color=clothed.rgb;out.skin=clothed.w;out.paint=dress>>16u;
  if(actor.shirt.w>0.5){out.position=vec4f(2,2,0,1);}
  return out;
}
@fragment fn surviving(v:CrewVertex)->@location(0) vec4f {
  // Screen-door transparency preserves correct depth and the two instanced draws.
  // Every nearby sailor clears the first-person sightline, including moving crew.
  let opacity=select(1.0,smoothstep(1.4,4.8,distance(v.world,F.camPos.xyz)),v.helm>.5);
  let pixel=vec2u(v.position.xy)%4u;
  let bayer=array<f32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
  if(opacity<(bayer[pixel.y*4u+pixel.x]+.5)/16.0){discard;}
  let woundAmt=v.damage.x;let scorchAmt=v.damage.y;
  // Tattered cloth edges at cuffs and hems when heavily wounded or scorched
  if(v.skin<0.5 && (woundAmt+scorchAmt)>0.45){
    let bp=v.bodyPos;let bSeed=v.damage.z;
    let isCuffOrHem=(bp.y>0.16 && bp.y<0.28) || (bp.y>0.68 && bp.y<0.80) || (abs(bp.x)>0.22 && bp.y>0.85 && bp.y<1.08);
    if(isCuffOrHem){
      let nHash=fract(sin(dot(bp*vec3f(19.3,27.1,23.7)+vec3f(bSeed*31.0),vec3f(12.9898,78.233,45.164)))*43758.5453);
      let fray=sin(bp.x*95.0+bp.z*85.0+bSeed*50.0)*0.5+0.5;
      if(fray*0.65+nHash*0.35 > 1.12-(woundAmt*0.32+scorchAmt*0.25)){discard;}
    }
  }
  return vec4f(0);
}
@fragment fn fs(v:CrewVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let woundAmt=v.damage.x;let scorchAmt=v.damage.y;let bSeed=v.damage.z;
  let bp=v.bodyPos;
  let nHash=fract(sin(dot(bp*vec3f(19.3,27.1,23.7)+vec3f(bSeed*31.0),vec3f(12.9898,78.233,45.164)))*43758.5453);
  let nLow=sin(bp.x*18.0+bSeed*41.0)*cos(bp.y*14.0-bSeed*23.0)*0.5+0.5;
  let n=normalize(v.normal)*select(-1.0,1.0,front);let sun=F.sunDir.xyz;
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS-1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS-1}.0).rgb;
  let ambient=vesselAmbient(n,sky,sea);
  let wet=clamp(v.wet,vec2f(0),vec2f(1));
  var baseColor=v.color;
  var roughBias=0.0;
  if(v.paint!=0u&&v.skin>.5){
    // Genipap: dark bands over the body and limbs, the face left clear.
    if((v.paint&1u)!=0u){
      let band=1.0-smoothstep(.2,.3,abs(fract(bp.y*10.0+abs(bp.x)*6.0)-.5));
      baseColor=mix(baseColor,vec3f(.014,.016,.024),band*(1.0-smoothstep(1.46,1.5,bp.y))*.88);
    }
    // Annatto or red earth, in a band across the eyes and cheeks.
    if((v.paint&2u)!=0u){
      let across=smoothstep(1.595,1.615,bp.y)*(1.0-smoothstep(1.68,1.7,bp.y));
      baseColor=mix(baseColor,vec3f(.40,.05,.028),across*.82);
    }
  }
  if(woundAmt>0.15 || scorchAmt>0.10){
    // Linen bandages wrapped around brow/head or forearm/calf on wounded sailors
    let hasHeadBand=bSeed>0.16 && bp.y>1.63 && bp.y<1.71 && bp.z>-0.10;
    let hasArmBand=bSeed>0.05 && abs(bp.x)>0.16 && bp.y>0.92 && bp.y<1.12 && sign(bp.x)==select(-1.0,1.0,bSeed>0.22);
    let hasLegBand=bSeed>0.11 && bp.y>0.24 && bp.y<0.42 && sign(bp.x)==select(1.0,-1.0,bSeed>0.20);
    if(woundAmt>0.25 && (hasHeadBand || hasArmBand || hasLegBand)){
      let wrapStripe=sin((bp.y*85.0+bp.x*32.0)*6.283)*0.04;
      var linen=vec3f(0.84,0.80,0.72)+vec3f(wrapStripe);
      let seep=smoothstep(0.58,0.82,nLow+0.25*woundAmt);
      linen=mix(linen,vec3f(0.38,0.035,0.025),seep*0.78);
      baseColor=linen;
      roughBias=0.22;
    }else if(woundAmt>0.15){
      let stainZone=smoothstep(0.52,0.78,nLow+0.22*woundAmt)*smoothstep(0.35,1.45,bp.y);
      let bloodCol=select(vec3f(0.24,0.025,0.018),vec3f(0.32,0.04,0.03),v.skin>0.5);
      baseColor=mix(baseColor,bloodCol,stainZone*woundAmt*0.72);
    }
    if(scorchAmt>0.08){
      let sootMask=smoothstep(0.38,0.76,nLow*0.7+nHash*0.3)*scorchAmt;
      baseColor=mix(baseColor,vec3f(0.065,0.058,0.052),sootMask*0.78);
      roughBias=max(roughBias,sootMask*0.25);
    }
  }
  let albedo=baseColor*mix(1.0,mix(.68,.92,v.skin),wet.x);
  let view=normalize(F.camPos.xyz-v.world);
  // A little diffuse wrap softens facial terminators. Skin has a broad dry
  // highlight; absorbed water darkens linen, surface water strengthens glints.
  // Roughness values are authored material choices, not measured cloth/skin data.
  let rough=clamp(mix(mix(.92,.62,v.skin),mix(.55,.38,v.skin),wet.y)+roughBias,0.08,0.99);
  let wrap=.14*v.skin;
  let diffuse=max(0.0,(dot(n,sun)+wrap)/(1.0+wrap))/(1.0+wrap);
  let f0=vec3f(.04);
  let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS-1}.0).rgb;
  let col=lunarSurface(n,view,albedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,albedo,rough)+gunFlashSurface(v.world,n,view,albedo,rough)+albedo*(direct*diffuse/PI+ambient)+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  // Match timber, canvas and land: the same directional sky and marine haze
  // must veil every surface along this view ray, including shadowed sailors.
  return vec4f(surfaceAir(col,v.world),1);
}
`;
export const CREW_SHADOW = VESSEL_RIG + CREW_SKIN + SHADOW_FRAME + /* wgsl */ `
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@vertex fn vs(v:CrewInput)->@builtin(position) vec4f {
  return SH.lightView*vec4f(rotateHull((crewSkin(v)*vec4f(crewSurface(v).position,1)).xyz),1);
}
`;

// Sailors further from the eye are solved less often. Each frame the GPU carries every joint from
// the last solved pose towards the newest one, so their limbs still move smoothly between solves.
export const CREW_POSE_BLEND = /* wgsl */ `
@group(0) @binding(0) var<storage,read> solved:array<mat4x4f>;
@group(0) @binding(1) var<storage,read> blends:array<vec2f>;
@group(0) @binding(2) var<storage,read_write> shownJoints:array<mat4x4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&shownJoints)){return;}
  let sailor=id.x/65u;let joint=id.x%65u;let blend=blends[sailor];
  let newest=u32(blend.y);
  let older=solved[(sailor*2u+1u-newest)*65u+joint];let latest=solved[(sailor*2u+newest)*65u+joint];
  shownJoints[id.x]=mat4x4f(mix(older[0],latest[0],blend.x),mix(older[1],latest[1],blend.x),mix(older[2],latest[2],blend.x),mix(older[3],latest[3],blend.x));
}
`;

// A body's joints straight from its baked clips: standing and walking, blended, between frames.
export const CREW_CLIP_POSE = /* wgsl */ `
struct CrewClipLayout {idleFirst:u32,idleFrames:u32,walkFirst:u32,walkFrames:u32};
@group(0) @binding(0) var<storage,read> palettes:array<mat4x4f>;
@group(0) @binding(1) var<uniform> layout_:CrewClipLayout;
@group(0) @binding(2) var<storage,read> bodies:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> shownJoints:array<mat4x4f>;
fn mixJoints(a:mat4x4f,b:mat4x4f,t:f32)->mat4x4f {return mat4x4f(mix(a[0],b[0],t),mix(a[1],b[1],t),mix(a[2],b[2],t),mix(a[3],b[3],t));}
fn clipJoint(first:u32,frames:u32,frame:f32,joint:u32)->mat4x4f {
  let whole=u32(frame)%frames;let next=(whole+1u)%frames;
  return mixJoints(palettes[(first+whole)*65u+joint],palettes[(first+next)*65u+joint],fract(frame));
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&shownJoints)){return;}
  let body=bodies[id.x/65u];
  if(body.w<0.5){return;}
  let joint=id.x%65u;
  shownJoints[id.x]=mixJoints(clipJoint(layout_.idleFirst,layout_.idleFrames,body.x,joint),clipJoint(layout_.walkFirst,layout_.walkFrames,body.y,joint),body.z);
}
`;

