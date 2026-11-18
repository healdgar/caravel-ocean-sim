// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The forest in the one continuum's pipeline family (js/wgsl/continuum-cut.js): its material and the pass that stands
// its trees. Their cut, their shadow, their atlas and their sway are the one cut's (the WIND kind,
// js/wgsl/continuum-wind.js); this is only where a tree stands each frame and how its bark and leaves are worn.
//   stand     one thread a root (js/forest-scenery.js keeps them, struck where a ball lands): each tree in view or in
//             the shadow map's box is written as a record of the one format, in the order it is found, with its gust,
//             any blast's push and what shot has done to it (felled at its break, or wounded) as its pose, and the
//             select's workgroups are written for an indirect dispatch.
//   material  bark and leaves as the pack's own maps wear them, lit by the land's finish. A leaf card cuts its shape by
//             the sample mask alone (rule 2): each sample of a pixel is kept by the card's coverage there, its pattern
//             seeded by the card. The far body and the splat are lit as the crown of leaves they stand for.
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_RECORD_WGSL, CONTINUUM_ROW } from './continuum-cut.js';
import { CONTINUUM_WIND_FORM, CONTINUUM_WIND_POSE } from './continuum-wind.js';
import { CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_KIND, CONTINUUM_KIND_SHIFT, CONTINUUM_STRUCK } from '../continuum-format.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { FOREST_CONTINUUM_MATERIAL, FOREST_CONTINUUM_UNTEXTURED } from '../forest-continuum.js';
import { FOREST_FALL_BEARINGS, FOREST_FALL_HEIGHT_STEPS, FOREST_FALL_REST_MIN_DEG, FOREST_FALL_SECONDS, FOREST_WOUND_BEARINGS } from '../forest-trunks.js';

// Where the scene's data binds in a forest view: group 2, past the land's own group 2 bindings. Its maps and their
// optics are group 3.
export const FOREST_CONTINUUM_DATA = Object.freeze({ group: 2, binding: 40 });
// The blasts the stand pass pushes trees by at once, the latest kept.
export const FOREST_CONTINUUM_BLASTS = 8;
// The stand pass's uniform: [roots in use, records it may write, 1 if shadows are cast, blasts], the world's offset
// [x, 0, z, 0] (the roots stand in the scene's frame), then two vec4f a blast: [x, y, z, the frame time it went off],
// [radius, push at its centre in metres, the speed its wave runs at, 0], in the scene's frame.
export const FOREST_CONTINUUM_STAND_BYTES = 32 + FOREST_CONTINUUM_BLASTS * 32;
// The stand pass's own buffer: the select's workgroups (x, y, z), then how many records it wrote.
export const FOREST_CONTINUUM_STOOD_BYTES = 16;

// ---------------------------------------------------------------------------------------------- the stand pass
export function forestContinuumStandWGSL() {
  const F = CONTINUUM_WIND_FORM, M = FOREST_CONTINUUM_MATERIAL, T = CONTINUUM_TYPE;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_RECORD_WGSL + continuumGroundWGSL(0, 8) + /* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
struct ForestStand {counts:vec4u,shift:vec4f,blasts:array<vec4f,${FOREST_CONTINUUM_BLASTS * 2}>};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>SH:ShadowFrame;
@group(0)@binding(2)var<storage,read>forestRoots:array<ForestRoot>;
@group(0)@binding(3)var<storage,read>forestAtlas:array<u32>;
@group(0)@binding(4)var<storage,read_write>forestRecords:array<ContinuumRecord>;
@group(0)@binding(5)var<storage,read_write>forestPoses:array<vec4f>;
@group(0)@binding(6)var<storage,read_write>forestStood:array<atomic<u32>,4>;
@group(0)@binding(7)var<uniform>forestStand:ForestStand;
fn forestStandHash(value:u32)->u32{var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
fn forestStandTypeF(model:u32,field:u32)->f32{return bitcast<f32>(forestAtlas[forestAtlas[${CONTINUUM_HEADER.typesAt}u]+model*${CONTINUUM_TYPE_WORDS}u+field]);}
// A tree's yaw turns its type's +x toward (cos, 0, sin) of it.
fn forestStandTurn(yaw:f32,v:vec3f)->vec3f{let c=cos(yaw);let s=sin(yaw);return vec3f(c*v.x-s*v.z,v.y,s*v.x+c*v.z);}
fn forestStandOutside(relative:vec3f,reach:f32)->bool{
 let m=F.viewProj;let p=vec4f(relative,1.0);
 let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
 let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
 for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
 return false;
}
fn forestStandShadowed(world:vec3f,reach:f32)->bool{
 let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
 let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
 return abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z;
}
@compute @workgroup_size(1)fn forestStandReset(){atomicStore(&forestStood[3],0u);}
@compute @workgroup_size(64)fn forestStandRoots(@builtin(global_invocation_id)id:vec3u,@builtin(num_workgroups)groups:vec3u){
 let i=id.x+id.y*groups.x*64u;
 if(i>=forestStand.counts.x){return;}
 let r=forestRoots[i];let scale=r.rootScale.w;
 if(!(scale>0.0)){return;}
 let model=u32(r.identity.x);let yaw=r.yawColour.x;
 // Where it stands as drawn: on the ground the land draws there (js/continuum-ground.js). It is struck, felled and
 // blown over where it truly stands (js/forest-trunks.js on the CPU).
 let shift=forestStand.shift.xyz;
 let position=r.rootScale.xyz+vec3f(0.0,continuumGroundLift(r.rootScale.xz+shift.xz),0.0);
 let sphere=vec4f(forestStandTypeF(model,${T.sphere}u),forestStandTypeF(model,${T.sphere + 1}u),forestStandTypeF(model,${T.sphere + 2}u),forestStandTypeF(model,${T.sphere + 3}u));
 let felled=r.identity.w<0.0;let wounded=r.identity.w>0.0;
 // Gust fronts roll downwind across the forest at the wind's own speed; a tree on the ground is still.
 let speed=F.windP[0].z;let downwind=F.windP[0].xy;let t=F.camPos.w;
 var strength=0.0;
 if(speed>0.05&&!felled){
  let front=(dot(r.rootScale.xz,downwind)-t*speed)*.035;
  let across=dot(r.rootScale.xz,vec2f(-downwind.y,downwind.x))*.02;
  strength=clamp(speed/14.0,0.0,1.6)*(.55+.3*sin(front)+.15*sin(front*2.7+across));
 }
 // A blast's wave runs out from where it went off and whips each tree it reaches away from it, and back.
 var push=vec3f(0.0);
 for(var e=0u;e<min(forestStand.counts.w,${FOREST_CONTINUUM_BLASTS}u);e++){
  let at=forestStand.blasts[e*2u];let shape=forestStand.blasts[e*2u+1u];
  let d=distance(r.rootScale.xz,at.xz);
  if(d>=shape.x){continue;}
  let age=t-at.w-d/max(shape.z,1.0);
  if(age<0.0||age>4.0){continue;}
  let near=1.0-d/shape.x;
  let away=select(vec2f(1.0,0.0),(r.rootScale.xz-at.xz)/max(d,1e-3),d>1e-3);
  push+=vec3f(away.x,.12,away.y)*shape.y*near*near*exp(-age*1.5)*sin(age*6.0);
 }
 let sway=forestStandTypeF(model,${M.sway}u)*strength;
 // A tree felled lies within its own height of where it stood: its record's reach takes it in.
 let reach=select(0.0,sphere.w*scale,felled);
 let radius=(sphere.w+abs(sway)*1.8)*scale+length(push)+reach;
 let centre=position+forestStandTurn(yaw,sphere.xyz)*scale;
 let relative=centre+shift-F.camPos.xyz;
 if(forestStandOutside(earthCurve(relative,F.camPos.y),radius)&&!(forestStand.counts.z!=0u&&forestStandShadowed(centre,radius))){return;}
 let slot=atomicAdd(&forestStood[3],1u);
 if(slot>=forestStand.counts.y){return;}
 // What shot has done to it (js/forest-trunks.js): felled at the height it broke, falling toward its bearing over
 // ${FOREST_FALL_SECONDS} s; or wounded, the ball's side gouged. Bearings are turned into its type's own frame.
 var form=${F.STANDING}u;var held=vec4f(0.0);
 if(felled){
  let code=u32(r.identity.y);
  let rest=(${FOREST_FALL_REST_MIN_DEG}.0+f32(code>>18u))*.01745329;var angle=rest;
  let age=t+r.identity.w;
  if(r.identity.w>-1e8&&age>=0.0){let e=min(age/${FOREST_FALL_SECONDS.toFixed(4)},1.0);angle=rest*e*e;}
  form=${F.FELLED}u;
  held=vec4f(f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.0,f32((code>>11u)&${FOREST_FALL_BEARINGS - 1}u)/${FOREST_FALL_BEARINGS}.0*6.2831853-yaw,angle,0.0);
 }else if(wounded){
  let code=u32(r.identity.w);
  form=${F.WOUNDED}u;
  held=vec4f(f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.0,f32((code>>11u)&${FOREST_WOUND_BEARINGS - 1}u)/${FOREST_WOUND_BEARINGS}.0*6.2831853-yaw,f32(code>>17u)/127.0,0.0);
 }
 let pose=slot*${CONTINUUM_WIND_POSE}u;
 forestPoses[pose]=vec4f(r.rootScale.x*.13+r.rootScale.z*.11,sway,0.0,f32(form));
 forestPoses[pose+1u]=held;
 forestPoses[pose+2u]=vec4f(forestStandTurn(-yaw,push)/scale,0.0);
 // Its seed is where it stands, so its sample pattern and its thinning are its own however the trees are listed.
 let seed=forestStandHash(bitcast<u32>(r.rootScale.x)^forestStandHash(bitcast<u32>(r.rootScale.z)));
 let half=yaw*0.5;
 let tag=model|(${CONTINUUM_KIND.WIND}u<<${CONTINUUM_KIND_SHIFT}u)|select(0u,${CONTINUUM_STRUCK >>> 0}u,felled||wounded);
 forestRecords[slot]=ContinuumRecord(vec4f(position,scale),vec4f(0.0,-sin(half),0.0,cos(half)),vec4u(tag,pose,seed,bitcast<u32>(reach)),vec4u(pack4x8unorm(vec4f(r.yawColour.yzw*0.5,0.0)),0u,0u,0u));
}
// The select's workgroups for the records written, ${CONTINUUM_ROW} a row; every record of the last row past them gone.
@compute @workgroup_size(64)fn forestStandFinish(@builtin(global_invocation_id)id:vec3u){
 let n=min(atomicLoad(&forestStood[3]),forestStand.counts.y);
 let across=min(n,${CONTINUUM_ROW}u);let rows=(n+${CONTINUUM_ROW - 1}u)/${CONTINUUM_ROW}u;
 if(id.x==0u){atomicStore(&forestStood[0],across);atomicStore(&forestStood[1],rows);atomicStore(&forestStood[2],1u);}
 let tail=n+id.x;
 if(tail<across*rows&&tail<forestStand.counts.y){forestRecords[tail].tag.x=CONTINUUM_GONE;}
}
`;
}

// ---------------------------------------------------------------------------------------------- the material
const forestContinuumMaterialWGSL = () => {
  const M = FOREST_CONTINUUM_MATERIAL, F = CONTINUUM_WIND_FORM;
  return /* wgsl */`
struct ForestLeafMaterial {optics:vec4f,underside:vec4f,coordinates:vec4f};
@group(3)@binding(0)var forestNativeAlbedo0:texture_2d_array<f32>;
@group(3)@binding(1)var forestNativeNormal0:texture_2d_array<f32>;
@group(3)@binding(2)var forestNativeAlbedo1:texture_2d_array<f32>;
@group(3)@binding(3)var forestNativeNormal1:texture_2d_array<f32>;
@group(3)@binding(4)var forestNativeAlbedo2:texture_2d_array<f32>;
@group(3)@binding(5)var forestNativeNormal2:texture_2d_array<f32>;
@group(3)@binding(6)var forestNativeAlbedo3:texture_2d_array<f32>;
@group(3)@binding(7)var forestNativeNormal3:texture_2d_array<f32>;
@group(3)@binding(8)var forestNativeSampler:sampler;
@group(3)@binding(9)var forestNativeRepeatSampler:sampler;
@group(3)@binding(10)var<storage,read>forestNativeMaterials:array<ForestLeafMaterial>;
const FOREST_UNTEXTURED:u32=0xffffu;
fn forestNativeLinear(c:vec3f)->vec3f{return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));}
struct ForestSurface {pigment:vec4f,detail:vec4f};
// A leaf's own colour from what the maps keep, which is that colour times coverage. Where coverage nears nothing the
// two are noise over noise (block compression and rounding leave a little colour over a coverage of zero), so below
// this floor the colour fades to black instead of growing.
const FOREST_THINNEST_COVERAGE=1./32.;
fn forestOwnColour(pigment:vec4f)->vec3f{return min(pigment.rgb/max(pigment.a,FOREST_THINNEST_COVERAGE),vec3f(1));}
fn forestDetailSigned(d:vec4f)->vec4f{return vec4f(d.xyz*(255./127.)-vec3f(128./127.),d.a);}
fn forestNativePair(albedo:texture_2d_array<f32>,normal:texture_2d_array<f32>,uv:vec2f,ux:vec2f,uy:vec2f,layer:i32,repeating:bool)->ForestSurface{
 var result:ForestSurface;
 if(repeating){result.pigment=textureSampleGrad(albedo,forestNativeRepeatSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeRepeatSampler,uv,layer,ux,uy);}
 else{result.pigment=textureSampleGrad(albedo,forestNativeSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeSampler,uv,layer,ux,uy);}
 result.detail=forestDetailSigned(result.detail);
 return result;
}
fn forestReadNative(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->ForestSurface{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let repeating=material.coordinates.z>0.;
 if(family==0u){return forestNativePair(forestNativeAlbedo0,forestNativeNormal0,uv,ux,uy,layer,repeating);}
 if(family==1u){return forestNativePair(forestNativeAlbedo1,forestNativeNormal1,uv,ux,uy,layer,repeating);}
 if(family==2u){return forestNativePair(forestNativeAlbedo2,forestNativeNormal2,uv,ux,uy,layer,repeating);}
 return forestNativePair(forestNativeAlbedo3,forestNativeNormal3,uv,ux,uy,layer,repeating);
}
fn forestNativeAlbedoOnly(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->vec4f{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);
 if(family==0u){return textureSampleGrad(forestNativeAlbedo0,forestNativeSampler,uv,layer,ux,uy);}
 if(family==1u){return textureSampleGrad(forestNativeAlbedo1,forestNativeSampler,uv,layer,ux,uy);}
 if(family==2u){return textureSampleGrad(forestNativeAlbedo2,forestNativeSampler,uv,layer,ux,uy);}
 return textureSampleGrad(forestNativeAlbedo3,forestNativeSampler,uv,layer,ux,uy);
}
// A layer's own colour over all of it: the last level of its coverage-weighted mips.
fn forestNativeMean(material:ForestLeafMaterial)->vec3f{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let middle=vec2f(.5);
 var pigment:vec4f;
 if(family==0u){pigment=textureSampleLevel(forestNativeAlbedo0,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo0)-1u));}
 else if(family==1u){pigment=textureSampleLevel(forestNativeAlbedo1,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo1)-1u));}
 else if(family==2u){pigment=textureSampleLevel(forestNativeAlbedo2,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo2)-1u));}
 else{pigment=textureSampleLevel(forestNativeAlbedo3,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo3)-1u));}
 return forestOwnColour(pigment);
}
fn forestMappedNormal(geometric:vec3f,detail:vec3f,dx:vec3f,dy:vec3f,ux:vec2f,uy:vec2f)->vec3f{
 let determinant=ux.x*uy.y-ux.y*uy.x;
 let direction=select(-1.,1.,determinant>=0.);
 let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 var n=geometric;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
   let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;
   let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+geometric*sampled.z);
 }
 return n;
}
// Near, a leaf's edge is crisp and its veins and cuticle show; this fades out before the canopy is far.
fn forestBotanicalDetail(uv:vec2f,viewDist:f32,rawAlpha:f32)->vec4f{
 let detailW=1.-smoothstep(10.,38.,viewDist);
 if(detailW<=.001||rawAlpha<=.04){return vec4f(rawAlpha,0.,0.,0.);}
 let edgeSharp=smoothstep(.24,.76,rawAlpha);
 let crispAlpha=mix(rawAlpha,edgeSharp,detailW*.24);
 let interior=smoothstep(.20,.65,rawAlpha)*detailW;
 let chevronU=uv.x*22.0-abs(uv.y-.5)*14.0;
 let secVein=sin(chevronU)*exp(-abs(fract(chevronU*.1591549)-.5)*3.2);
 let fineNet=sin(uv.x*68.0+uv.y*44.0)*cos(uv.x*41.0-uv.y*63.0);
 let sideSign=select(-1.,1.,uv.y>=.5);
 let veinX=(secVein*.16+fineNet*.045)*interior;
 let veinY=(cos(chevronU)*sideSign*.14+fineNet*.045)*interior;
 let dapple=(sin(uv.x*11.3+uv.y*7.9)*.55+cos(uv.x*19.7-uv.y*15.1)*.45)*interior;
 return vec4f(crispAlpha,veinX,veinY,dapple);
}
// The samples of a pixel a leaf card covers: its coverage times the samples, rounded by a hash of the card and the
// pixel and rotated by it, so cards seen through one another keep independent footprints.
fn forestLeafSampleMask(alpha:f32,seed:u32,pixel:vec2f,samples:u32)->u32{
 let n=clamp(samples,1u,8u);let p=vec2u(pixel);
 let random=continuumHash(seed^continuumHash(p.x)^continuumHash(p.y*0x9e3779b9u));
 let coverage=clamp(alpha,0.,1.)*f32(n);let whole=u32(floor(coverage));
 let count=min(n,whole+select(0u,1u,fract(coverage)>f32(random&65535u)/65536.));
 let bits=(1u<<count)-1u;let rotation=(random>>16u)%n;
 return ((bits<<rotation)|(bits>>(n-rotation)))&((1u<<n)-1u);
}
// A crown is lit as the leaves it stands for, not as the surface it is. Each leaf is lit by its own normal, turned
// to face the viewer, and shows its underside from below; the leaves of a bough face much the same way (leaves) and
// differ by a known spread (FOREST_CROWN_ALIKE, the length of their mean). Eight leaves about that mean, each counted
// by how much of it the viewer sees, give the light and colour a pixel full of them would average to.
const FOREST_CROWN_ALIKE=.7;
const FOREST_CROWN_RING=array<vec2f,8>(
 vec2f(.92387953,.38268343),vec2f(.38268343,.92387953),vec2f(-.38268343,.92387953),vec2f(-.92387953,.38268343),
 vec2f(-.92387953,-.38268343),vec2f(-.38268343,-.92387953),vec2f(.38268343,-.92387953),vec2f(.92387953,-.38268343));
struct ForestCrownLight {colour:vec3f,light:vec2f,finish:vec2f,normal:vec3f};
fn forestCrownLight(world:vec3f,leaves:vec3f,outward:vec3f,colour:vec3f,exposure:f32,escape:f32,transmission:f32,roughness:f32,underside:vec3f)->ForestCrownLight{
 let view=normalize(continuumEye()-world);let middle=normalize(leaves);
 let side=normalize(cross(middle,select(vec3f(1.,0.,0.),vec3f(0.,0.,1.),abs(middle.x)>.9)));let other=cross(middle,side);
 let spread=sqrt(1.-FOREST_CROWN_ALIKE*FOREST_CROWN_ALIKE);
 let moonDir=lunarDirection();
 var weight=0.;var gain=vec3f(0.);var lit=vec3f(0.);var mean=vec3f(0.);var level=0.;var moon=0.;
 for(var k=0;k<8;k++){
  let cs=FOREST_CROWN_RING[k];
  var n=middle*FOREST_CROWN_ALIKE+(side*cs.x+other*cs.y)*spread;
  let facing=dot(n,view);let seen=abs(facing);
  if(facing<0.){n=-n;}
  let nDotL=dot(n,F.sunDir.xyz);let backlit=max(-nDotL,0.)*transmission;
  let tint=select(underside,vec3f(1.),facing>=0.)*mix(vec3f(1.),vec3f(1.12,1.16,.78),backlit*exposure);
  gain+=tint*seen;lit+=tint*(seen*(max(nDotL,0.)+backlit));mean+=n*seen;level+=abs(n.y)*seen;moon+=max(dot(n,moonDir),0.)*seen;weight+=seen;
 }
 weight=max(weight,1e-4);mean/=weight;
 let luma=vec3f(.2126,.7152,.0722);
 var o:ForestCrownLight;
 o.colour=colour*gain/weight;
 o.light=vec2f(dot(lit,luma)/max(dot(gain,luma),1e-4)*(.22+.78*exposure*exposure)*(.35+.65*escape),(.12+exposure*.56+level/weight*.09)*escape);
 let rough=clamp(roughness,.24,.92);
 // Leaves this small show no highlight of their own; a wet leaf's darker colour stays.
 o.finish=vec2f(clamp((1.-rough)*.42*(.35+.65*exposure),0.,.36),max(rough,.8));
 // By night the moon is the light that matters, and the normal is turned to give the leaves' own share of it.
 var night=mean;let low=length(moonDir.xz);
 if(low>.05){let along=clamp((moon/weight-mean.y*moonDir.y)/low,-1.,1.);night=vec3f(moonDir.x/low*along,mean.y,moonDir.z/low*along);}
 o.normal=mix(mean,night,1.-smoothstep(-.12,.02,F.sunDir.y));
 // A crown is a rounded body as well as a mass of leaves: darker on the side it turns from the sun, its underside
 // seeing less sky than its top. Over a whole crown both average to one.
 o.light*=vec2f(mix(.68,1.36,smoothstep(-.45,.75,dot(outward,F.sunDir.xyz))),mix(.8,1.2,outward.y*.5+.5));
 return o;
}
// Value noise on a lattice fixed to the ground, between -1 and 1.
fn forestCrownLattice(p:vec3f)->f32{
 let i=vec3i(floor(p));let f=fract(p);let u=f*f*(3.-2.*f);var sum=0.;
 for(var k=0;k<8;k++){
  let corner=vec3i(k&1,(k>>1)&1,k>>2);let q=bitcast<vec3u>(i+corner);
  let h=continuumHash((q.x*0x8da6b343u)^continuumHash((q.y*0xd8163841u)^continuumHash(q.z*0xcb1ab31fu)));
  let w=mix(vec3f(1.)-u,u,vec3f(corner));
  sum+=w.x*w.y*w.z*f32(h&65535u)/65535.;
 }
 return sum*2.-1.;
}
// Sprays of leaves catch the light or fall into the next one's shade, and whole boughs stand lighter or darker: two
// sizes of that unevenness, each fading out as it shrinks below what a pixel can show.
fn forestCrownMottle(world:vec3f)->f32{
 let pixel=length(continuumEye()-world)*2.*length(F.camUp.xyz)/max(F.screen.y,1.);
 let spray=forestCrownLattice(world/1.1)*.26*(1.-smoothstep(.3,.8,pixel/1.1));
 let bough=forestCrownLattice(world/3.4+vec3f(17.3,5.1,9.7))*.16*(1.-smoothstep(.3,.8,pixel/3.4));
 return 1.+spray+bough;
}
// The surface lies just inside its outermost leaves, which the land's shadow map holds: its shadow is looked up beyond them.
const FOREST_CROWN_SHADOW_LIFT=.45;
// A far triangle's word and a splat's: leaf | layer << 1 | exposure << 5 | canopy light << 11 | colour << 17.
struct ForestFarLook {leaf:bool,layer:u32,exposure:f32,escape:f32,colour:vec3f};
fn forestFarLook(word:u32)->ForestFarLook{
 var o:ForestFarLook;
 o.leaf=(word&1u)!=0u;o.layer=(word>>1u)&15u;o.exposure=f32((word>>5u)&63u)/63.;o.escape=f32((word>>11u)&63u)/63.;
 let root=vec3f(f32((word>>17u)&31u),f32((word>>22u)&31u),f32((word>>27u)&31u))/31.;
 o.colour=root*root;
 return o;
}
fn forestContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>){
 let tint=unpack4x8unorm(s.record.spare.x).rgb*2.0;
 let first=continuumType(s.model,${M.firstLayer}u);
 let data=continuumKindData(s.record);
 (*v).seed=continuumHash(s.vertex^(s.record.tag.z*0x9e3779b9u));
 (*v).uv=vec2f(0.0);(*v).surface=vec4f(0.0);(*v).crown=vec4f(0.0);
 if(s.what==CONTINUUM_CLUSTER_ENTRY){
  let layer=s.high&15u;let leaf=(s.high>>4u)&1u;
  let word=unpack4x8unorm(s.word);
  let uvLow=vec2f(continuumTypeF(s.model,${M.uvLow}u),continuumTypeF(s.model,${M.uvLow + 1}u));
  let uvScale=vec2f(continuumTypeF(s.model,${M.uvScale}u),continuumTypeF(s.model,${M.uvScale + 1}u));
  (*v).uv=uvLow+continuumUV(s.vertex)*uvScale;
  let textured=layer!=${FOREST_CONTINUUM_UNTEXTURED}u;
  // The maps carry a textured surface's colour; the pack's vertex colour stands for one without.
  (*v).colour=select(word.rgb*word.rgb,vec3f(1.0),textured)*tint;
  // Raw wood where a ball gouged the trunk, and about the break of one felled.
  var raw=0.0;
  if(leaf==0u){
   let form=u32(round(continuumPoses[data].w));
   if(form==${F.WOUNDED}u){raw=continuumWindWound(data,s.local,continuumQuat(vec4f(-s.record.turn.xyz,s.record.turn.w),s.normal));}
   else if(form==${F.FELLED}u){
    // About the break: the height each point stood at before it fell (what lies below the hinge never moved).
    let held=continuumPoses[data+1u];let hinge=vec3f(0.0,held.x,0.0);
    let stood=hinge+continuumWindFall(s.local-hinge,held.y,-held.z);
    raw=1.0-smoothstep(0.0,.7,abs(select(s.local.y,stood.y,s.local.y>held.x||stood.y>held.x)-held.x));
   }
  }
  (*v).surface=vec4f(f32((s.high>>5u)&255u)/255.,word.a,raw,0.0);
  (*v).layer=select(FOREST_UNTEXTURED,first+layer,textured)|(leaf<<16u);
  return;
 }
 // The far body and the splat: a crown of leaves, or the bare wood below it.
 var look:ForestFarLook;
 if(s.what==CONTINUUM_FAR_ENTRY){look=forestFarLook(s.word);}else{look=forestFarLook(continuumType(s.model,${M.splat}u));}
 let textured=look.layer!=${FOREST_CONTINUUM_UNTEXTURED}u;
 let material=forestNativeMaterials[select(0u,first+look.layer,textured)];
 var colour=look.colour;
 if(textured){colour=forestNativeMean(material);}
 colour*=tint;
 (*v).layer=FOREST_UNTEXTURED;
 if(!look.leaf){
  let n=s.normal;
  (*v).colour=colour;
  (*v).crown=vec4f(max(dot(n,F.sunDir.xyz),0.)*(.35+.65*look.escape),(.36+max(n.y,0.)*.25)*look.escape,0.,.95);
  return;
 }
 var outward=s.normal;
 if(s.what==CONTINUUM_SPLAT_ENTRY){
  // The splat is a dome toward the eye: its corners lean out from the middle as a crown's sides do.
  let toEye=s.normal;let up=normalize(vec3f(0.0,1.0,0.0)-toEye*toEye.y+vec3f(0.0,1e-4,0.0));let right=cross(up,toEye);
  outward=normalize(toEye*.68+right*(s.corner.x*.79*.52)+up*(s.corner.y*.79*.56));
 }
 // A leaf's underside, as its maps' optics give it, against its face.
 let under=mix(vec3f(1.0),clamp(forestNativeLinear(material.underside.rgb)/max(colour,vec3f(1e-3)),vec3f(0.0),vec3f(8.0)),select(0.0,material.optics.y,textured));
 let lit=forestCrownLight(s.world,normalize(outward+vec3f(0.,.35,0.)),outward,colour,look.exposure,look.escape,material.optics.z,material.optics.x,under);
 (*v).colour=lit.colour;(*v).normal=lit.normal;(*v).crown=vec4f(lit.light,lit.finish);
 (*v).surface=vec4f(look.exposure,1.0,0.0,0.0);
}
fn forestContinuumShade(v:ContinuumVarying,front:bool)->vec4f{
 let dx=dpdx(v.world);let dy=dpdy(v.world);let ux=dpdx(v.uv);let uy=dpdy(v.uv);
 let toEye=continuumEye()-v.world;let viewDist=length(toEye);
 var n=normalize(v.normal);var colour=v.colour;var diffuse=0.0;var ambient=0.0;var wet=0.0;var roughness=.9;
 var shadowAt=v.world;
 let exposure=clamp(v.surface.x,0.,1.);
 if(v.coverage.x!=CONTINUUM_CLUSTER_ENTRY){
  // A crown, each face by its own plane, mottled as its leaves would be.
  let across=cross(dx,dy);
  let outward=normalize(across*select(-1.,1.,dot(across,toEye)>=0.)+toEye*1e-9);
  shadowAt=v.world+outward*FOREST_CROWN_SHADOW_LIFT;
  let mottle=mix(1.,forestCrownMottle(v.world),clamp(v.surface.y,0.,1.));
  // An edge-on triangle's pixel reads its varyings from past its corners: each is held to what a leaf can be.
  let span=dot(v.normal,v.normal);
  n=select(outward,v.normal*inverseSqrt(max(span,1e-12)),span>1e-6&&span<1e6);
  colour=clamp(v.colour,vec3f(0.),vec3f(4.));let light=clamp(v.crown.xy,vec2f(0.),vec2f(4.,1.));
  let finish=clamp(v.crown.zw,vec2f(0.,.05),vec2f(1.));
  diffuse=light.x*mottle;ambient=light.y*mix(1.,mottle,.6);wet=finish.x;roughness=finish.y;
 }else{
  let layer=v.layer&0xffffu;let leaf=(v.layer>>16u)!=0u;let textured=layer!=FOREST_UNTEXTURED;
  let material=forestNativeMaterials[select(0u,layer,textured)];
  var surface=forestReadNative(material,v.uv,ux,uy);
  if(!textured){surface.pigment=vec4f(1.);surface.detail=vec4f(0.,0.,1.,.9);}
  let canopy=clamp(v.surface.y,0.,1.);
  if(!leaf){
   // Bark: its maps, its grain close to, raw where shot has opened it.
   let pale=v.colour*vec3f(2.7,2.2,1.5)+vec3f(.07,.055,.03);
   colour=forestOwnColour(surface.pigment)*mix(v.colour,pale,clamp(v.surface.z,0.,1.));
   let barkClose=1.-smoothstep(8.,32.,viewDist);
   var detailVec=surface.detail.xyz*vec3f(1.25+0.35*barkClose,1.25+0.35*barkClose,1.0);
   if(barkClose>0.001){
    let grainU=v.uv.x*46.0+sin(v.uv.y*9.5)*1.4;let grainV=v.uv.y*18.0;
    let fissure=sin(grainU)*0.65+sin(grainU*2.3+grainV*0.7)*0.35;
    let plate=cos(grainU)*0.65+cos(grainU*2.3+grainV*0.7)*0.35;
    detailVec.x+=plate*0.18*barkClose;detailVec.y+=sin(grainV*2.1+grainU*0.4)*0.08*barkClose;
    colour*=1.0+fissure*0.055*barkClose;
   }
   n=forestMappedNormal(n,detailVec,dx,dy,ux,uy)*select(-1.,1.,front);
   roughness=clamp(surface.detail.a/max(surface.pigment.a,FOREST_THINNEST_COVERAGE),0.22,0.98);
   wet=clamp(material.coordinates.w*(1.0-roughness),0.0,0.28);
   // The light the specimen's own canopy lets through (not a sun shadow: the land's and the clouds' stay).
   let woodAO=min(canopy,select(1.0,mix(0.30,1.0,exposure),canopy>0.995&&exposure<0.995));
   diffuse=max(dot(n,F.sunDir.xyz),0.)*(.35+.65*woodAO);ambient=(.36+max(n.y,0.)*.25)*woodAO;
  }else{
   let pigment=surface.pigment;
   colour=forestOwnColour(pigment)*v.colour;
   let uvOff=v.uv-vec2f(.5,.5);
   let mappedN=forestMappedNormal(n,surface.detail.xyz*vec3f(1.35,1.35,1.0),dx,dy,ux,uy)*select(-1.,1.,front);
   n=normalize(mappedN+vec3f(uvOff.x*0.06,uvOff.y*0.05,0.0));
   var rawRough=surface.detail.a/max(pigment.a,FOREST_THINNEST_COVERAGE);
   if(viewDist<38.){
    let bot=forestBotanicalDetail(v.uv,viewDist,pigment.a);
    let tDir=normalize(dx+vec3f(1e-5,0.,0.));let bDir=normalize(dy+vec3f(0.,0.,1e-5));
    n=normalize(n+(tDir*bot.y+bDir*bot.z)*0.28);
    colour*=vec3f(1.+bot.w*.07,1.+bot.w*.10,1.-bot.w*.05);
    rawRough=clamp(rawRough-bot.w*.08,0.22,0.92);
   }
   if(!front){colour=mix(colour,forestNativeLinear(material.underside.rgb)*v.colour,material.optics.y);}
   let nDotL=dot(n,F.sunDir.xyz);
   let backlit=max(-nDotL,0.)*material.optics.z;
   colour=colour*mix(vec3f(1.0),vec3f(1.12,1.18,0.72),backlit*exposure);
   diffuse=(max(nDotL,0.)+backlit)*(.22+.78*exposure*exposure)*(.35+.65*canopy);
   ambient=(.12+exposure*.56+abs(n.y)*.09)*canopy;
   roughness=clamp(rawRough,0.24,0.92);
   wet=clamp((1.0-roughness)*0.42*(0.35+0.65*exposure),0.0,0.36);
  }
 }
 return landFinishShadowed(v.world,n,colour,diffuse,ambient,wet,roughness,landShadowVisibility(shadowAt,select(n,normalize(shadowAt-v.world+n*1e-6),v.coverage.x!=CONTINUUM_CLUSTER_ENTRY)));
}
// A leaf card's cut: the samples its coverage takes, nearer leaves reading coverage half a level finer, which shows
// their shapes, and far ones a little fuller, as a canopy's many small gaps close at a distance. Bark, the far body
// and the splat cover every sample.
fn forestContinuumCoverage(v:ContinuumVarying,front:bool)->u32{
 let ux=dpdx(v.uv);let uy=dpdy(v.uv);
 let layer=v.layer&0xffffu;
 if(v.coverage.x!=CONTINUUM_CLUSTER_ENTRY||(v.layer>>16u)==0u||layer==FOREST_UNTEXTURED){return 0xffffffffu;}
 let viewDist=length(continuumEye()-v.world);
 let near=mix(.7,1.,smoothstep(30.,90.,viewDist));
 let rawAlpha=forestNativeAlbedoOnly(forestNativeMaterials[layer],v.uv,ux*near,uy*near).a;
 let crisp=select(rawAlpha,forestBotanicalDetail(v.uv,viewDist,rawAlpha).x,viewDist<38.);
 return forestLeafSampleMask(clamp(crisp*mix(1.,2.25,smoothstep(45.,220.,viewDist)),0.,1.),v.seed,v.position.xy,v.coverage.w);
}
`;
};

// The forest's material (js/wgsl/continuum-cut.js), shaded with the land's module source (js/wgsl/terrain.js TERRAIN as
// the terrain draws it), which holds the shared core, the frame and the land's finish (groups 0 and 1).
export function forestContinuumMaterial(landSource) {
  return Object.freeze({
    name: 'forestContinuum', prelude: () => landSource, core: true, data: FOREST_CONTINUUM_DATA,
    varyings: [['uv', 'vec2f'], ['colour', 'vec3f'], ['surface', 'vec4f'], ['crown', 'vec4f'], ['layer', 'u32', true], ['seed', 'u32', true]],
    wgsl: forestContinuumMaterialWGSL, salt: 3,
    // Leaf cards are seen from both sides; the far body's back faces are its far side's leaves.
    cullMode: 'none', air: false, capture: false, coverage: true,
  });
}
