import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { VESSEL_LIGHTING } from './vessel.js';
import { SCENE_SHADOW_SAMPLE } from './shadows.js';

export const ANCHOR_RENDER = FRAME_WGSL+ATMO_CORE_WGSL+SKY_RENDER_FUNCS+VESSEL_LIGHTING+SCENE_SHADOW_SAMPLE+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32>;
struct AnchorPose {right:vec4f,up:vec4f,aft:vec4f,origin:vec4f};
@group(0) @binding(6) var<uniform> A:AnchorPose;
struct AnchorVertex {
  @builtin(position) position:vec4f,@location(0) world:vec3f,
  @location(1) normal:vec3f,@location(2) kind:vec2f,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->AnchorVertex {
  let world=select(position,A.origin.xyz+A.right.xyz*position.x+A.up.xyz*position.y+A.aft.xyz*position.z,A.origin.w>.5);
  let n=select(normal,A.right.xyz*normal.x+A.up.xyz*normal.y+A.aft.xyz*normal.z,A.origin.w>.5);
  var out:AnchorVertex;out.position=F.viewProj*vec4f(world-F.camPos.xyz,1);
  out.world=world;out.normal=n;out.kind=kind;return out;
}
@fragment fn fs(v:AnchorVertex)->@location(0) vec4f {
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);
  let iron=v.kind.x<.5;let water=v.kind.x>2.5;
  var color=select(select(vec3f(.11,.075,.037),vec3f(.07,.055,.04),v.kind.x>1.5),vec3f(.032,.035,.038),iron);
  color=select(color,vec3f(.45,.57,.59),water);
  let grain=.92+.08*sin(v.world.y*110.0+sin(v.world.x*67.0)+v.world.z*53.0);
  color*=select(grain,1.0,water);
  let rough=select(select(.8,.38,iron),.5,water);
  let f0=select(vec3f(.035),vec3f(.13),iron);
  let sun=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y)*solarShadowVisibility(vesselShadow(v.world,n));
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-1,0),7).rgb;
  var radiance=color*vesselAmbient(n,sky,sea)+sun*(color/PI+vesselSpecular(n,eye,F.sunDir.xyz,rough,f0))*max(dot(n,F.sunDir.xyz),0.0);
  radiance+=lunarSurface(n,eye,color,rough,f0,sunVis[1]*lunarShadowVisibility(vesselShadow(v.world,n)))+lightningSurface(n,eye,color,rough);
  let alpha=select(1.0,clamp(v.kind.y,0.0,1.0),water);
  return vec4f(surfaceAir(radiance,v.world)*alpha,alpha);
}
`;

// Keep ANCHOR_RENDER intact: the crew-tool renderer shares its material and
// ordinary position/normal interface. Only the anchor uses these templates.
const anchorGPUVertexStart=ANCHOR_RENDER.indexOf('@vertex fn vs(');
const anchorGPUFragmentStart=ANCHOR_RENDER.indexOf('@fragment fn fs(');
if(anchorGPUVertexStart<0||anchorGPUFragmentStart<anchorGPUVertexStart)throw Error('Anchor GPU shader interface changed');
export const ANCHOR_GPU_RENDER=ANCHOR_RENDER.slice(0,anchorGPUVertexStart)+/* wgsl */`
// Header: scale/rodeRadius/heading/stowed; iron origin/splash age;
// fairlead/splash active; splash origin; then 49 physical catenary knots.
@group(0) @binding(7) var<storage,read> anchorGPUState:array<vec4f>;
struct AnchorGPUPoint {position:vec3f,normal:vec3f,kind:vec2f};
fn anchorGPUUnit(v:vec3f)->vec3f {let n=length(v);if(n>1e-12){return v/n;}return vec3f(0,1,0);}
fn anchorGPUWorld(p:vec3f)->vec3f {
  return select(p,A.origin.xyz+A.right.xyz*p.x+A.up.xyz*p.y+A.aft.xyz*p.z,A.origin.w>.5);
}
fn anchorGPUNormal(n:vec3f)->vec3f {return select(n,A.right.xyz*n.x+A.up.xyz*n.y+A.aft.xyz*n.z,A.origin.w>.5);}
fn anchorGPUIron(p:vec3f)->vec3f {
  let scale=anchorGPUState[0].x;let angle=anchorGPUState[0].z;let q=p*scale;let c=cos(angle);let s=sin(angle);
  return anchorGPUState[1].xyz+vec3f(c*q.x-s*q.z,q.y,s*q.x+c*q.z);
}
fn anchorGPUCircle(angle:f32,r:f32)->vec3f {return vec3f(cos(angle)*r,sin(angle)*r,0);}
fn anchorGPUTube(a:vec3f,b:vec3f,radius:f32,endpoint:f32,angle:f32,baseAngle:f32,sides:f32,kind:f32)->AnchorGPUPoint {
  let axis=b-a;if(length(axis)<1e-6){return AnchorGPUPoint(a,vec3f(0,1,0),vec2f(kind,1));}
  let direction=normalize(axis);var seed=vec3f(0,1,0);if(abs(direction.y)>.9){seed=vec3f(1,0,0);}
  let across=normalize(cross(direction,seed));let up=cross(direction,across);
  let p=mix(a,b,endpoint)+radius*(across*cos(angle)+up*sin(angle));
  let edge=radius*(across*(cos(baseAngle+2.0*PI/sides)-cos(baseAngle))+up*(sin(baseAngle+2.0*PI/sides)-sin(baseAngle)));
  return AnchorGPUPoint(p,anchorGPUUnit(cross(edge,axis)),vec2f(kind,1));
}
fn anchorGPUSplashRing(segment:f32,corner:u32)->vec3f {
  let age=anchorGPUState[1].w;let scale=sqrt(anchorGPUState[0].x);let radius=(.22+age*1.7)*scale;let inner=radius*.85;
  let a=segment*PI/12.0;let b=(segment+1.0)*PI/12.0;
  let p0=vec3f(cos(a)*inner,.025,sin(a)*inner);let p1=vec3f(cos(b)*inner,.025,sin(b)*inner);
  let p2=vec3f(cos(a)*radius,.03,sin(a)*radius);let p3=vec3f(cos(b)*radius,.03,sin(b)*radius);
  if(corner==0u){return p0;}if(corner==1u||corner==4u){return p2;}if(corner==2u||corner==3u){return p1;}return p3;
}
fn anchorGPUSplashDrop(segment:f32,corner:u32)->vec3f {
  let age=anchorGPUState[1].w;let scale=sqrt(anchorGPUState[0].x);let a=segment*PI/8.0;
  let radius=(.2+age*(.7+sin(segment*7.0)*.25))*scale;let height=max(0.0,age*3.8-age*age*5.5)*scale;
  let width=.06*(1.0-age/.75)*scale;let origin=vec3f(cos(a)*radius,0,sin(a)*radius);
  if(corner==0u){return origin+vec3f(-width,.025,0);}if(corner==1u){return origin+vec3f(width,.025,0);}return origin+vec3f(0,height+.03,width);
}
fn anchorGPUExpand(position:vec3f,normal:vec3f,kind:vec2f)->AnchorGPUPoint {
  let mode=u32(round(kind.x));let scale=anchorGPUState[0].x;
  if(mode<2u){
    let a=anchorGPUState[0].z;let c=cos(a);let s=sin(a);
    return AnchorGPUPoint(anchorGPUIron(position),vec3f(c*normal.x-s*normal.z,normal.y,s*normal.x+c*normal.z),kind);
  }
  if(mode==4u){
    let segment=u32(round(position.x));return anchorGPUTube(anchorGPUState[4u+segment].xyz,anchorGPUState[5u+segment].xyz,
      anchorGPUState[0].y,position.y,position.z,normal.x,5.0,2.0);
  }
  if(mode==5u){
    let a=position.x*PI/5.0;let b=(position.x+1.0)*PI/5.0;let origin=anchorGPUState[2].xyz;
    return anchorGPUTube(origin+anchorGPUCircle(a,.10*scale),origin+anchorGPUCircle(b,.10*scale),.025*scale,position.y,position.z,normal.x,4.0,0.0);
  }
  let corner=u32(round(position.y));let age=anchorGPUState[1].w;let fade=max(0.0,1.0-age/1.6);
  if(mode==6u){
    let first=(corner/3u)*3u;let p=anchorGPUSplashRing(position.x,corner);
    let a=anchorGPUSplashRing(position.x,first);let b=anchorGPUSplashRing(position.x,first+1u);let c=anchorGPUSplashRing(position.x,first+2u);
    return AnchorGPUPoint(anchorGPUState[3].xyz+p,anchorGPUUnit(cross(b-a,c-a)),vec2f(3,.48*fade));
  }
  let p=anchorGPUSplashDrop(position.x,corner);let a=anchorGPUSplashDrop(position.x,0u);let b=anchorGPUSplashDrop(position.x,1u);let c=anchorGPUSplashDrop(position.x,2u);
  return AnchorGPUPoint(anchorGPUState[3].xyz+p,anchorGPUUnit(cross(b-a,c-a)),vec2f(3,.5*fade));
}
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->AnchorVertex {
  let expanded=anchorGPUExpand(position,normal,kind);let world=anchorGPUWorld(expanded.position);let n=anchorGPUNormal(expanded.normal);
  var out:AnchorVertex;out.position=F.viewProj*vec4f(world-F.camPos.xyz,1);
  out.world=world;out.normal=n;out.kind=expanded.kind;return out;
}
`+ANCHOR_RENDER.slice(anchorGPUFragmentStart);
