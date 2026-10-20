import {FRAME_WGSL,ATMO_CORE_WGSL} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';

export const DOLPHIN_RENDER=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(6) var displacement:texture_2d_array<f32>;
@group(0) @binding(7) var seaSampler:sampler;
struct Dolphin {root:vec4f,pose:vec4f};
struct DolphinSplash {root:vec4f,shape:vec4f};
@group(0) @binding(8) var<storage,read> dolphins:array<Dolphin>;
@group(0) @binding(9) var<storage,read> splashes:array<DolphinSplash>;
`+SKY_RENDER_FUNCS+/* wgsl */ `
fn dolphinSea(q:vec2f)->vec3f {
  var d=vec3f(0);
  for(var c=0u;c<3u;c++){d+=textureSampleLevel(displacement,seaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}
  return d;
}
fn dolphinHeight(p:vec2f)->f32 {let q=p-dolphinSea(p).xz;return dolphinSea(q).y;}
fn dolphinYaw(p:vec3f,heading:f32)->vec3f {let c=cos(heading);let s=sin(heading);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
struct DolphinVertex {@builtin(position) pos:vec4f,@location(0) world:vec3f,@location(1) normal:vec3f,@location(2) albedo:vec3f};
@vertex fn dolphinVS(@location(0) p:vec3f,@location(1) normal:vec3f,@location(2) albedo:vec3f,@builtin(instance_index) id:u32)->DolphinVertex {
  let d=dolphins[id];let tail=max(0.0,(p.z-.25)/1.35);let beat=sin(F.reserved.w*8.0+d.pose.z);
  let local=p+vec3f(0,beat*.24*tail*tail,0);
  let bentN=normalize(normal+vec3f(0,0,-normal.y*beat*.48*tail/1.35));
  let c=cos(d.pose.x);let s=sin(d.pose.x);
  let pitch=mat3x3f(vec3f(1,0,0),vec3f(0,c,s),vec3f(0,-s,c));
  let root=vec3f(d.root.x,dolphinHeight(d.root.xz)+d.root.y,d.root.z);
  var o:DolphinVertex;o.world=root+dolphinYaw(pitch*local*d.pose.y,d.root.w);
  o.normal=dolphinYaw(pitch*bentN,d.root.w);o.albedo=albedo;
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinFS(v:DolphinVertex)->@location(0) vec4f {
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);let sun=F.sunDir.xyz;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let f0=vec3f(.035);let rough=.24;
  let diffuse=v.albedo*(vesselAmbient(n,sky,sea)+direct*max(dot(n,sun),0.0)/PI);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),rough*8.0).rgb*vesselEnvironment(n,eye,rough,f0);
  let spec=vesselSpecular(n,eye,sun,rough,f0)*direct*max(dot(n,sun),0.0);
  let color=diffuse+reflected+spec+lightningSurface(n,eye,v.albedo,rough);
  return vec4f(surfaceAir(color,v.world),1);
}
fn dolphinCorner(i:u32)->vec2f {return array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i];}
struct DolphinEffect {@builtin(position) pos:vec4f,@location(0) uv:vec2f,@location(1) world:vec3f,@location(2) data:vec4f};
@vertex fn dolphinRippleVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let age=s.root.z;let corner=dolphinCorner(vertex);let radius=.45+age*1.1;
  let q=s.root.xy+dolphinYaw(vec3f(corner.x*radius,0,corner.y*radius*.65),s.shape.x).xz;
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.025,q.y);o.uv=corner;
  o.data=vec4f(age,s.root.w,s.shape.y,0);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinRippleFS(v:DolphinEffect)->@location(0) vec4f {
  let radius=length(v.uv);let band=abs(radius-.65);let aa=max(fwidth(radius),.008);
  let broken=.65+.35*sin(atan2(v.uv.y,v.uv.x)*11.0+v.data.z);
  let alpha=(1.0-smoothstep(.025,.065+aa,band))*(1.0-smoothstep(.3,3.2,v.data.x))*.32*v.data.y*broken;
  let light=skyAtmo(vec3f(0,1,0))*.5+sunIlluminance()*sunVis[0]*max(F.sunDir.y,0.0)*.24+lightningLight()*.2;
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
@vertex fn dolphinDropVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->DolphinEffect {
  let s=splashes[instance/12u];let id=f32(instance%12u);let age=s.root.z;
  let angle=id*2.39996+s.shape.y;let speed=.5+fract(sin(id*13.71+s.shape.y)*312.6)*1.4;
  let launch=vec3f(cos(angle)*speed,1.2+speed*.6,sin(angle)*speed);
  let p=vec3f(s.root.x,dolphinHeight(s.root.xy)+.06,s.root.y)+launch*age+vec3f(0,-4.905*age*age,0);
  let corner=dolphinCorner(vertex);let width=.016*(.7+s.root.w)*max(.1,1.0-age);
  var o:DolphinEffect;o.world=p;o.uv=corner;o.data=vec4f(age,s.root.w,s.shape.y,0);
  o.pos=F.viewProj*vec4f(p-F.camPos.xyz+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*width,1);return o;
}
@fragment fn dolphinDropFS(v:DolphinEffect)->@location(0) vec4f {
  let alpha=(1.0-smoothstep(.1,1.0,dot(v.uv,v.uv)))*(1.0-smoothstep(.25,.7,v.data.x))*.5*v.data.y;
  let light=skyAtmo(vec3f(0,1,0))*.6+sunIlluminance()*sunVis[0]*max(F.sunDir.y,0.0)*.32+lightningLight()*.3;
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
`;
