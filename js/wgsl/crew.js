import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_SAMPLE, SHADOW_FRAME } from './shadows.js';
import { DRESS_MASK_SCALE } from '../indigenous-dress.js';
import { CREW_JOINT_COUNT, CREW_REST_MALE_PLACES, CREW_REST_FEMALE_PLACES } from '../crew-skeleton.js';

// The captain's painted texture is read a third of a mip level sharper than its footprint: 2^-0.35 of it.
const CAPTAIN_TEXTURE_SHARPEN = (2 ** -0.35).toFixed(4);
// How much of the light a shirt of some colour throws back, a captain's coat of that colour does.
const CAPTAIN_COAT_DEPTH = 0.3;

// Where each joint of the crew skeleton is at rest on the male and female bodies, as WGSL array members.
const crewRestPlacesWgsl = (places) => places.map(([x, y, z]) => `vec3f(${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)})`).join(',');

export const CREW_JOINT_BLEND_WGSL = /* wgsl */ `
const CREW_REST_MALE=array<vec3f,${CREW_JOINT_COUNT}>(${crewRestPlacesWgsl(CREW_REST_MALE_PLACES)});
const CREW_REST_FEMALE=array<vec3f,${CREW_JOINT_COUNT}>(${crewRestPlacesWgsl(CREW_REST_FEMALE_PLACES)});
fn crewRestJoint(joint:u32,isFemale:bool)->vec3f {
  let j=min(joint,${CREW_JOINT_COUNT - 1}u);
  return select(CREW_REST_MALE[j],CREW_REST_FEMALE[j],isFemale);
}
fn crewRestJointMid(joint:u32)->vec3f {
  let j=min(joint,${CREW_JOINT_COUNT - 1}u);
  return 0.5*(CREW_REST_MALE[j]+CREW_REST_FEMALE[j]);
}
fn crewRotVec(v:vec3f,axis:vec3f,ca:f32,sa:f32)->vec3f {
  return v*ca+cross(axis,v)*sa+axis*(dot(axis,v)*(1.0-ca));
}
fn crewOrthonormal3x3(m:mat4x4f)->mat3x3f {
  let c0=m[0].xyz;let c1=m[1].xyz;let c2=m[2].xyz;
  let l0=dot(c0,c0);
  let u0=select(vec3f(1.0,0.0,0.0),c0*inverseSqrt(max(l0,1e-8)),l0>1e-8);
  let p1=c1-u0*dot(c1,u0);
  let l1=dot(p1,p1);
  var fb=cross(u0,select(vec3f(0.0,1.0,0.0),vec3f(0.0,0.0,1.0),abs(u0.y)>0.9));
  fb=fb*inverseSqrt(max(dot(fb,fb),1e-8));
  let u1=select(fb,p1*inverseSqrt(max(l1,1e-8)),l1>1e-8);
  let hand=select(1.0,-1.0,dot(cross(c0,c1),c2)<0.0);
  return mat3x3f(u0,u1,cross(u0,u1)*hand);
}
// Closed-form SO(3) polar orthonormalization + antipodal Rodrigues fallback + rest-pivot compensation,
// preserving intended bone column scales while preventing mid-frame rotation shrinkage.
fn crewBlendJoint(a:mat4x4f,b:mat4x4f,t:f32,pivot:vec3f)->mat4x4f {
  if(t<=0.0){return a;}
  if(t>=1.0){return b;}
  let a0=a[0].xyz;let a1=a[1].xyz;let a2=a[2].xyz;
  let b0=b[0].xyz;let b1=b[1].xyz;let b2=b[2].xyz;
  let ia0=inverseSqrt(max(dot(a0,a0),1e-8));let ia1=inverseSqrt(max(dot(a1,a1),1e-8));let ia2=inverseSqrt(max(dot(a2,a2),1e-8));
  let ib0=inverseSqrt(max(dot(b0,b0),1e-8));let ib1=inverseSqrt(max(dot(b1,b1),1e-8));let ib2=inverseSqrt(max(dot(b2,b2),1e-8));
  let s0=mix(1.0/ia0,1.0/ib0,t);let s1=mix(1.0/ia1,1.0/ib1,t);let s2=mix(1.0/ia2,1.0/ib2,t);
  let na0=a0*ia0;let na1=a1*ia1;let na2=a2*ia2;
  let nb0=b0*ib0;let nb1=b1*ib1;let nb2=b2*ib2;
  let hand=select(1.0,-1.0,dot(cross(na0,na1),na2)<0.0);
  let m0=mix(na0,nb0,t);let m1=mix(na1,nb1,t);let m2=mix(na2,nb2,t);
  let c0=cross(m1,m2);let c1=cross(m2,m0);
  let det=dot(m0,c0)*hand;
  var u0:vec3f;var u1:vec3f;
  if(det>1e-6){
    let r=sqrt(det);
    let p0=m0*r+c0*hand;
    let p1=m1*r+c1*hand;
    u0=p0*inverseSqrt(max(dot(p0,p0),1e-8));
    let ortho1=p1-u0*dot(p1,u0);
    u1=ortho1*inverseSqrt(max(dot(ortho1,ortho1),1e-8));
  }else{
    let sA0=na0+nb0;let sA1=na1+nb1;let sA2=na2+nb2;
    let d0=dot(sA0,sA0);let d1=dot(sA1,sA1);let d2=dot(sA2,sA2);
    var ax=select(sA2,sA1,d1>=d2);
    ax=select(ax,sA0,d0>=max(d1,d2));
    let la=dot(ax,ax);
    ax=select(vec3f(0.0,1.0,0.0),ax*inverseSqrt(max(la,1e-8)),la>1e-8);
    let ang=t*3.14159265;let ca=cos(ang);let sa=sin(ang);
    u0=crewRotVec(na0,ax,ca,sa);
    let r1=crewRotVec(na1,ax,ca,sa);
    let ortho1=r1-u0*dot(r1,u0);
    u1=ortho1*inverseSqrt(max(dot(ortho1,ortho1),1e-8));
  }
  let u2=cross(u0,u1)*hand;
  let q0=u0*s0;let q1=u1*s1;let q2=u2*s2;
  let lin0=mix(a0,b0,t);let lin1=mix(a1,b1,t);let lin2=mix(a2,b2,t);let lin3=mix(a[3].xyz,b[3].xyz,t);
  let q3=lin3+(lin0-q0)*pivot.x+(lin1-q1)*pivot.y+(lin2-q2)*pivot.z;
  return mat4x4f(vec4f(q0,0.0),vec4f(q1,0.0),vec4f(q2,0.0),vec4f(q3,1.0));
}
`;

export const CREW_SKIN = CREW_JOINT_BLEND_WGSL + /* wgsl */ `
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
  let b=v.bones+vec4u(v.instance*${CREW_JOINT_COUNT}u);
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
// look says which they wear: either bit-packed with the local moisture slot when hair.w < 0, or in
// the fraction of hair.w when hair.w >= 0.
fn crewDressOf(hairW:f32)->u32 {
  if(hairW<0.0){return bitcast<u32>(hairW)&0x3ffffu;}
  return u32(fract(hairW)*${DRESS_MASK_SCALE}.0+.5);
}
fn crewMoistureBase(hairW:f32)->u32 {
  if(hairW<0.0){return (bitcast<u32>(hairW)>>18u)&0x7ffu;}
  return u32(hairW);
}
fn crewPieceHidden(color:vec3f,dress:u32)->bool {
  let piece=u32(color.r*.5);
  return piece>0u&&((dress>>(piece-1u))&1u)==0u;
}
fn crewCompMask(faceW:f32)->u32 {return select(0u,u32((-faceW)*.5),faceW<0.0);}
fn crewEyeOpen(faceW:f32)->f32 {
  if(faceW<0.0){let raw=-faceW;return raw-f32(u32(raw*.5))*2.0;}
  return select(faceW,faceW-2.0,faceW>1.5);
}
fn crewCompHidden(color:vec3f,compMask:u32)->bool {
  let comp=u32(color.g*.5);
  if(comp==0u){return false;}
  let hair=compMask&7u;
  let hat=(compMask>>3u)&7u;
  let beard=(compMask>>6u)&3u;
  let gar=(compMask>>8u)&7u;
  if(comp<=5u){
    if(comp!=hair){return true;}
    if(hat==3u){return true;}
    if(hat==1u){return comp!=3u;}
    if(hat==2u||hat==4u){return comp==1u||comp==5u;}
    return false;
  }
  if(comp<=9u){return hat==0u||comp!=5u+hat;}
  if(comp<=12u){return beard==0u||comp!=9u+beard;}
  return gar==0u||comp!=12u+gar;
}
const CREW_PIECE_OUT=vec3f(0.0,1.62,0.0);
// The whole part of skin.w says whose body this is: 0 a man's, 1 a woman's, 2 a woman captain in the captain's body,
// which is built on the man's and so takes the man's face.
fn crewSurface(v:CrewInput)->CrewSurface {
  let actor=actors[v.instance];
  if(crewPieceHidden(v.color,crewDressOf(actor.hair.w))){return CrewSurface(CREW_PIECE_OUT,v.normal);}
  return crewMorph(v.position,v.normal,actor.face,select(0.0,1.0,actor.skin.w>.5&&actor.skin.w<1.5));
}
fn crewMorph(p:vec3f,normal:vec3f,f:vec4f,sex:f32)->CrewSurface {
  let headY=select(1.600,1.550,sex>.5);
  let build=(crewCompMask(f.w)>>11u)&3u;
  if(p.y<=headY+.015){
    if(build==0u||p.y<=.68||p.y>=1.40||abs(p.x)>=.25){return CrewSurface(p,normal);}
    let env=crewRamp(.68,.86,p.y).x*(1.0-crewRamp(1.24,1.40,p.y).x)*(1.0-crewRamp(.20,.25,abs(p.x)).x);
    let sx=select(select(.11,-.085,build==1u),.095*crewRamp(.84,1.18,p.y).x,build==2u);
    let sz=select(select(.10,-.095,build==1u),.075,build==2u);
    let belly=select(0.0,.030*smoothstep(-.02,.08,p.z)*(1.0-crewRamp(1.06,1.24,p.y).x),build==3u);
    let qx=p.x*(1.0+sx*env);
    let qz=-0.025+(p.z+0.025)*(1.0+sz*env)+belly*env;
    let nrm=normalize(vec3f(normal.x/(1.0+sx*env),normal.y,normal.z/(1.0+sz*env)));
    return CrewSurface(vec3f(qx,p.y,qz),nrm);
  }
  let eyeY=select(1.666,1.612,sex>.5);
  let head=crewRamp(headY+.015,headY+.065,p.y);
  let jaw=vec2f(1,0)-crewRamp(headY+.06,headY+.13,p.y);
  let width=1.0+head.x*((f.x-1.0)+(f.y-1.0)*jaw.x);
  let widthY=head.y*((f.x-1.0)+(f.y-1.0)*jaw.x)+head.x*(f.y-1.0)*jaw.y;
  let nx=vec2f(1,0)-crewRamp(.012,.045,abs(p.x));
  let ny0=crewRamp(eyeY-.065,eyeY-.025,p.y);
  let ny1=vec2f(1,0)-crewRamp(eyeY+.005,eyeY+.04,p.y);
  let nz=crewRamp(.045,.085,p.z);
  let nose=nx.x*ny0.x*ny1.x*nz.x;
  let noseD=vec3f(nx.y*sign(p.x)*ny0.x*ny1.x*nz.x,
    nx.x*(ny0.y*ny1.x+ny0.x*ny1.y)*nz.x,nx.x*ny0.x*ny1.x*nz.y);
  let noseScale=f.z*0.35;
  let ex0=crewRamp(.015,.026,abs(p.x));
  let ex1=vec2f(1,0)-crewRamp(.058,.080,abs(p.x));
  let ey=vec2f(1,0)-crewRamp(.016,.040,abs(p.y-eyeY));
  let ez=crewRamp(.015,.055,p.z);
  let eye=ex0.x*ex1.x*ey.x*ez.x;
  let eyeD=vec3f((ex0.y*ex1.x+ex0.x*ex1.y)*sign(p.x)*ey.x*ez.x,
    ex0.x*ex1.x*ey.y*sign(p.y-eyeY)*ez.x,ex0.x*ex1.x*ey.x*ez.y);
  let eyeOpen=1.0+(crewEyeOpen(f.w)-1.0)*0.35;
  let eyeShift=(p.y-eyeY)*(eyeOpen-1.0);
  let eyeGradient=eyeShift*eyeD+vec3f(0,(eyeOpen-1.0)*eye,0);
  // Columns of the deformation Jacobian; cofactor columns transform normals.
  let dx=vec3f(width,eyeGradient.x,noseScale*noseD.x);
  let dy=vec3f(p.x*widthY,1.0+eyeGradient.y,noseScale*noseD.y);
  let dz=vec3f(0,eyeGradient.z,1.0+noseScale*noseD.z);
  let morphed=normalize(cross(dy,dz)*normal.x+cross(dz,dx)*normal.y+cross(dx,dy)*normal.z);
  return CrewSurface(vec3f(p.x*width,p.y+eyeShift*eye,p.z+noseScale*nose),morphed);
}
`;
export const CAPTAIN_OWN_COLOURS = /* wgsl */ `
// The 1550 officer mesh carries crisp baked velvet, gold embroidery, white linen ruff/cuffs, leather boots, and a
// clean-shaven bald head whose true flesh vertices are flagged in v.skin. Skin is recoloured uniformly from its
// measured linear median so faces and necks stay seamless (with sculpted 3D hair/beards attached separately), while
// the deep crimson velvet doublet body takes a subtle tint of the actor's shirt colour without staining gold trim.
fn captainOwnColours(paint:vec3f,p:vec3f,flagged:f32,skin:vec4f,hair:vec3f,shirt:vec3f)->vec3f {
  let luma=dot(paint,vec3f(.2126,.7152,.0722));
  // Eye opening on 1550_captain_officer_bald.glb sits around (|x| ~ 0.0248, y ~ 1.6365, z > 0.050) and has low R-G warmth compared to skin.
  let eyeDist=length(vec2f(abs(p.x)-0.0248,(p.y-1.6365)*1.30));
  let rgWarmth=(paint.r-paint.g)/max(paint.r,1e-4);
  let inEyeOpening=step(0.050,p.z)*(1.0-smoothstep(0.0115,0.0155,eyeDist))*(1.0-smoothstep(0.28,0.44,rgWarmth));
  let skinMask=clamp(flagged,0.0,1.0)*(1.0-inEyeOpening);
  // Normalize painted skin against 1550_captain_officer_bald.glb's measured linear skin median (.5711, .2346, .1620).
  let lit=paint/vec3f(.5711,.2346,.1620);
  let shadeL=clamp(dot(lit,vec3f(.299,.587,.114)),.52,1.24);
  let skinShade=mix(vec3f(shadeL),clamp(lit,vec3f(.48),vec3f(1.26)),.28);
  // Eyebrows on the upper face tint gently toward the captain's hair.
  let browMask=(1.0-skinMask)*(1.0-inEyeOpening)*smoothstep(1.644,1.654,p.y)*(1.0-smoothstep(1.682,1.696,p.y))*smoothstep(.045,.072,p.z)*(1.0-smoothstep(.055,.11,luma));
  // Preserve the rich Renaissance crimson velvet & gold embroidery, adding only a subtle personal coat undertone.
  let redRatio=paint.r/max(paint.g,1e-4);
  let onDoublet=(1.0-skinMask)*smoothstep(.74,.79,p.y)*(1.0-smoothstep(1.40,1.45,p.y));
  let isVelvet=onDoublet*smoothstep(2.5,3.8,redRatio)*(1.0-smoothstep(.045,.095,luma));
  let coatTint=shirt*(${CAPTAIN_COAT_DEPTH}*clamp(luma/.0145,.45,1.45));
  var worn=mix(paint,mix(paint,coatTint,.12),isVelvet);
  worn=mix(worn,hair*clamp(luma/.032,.45,1.5),browMask*.65);
  // Natural shadowed sclera + rich dark brown iris + pupil strictly inside the low-warmth eye opening.
  if(inEyeOpening>0.01){
    let sclera=vec3f(0.058,0.052,0.048)*clamp(0.75+luma*0.7,0.65,1.15);
    let irisMask=1.0-smoothstep(0.0068,0.0092,eyeDist);
    let pupilMask=1.0-smoothstep(0.0032,0.0048,eyeDist);
    var eyeCol=mix(sclera,vec3f(0.018,0.010,0.006),irisMask);
    eyeCol=mix(eyeCol,vec3f(0.003,0.003,0.004),pupilMask);
    worn=mix(worn,eyeCol,inEyeOpening);
  }
  return mix(worn,skin.rgb*skinShade,skinMask);
}
`;
// Shading never discards, so the GPU shades only what shows: people are drawn opaque through the one continuum
// (js/wgsl/crew-continuum.js), however near the eye stands.
// How much of the light on dry cloth it throws back toward a grazing eye. Skin has none of it, and nor has a hull.
export const CREW_CLOTH_SHEEN = 0.045;
// The crew's shading. The sheen is a parameter so that a test can take the cloth's own lobe away and hold everything
// else to the vessel's lighting, term for term.
export const crewRenderWGSL = (clothSheen = CREW_CLOTH_SHEEN) => FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + CREW_SKIN + CAPTAIN_OWN_COLOURS + SHADOW_SAMPLE + SKY_RENDER_FUNCS + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(8) var<storage,read> moisture:array<vec2f>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(13) var captainTex:texture_2d<f32>;
@group(0) @binding(14) var captainSampler:sampler;
// Centroid, because a sliver of limb can cover a sample and miss the pixel's centre. Read at the
// centre, its values are extrapolated far past any its corners hold, and skin at -7 divides by zero
// in the wrap below: one sample of a distant figure then blazes at the top of the half-float range.
struct CrewVertex {
  @invariant @builtin(position) position:vec4f, @location(0) @interpolate(perspective,centroid) world:vec3f,
  @location(1) @interpolate(perspective,centroid) normal:vec3f, @location(2) @interpolate(perspective,centroid) color:vec3f,
  @location(4) @interpolate(perspective,centroid) wet:vec2f, @location(5) @interpolate(perspective,centroid) skin:f32,
  @location(6) @interpolate(perspective,centroid) bodyPos:vec3f, @location(7) @interpolate(flat) damage:vec3f,
  @location(8) @interpolate(flat) paint:u32, @location(9) @interpolate(flat) actor:u32
};
// The model's colours are placeholders for what this person wears: rgb, and whether it is skin.
fn crewClothed(tagged:vec3f,p:vec3f,shirt:vec3f,trousers:vec3f,skin:vec3f,hair:vec3f,isIndigenous:bool,dress:u32,compMask:u32)->vec4f {
  if(tagged.b<-1.0){
    return vec4f(tagged,select(0.0,1.0,tagged.b<-10.5));
  }
  // A body painted garment by garment: blue's whole part says which, and the colour is how far this
  // point departs from that garment's typical colour, so folds and faces survive any cloth or skin.
  let garment=u32(tagged.b*.5);
  if(garment>0u){
    let piece=u32(tagged.r*.5);
    let comp=u32(tagged.g*.5);
    let rawShade=vec3f(tagged.r-2.0*f32(piece),tagged.g-2.0*f32(comp),tagged.b-2.0*f32(garment));
    let shadeLuma=clamp(dot(rawShade,vec3f(0.299,0.587,0.114)),0.64,1.16);
    let compShade=mix(vec3f(shadeLuma),clamp(rawShade,vec3f(0.62),vec3f(1.18)),select(0.20,0.45,garment==3u));
    let shade=select(rawShade,compShade,comp>0u);
    let bareUpper=garment==1u && (dress&${1 << 14}u)!=0u;
    let bareLower=garment==2u && (dress&${1 << 15}u)!=0u && p.y<0.64;
    let shaved=garment==4u && piece==0u && ((dress&${1 << 12}u)!=0u||((dress&${1 << 13}u)!=0u&&p.z>-.02));
    let asSkin=(garment==3u)||bareUpper||bareLower||shaved;
    var worn=select(select(select(hair,skin,asSkin),trousers,garment==2u&&!asSkin),shirt,garment==1u&&!asSkin);
    if(garment==5u){
      let acc=(compMask>>13u)&3u;
      var pal=select(select(select(vec3f(0.24,0.13,0.065),vec3f(0.38,0.065,0.048),acc==1u),vec3f(0.085,0.125,0.20),acc==2u),vec3f(0.46,0.35,0.19),acc==3u);
      if(comp==9u){pal=select(vec3f(0.14,0.145,0.155),pal*0.65,acc==1u||acc==2u);}
      worn=pal;
    }else if(garment==6u){
      let acc=(compMask>>13u)&3u;
      let rawLinen=vec3f(0.46,0.41,0.33);
      let kerchiefPal=select(select(rawLinen,vec3f(0.36,0.085,0.062),acc==1u),vec3f(0.11,0.16,0.26),acc==2u);
      worn=select(rawLinen,kerchiefPal,comp==8u);
    }
    return vec4f(worn*shade,select(0.0,1.0,asSkin));
  }
  let color=vec3f(tagged.r-2.0*f32(u32(tagged.r*.5)),tagged.gb);
  let isShirt=distance(color,vec3f(.55,.47,.31))<.001;
  let isLower=distance(color,vec3f(.095,.12,.15))<.001;
  let isHair=distance(color,vec3f(.045,.019,.009))<.001;
  let isArmSkin=isIndigenous && isShirt && abs(p.x)>0.145 && p.y>0.84 && p.y<1.46;
  let isCalfSkin=isIndigenous && isLower && p.y>0.19 && p.y<0.58;
  let bareTorso=isShirt && (dress&${1 << 14}u)!=0u;
  let bareLeg=isLower && (dress&${1 << 15}u)!=0u && p.y<0.84;
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
  out.world=p;out.normal=normalize(rotateHull(crewOrthonormal3x3(skin)*surface.normal));
  let actor=actors[v.instance];
  out.bodyPos=v.position;
  let woundAmt=select(clamp(actor.shirt.w/0.45,0.0,1.0),0.0,actor.shirt.w>0.5);
  let scorchAmt=clamp(fract(actor.trousers.w)/0.42,0.0,1.0);
  let bandageSeed=fract(actor.skin.w);
  out.damage=vec3f(woundAmt,scorchAmt,bandageSeed);
  let base=crewMoistureBase(actor.hair.w);let y=v.position.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.48,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.02,1.48,y));
  out.wet=mix(lower,upper,smoothstep(.48,1.02,y));
  let dress=crewDressOf(actor.hair.w);
  let compMask=crewCompMask(actor.face.w);
  let clothed=crewClothed(v.color,v.position,actor.shirt.rgb,actor.trousers.rgb,actor.skin.rgb,actor.hair.rgb,actor.face.w>1.5,dress,compMask);
  out.color=clothed.rgb;out.skin=clothed.w;out.paint=dress>>16u;out.actor=v.instance;
  if(actor.shirt.w>0.5||crewCompHidden(v.color,compMask)){out.position=vec4f(2,2,0,1);}
  return out;
}
// The light a person throws toward the eye, before the air between (the continuum's material veils it as every
// family's is, js/wgsl/crew-continuum.js).
fn crewShadeLit(v:CrewVertex,front:bool,baseIn:vec3f)->vec3f {
  let dPdx=dpdx(v.world);let dPdy=dpdy(v.world);
  let dBpdx=dpdx(v.bodyPos);let dBpdy=dpdy(v.bodyPos);
  let woundAmt=v.damage.x;let scorchAmt=v.damage.y;let bSeed=v.damage.z;
  let bp=v.bodyPos;
  let nHash=fract(sin(dot(bp*vec3f(19.3,27.1,23.7)+vec3f(bSeed*31.0),vec3f(12.9898,78.233,45.164)))*43758.5453);
  let nLow=sin(bp.x*18.0+bSeed*41.0)*cos(bp.y*14.0-bSeed*23.0)*0.5+0.5;
  let nGeom=normalize(v.normal)*select(-1.0,1.0,front);
  let clothGate=(1.0-clamp(v.skin,0.0,1.0))*${(clothSheen / CREW_CLOTH_SHEEN).toFixed(4)};
  let bpFoot=max(length(dBpdx),length(dBpdy));
  let fineFade=(1.0-smoothstep(0.0009,0.0036,bpFoot))*step(1e-6,bpFoot)*clothGate;
  let twillFade=(1.0-smoothstep(0.0035,0.016,bpFoot))*step(1e-6,bpFoot)*clothGate;
  let uWeave=(bp.x+bp.z)*210.0*6.2831853;
  let vWeave=bp.y*210.0*6.2831853;
  let tWeave=(bp.x*44.0-bp.y*36.0+bp.z*40.0)*6.2831853;
  let gradFine=vec3f(cos(uWeave)*210.0,cos(vWeave)*210.0,cos(uWeave)*210.0)*(0.00018*fineFade);
  let gradTwill=vec3f(cos(tWeave)*44.0,-cos(tWeave)*36.0,cos(tWeave)*40.0)*(0.00055*twillFade);
  let gradBp=gradFine+gradTwill;
  let dhdx=dot(gradBp,dBpdx);let dhdy=dot(gradBp,dBpdy);
  let r1=cross(dPdy,nGeom);let r2=cross(nGeom,dPdx);
  let det=dot(dPdx,r1);
  let invDet=1.0/select(max(abs(det),1e-8),-max(abs(det),1e-8),det<0.0);
  let n=normalize(nGeom-(r1*dhdx+r2*dhdy)*select(0.0,invDet,abs(det)>1e-8));
  let clothThreadMod=1.0+(sin(uWeave)*sin(vWeave)*0.032*fineFade+sin(tWeave)*0.022*twillFade);
  let sun=F.sunDir.xyz;
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS-1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS-1}.0).rgb;
  let ambient=vesselAmbient(n,sky,sea);
  let wet=clamp(v.wet,vec2f(0),vec2f(1));
  var baseColor=baseIn*clothThreadMod;
  var roughBias=0.0;
  if(v.paint!=0u&&v.skin>.5){
    // Genipap: dark bands over the body and limbs, the face left clear.
    if((v.paint&1u)!=0u){
      let band=1.0-smoothstep(.2,.3,abs(fract(bp.y*10.0+abs(bp.x)*6.0)-.5));
      baseColor=mix(baseColor,vec3f(.014,.016,.024),band*(1.0-smoothstep(1.38,1.43,bp.y))*.88);
    }
    // Annatto or red earth, in a band across the eyes and cheeks.
    if((v.paint&2u)!=0u){
      let across=smoothstep(1.555,1.575,bp.y)*(1.0-smoothstep(1.665,1.685,bp.y));
      baseColor=mix(baseColor,vec3f(.40,.05,.028),across*.82);
    }
  }
  if(woundAmt>0.15 || scorchAmt>0.10){
    // Linen bandages wrapped around brow/head or forearm/calf on wounded survivors
    let hasHeadBand=bSeed>0.16 && bp.y>1.54 && bp.y<1.69 && bp.z>-0.10;
    let hasArmBand=bSeed>0.05 && abs(bp.x)>0.15 && bp.y>0.88 && bp.y<1.08 && sign(bp.x)==select(-1.0,1.0,bSeed>0.22);
    let hasLegBand=bSeed>0.11 && bp.y>0.22 && bp.y<0.40 && sign(bp.x)==select(1.0,-1.0,bSeed>0.20);
    if(woundAmt>0.25 && woundAmt<0.85 && (hasHeadBand || hasArmBand || hasLegBand)){
      let wrapStripe=sin((bp.y*85.0+bp.x*32.0)*6.283)*0.04;
      var linen=vec3f(0.84,0.80,0.72)+vec3f(wrapStripe);
      let seep=smoothstep(0.58,0.82,nLow+0.25*woundAmt);
      linen=mix(linen,vec3f(0.38,0.035,0.025),seep*0.78);
      baseColor=linen;
      roughBias=0.22;
    }else if(woundAmt>0.15){
      let stainZone=smoothstep(0.42,0.74,nLow+0.30*woundAmt)*smoothstep(0.18,1.55,bp.y);
      let bloodCol=select(vec3f(0.24,0.022,0.016),vec3f(0.34,0.035,0.025),v.skin>0.5);
      baseColor=mix(baseColor,bloodCol,clamp(stainZone*woundAmt*0.84,0.0,0.88));
      roughBias=min(roughBias,-stainZone*woundAmt*0.14);
    }
    if(scorchAmt>0.08){
      let sootMask=smoothstep(0.38,0.76,nLow*0.7+nHash*0.3)*scorchAmt;
      baseColor=mix(baseColor,vec3f(0.065,0.058,0.052),sootMask*0.78);
      roughBias=max(roughBias,sootMask*0.25);
    }
  }
  let albedo=baseColor*mix(1.0,mix(.68,.92,v.skin),wet.x);
  let view=normalize(F.camPos.xyz-v.world);
  let skinAmt=saturate(v.skin);
  // Pre-integrated warm hemoglobin subsurface scatter wrap on skin so facial shadow terminators stay warm and lifelike
  // instead of turning greyish-lavender under cool sky ambient; cloth (skinAmt == 0) keeps the exact vessel lighting.
  let rough=clamp(mix(mix(.92,.72,skinAmt),mix(.55,.40,skinAmt),wet.y)+roughBias,0.08,0.99);
  let wrapRGB=vec3f(.38,.22,.14)*skinAmt;
  let ndlRaw=dot(n,sun);
  let diffRGB=max(vec3f(0.0),(vec3f(ndlRaw)+wrapRGB)/(vec3f(1.0)+wrapRGB))/(vec3f(1.0)+wrapRGB);
  let skinAmb=mix(ambient,ambient*vec3f(1.08,1.00,0.90),skinAmt*0.45);
  let f0=mix(vec3f(.04),vec3f(.028),skinAmt);
  let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS-1}.0).rgb;
  let grazing=1.0-clamp(dot(n,view),0.0,1.0);
  let clothSheen=grazing*grazing*grazing*grazing*(1.0-skinAmt)*(1.0-wet.x*0.7)*${clothSheen.toFixed(4)};
  let col=lunarSurface(n,view,albedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,albedo,rough)+gunFlashSurface(v.world,n,view,albedo,rough)+worldFireSurface(v.world,n,view,albedo,rough)+albedo*(direct*(diffRGB/PI+vec3f(clothSheen))+skinAmb*(1.0+clothSheen*0.5))+direct*spec*max(ndlRaw,0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  return col;
}
// Match timber, canvas and land: the same directional sky and marine haze must veil every surface along this view
// ray, including shadowed sailors.
fn crewShade(v:CrewVertex,front:bool,baseIn:vec3f)->vec4f { return vec4f(surfaceAir(crewShadeLit(v,front,baseIn),v.world),1); }
@fragment fn fs(v:CrewVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  return crewShade(v,front,v.color);
}
@fragment fn crewFS(v:CrewVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  // Only the captain's body is painted, and only its fragments look the painting up. The footprint is measured out
  // here, where every fragment runs, and is drawn in by the same third of a level the lookup was sharpened by.
  let footX=dpdx(v.color.rg)*${CAPTAIN_TEXTURE_SHARPEN};let footY=dpdy(v.color.rg)*${CAPTAIN_TEXTURE_SHARPEN};
  var base=v.color;
  if(v.color.b<-1.0){base=textureSampleGrad(captainTex,captainSampler,v.color.rg,footX,footY).rgb;let own=actors[v.actor];base=captainOwnColours(base,v.bodyPos,v.skin,own.skin,own.hair.rgb,own.shirt.rgb);}
  return crewShade(v,front,base);
}
`;
export const CREW_RENDER = crewRenderWGSL();
export const CREW_WGSL = CREW_RENDER;
export const CREW_SHADOW = VESSEL_RIG + CREW_SKIN + SHADOW_FRAME + /* wgsl */ `
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@vertex fn vs(v:CrewInput)->@builtin(position) vec4f {
  let actor=actors[v.instance];
  if(actor.shirt.w>0.5||crewCompHidden(v.color,crewCompMask(actor.face.w))){return vec4f(2,2,0,1);}
  return SH.lightView*vec4f(rotateHull((crewSkin(v)*vec4f(crewSurface(v).position,1)).xyz)+hull.origin.xyz-SH.origin.xyz,1);
}
`;

// Sailors further from the eye are solved less often. Each frame the GPU carries every joint from
// the last solved pose towards the newest one, so their limbs still move smoothly between solves.
export const CREW_POSE_BLEND = CREW_JOINT_BLEND_WGSL + /* wgsl */ `
@group(0) @binding(0) var<storage,read> solved:array<mat4x4f>;
@group(0) @binding(1) var<storage,read> blends:array<vec2f>;
@group(0) @binding(2) var<storage,read_write> shownJoints:array<mat4x4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&shownJoints)){return;}
  let sailor=id.x/${CREW_JOINT_COUNT}u;let joint=id.x%${CREW_JOINT_COUNT}u;let blend=blends[sailor];
  let newest=u32(blend.y);
  let older=solved[(sailor*2u+1u-newest)*${CREW_JOINT_COUNT}u+joint];let latest=solved[(sailor*2u+newest)*${CREW_JOINT_COUNT}u+joint];
  shownJoints[id.x]=crewBlendJoint(older,latest,blend.x,crewRestJointMid(joint));
}
`;

// A body's joints straight from its baked clips, between frames: standing and walking, blended, or one loop of a
// man swimming or a body afloat. A body's `w` says which, as CREW_CLIP_MODES in js/crew-clip-pose.js.
export const CREW_CLIP_POSE = CREW_JOINT_BLEND_WGSL + /* wgsl */ `
struct CrewClipLayout {idleFirst:u32,idleFrames:u32,walkFirst:u32,walkFrames:u32,swimFirst:u32,swimFrames:u32,floatFirst:u32,floatFrames:u32};
@group(0) @binding(0) var<storage,read> palettes:array<mat4x4f>;
@group(0) @binding(1) var<uniform> layout_:CrewClipLayout;
@group(0) @binding(2) var<storage,read> bodies:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> shownJoints:array<mat4x4f>;
fn mixJoints(a:mat4x4f,b:mat4x4f,t:f32,joint:u32)->mat4x4f {
  return crewBlendJoint(a,b,t,crewRestJointMid(joint));
}
fn clipJoint(first:u32,frames:u32,frame:f32,joint:u32)->mat4x4f {
  let whole=u32(frame)%frames;let next=(whole+1u)%frames;
  return mixJoints(palettes[(first+whole)*${CREW_JOINT_COUNT}u+joint],palettes[(first+next)*${CREW_JOINT_COUNT}u+joint],fract(frame),joint);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&shownJoints)){return;}
  let body=bodies[id.x/${CREW_JOINT_COUNT}u];
  if(body.w<0.5){return;}
  let joint=id.x%${CREW_JOINT_COUNT}u;
  if(body.w>2.5){shownJoints[id.x]=clipJoint(layout_.floatFirst,max(layout_.floatFrames,1u),body.x,joint);return;}
  if(body.w>1.5){shownJoints[id.x]=clipJoint(layout_.swimFirst,max(layout_.swimFrames,1u),body.x,joint);return;}
  shownJoints[id.x]=mixJoints(clipJoint(layout_.idleFirst,layout_.idleFrames,body.x,joint),clipJoint(layout_.walkFirst,layout_.walkFrames,body.y,joint),body.z,joint);
}
`;


// A body turned to go by someone in a tight place: the joints above the hips come round about the pelvis, each by its own
// share of the turn, over whatever the clips and the solved poses left. The legs keep walking where he is going.
export const CREW_SHOULDER_TURN = /* wgsl */ `
struct CrewTurnRig {pivot:vec2f,count:u32,pad:u32};
@group(0) @binding(0) var<storage,read> turns:array<f32>;
@group(0) @binding(1) var<storage,read> shares:array<f32>;
@group(0) @binding(2) var<uniform> rig:CrewTurnRig;
@group(0) @binding(3) var<storage,read_write> shownJoints:array<mat4x4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&shownJoints)){return;}
  let sailor=id.x/${CREW_JOINT_COUNT}u;
  if(sailor>=rig.count){return;}
  let angle=turns[sailor]*shares[id.x%${CREW_JOINT_COUNT}u];
  if(angle==0.0){return;}
  let c=cos(angle);let s=sin(angle);
  // About the vertical through the pelvis, in the same sense as a body's yaw: +z comes round toward +x.
  let turn=mat4x4f(vec4f(c,0.0,-s,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(s,0.0,c,0.0),vec4f(rig.pivot.x*(1.0-c)-rig.pivot.y*s,0.0,rig.pivot.y*(1.0-c)+rig.pivot.x*s,1.0));
  shownJoints[id.x]=turn*shownJoints[id.x];
}
`;
