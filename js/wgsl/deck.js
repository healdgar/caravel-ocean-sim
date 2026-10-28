import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { VESSEL_LIGHTING } from './vessel.js';
import { SHADOW_SAMPLE } from './shadows.js';
import { HULL_PROFILE } from './hull.js';
import { INTERACTION_TYPES, INTERACTION_SEA } from './interaction.js';
import {coupleSurfaceHeight} from './surface-coupling.js';
import { QUARTERDECK_START } from '../hull.js';
import {LATER_SAIL_DESIGNS,laterSailStairFlights} from '../models/later-sail.js';

export const DECK_COLS = 32;
export const DECK_ROWS = 96;
const cockpitDeckCheck=Object.values(LATER_SAIL_DESIGNS).filter(d=>d.cockpit).map(d=>'abs(hull.rig.w-'+d.modelCode+'.0)<.1').join('||');
// Same footprint and raised decks as the timber mesh. Coordinates are hull-local.
export const DECK_PROFILE = HULL_PROFILE + /* wgsl */ `
fn deckWidth(z:f32)->f32 {
  if(hull.rig.w>.5){
    let y=select(modelVesselDeck(z,hull.rig.w),modelHullDeck(z,hull.rig.w),${cockpitDeckCheck});
    return max(.012,modelHullWidth(z,y,hull.rig.w)-.045);
  }
  return max(0.015,hullBreadth(z)-0.145);
}
fn deckFloor(z:f32)->f32 {
  return modelVesselDeck(z,hull.rig.w);
}
fn deckRail(z:f32)->f32 {
  return modelDeckBarrier(z,hull.rig.w);
}
fn deckFloorAt(z:f32,x:f32)->f32 {
  if(hull.rig.w>=3.5){
    ${Object.values(LATER_SAIL_DESIGNS).map(d=>`if(abs(hull.rig.w-${d.modelCode}.0)<.1){${laterSailStairFlights(d.id).map(f=>`if(abs(x-(${f.x.toFixed(7)}))<=${(f.width/2).toFixed(7)}&&z>=${f.z0.toFixed(7)}&&z<=${f.z1.toFixed(7)}){return mix(${f.y0.toFixed(7)},${f.y1.toFixed(7)},(z-(${f.z0.toFixed(7)}))/${(f.z1-f.z0).toFixed(7)});}`).join('')}}`).join('\n')}
    return modelVesselDeckAt(z,x,hull.rig.w);
  }
  return deckFloor(z);
}
fn deckRailAt(z:f32,x:f32)->f32 {
  if(hull.rig.w>=3.5){return modelDeckBarrierAt(z,x,hull.rig.w);}
  return deckRail(z);
}
fn deckMinZ()->f32 {return select(-6.4,-6.0,hull.rig.w>.5);}
fn deckLength()->f32 {return 12.0;}
fn deckUV(p:vec3f)->vec2f { return vec2f(p.x/(2.0*deckWidth(p.z))+0.5,(p.z-deckMinZ())/deckLength()); }
fn deckPoint(uv:vec2f)->vec3f {
  let z=uv.y*deckLength()+deckMinZ();
  let x=(uv.x*2.0-1.0)*deckWidth(z);return vec3f(x,deckFloorAt(z,x),z);
}
`;
// Float32 retains small drainage/drying increments at high frame rates. Explicit
// bilinear loads avoid requiring the optional float32-filterable GPU feature.
export const DECK_SAMPLING = /* wgsl */ `
fn sampleDeck(uv:vec2f)->vec4f {
  let size=vec2i(textureDimensions(deckWater));let p=clamp(uv,vec2f(0.0),vec2f(1.0))*vec2f(size)-0.5;
  let base=vec2i(floor(p));let f=fract(p);
  let a=textureLoad(deckWater,clamp(base,vec2i(0),size-1),0);
  let b=textureLoad(deckWater,clamp(base+vec2i(1,0),vec2i(0),size-1),0);
  let c=textureLoad(deckWater,clamp(base+vec2i(0,1),vec2i(0),size-1),0);
  let d=textureLoad(deckWater,clamp(base+vec2i(1,1),vec2i(0),size-1),0);
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
`;
const DECK_TRANSFORM = /* wgsl */ `
fn deckWorld(p:vec3f)->vec3f {
  return hull.origin.xyz+hull.right.xyz*p.x*(hull.size.x/3.6)+hull.up.xyz*p.y*shipY(hull.right.w)-hull.forward.xyz*p.z*(hull.size.y/12.0);
}
// A cockpit's coaming is an internal barrier, except at its real stair opening.
// The legacy four ships retain their existing exchange arithmetic.
fn deckInteriorCrest(a:vec3f,b:vec3f)->f32 {
  ${Object.values(LATER_SAIL_DESIGNS).filter(d=>d.cockpit).map(d=>{
    const c=d.cockpit,flights=laterSailStairFlights(d.id).filter(f=>f.zoneId==='cockpit');
    return `if(abs(hull.rig.w-${d.modelCode}.0)<.1){
      let A=a.z>${c.bounds[0]}&&a.z<${c.bounds[1]}&&abs(a.x)<${c.halfWidth};let B=b.z>${c.bounds[0]}&&b.z<${c.bounds[1]}&&abs(b.x)<${c.halfWidth};
      if(A!=B){let p=(a+b)*.5;${flights.map(f=>`if(abs(p.x-(${f.x.toFixed(7)}))<=${(f.width/2).toFixed(7)}&&p.z>=${f.z0.toFixed(7)}&&p.z<=${f.z1.toFixed(7)}){return -1000000.0;}`).join('')}
        return ${c.coamingHeight}+modelHullDeck(p.z,hull.rig.w)-${d.profile.deck};}
    }`;
  }).join('\n')}
  return -1000000.0;
}
// UV is on one perimeter face. Return the actual cap lead, rather than a
// dimensioned-in-metres offset accidentally multiplied by vessel scale.
fn deckLip(uv:vec2f,sideFace:bool)->vec3f {
  var p=deckPoint(uv);
  if(sideFace){
    let side=select(-1.0,1.0,uv.x>.5);
    let nina=deckWidth(p.z)+.04;
    let victory=modelHullWidth(p.z,p.y+deckRailAt(p.z,p.x),hull.rig.w);
    p.x=side*select(nina,victory,hull.rig.w>.5);
    if(hull.rig.w>=3.5){p.y=deckFloorAt(p.z,p.x);}
  }
  return p;
}
`;

// Conservative, positivity-limited downhill exchange. This is a thin-water visual
// model, not a flooding/stability solver. Depth is WORLD metres along hull.up;
// deck coordinates/barrier heights remain model-local. Sea enters at the rail; stored water
// crosses the deck, drains through scuppers, and leaves a slower-drying wet film.
export const DECK_UPDATE = FRAME_WGSL + INTERACTION_TYPES + DECK_PROFILE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> I:Interaction;
@group(0) @binding(2) var<uniform> hull:InteractionHull;
@group(0) @binding(3) var seaTex:texture_2d_array<f32>;
@group(0) @binding(4) var seaSamp:sampler;
@group(0) @binding(5) var previousDeck:texture_2d<f32>;
@group(0) @binding(6) var nextDeck:texture_storage_2d<rgba32float,write>;
` + INTERACTION_SEA + DECK_TRANSFORM + /* wgsl */ `
const DECK_SIZE=vec2i(${DECK_COLS},${DECK_ROWS});
fn cellPoint(c:vec2i)->vec3f { return deckPoint((vec2f(c)+0.5)/vec2f(DECK_SIZE)); }
fn cellArea(p:vec3f)->f32 {
  return 2.0*deckWidth(p.z)*(hull.size.x/3.6)/f32(DECK_SIZE.x)*deckLength()*(hull.size.y/12.0)/f32(DECK_SIZE.y);
}
// Positive means water leaves a for b. Each face uses the identical flux on both sides.
fn flux(a:vec2i,pa:vec3f,wa:f32,wA:f32,areaA:f32,b:vec2i,dt:f32)->f32 {
  if(any(b<vec2i(0)) || any(b>=DECK_SIZE)){return 0.0;}
  let pb=cellPoint(b);
  if(abs(pa.y-pb.y)*shipY(hull.right.w)>0.8){return 0.0;} // solid cabin face
  let wb=textureLoad(previousDeck,b,0).x;
  let dh=deckWorld(pa).y+wa*hull.up.y-deckWorld(pb).y-wb*hull.up.y;
  var donor=select(wb,wa,dh>0.0);
  if(hull.rig.w>=3.5){
    let crest=deckInteriorCrest(pa,pb);
    if(crest> -10000.0){
      let p=(pa+pb)*.5;let top=deckWorld(vec3f(p.x,crest,p.z)).y;
      let bottom=select(deckWorld(pb).y,deckWorld(pa).y,dh>0.0);
      donor=max(0.0,donor-max(0.0,(top-bottom)/max(hull.up.y,.35)));
    }
  }
  let wB=select(deckWidth(pb.z),wA,a.y==b.y);
  let areaB=2.0*wB*(hull.size.x/3.6)/f32(DECK_SIZE.x)*deckLength()*(hull.size.y/12.0)/f32(DECK_SIZE.y);
  let area=select(areaB,areaA,dh>0.0);
  let face=select((wA+wB)*(hull.size.x/3.6)/f32(DECK_SIZE.x),deckLength()*(hull.size.y/12.0)/f32(DECK_SIZE.y),a.x!=b.x);
  // Limit the head conductance as well as donor volume. sqrt(head) alone
  // oscillates around equilibrium and leaves a checkerboard on pooled water.
  let conductance=min(2.0*sqrt(9.81*donor)*face,min(areaA,areaB)/(8.0*dt));
  let rate=abs(dh)*conductance;
  return sign(dh)*min(rate,donor*area/(4.0*dt));
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let c=vec2i(id.xy);if(any(c>=DECK_SIZE)){return;}
  if(I.motion.y<0.5 || I.previous.w>0.5){textureStore(nextDeck,c,vec4f(0.0));return;}
  let dt=max(I.previous.z*0.25,0.00001);
  let p=cellPoint(c);let wA=deckWidth(p.z);let area=2.0*wA*(hull.size.x/3.6)/f32(DECK_SIZE.x)*deckLength()*(hull.size.y/12.0)/f32(DECK_SIZE.y);let old=textureLoad(previousDeck,c,0);
  var q=vec4f(0.0);
  let steps=array<vec2i,4>(vec2i(1,0),vec2i(-1,0),vec2i(0,1),vec2i(0,-1));
  for(var d=0u;d<4u;d++){q[d]=flux(c,p,old.x,wA,area,c+steps[d],dt);}
  var depth=max(0.0,old.x-dot(q,vec4f(1.0))*dt/area);
  var ingress=0.0;var boundaryFlow=0.0;var perimeter=0.0;
  // All four perimeter faces participate. Corner cells own two distinct faces;
  // their physical lengths weight both volume and the rendered net flow.
  for(var edge=0u;edge<4u;edge++){
    let sideFace=edge<2u;let positive=(edge&1u)!=0u;
    let onBoundary=select(select(c.y==0,c.y==DECK_SIZE.y-1,positive),select(c.x==0,c.x==DECK_SIZE.x-1,positive),sideFace);
    if(!onBoundary){continue;}
    var uv=(vec2f(c)+.5)/vec2f(DECK_SIZE);
    if(sideFace){uv.x=select(0.0,1.0,positive);}else{uv.y=select(0.0,1.0,positive);}
    let lip=deckLip(uv,sideFace);let barrier=deckRailAt(lip.z,lip.x);
    let rail=deckWorld(lip+vec3f(0.0,barrier,0.0));
    // Convert vertical separation to normal WORLD depth once. shipY converts
    // the local rail through deckWorld; applying it again here breaks scale.
    let over=max(0.0,(interactionSea(rail.xz)-rail.y)/max(hull.up.y,0.35));
    let face=select(2.0*deckWidth(lip.z)*(hull.size.x/3.6)/f32(DECK_SIZE.x),deckLength()*(hull.size.y/12.0)/f32(DECK_SIZE.y),sideFace);
    let incoming=min(4.0,1.3*pow(over,1.5));
    // Solid bow/transom faces gain no invented scuppers. Open afterdeck rails
    // still drain underneath; existing side scuppers retain their positions.
    let scupper=select(0.0,0.8,sideFace&&abs(fract((5.3-lip.z)/0.82)-0.5)<0.17);
    let opening=select(scupper,1.0,hull.rig.w<.5&&lip.z>=${QUARTERDECK_START});
    let potential=opening*sqrt(19.62*depth)*min(depth,.12)+1.3*pow(max(0.0,depth-barrier*shipY(hull.right.w)),1.5);
    let drain=select(min(depth*area/(dt*face),potential),0.0,over>0.0);
    depth+=(incoming-drain)*face*dt/area;
    ingress+=incoming*face;boundaryFlow+=(drain-incoming)*face;perimeter+=face;
  }
  // Bound violent immersion; do not accumulate an unbounded reservoir inside the hull.
  depth=clamp(depth-0.0015*dt,0.0,1.2);
  let turbulence=min(1.0,ingress/max(perimeter,.001)*0.8+dot(abs(q),vec4f(1.0))/area*0.15);
  let froth=max(old.y*exp(-dt*1.1),turbulence)*smoothstep(0.001,0.025,depth);
  let wet=max(old.z*exp(-dt*0.045),smoothstep(0.0005,0.01,depth));
  textureStore(nextDeck,c,vec4f(depth,froth,wet,boundaryFlow/max(perimeter,.001)));
}
`;
export const SCENE_DECK_UPDATE=coupleSurfaceHeight(DECK_UPDATE,'interactionDisp(q).y','p',{group:1,uniformBinding:0,textureBinding:1,samplerName:'seaSamp'});

export const DECK_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_LIGHTING + INTERACTION_TYPES + DECK_PROFILE + SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:InteractionHull;
@group(0) @binding(2) var deckWater:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var transLUT:texture_2d<f32>;
@group(0) @binding(6) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(7) var skyLUT:texture_2d<f32>;
` + SKY_RENDER_FUNCS + DECK_TRANSFORM + DECK_SAMPLING + /* wgsl */ `
struct DeckVertex {
  @builtin(position) pos:vec4f, @location(0) world:vec3f,
  @location(1) uv:vec2f, @location(2) local:vec3f,
  @location(3) curtain:vec2f,
};
fn corner(v:u32)->vec2f {
  return array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[v];
}
@vertex fn washVS(@builtin(vertex_index) v:u32)->DeckVertex {
  let cell=v/6u;let uv=(vec2f(f32(cell%${DECK_COLS*2}u),f32(cell/${DECK_COLS*2}u))+corner(v%6u))/vec2f(${DECK_COLS*2}.0,${DECK_ROWS*2}.0);
  let water=sampleDeck(uv);
  var p=deckPoint(uv);
  let ripple=gnoise(p.xz*7.0+vec2f(-F.camPos.w*1.3,F.camPos.w*0.7))*min(water.x*0.08,0.008);
  p.y+=(0.008+water.x+ripple)/shipY(hull.right.w);
  var o:DeckVertex;o.world=deckWorld(p);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);
  o.uv=uv;o.local=p;o.curtain=vec2f(0.0);return o;
}
// Continuous strips through scuppers, plus inward curtains while a crest overtops.
@vertex fn runoffVS(@builtin(vertex_index) v:u32,@builtin(instance_index) inst:u32)->DeckVertex {
  let sideFace=inst<${DECK_ROWS*2}u;
  let index=select(inst-${DECK_ROWS*2}u,inst,sideFace);
  let count=select(${DECK_COLS}u,${DECK_ROWS}u,sideFace);
  let side=select(-1.0,1.0,index>=count);let row=index%count;
  let c=corner(v%6u);let segment=v/6u;
  let fall=(f32(segment)+c.y)/8.0;
  let along=(f32(row)+c.x)/f32(count);
  let uv=select(vec2f(along,select(0.0,1.0,side>0.0)),vec2f(select(0.0,1.0,side>0.0),along),sideFace);
  let water=sampleDeck(uv);
  var p=deckLip(uv,sideFace);let incoming=water.w<0.0;let flow=abs(water.w);
  let verticalScale=shipY(hull.right.w);let barrier=deckRailAt(p.z,p.x)*verticalScale;
  // Invert the same bounded weir law to recover an incoming crest head. Start
  // on that cap lead and travel INWARD; outgoing water leaves toward the sea.
  let head=pow(flow/1.3,2.0/3.0);
  let outlet=select(min(water.x,0.10),water.x,water.x>barrier);
  let start=select(.03+outlet,barrier+head,incoming);
  let fallHeight=select(max(.1,deckWorld(p).y+start*hull.up.y+.4),max(.02,(start-water.x)*max(hull.up.y,.35)),incoming);
  let duration=clamp(sqrt(2.0*fallHeight/9.81),.06,.85);let t=fall*duration;
  let speed=clamp(sqrt(19.62*select(max(water.x,.02),head,incoming)),.5,4.0);
  let travel=select(1.0,-1.0,incoming)*speed*t;
  let direction=select(vec2f(0,side),vec2f(side,0),sideFace);
  p.x+=direction.x*travel/(hull.size.x/3.6);p.z+=direction.y*travel/(hull.size.y/12.0);
  p.y+=start/verticalScale;
  p.x+=sin(p.z*31.0+F.camPos.w*6.0+fall*5.0)*.012*fall/(hull.size.x/3.6);
  var o:DeckVertex;o.world=deckWorld(p)-vec3f(0.0,4.905*t*t,0.0);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);
  o.uv=uv;o.local=p;o.curtain=vec2f(fall+0.001,flow);return o;
}
@fragment fn washFS(in:DeckVertex)->@location(0) vec4f {
  let w=sampleDeck(in.uv);
  let curtain=in.curtain.x>0.0;
  let flowUV=in.local.xz*6.0+vec2f(-F.camPos.w*0.7,F.camPos.w*0.4);
  let ripple=vec2f(gnoise(flowUV),gnoise(flowUV+vec2f(13.7,8.1)))*0.025;
  // Central height differences stay continuous across cell boundaries; facet
  // derivatives and derivatives of bilinear heights both expose the grid.
  let texel=vec2f(1.0/${DECK_COLS}.0,1.0/${DECK_ROWS}.0);
  let wLocal=deckWidth(in.local.z);
  var xSlope=(sampleDeck(in.uv+vec2f(texel.x,0)).x-sampleDeck(in.uv-vec2f(texel.x,0)).x)/(4.0*wLocal*texel.x);
  if(hull.rig.w>=3.5){let dx=2.0*wLocal*texel.x;xSlope+=(deckFloorAt(in.local.z,in.local.x+dx)-deckFloorAt(in.local.z,in.local.x-dx))*shipY(hull.right.w)/(2.0*dx);}
  let dz=texel.y*deckLength();
  let zSlope=(sampleDeck(in.uv+vec2f(0,texel.y)).x-sampleDeck(in.uv-vec2f(0,texel.y)).x+(deckFloorAt(in.local.z+dz,in.local.x)-deckFloorAt(in.local.z-dz,in.local.x))*shipY(hull.right.w))/(2.0*dz);
  let gradient=clamp(vec2f(xSlope,zSlope),vec2f(-3.0),vec2f(3.0));
  var n=normalize(hull.up.xyz-hull.right.xyz*gradient.x/(hull.size.x/3.6)+hull.forward.xyz*gradient.y/(hull.size.y/12.0));
  n=normalize(n+hull.right.xyz*ripple.x+hull.forward.xyz*ripple.y);
  let v=normalize(F.camPos.xyz-in.world);
  // Falling sheets bend away from the rail: use their actual surface, not
  // a fixed +X normal (which also treated port and starboard identically).
  let face=cross(dpdx(in.world),dpdy(in.world));
  // Finish quad derivatives before rejecting transparent sheets. These exact
  // zero-coverage cases previously paid for all environment/shadow lighting.
  if(!curtain && w.x<=0.001){discard;}
  if(curtain && (in.curtain.y<=0.002 || in.curtain.x>=1.0)){discard;}
  // Do not bridge the vertical cabin face with a diagonal water polygon.
  if(!curtain && abs((in.local.y-deckFloorAt(in.local.z,in.local.x))*shipY(hull.right.w)-w.x-0.008)>0.10){discard;}
  if(curtain){n=normalize(face/max(length(face),0.00001)+hull.forward.xyz*ripple.x+hull.up.xyz*ripple.y);}
  n=select(-n,n,dot(n,v)>=0.0);
  let f=0.02+0.98*pow(clamp(1.0-abs(dot(n,v)),0.0,1.0),5.0);
  let reflection=textureSampleLevel(envCube,sampC,reflect(-v,n),2.0).rgb;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),6.0).rgb;
  let sun=textureSampleLevel(transLUT,sampC,transRMuToUV(RG+F.atmo.y,F.sunDir.y),0.0).rgb*F.sunDir.w*sunVis[0]*step(0.0,F.sunDir.y)*solarShadowVisibility(vesselShadow(in.world,n));
  let pattern=clamp(0.5+gnoise(flowUV*1.7)+gnoise(flowUV*4.1)*0.3,0.0,1.0);
  let front=(1.0-smoothstep(0.015,0.11,w.x))*smoothstep(0.003,0.018,w.x)*w.z;
  let froth=clamp(w.y*(0.4+pattern*0.6)+front*0.55,0.0,0.85);
  let nl=max(dot(n,F.sunDir.xyz),0.0);
  // Entrained bubbles scatter light from either side of a thin water sheet.
  let scatter=pow(max(dot(-v,F.sunDir.xyz),0.0),12.0);
  let foamLight=vec3f(0.88,0.90,0.91)*(ambient*1.1+sun*(0.12+0.28*abs(dot(n,F.sunDir.xyz))+scatter*0.35));
  let moonFoam=lunarIlluminance()*sunVis[1]*lunarShadowVisibility(vesselShadow(in.world,n))*(.12+.28*abs(dot(n,lunarDirection()))+.35*pow(max(dot(-v,lunarDirection()),0.0),12.0));
  let color=mix(reflection,foamLight+vec3f(.88,.90,.91)*moonFoam,froth);
  var alpha=smoothstep(0.001,0.015,w.x)*clamp(f+froth*0.7+w.x*0.28,0.0,0.9);
  if(curtain){
    let fall=in.curtain.x;
    let aeration=clamp(w.y*0.35+0.08+smoothstep(0.1,0.8,fall)*pattern*0.22,0.0,0.55);
    let breakup=mix(1.0,smoothstep(0.2,0.65,pattern),smoothstep(0.35,0.95,fall));
    let coverage=smoothstep(0.002,0.04,in.curtain.y)*breakup*(1.0-smoothstep(0.65,1.0,fall));
    // Clear water transmits the hull behind it. Only Fresnel reflection and
    // bubbles obscure it; fixed opacity made dark blue plastic strips.
    alpha=coverage*(f*(1.0-aeration)+aeration);
    if(alpha<0.003){discard;}
    let glint=sun*vesselSpecular(n,v,F.sunDir.xyz,0.24,vec3f(0.02))*nl;
    let radiance=coverage*((reflection*f+glint)*(1.0-aeration)+foamLight*aeration+lightningSurface(n,v,vec3f(.1),.24));
    return vec4f(surfaceAir(radiance/alpha,in.world)*alpha,alpha);
  }
  if(alpha<0.003){discard;}
  return vec4f(surfaceAir(color+lightningSurface(n,v,vec3f(.1),.24),in.world)*alpha,alpha);
}
`;
