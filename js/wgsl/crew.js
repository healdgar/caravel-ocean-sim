import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_SAMPLE, SHADOW_FRAME } from './shadows.js';
import { DRESS_MASK_SCALE } from '../indigenous-dress.js';

// The captain's painted texture is read a third of a mip level sharper than its footprint: 2^-0.35 of it.
const CAPTAIN_TEXTURE_SHARPEN = (2 ** -0.35).toFixed(4);
// How much of the light a shirt of some colour throws back, a captain's coat of that colour does.
const CAPTAIN_COAT_DEPTH = 0.3;

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
  let headY=select(1.5998,1.5496,sex>.5);
  let build=(crewCompMask(f.w)>>11u)&3u;
  if(p.y<=headY+.015){
    if(build==0u||p.y<=.72||p.y>=1.38||abs(p.x)>=.25){return CrewSurface(p,normal);}
    let env=crewRamp(.72,.90,p.y).x*(1.0-crewRamp(1.26,1.38,p.y).x)*(1.0-crewRamp(.20,.25,abs(p.x)).x);
    let sx=select(select(.11,-.085,build==1u),.095*crewRamp(.88,1.24,p.y).x,build==2u);
    let sz=select(select(.10,-.095,build==1u),.075,build==2u);
    let belly=select(0.0,.030*smoothstep(-.02,.08,p.z)*(1.0-crewRamp(1.12,1.30,p.y).x),build==3u);
    let qx=p.x*(1.0+sx*env);
    let qz=-0.025+(p.z+0.025)*(1.0+sz*env)+belly*env;
    let nrm=normalize(vec3f(normal.x/(1.0+sx*env),normal.y,normal.z/(1.0+sz*env)));
    return CrewSurface(vec3f(qx,p.y,qz),nrm);
  }
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
  let eyeOpen=crewEyeOpen(f.w);
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
export const CAPTAIN_OWN_COLOURS = /* wgsl */ `
// One man sat for the captain's painting: his skin, his brown hair and beard, his navy coat. Every captain wears it,
// so each one's own skin, hair and coat are laid over it wherever the paint is one of those, keeping the painting's
// light and shade, and a woman's beard is painted out in her skin. Paint is told by its colour, since the painting's
// islands follow no garment: flesh is far redder than green and lit, the coat is the only dark thing bluer than red,
// and hair is whatever else is dark on the head, and everything on its crown. The cut of the body, the face and the
// hair stay the sitter's.
fn captainOwnColours(paint:vec3f,p:vec3f,flagged:f32,skin:vec4f,hair:vec3f,shirt:vec3f)->vec3f {
  let luma=dot(paint,vec3f(.2126,.7152,.0722));
  let red=paint.r/max(paint.g,1e-4);
  let dark=1.0-smoothstep(.12,.2,luma);
  // The head, less the wings of the collar that stand up beside the jaw, and with the beard that hangs below the chin
  // between them, which is darker than any shade on the collar.
  let wing=smoothstep(.08,.095,abs(p.x))*smoothstep(.03,.05,p.z)*(1.0-smoothstep(1.58,1.6,p.y));
  let onHead=max(smoothstep(1.49,1.52,p.y)*(1.0-smoothstep(.15,.19,abs(p.x)))*(1.0-wing),
    smoothstep(1.45,1.465,p.y)*(1.0-smoothstep(.06,.085,abs(p.x)))*smoothstep(.02,.04,p.z)*(1.0-smoothstep(.06,.1,luma)));
  // The coat's own black shadows are coat too. The head has none of it but the collar behind the neck: a blue shade
  // under the fringe is hair.
  let blue=paint.b/max(max(paint.r,paint.g),1e-4);
  let nape=1.0-onHead*max(smoothstep(-.08,-.05,p.z),smoothstep(1.58,1.6,p.y));
  let coat=smoothstep(.82,.94,blue)*(1.0-smoothstep(.05,.09,luma))*nape;
  // Nothing but hair is painted on the top of the head, the back of it, or its sides above the ears.
  let crown=onHead*max(smoothstep(1.755,1.77,p.y),max((1.0-smoothstep(-.085,-.06,p.z))*smoothstep(1.575,1.595,p.y),
    smoothstep(.085,.1,abs(p.x))*smoothstep(1.66,1.68,p.y)));
  // Where the body says skin, its deepest shade is still skin; elsewhere a dark red is the waistcoat.
  let flesh=smoothstep(2.2,2.7,red)*smoothstep(mix(.035,.012,flagged),mix(.07,.03,flagged),luma)*(1.0-crown);
  // Below the crown hair is only the deepest of what is not flesh: the paint fades from a beard into the collar
  // beside it, and bright hair laid over that fade would stain the collar.
  let hairy=(1.0-coat)*mix(onHead*(1.0-flesh)*(1.0-smoothstep(.07,.13,luma)),1.0,crown);
  // A woman's jaw: the front of the head below the nose. The beard, whiskers and moustache are whatever is dark on
  // it, and the shade the painter put round them goes with them.
  let jaw=onHead*(1.0-crown)*smoothstep(-.035,-.01,p.z)*(1.0-smoothstep(1.63,1.655,p.y))*step(1.5,skin.w);
  let lit=paint/vec3f(.40,.125,.058);
  var shade=mix(vec3f(clamp(dot(lit,vec3f(.299,.587,.114)),.4,1.3)),clamp(lit,vec3f(.4),vec3f(1.3)),.45);
  shade=mix(shade,max(shade,vec3f(.8)),jaw);
  // A coat is heavier and darker cloth than the shirt whose colour it takes.
  var worn=mix(paint,shirt*(${CAPTAIN_COAT_DEPTH}*clamp(luma/.0141,.55,1.4)),coat);
  worn=mix(worn,hair*clamp(luma/.032,.45,1.6),hairy);
  worn=mix(worn,skin.rgb*.9,jaw*(1.0-flesh)*dark);
  return mix(worn,skin.rgb*shade,flesh);
}
`;
// Shading never discards, so the GPU shades only what shows. Anyone with something to cut away,
// someone fading out of a first-person sightline or in torn clothes, lays depth with `surviving`
// after the opaque scene, then shades what is left.
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
  @location(1) @interpolate(perspective,centroid) normal:vec3f, @location(2) @interpolate(perspective,centroid) color:vec3f, @location(3) @interpolate(flat) helm:f32,
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
    let comp=u32(tagged.g*.5);
    let rawShade=vec3f(tagged.r,tagged.g-2.0*f32(comp),tagged.b-2.0*f32(garment));
    let shadeLuma=clamp(dot(rawShade,vec3f(0.299,0.587,0.114)),0.64,1.16);
    let shade=mix(vec3f(shadeLuma),clamp(rawShade,vec3f(0.62),vec3f(1.18)),select(0.20,0.45,garment==3u));
    var worn=select(select(select(hair,skin,garment==3u),trousers,garment==2u),shirt,garment==1u);
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
    return vec4f(worn*shade,select(0.0,1.0,garment==3u));
  }
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
  let compMask=crewCompMask(actor.face.w);
  let clothed=crewClothed(v.color,v.position,actor.shirt.rgb,actor.trousers.rgb,actor.skin.rgb,actor.hair.rgb,actor.face.w>1.5,dress,compMask);
  out.color=clothed.rgb;out.skin=clothed.w;out.paint=dress>>16u;out.actor=v.instance;
  if(actor.shirt.w>0.5||crewCompHidden(v.color,compMask)){out.position=vec4f(2,2,0,1);}
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
fn crewShade(v:CrewVertex,front:bool,baseIn:vec3f)->vec4f {
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
  var baseColor=baseIn;
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
    // Linen bandages wrapped around brow/head or forearm/calf on wounded survivors
    let hasHeadBand=bSeed>0.16 && bp.y>1.63 && bp.y<1.71 && bp.z>-0.10;
    let hasArmBand=bSeed>0.05 && abs(bp.x)>0.16 && bp.y>0.92 && bp.y<1.12 && sign(bp.x)==select(-1.0,1.0,bSeed>0.22);
    let hasLegBand=bSeed>0.11 && bp.y>0.24 && bp.y<0.42 && sign(bp.x)==select(1.0,-1.0,bSeed>0.20);
    if(woundAmt>0.25 && woundAmt<0.85 && (hasHeadBand || hasArmBand || hasLegBand)){
      let wrapStripe=sin((bp.y*85.0+bp.x*32.0)*6.283)*0.04;
      var linen=vec3f(0.84,0.80,0.72)+vec3f(wrapStripe);
      let seep=smoothstep(0.58,0.82,nLow+0.25*woundAmt);
      linen=mix(linen,vec3f(0.38,0.035,0.025),seep*0.78);
      baseColor=linen;
      roughBias=0.22;
    }else if(woundAmt>0.15){
      let stainZone=smoothstep(0.42,0.74,nLow+0.30*woundAmt)*smoothstep(0.18,1.62,bp.y);
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
  // A little diffuse wrap softens facial terminators. Skin has a broad dry
  // highlight; absorbed water darkens linen, surface water strengthens glints.
  // Roughness values are authored material choices, not measured cloth/skin data.
  let rough=clamp(mix(mix(.92,.62,v.skin),mix(.55,.38,v.skin),wet.y)+roughBias,0.08,0.99);
  let wrap=.14*saturate(v.skin);
  let diffuse=max(0.0,(dot(n,sun)+wrap)/(1.0+wrap))/(1.0+wrap);
  let f0=vec3f(.04);
  let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS-1}.0).rgb;
  let grazing=1.0-clamp(dot(n,view),0.0,1.0);
  let clothSheen=grazing*grazing*grazing*grazing*(1.0-clamp(v.skin,0.0,1.0))*(1.0-wet.x*0.7)*${clothSheen.toFixed(4)};
  let col=lunarSurface(n,view,albedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,albedo,rough)+gunFlashSurface(v.world,n,view,albedo,rough)+worldFireSurface(v.world,n,view,albedo,rough)+albedo*(direct*(diffuse/PI+clothSheen)+ambient*(1.0+clothSheen*0.5))+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  // Match timber, canvas and land: the same directional sky and marine haze
  // must veil every surface along this view ray, including shadowed sailors.
  return vec4f(surfaceAir(col,v.world),1);
}
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

// A body's joints straight from its baked clips, between frames: standing and walking, blended, or one loop of a
// man swimming or a body afloat. A body's `w` says which, as CREW_CLIP_MODES in js/crew-clip-pose.js.
export const CREW_CLIP_POSE = /* wgsl */ `
struct CrewClipLayout {idleFirst:u32,idleFrames:u32,walkFirst:u32,walkFrames:u32,swimFirst:u32,swimFrames:u32,floatFirst:u32,floatFrames:u32};
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
  if(body.w>2.5){shownJoints[id.x]=clipJoint(layout_.floatFirst,max(layout_.floatFrames,1u),body.x,joint);return;}
  if(body.w>1.5){shownJoints[id.x]=clipJoint(layout_.swimFirst,max(layout_.swimFrames,1u),body.x,joint);return;}
  shownJoints[id.x]=mixJoints(clipJoint(layout_.idleFirst,layout_.idleFrames,body.x,joint),clipJoint(layout_.walkFirst,layout_.walkFrames,body.y,joint),body.z);
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
  let sailor=id.x/65u;
  if(sailor>=rig.count){return;}
  let angle=turns[sailor]*shares[id.x%65u];
  if(angle==0.0){return;}
  let c=cos(angle);let s=sin(angle);
  // About the vertical through the pelvis, in the same sense as a body's yaw: +z comes round toward +x.
  let turn=mat4x4f(vec4f(c,0.0,-s,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(s,0.0,c,0.0),vec4f(rig.pivot.x*(1.0-c)-rig.pivot.y*s,0.0,rig.pivot.y*(1.0-c)+rig.pivot.x*s,1.0));
  shownJoints[id.x]=turn*shownJoints[id.x];
}
`;
