import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';

const LAND_SAMPLING = /* wgsl */ `
struct Land { domain:vec4f };
fn landHeight(p:vec2f)->f32 {
  let uv=(p-LAND.domain.xy)/LAND.domain.z+0.5;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){return -120.0;}
  let q=uv*vec2f(textureDimensions(elevation)-1u);let i=vec2i(floor(q));let f=fract(q);
  let limit=vec2i(textureDimensions(elevation))-1;
  return mix(mix(textureLoad(elevation,i,0).r,textureLoad(elevation,min(i+vec2i(1,0),limit),0).r,f.x),
    mix(textureLoad(elevation,min(i+vec2i(0,1),limit),0).r,textureLoad(elevation,min(i+vec2i(1,1),limit),0).r,f.x),f.y);
}
`;

// Visual shore response only. The heightfield's underwater skirt is authored;
// this does not pretend to be a surveyed shallow-water wave simulation.
export const COASTAL_WATER = /* wgsl */ `
@group(2) @binding(0) var<uniform> LAND:Land;
@group(2) @binding(1) var elevation:texture_2d<f32>;
` + LAND_SAMPLING + /* wgsl */ `
fn coastalWater(color:vec3f,p:vec2f,height:f32,foamLight:vec3f)->vec3f{
  let bed=landHeight(p);let shallows=smoothstep(-6.0,0.5,bed);
  let sunlight=sunIlluminance()*max(F.sunDir.y,0.0)/PI;
  var col=mix(color,vec3f(0.045,0.17,0.15)*(sunlight+skyAtmo(vec3f(0,1,0))),shallows*0.28);
  let depth=height-bed;
  let surge=smoothstep(-0.05,0.45,height);
  let broken=0.55+0.45*gnoise(p*0.17+vec2f(F.camPos.w*0.06));
  let foam=(1.0-smoothstep(0.35,3.0,abs(depth)))*surge*broken;
  return mix(col,foamLight,foam*0.7);
}
`;

export const TERRAIN_LIGHT = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var elevation:texture_2d<f32>;
@group(0) @binding(5) var lightOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var<uniform> LAND:Land;
` + LAND_SAMPLING + SKY_RENDER_FUNCS + CLOUD_SAMPLE + /* wgsl */ `
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(lightOut);if(any(id.xy>=size)){return;}
  let p=(vec2f(id.xy)+0.5)/vec2f(size)*LAND.domain.z-LAND.domain.z*0.5+LAND.domain.xy;
  let h=landHeight(p);var visibility=0.0;
  if(F.sunDir.y>0.0){
    visibility=volumeSunVisibility(vec3f(p.x,h+8.0,p.y)*0.001,F.sunDir.xyz);
    let horizontal=max(length(F.sunDir.xz),0.01);let direction=F.sunDir.xz/horizontal;
    for(var i=0u;i<16u;i++){
      let reach=28.0*pow(1.31,f32(i));
      let rayHeight=h+8.0+reach*F.sunDir.y/horizontal;
      visibility*=smoothstep(-5.0,12.0,rayHeight-landHeight(p+direction*reach));
    }
  }
  textureStore(lightOut,vec2i(id.xy),vec4f(visibility,0,0,1));
}
`;

export const TERRAIN = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND:Land;
struct Land {domain:vec4f};
@group(0) @binding(7) var canopy:texture_2d<f32>;
@group(0) @binding(8) var canopySampler:sampler;
` + SKY_RENDER_FUNCS + CLOUD_SAMPLE + /* wgsl */ `
struct LandVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->LandVertex{
  var o:LandVertex;o.world=position;o.normal=normal;o.kind=kind;
  o.pos=F.viewProj*vec4f(position-F.camPos.xyz,1.0);return o;
}
@vertex fn treeVS(@builtin(vertex_index) index:u32,@location(0) root:vec4f,@location(1) shape:vec4f)->LandVertex{
  // Rounded, solid broadleaf crowns. Blend distant leaf lighting into the
  // underlying forest so low-detail crowns do not become black cutouts.
  let face=index/3u;let corner=index%3u;let sector=face%8u;let band=face/8u;
  var ring=0.0;var edge=sector;
  if(band==0u){ring=select(1.0,0.0,corner==0u);if(corner==2u){edge=(sector+1u)%8u;}}
  if(band==1u){ring=select(1.0,2.0,corner==1u);if(corner==2u){edge=(sector+1u)%8u;}}
  if(band==2u){ring=select(2.0,1.0,corner==2u);if(corner>0u){edge=(sector+1u)%8u;}}
  if(band==3u){ring=select(2.0,3.0,corner==0u);if(corner==2u){edge=(sector+1u)%8u;}}
  let latitude=ring*PI/3.0;let angle=f32(edge)*PI/4.0+shape.y*2.0*PI;
  let radial=vec3f(sin(latitude)*cos(angle),cos(latitude),sin(latitude)*sin(angle));
  let local=radial*vec3f(root.w,shape.x*0.42,root.w)+vec3f(0,shape.x*0.56,0);
  var o:LandVertex;o.world=root.xyz+local;
  let ground=normalize(vec3f(-shape.z,1,-shape.w));
  let detail=0.12+0.35*(1.0-smoothstep(60.0,400.0,distance(o.world,F.camPos.xyz)));
  o.normal=normalize(mix(ground,normalize(radial+vec3f(0,1.1,0)),detail));o.kind=vec2f(1,shape.y);
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);return o;
}
@fragment fn fs(in:LandVertex)->@location(0) vec4f{
  let world=in.world;let distanceToEye=distance(world,F.camPos.xyz);var n=normalize(in.normal);
  let broad=gnoise(world.xz*0.0018);let grain=gnoise(world.xz*0.019);
  let fineFade=1.0-smoothstep(0.3,2.0,max(length(dpdx(world)),length(dpdy(world))));
  let fine=gnoise(world.xz*0.31)*fineFade;
  let slope=1.0-n.y;let rocky=smoothstep(0.22,0.56,slope+grain*0.07);
  let shore=1.0-smoothstep(3.0,17.0,world.y+grain*2.0);
  let canopyField=textureSampleBias(canopy,canopySampler,world.xz/512.0,0.75);
  let forest=pow(vec3f(canopyField.rg,(31.0+canopyField.b*16.0)/255.0),vec3f(2.2))*mix(vec3f(0.65,0.65,0.60),vec3f(1.0,0.95,0.7),saturate(0.5+broad+grain*0.35));
  let strata=gnoise(vec2f(world.y*0.13,world.x*0.011+world.z*0.015));
  let rock=mix(vec3f(0.075,0.065,0.055),vec3f(0.18,0.16,0.13),0.5+grain*0.4+strata*0.25);
  var albedo=mix(forest,rock,rocky);
  albedo=mix(albedo,vec3f(0.20,0.18,0.135)*(0.9+grain*0.3),shore);
  albedo*=1.0+fine*0.18;
  if(in.kind.x>0.5){albedo=forest*(0.94+in.kind.y*0.12);}
  let canopyDetail=1.0-smoothstep(700.0,2400.0,distanceToEye);
  let relief=gnoise(world.xz*0.075)*fineFade*0.25+canopyField.b*0.2*canopyDetail*(1.0-rocky)*(1.0-shore);
  let dx=dpdx(world);let dy=dpdy(world);let sx=cross(dy,n);let sy=cross(n,dx);let det=dot(dx,sx);
  let gradient=(dpdx(relief)*sx+dpdy(relief)*sy)/max(abs(det),0.00001)*sign(det);
  n=normalize(n-clamp(gradient,vec3f(-0.45),vec3f(0.45)));
  let wet=(1.0-smoothstep(0.5,3.5,world.y))*(0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02));
  albedo*=1.0-wet*0.36;
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let sunlight=textureSampleLevel(landLight,sampC,uv,0.0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7.0).rgb;
  var col=albedo*(direct*max(dot(n,F.sunDir.xyz),0.0)/PI+ambient*(0.42+0.35*max(n.y,0.0)));
  let v=normalize(F.camPos.xyz-world);let h=normalize(v+F.sunDir.xyz);
  col+=direct*wet*pow(max(dot(n,h),0.0),48.0)*0.06;
  col=surfaceAir(col,world);
  // Clip cloud integration at the land surface: clouds behind mountains stay
  // hidden; low clouds in front veil the slopes using the existing volume.
  let ray=marchCloudsTo(F.camPos.xyz*0.001,normalize(world-F.camPos.xyz),12u,0.5,
    sunIlluminance(),skyAtmo(vec3f(0,1,0)),distanceToEye*0.001);
  return vec4f(col*(1.0-ray.color.a)+ray.color.rgb,1.0);
}
`;
