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
  let shadowSample=vesselShadow(v.world,n);
  let sun=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-1,0),7).rgb;
  var radiance=color*vesselAmbient(n,sky,sea)+sun*(color/PI+vesselSpecular(n,eye,F.sunDir.xyz,rough,f0))*max(dot(n,F.sunDir.xyz),0.0);
  radiance+=lunarSurface(n,eye,color,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,eye,color,rough);
  let alpha=select(1.0,clamp(v.kind.y,0.0,1.0),water);
  return vec4f(surfaceAir(radiance,v.world)*alpha,alpha);
}
`;

// The splash a let-go anchor throws up where it strikes the sea, drawn blended over the water. Her iron, its ring and
// its rode are her own assembly and detail lines (js/vessel-detail.js); this draws only the water. It keeps
// ANCHOR_RENDER's material and interface, and builds its ring and drops from the vertex index alone.
const anchorSplashVertexStart=ANCHOR_RENDER.indexOf('@vertex fn vs(');
const anchorSplashFragmentStart=ANCHOR_RENDER.indexOf('@fragment fn fs(');
if(anchorSplashVertexStart<0||anchorSplashFragmentStart<anchorSplashVertexStart)throw Error('Anchor shader interface changed');
export const ANCHOR_SPLASH_RING_VERTICES=144;
export const ANCHOR_SPLASH_DROP_VERTICES=48;
export const ANCHOR_SPLASH_RENDER=ANCHOR_RENDER.slice(0,anchorSplashVertexStart)+/* wgsl */`
// at: where the iron struck (world metres) and the splash's age (s); size.x: the anchor's render scale.
struct AnchorSplash {at:vec4f,size:vec4f};
@group(0) @binding(7) var<uniform> anchorSplash:AnchorSplash;
fn anchorSplashUnit(v:vec3f)->vec3f {let n=length(v);if(n>1e-12){return v/n;}return vec3f(0,1,0);}
fn anchorSplashRing(segment:f32,corner:u32)->vec3f {
  let age=anchorSplash.at.w;let scale=sqrt(anchorSplash.size.x);let radius=(.22+age*1.7)*scale;let inner=radius*.85;
  let a=segment*PI/12.0;let b=(segment+1.0)*PI/12.0;
  let p0=vec3f(cos(a)*inner,.025,sin(a)*inner);let p1=vec3f(cos(b)*inner,.025,sin(b)*inner);
  let p2=vec3f(cos(a)*radius,.03,sin(a)*radius);let p3=vec3f(cos(b)*radius,.03,sin(b)*radius);
  if(corner==0u){return p0;}if(corner==1u||corner==4u){return p2;}if(corner==2u||corner==3u){return p1;}return p3;
}
fn anchorSplashDrop(segment:f32,corner:u32)->vec3f {
  let age=anchorSplash.at.w;let scale=sqrt(anchorSplash.size.x);let a=segment*PI/8.0;
  let radius=(.2+age*(.7+sin(segment*7.0)*.25))*scale;let height=max(0.0,age*3.8-age*age*5.5)*scale;
  let width=.06*(1.0-age/.75)*scale;let origin=vec3f(cos(a)*radius,0,sin(a)*radius);
  if(corner==0u){return origin+vec3f(-width,.025,0);}if(corner==1u){return origin+vec3f(width,.025,0);}return origin+vec3f(0,height+.03,width);
}
// The ring's 24 quads, then the drops' 16 triangles while the splash is young.
@vertex fn vs(@builtin(vertex_index) index:u32)->AnchorVertex {
  let fade=max(0.0,1.0-anchorSplash.at.w/1.6);
  var p:vec3f;var a:vec3f;var b:vec3f;var c:vec3f;var alpha:f32;
  if(index<${ANCHOR_SPLASH_RING_VERTICES}u){
    let segment=f32(index/6u);let corner=index%6u;let first=(corner/3u)*3u;
    p=anchorSplashRing(segment,corner);a=anchorSplashRing(segment,first);b=anchorSplashRing(segment,first+1u);c=anchorSplashRing(segment,first+2u);alpha=.48*fade;
  }else{
    let j=index-${ANCHOR_SPLASH_RING_VERTICES}u;let segment=f32(j/3u);
    p=anchorSplashDrop(segment,j%3u);a=anchorSplashDrop(segment,0u);b=anchorSplashDrop(segment,1u);c=anchorSplashDrop(segment,2u);alpha=.5*fade;
  }
  let world=anchorSplash.at.xyz+p;
  var out:AnchorVertex;out.position=F.viewProj*vec4f(world-F.camPos.xyz,1);
  out.world=world;out.normal=anchorSplashUnit(cross(b-a,c-a));out.kind=vec2f(3,alpha);return out;
}
`+ANCHOR_RENDER.slice(anchorSplashFragmentStart);
