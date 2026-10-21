// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';

export const GUNNERY_CROWN_SEGMENTS=32;
export const GUNNERY_CROWN_ROWS=5;
export const GUNNERY_DROP_COUNT=32;
export const GUNNERY_RING_SEGMENTS=48;
export const GUNNERY_RING_COUNT=4;

export function GUNNERY_DEPTH_RESOLVE(samples=4){
  const count=Math.max(1,Math.floor(samples));
  return /* wgsl */ `
@group(0)@binding(0)var gunneryDepthSource:${count===1?'texture_depth_2d':'texture_depth_multisampled_2d'};
@group(0)@binding(1)var gunneryDepthTarget:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)fn gunneryResolveDepth(@builtin(global_invocation_id)id:vec3u){
  let size=textureDimensions(gunneryDepthTarget);if(any(id.xy>=size)){return;}
  var depth=0.0;
  for(var sample=0;sample<${count};sample++){depth=max(depth,textureLoad(gunneryDepthSource,vec2i(id.xy),${count===1?'0':'sample'}));}
  textureStore(gunneryDepthTarget,vec2i(id.xy),vec4f(depth));
}`;
}

export const GUNNERY_RENDER=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
@group(0)@binding(4)var envCube:texture_cube<f32>;
@group(0)@binding(5)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(6)var gunnerySea:texture_2d_array<f32>;
@group(0)@binding(7)var gunnerySeaSampler:sampler;
struct GunneryVolume{centre:vec4f,axisX:vec4f,axisY:vec4f,axisZ:vec4f,optical:vec4f};
struct GunneryBall{positionRadius:vec4f};
struct GunneryContact{root:vec4f,motion:vec4f,detail:vec4f,extra:vec4f};
@group(0)@binding(8)var<storage,read>gunneryVolumes:array<GunneryVolume>;
@group(0)@binding(9)var<storage,read>gunneryBalls:array<GunneryBall>;
@group(0)@binding(10)var<storage,read>gunneryContacts:array<GunneryContact>;
@group(0)@binding(11)var gunnerySceneDepth:texture_2d<f32>;
`+SKY_RENDER_FUNCS+/* wgsl */ `
fn gunneryCorner(vertex:u32)->vec2f{return array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[vertex%6u];}
fn gunneryCube(vertex:u32)->vec3f{
  let points=array<vec3f,8>(vec3f(-1,-1,-1),vec3f(1,-1,-1),vec3f(-1,1,-1),vec3f(1,1,-1),vec3f(-1,-1,1),vec3f(1,-1,1),vec3f(-1,1,1),vec3f(1,1,1));
  let indices=array<u32,36>(0u,2u,1u,1u,2u,3u,4u,5u,6u,5u,7u,6u,0u,4u,2u,2u,4u,6u,1u,3u,5u,3u,7u,5u,0u,1u,4u,1u,5u,4u,2u,6u,3u,3u,6u,7u);
  return points[indices[vertex]];
}
fn gunneryVolumeLocal(v:GunneryVolume,p:vec3f)->vec3f{
  let d=p-v.centre.xyz;return vec3f(dot(d,v.axisX.xyz)/v.axisX.w,dot(d,v.axisY.xyz)/v.axisY.w,dot(d,v.axisZ.xyz)/v.axisZ.w);
}
fn gunneryVolumeRay(v:GunneryVolume,ray:vec3f)->vec3f{return vec3f(dot(ray,v.axisX.xyz)/v.axisX.w,dot(ray,v.axisY.xyz)/v.axisY.w,dot(ray,v.axisZ.xyz)/v.axisZ.w);}
fn gunneryDensity(local:vec3f,age:f32,seed:f32)->f32{
  // Compact support guarantees no cube edge can appear. Two low-frequency
  // domain-warped eddies create connected billows, rather than tiny smoke dots.
  let support=1.0-smoothstep(.65,1.0,dot(local,local));if(support<=0.0){return 0.0;}
  let p=local+sin(local.yzx*3.3+vec3f(seed,seed*.7,-seed)+age*.36)*.075;
  let r2=dot(p,p);if(r2>=1.0){return 0.0;}
  let turn=seed*.71;let a=vec3f(cos(turn)*.29,.23,sin(turn)*.21);
  let b=vec3f(-sin(turn)*.29,-.22,cos(turn)*.22);
  let c=vec3f(sin(turn)*.3,-.08,-cos(turn)*.25);
  let lobes=exp(-dot(p-a,p-a)*6.0)+exp(-dot(p-b,p-b)*6.7)+exp(-dot(p-c,p-c)*7.0);
  let billow=smoothstep(.08,.72,lobes);
  let eddy=sin(p.x*5.1+seed+age*.45)*sin(p.y*4.7-seed*.3)*sin(p.z*4.3+age*.27);
  let detail=sin(p.x*12.0+p.z*4.0+seed)*sin(p.y*10.0-p.z*5.0-age*.3);
  return support*billow*max(.12,.56+eddy*.38+detail*.12);
}
fn gunnerySceneDistance(pixel:vec2f,ray:vec3f)->f32{
  let size=textureDimensions(gunnerySceneDepth);let uv=clamp(vec2i(pixel),vec2i(0),vec2i(size)-1);
  let depth=textureLoad(gunnerySceneDepth,uv,0).x;if(depth<=0.0){return 1e8;}
  // General camera-relative projection inversion, including the actual near
  // plane. No guessed 0.1/depth conversion or detached screen-space billboard.
  let clipRay=F.viewProj*vec4f(ray,0);let clipOrigin=F.viewProj*vec4f(0,0,0,1);
  return max(0.0,(clipOrigin.z-depth*clipOrigin.w)/(depth*clipRay.w-clipRay.z));
}
struct GunneryVolumeVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)@interpolate(flat)id:u32};
@vertex fn gunneryVolumeVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryVolumeVertex{
  let v=gunneryVolumes[id];let c=gunneryCube(vertex);
  let world=v.centre.xyz+v.axisX.xyz*c.x*v.axisX.w+v.axisY.xyz*c.y*v.axisY.w+v.axisZ.xyz*c.z*v.axisZ.w;
  return GunneryVolumeVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,id);
}
@fragment fn gunneryVolumeFS(v:GunneryVolumeVertex)->@location(0)vec4f{
  let volume=gunneryVolumes[v.id];let ray=normalize(v.world-F.camPos.xyz);
  let origin=gunneryVolumeLocal(volume,F.camPos.xyz);let direction=gunneryVolumeRay(volume,ray);
  // The density's domain warp stays within this ellipsoid's conservative cube.
  let safe=select(direction,vec3f(.000001),abs(direction)<vec3f(.000001));
  let t0=(-vec3f(1)-origin)/safe;let t1=(vec3f(1)-origin)/safe;
  let low=min(t0,t1);let high=max(t0,t1);
  let enter=max(0.0,max(low.x,max(low.y,low.z)));
  let scene=gunnerySceneDistance(v.position.xy,ray);
  let exit=min(scene,min(high.x,min(high.y,high.z)));if(exit<=enter){discard;}
  let stepSize=(exit-enter)/12.0;var transmittance=1.0;var radiance=vec3f(0);
  let ambient=skyAtmo(vec3f(0,1,0))*.58+lightningLight()*.2;
  let sunlight=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let sunLocal=gunneryVolumeRay(volume,F.sunDir.xyz);
  let phase=.075+.11*pow(max(0.0,dot(ray,F.sunDir.xyz)),4.0);
  for(var sample=0u;sample<12u;sample++){
    let distance=enter+(f32(sample)+.5)*stepSize;let world=F.camPos.xyz+ray*distance;
    let local=origin+direction*distance;
    var density=gunneryDensity(local,volume.optical.y,volume.optical.z);
    // A small soft intersection margin removes hard slices at timber and sea.
    density*=smoothstep(0.0,.16,scene-distance);
    if(density<.001){continue;}
    var emission=vec3f(0);var extinction=volume.optical.x*density;
    if(volume.centre.w>.5){
      let flame=max(0.0,1.0-dot(local,local));
      emission=mix(vec3f(15.0,2.2,.15),vec3f(38.0,25.0,8.0),flame*flame)*volume.optical.x;
      extinction=density*4.0;
    }else{
      // Three finite sunlight samples give a dark dense core and bright billow
      // edges. Smoke itself is not emissive at night after the short flash.
      let lightStep=min(volume.axisX.w,min(volume.axisY.w,volume.axisZ.w))*.58;
      var shadowDepth=0.0;
      for(var lightSample=1u;lightSample<=3u;lightSample++){
        shadowDepth+=gunneryDensity(local+sunLocal*lightStep*f32(lightSample),volume.optical.y,volume.optical.z)*lightStep*volume.optical.x;
      }
      emission=vec3f(.84,.83,.79)*(ambient+sunlight*phase*exp(-shadowDepth));
    }
    let opacity=1.0-exp(-extinction*stepSize);
    radiance+=transmittance*opacity*emission;transmittance*=1.0-opacity;
    if(transmittance<.008){break;}
  }
  let alpha=1.0-transmittance;if(alpha<.002){discard;}
  let averageWorld=F.camPos.xyz+ray*(enter+exit)*.5;
  return vec4f(surfaceAir(radiance/max(alpha,.0001),averageWorld)*alpha,alpha);
}

struct GunneryBallVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)normal:vec3f};
@vertex fn gunneryBallVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryBallVertex{
  let ball=gunneryBalls[id].positionRadius;let cell=vertex/6u;let uv=gunneryCorner(vertex);
  let longitude=(f32(cell%12u)+uv.x)*(2.0*PI)/12.0;let latitude=(f32(cell/12u)+uv.y)*PI/8.0;
  let normal=vec3f(cos(longitude)*sin(latitude),cos(latitude),sin(longitude)*sin(latitude));let world=ball.xyz+normal*ball.w;
  return GunneryBallVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,normal);
}
@fragment fn gunneryBallFS(v:GunneryBallVertex)->@location(0)vec4f{
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);let nl=max(0.0,dot(n,F.sunDir.xyz));
  let albedo=vec3f(.038,.034,.029);let light=albedo*(vesselAmbient(n,sky,sea)+direct*nl/PI)+vesselSpecular(n,eye,F.sunDir.xyz,.62,vec3f(.045))*direct*nl;
  return vec4f(surfaceAir(light+lightningSurface(n,eye,albedo,.62),v.world),1);
}

fn gunnerySeaDisplacement(q:vec2f)->vec3f{
  var d=vec3f(0);for(var c=0u;c<${CASCADES}u;c++){d+=textureSampleLevel(gunnerySea,gunnerySeaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}return d;
}
fn gunnerySeaHeight(p:vec2f)->f32{var q=p;for(var i=0u;i<2u;i++){q=p-gunnerySeaDisplacement(q).xz;}return gunnerySeaDisplacement(q).y;}
fn gunneryContactHeading(c:GunneryContact)->vec2f{let horizontal=c.motion.xz;return normalize(horizontal+vec2f(.00001));}
fn gunneryImpactLift(c:GunneryContact)->f32{return clamp(2.5+abs(c.motion.y)*.42+length(c.motion.xyz)*.014,3.0,12.0)*sqrt(c.motion.w);}
fn gunneryImpactRadial(c:GunneryContact)->f32{return clamp(1.3+length(c.motion.xyz)*.01,1.6,5.5)*sqrt(c.motion.w);}
fn gunneryWaterRadiance(world:vec3f,normal:vec3f,foam:f32)->vec3f{
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.2).rgb;
  let diffuse=skyAtmo(vec3f(0,1,0))*.6+direct*max(F.sunDir.y,.08)*.23+lightningLight()*.3;
  let glint=vesselSpecular(n,eye,F.sunDir.xyz,.16,vec3f(.0204))*direct*max(0.0,dot(n,F.sunDir.xyz));
  return mix(reflected*.88+glint,diffuse,foam);
}
struct GunneryWaterVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32};
// The initial crown is a connected film launched from the real impact's fixed
// birth height. Detached water follows gravity, never the next passing crest.
@vertex fn gunneryCrownVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let age=c.root.w;let uv=gunneryCorner(vertex);let cell=vertex/6u;
  let angle=(f32(cell%${GUNNERY_CROWN_SEGMENTS}u)+uv.x)*(2.0*PI)/${GUNNERY_CROWN_SEGMENTS}.0;
  let row=(f32(cell/${GUNNERY_CROWN_SEGMENTS}u)+uv.y)/${GUNNERY_CROWN_ROWS}.0;
  let lift=gunneryImpactLift(c);let radial=gunneryImpactRadial(c);let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let lobe=.77+.18*sin(angle*7.0+c.detail.x*70.0)+.08*sin(angle*13.0-c.detail.x*43.0);
  let radius=(.06+radial*age*row)*c.motion.w;
  let drift=heading*min(12.0,length(c.motion.xz)*.025)*age;
  let horizontal=side*cos(angle)*radius+heading*sin(angle)*radius*1.18+drift*row;
  let rise=max(0.0,lift*age-4.905*age*age)*row*lobe;
  let world=c.root.xyz+vec3f(horizontal.x,.025+rise,horizontal.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(angle,row),id);
}
@fragment fn gunneryCrownFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let age=c.root.w;let life=gunneryImpactLift(c)/4.905;
  if(age>=life||age<=0.0){discard;}
  let rim=smoothstep(.4,1.0,v.uv.y);let breakup=smoothstep(.15,.8,age)*v.uv.y;
  let lace=.5+.27*sin(v.uv.x*19.0+c.detail.x*31.0)*sin(v.uv.y*14.0+c.detail.x*59.0)+.2*sin(v.uv.x*31.0-v.uv.y*8.0);
  let film=smoothstep(breakup*.58,breakup*.58+.15,lace);
  let foam=clamp(.12+rim*.7+breakup*.2,0.0,1.0);
  let alpha=film*(.18+foam*.52)*smoothstep(0.0,.035,age)*(1.0-smoothstep(life*.6,life,age));
  if(alpha<.002){discard;}
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,foam),v.world)*alpha,alpha);
}
@vertex fn gunneryDropVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryWaterVertex{
  let id=instance/${GUNNERY_DROP_COUNT}u;let c=gunneryContacts[id];let drop=f32(instance%${GUNNERY_DROP_COUNT}u);let age=c.root.w;
  let random=fract(sin(drop*17.137+c.detail.x*73.0)*437.1);let angle=drop*2.399963+c.detail.x*63.0;
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);let radial=gunneryImpactRadial(c)*(.6+random*.55);
  let across=side*cos(angle)*radial+heading*sin(angle)*radial+heading*min(12.0,length(c.motion.xz)*.025);
  let launch=vec3f(across.x,gunneryImpactLift(c)*(.65+random*.4),across.y);
  // Analytic aerodynamic drift grows gradually; gravity remains 9.81 m/s².
  let wind=c.detail.yzw*(age-.7*(1.0-exp(-age/.7)))*.16;
  let world=c.root.xyz+launch*age+vec3f(0,.04-4.905*age*age,0)+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;let radius=(.012+random*.028)*c.motion.w;
  let eye=normalize(F.camPos.xyz-world);let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);
  let surface=world+(right*corner.x+up*corner.y)*radius;
  return GunneryWaterVertex(F.viewProj*vec4f(surface-F.camPos.xyz,1),surface,corner,id);
}
@fragment fn gunneryDropFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let radius=dot(v.uv,v.uv);if(radius>=1.0||c.root.w>3.0||v.world.y<c.root.y){discard;}
  let eye=normalize(F.camPos.xyz-v.world);let n=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.001,1.0-radius)));
  let alpha=(1.0-smoothstep(.3,1.0,radius))*.7;
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,.45),v.world)*alpha,alpha);
}
@vertex fn gunneryRingVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let ring=vertex/(${GUNNERY_RING_SEGMENTS}u*6u);let uv=gunneryCorner(vertex);let segment=(vertex/6u)%${GUNNERY_RING_SEGMENTS}u;
  let age=c.root.w-f32(ring)*.15;let angle=(f32(segment)+uv.x)*(2.0*PI)/${GUNNERY_RING_SEGMENTS}.0;
  let crossSection=uv.y*2.0-1.0;let radius=(.1+max(0.0,age)*2.1*sqrt(c.motion.w))+crossSection*(.055+max(0.0,age)*.018);
  let q=c.root.xz+vec2f(cos(angle),sin(angle))*radius;
  let crest=(1.0-crossSection*crossSection)*.07*c.motion.w*exp(-max(0.0,age)*.8);
  let world=vec3f(q.x,gunnerySeaHeight(q)+.025+crest,q.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(crossSection,angle),id*${GUNNERY_RING_COUNT}u+ring);
}
@fragment fn gunneryRingFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id/${GUNNERY_RING_COUNT}u];let ring=v.id%${GUNNERY_RING_COUNT}u;let age=c.root.w-f32(ring)*.15;if(age<=0.0||age>=8.0){discard;}
  let edge=1.0-smoothstep(.3,1.0,abs(v.uv.x));let broken=.7+.2*sin(v.uv.y*13.0+c.detail.x*71.0)+.1*sin(v.uv.y*29.0-c.detail.x*49.0);
  let alpha=edge*broken*exp(-age*.48)*smoothstep(0.0,.08,age)*(1.0-smoothstep(5.5,8.0,age))*.55;
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,exp(-age*.9)*.8),v.world)*alpha,alpha);
}
`;
