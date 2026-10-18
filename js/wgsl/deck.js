import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL } from './common.js';
import { SHADOW_SAMPLE } from './shadows.js';
import { HULL_PROFILE } from './hull.js';
import { INTERACTION_TYPES, INTERACTION_SEA } from './interaction.js';
import { FORECASTLE_END, FORECASTLE_HEIGHT, QUARTERDECK_START, QUARTERDECK_HEIGHT } from '../hull.js';

export const DECK_COLS = 32;
export const DECK_ROWS = 96;
// Same footprint and raised decks as the timber mesh. Coordinates are hull-local.
export const DECK_PROFILE = HULL_PROFILE + /* wgsl */ `
fn deckWidth(z:f32)->f32 {
  let r=select(z/7.4,-z/6.4,z<0.0);
  return max(0.04,1.8*sqrt(max(0.0006,1.0-r*r))-0.04);
}
fn deckFloor(z:f32)->f32 {
  if(z<=${FORECASTLE_END}){return ${FORECASTLE_HEIGHT};}
  return select(hullDeck(z),${QUARTERDECK_HEIGHT},z>=${QUARTERDECK_START});
}
fn deckRail(z:f32)->f32 { return select(0.66,0.16,z>=${QUARTERDECK_START}); }
fn deckUV(p:vec3f)->vec2f { return vec2f(p.x/(2.0*deckWidth(p.z))+0.5,(p.z+6.3)/11.9); }
fn deckPoint(uv:vec2f)->vec3f {
  let z=uv.y*11.9-6.3;
  return vec3f((uv.x*2.0-1.0)*deckWidth(z),deckFloor(z),z);
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
  return H.origin.xyz+H.right.xyz*p.x*(H.size.x/3.6)+H.up.xyz*p.y-H.forward.xyz*p.z*(H.size.y/12.0);
}
`;

// Conservative, positivity-limited downhill exchange. This is a thin-water visual
// model, not a flooding/stability solver. Sea enters at the rail; stored water
// crosses the deck, drains through scuppers, and leaves a slower-drying wet film.
export const DECK_UPDATE = FRAME_WGSL + INTERACTION_TYPES + DECK_PROFILE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> I:Interaction;
@group(0) @binding(2) var<uniform> H:InteractionHull;
@group(0) @binding(3) var seaTex:texture_2d_array<f32>;
@group(0) @binding(4) var seaSamp:sampler;
@group(0) @binding(5) var previousDeck:texture_2d<f32>;
@group(0) @binding(6) var nextDeck:texture_storage_2d<rgba32float,write>;
` + INTERACTION_SEA + DECK_TRANSFORM + /* wgsl */ `
const DECK_SIZE=vec2i(${DECK_COLS},${DECK_ROWS});
fn cellPoint(c:vec2i)->vec3f { return deckPoint((vec2f(c)+0.5)/vec2f(DECK_SIZE)); }
fn cellArea(p:vec3f)->f32 {
  return 2.0*deckWidth(p.z)*(H.size.x/3.6)/f32(DECK_SIZE.x)*11.9*(H.size.y/12.0)/f32(DECK_SIZE.y);
}
// Positive means water leaves a for b. Each face uses the identical flux on both sides.
fn flux(a:vec2i,b:vec2i,dt:f32)->f32 {
  if(any(b<vec2i(0)) || any(b>=DECK_SIZE)){return 0.0;}
  let pa=cellPoint(a);let pb=cellPoint(b);
  if(abs(pa.y-pb.y)>0.8){return 0.0;} // solid cabin face
  let wa=textureLoad(previousDeck,a,0).x;let wb=textureLoad(previousDeck,b,0).x;
  let dh=deckWorld(pa).y+wa*H.up.y-deckWorld(pb).y-wb*H.up.y;
  let donor=select(wb,wa,dh>0.0);
  let area=select(cellArea(pb),cellArea(pa),dh>0.0);
  let face=select((deckWidth(pa.z)+deckWidth(pb.z))*(H.size.x/3.6)/f32(DECK_SIZE.x),11.9*(H.size.y/12.0)/f32(DECK_SIZE.y),a.x!=b.x);
  // Limit the head conductance as well as donor volume. sqrt(head) alone
  // oscillates around equilibrium and leaves a checkerboard on pooled water.
  let conductance=min(2.0*sqrt(9.81*donor)*face,min(cellArea(pa),cellArea(pb))/(8.0*dt));
  let rate=abs(dh)*conductance;
  return sign(dh)*min(rate,donor*area/(4.0*dt));
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let c=vec2i(id.xy);if(any(c>=DECK_SIZE)){return;}
  if(I.motion.y<0.5 || I.previous.w>0.5){textureStore(nextDeck,c,vec4f(0.0));return;}
  let dt=max(I.previous.z*0.25,0.00001);
  let p=cellPoint(c);let area=cellArea(p);let old=textureLoad(previousDeck,c,0);
  let q=vec4f(flux(c,c+vec2i(1,0),dt),flux(c,c-vec2i(1,0),dt),flux(c,c+vec2i(0,1),dt),flux(c,c-vec2i(0,1),dt));
  var depth=max(0.0,old.x-dot(q,vec4f(1.0))*dt/area);
  var ingress=0.0;var drain=0.0;
  if(c.x==0 || c.x==DECK_SIZE.x-1) {
    let side=select(-1.0,1.0,c.x>0);
    let edge=vec3f(side*(deckWidth(p.z)+0.10),p.y,p.z);
    let rail=deckWorld(edge+vec3f(0.0,deckRail(p.z),0.0));
    let over=max(0.0,(interactionSea(rail.xz)-rail.y)/max(H.up.y,0.35));
    let face=11.9*(H.size.y/12.0)/f32(DECK_SIZE.y);
    ingress=min(4.0,1.3*pow(over,1.5));
    // Scuppers between rail posts; quarterdeck railing is open underneath.
    let opening=select(select(0.0,0.8,abs(fract((5.3-p.z)/0.82)-0.5)<0.17),1.0,p.z>=${QUARTERDECK_START});
    drain=select(min(depth*area/(dt*face),opening*sqrt(19.62*depth)*min(depth,0.12)+1.3*pow(max(0.0,depth-deckRail(p.z)),1.5)),0.0,over>0.0);
    depth+=(ingress-drain)*face*dt/area;
  }
  // Bound violent immersion; do not accumulate an unbounded reservoir inside the hull.
  depth=clamp(depth-0.0015*dt,0.0,1.2);
  let turbulence=min(1.0,ingress*0.8+dot(abs(q),vec4f(1.0))/area*0.15);
  let froth=max(old.y*exp(-dt*1.1),turbulence)*smoothstep(0.001,0.025,depth);
  let wet=max(old.z*exp(-dt*0.045),smoothstep(0.0005,0.01,depth));
  textureStore(nextDeck,c,vec4f(depth,froth,wet,drain-ingress));
}
`;

export const DECK_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + NOISE_WGSL + INTERACTION_TYPES + DECK_PROFILE + SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> H:InteractionHull;
@group(0) @binding(2) var deckWater:texture_2d<f32>;
@group(0) @binding(3) var deckSamp:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var transLUT:texture_2d<f32>;
@group(0) @binding(6) var<storage,read> sunVis:array<f32,4>;
` + DECK_TRANSFORM + DECK_SAMPLING + /* wgsl */ `
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
  p.y+=0.008+water.x+ripple;
  var o:DeckVertex;o.world=deckWorld(p);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);
  o.uv=uv;o.local=p;o.curtain=vec2f(0.0);return o;
}
// Continuous strips through scuppers, plus inward curtains while a crest overtops.
@vertex fn runoffVS(@builtin(vertex_index) v:u32,@builtin(instance_index) inst:u32)->DeckVertex {
  let side=select(-1.0,1.0,inst>=${DECK_ROWS}u);let row=inst%${DECK_ROWS}u;
  let c=corner(v%6u);let segment=v/6u;
  let fall=(f32(segment)+c.y)/8.0;
  let uv=vec2f(select(0.0,1.0,side>0.0),(f32(row)+c.x)/${DECK_ROWS}.0);
  let water=sampleDeck(uv);
  var p=deckPoint(uv);let incoming=water.w<0.0;
  let flow=abs(water.w);let duration=min(0.65,sqrt(2.0*max(0.1,p.y+1.2)/9.81));let t=fall*duration;
  p.x+=side*(0.16+0.55*t);
  let outlet=select(min(water.x,0.10),water.x,water.x>deckRail(p.z));
  p.y+=select(0.03+outlet,deckRail(p.z)+0.12,incoming);
  if(incoming){p.x=side*(deckWidth(p.z)+0.09-(0.5+min(flow,2.0))*t);}
  p.z+=sin(p.z*31.0+F.camPos.w*6.0+fall*5.0)*0.012*fall;
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
  let xSlope=(sampleDeck(in.uv+vec2f(texel.x,0)).x-sampleDeck(in.uv-vec2f(texel.x,0)).x)/(4.0*deckWidth(in.local.z)*texel.x);
  let dz=texel.y*11.9;
  let zSlope=(sampleDeck(in.uv+vec2f(0,texel.y)).x+deckFloor(in.local.z+dz)-sampleDeck(in.uv-vec2f(0,texel.y)).x-deckFloor(in.local.z-dz))/(2.0*dz);
  let gradient=clamp(vec2f(xSlope,zSlope),vec2f(-3.0),vec2f(3.0));
  var n=normalize(H.up.xyz-H.right.xyz*gradient.x/(H.size.x/3.6)+H.forward.xyz*gradient.y/(H.size.y/12.0));
  n=normalize(n+H.right.xyz*ripple.x+H.forward.xyz*ripple.y);
  let v=normalize(F.camPos.xyz-in.world);
  if(curtain){n=normalize(H.right.xyz+H.forward.xyz*ripple.x);}
  let f=0.02+0.98*pow(clamp(1.0-abs(dot(n,v)),0.0,1.0),5.0);
  let reflection=textureSampleLevel(envCube,deckSamp,reflect(-v,n),2.0).rgb;
  let ambient=textureSampleLevel(envCube,deckSamp,vec3f(0,1,0),6.0).rgb;
  let sun=textureSampleLevel(transLUT,deckSamp,transRMuToUV(RG+F.atmo.y,F.sunDir.y),0.0).rgb*F.sunDir.w*sunVis[0]*vesselShadow(in.world,n);
  let pattern=clamp(0.5+gnoise(flowUV*1.7)+gnoise(flowUV*4.1)*0.3,0.0,1.0);
  let front=(1.0-smoothstep(0.015,0.11,w.x))*smoothstep(0.003,0.018,w.x)*w.z;
  let froth=clamp(w.y*(0.4+pattern*0.6)+front*0.55,0.0,0.85);
  let foamLight=vec3f(0.83,0.88,0.91)*(ambient*1.35+sun*max(n.y,0.0)*0.12);
  let color=mix(reflection,foamLight,froth);
  var alpha=smoothstep(0.001,0.015,w.x)*clamp(f+froth*0.7+w.x*0.28,0.0,0.9);
  if(curtain){alpha=smoothstep(0.002,0.04,in.curtain.y)*(0.3+0.3*pattern)*(1.0-smoothstep(0.7,1.0,in.curtain.x));}
  // Do not bridge the vertical cabin face with a diagonal water polygon.
  if(abs(in.local.y-w.x-0.008-deckFloor(in.local.z))>0.10 && !curtain){discard;}
  if(alpha<0.003){discard;}
  return vec4f(color*alpha,alpha);
}
`;
