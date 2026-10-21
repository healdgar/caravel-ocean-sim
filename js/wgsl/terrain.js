import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';

// Procedurals need their sampling rate in material coordinates, just as image
// textures need mip/anisotropic footprints. See pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing.
// Derivatives are supplied by the caller before material-dependent branches.
export const TERRAIN_FILTERING = /* wgsl */ `
fn landMaterialFootprint(dx:vec2f,dy:vec2f)->f32{
  // Frobenius norm bounds the longest axis of the pixel's material footprint,
  // including oblique/sheared projections; max(length(dx),length(dy)) can miss it.
  return sqrt(dot(dx,dx)+dot(dy,dy));
}
fn landDetailWeight(cellWidth:f32)->f32{
  // A lattice cell needs several pixels. Remove its contrast before Nyquist;
  // multiplying a fully aliased sample by a distant world-metre fade is too late.
  return 1.0-smoothstep(0.125,0.5,cellWidth);
}
fn landFilteredNoise(p:vec2f,cellWidth:f32)->f32{
  let weight=landDetailWeight(cellWidth);
  if(weight<=0.0){return 0.0;}
  return gnoise(p)*weight; // Gradient noise has zero mean.
}
fn landFilteredFissure(p:vec2f,cellWidth:f32,inner:f32,outer:f32)->f32{
  // Thresholding noise introduces much finer features than the lattice itself.
  // Fade crack contrast at its own width, never threshold already-faded noise
  // (which would turn every unresolved cell into a dark crack). Unresolved crack
  // contrast returns to the registered material colour, not a darkened plateau.
  let weight=landDetailWeight(cellWidth/max(outer-inner,0.001));
  if(weight<=0.0){return 0.0;}
  return (1.0-smoothstep(inner,outer,abs(gnoise(p))))*weight;
}
fn landFilteredBump(n:vec3f,dx:vec3f,dy:vec3f,hx:f32,hy:f32)->vec3f{
  let sx=cross(dy,n);let sy=cross(n,dx);let det=dot(dx,sx);
  let area=length(cross(dx,dy));
  // Smooth vertex normals can become nearly tangent to a steep triangle. That
  // ill-conditioned inverse must not amplify tiny residual height differences.
  let confidence=smoothstep(0.08,0.25,abs(det)/max(area,0.000000000001));
  let gradient=(hx*sx+hy*sy)/max(abs(det),max(area*0.08,0.000000000001))*sign(det);
  return normalize(n-clamp(gradient,vec3f(-0.42),vec3f(0.42))*confidence);
}
`;

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
@group(0) @binding(7) var landAlbedo:texture_2d<f32>;
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(9) var vegetationMask:texture_2d<f32>;
@group(0) @binding(10) var leafSpray:texture_2d<f32>;
@group(0) @binding(11) var<uniform> leafMean:vec4f;
` + SKY_RENDER_FUNCS + CLOUD_SAMPLE + TERRAIN_FILTERING + /* wgsl */ `
struct LandVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
  @location(3) leafUV:vec2f,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->LandVertex{
  var o:LandVertex;o.world=position;o.normal=normal;o.kind=kind;o.leafUV=vec2f(0);
  o.pos=F.viewProj*vec4f(position-F.camPos.xyz,1.0);return o;
}
@vertex fn treeVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,
  @location(3) root:vec4f,@location(4) shape:vec4f,@location(5) leafUV:vec2f)->LandVertex{
  let phase=shape.y*2.0*PI;
  let angle=phase;let c=cos(angle);let s=sin(angle);
  let local=vec3f((position.x*c-position.z*s)*root.w,position.y*shape.x,(position.x*s+position.z*c)*root.w);
  // Bend the entire connected structure by height. The same wind field and
  // seed at every tier preserve branch attachments and tree identity at LODs.
  let wind=F.windP[0].xy;let crosswind=vec2f(-wind.y,wind.x);
  let windForce=clamp(F.windP[0].z/12.0,0.0,2.2)*0.018;
  let gust=0.7+0.3*sin(F.camPos.w*0.65+phase);
  let windDirection=wind*gust+crosswind*sin(F.camPos.w*0.49+phase)*0.22;
  let swayXZ=windDirection*windForce*shape.x*position.y*position.y;
  let sway=vec3f(swayXZ.x,0,swayXZ.y);
  var o:LandVertex;o.world=root.xyz+local+sway;
  let scaled=normal/max(vec3f(root.w,shape.x,root.w),vec3f(0.001));
  var rotated=vec3f(scaled.x*c-scaled.z*s,scaled.y,scaled.x*s+scaled.z*c);
  rotated.y-=dot(rotated.xz,windDirection)*windForce*2.0*position.y;
  o.normal=normalize(rotated);o.leafUV=leafUV;
  o.kind=kind;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);return o;
}
@vertex fn groundVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,
  @location(3) root:vec4f,@location(4) shape:vec4f,@location(5) leafUV:vec2f)->LandVertex{
  let angle=shape.y*2.0*PI;let c=cos(angle);let s=sin(angle);
  let up=normalize(vec3f(-shape.z,1,-shape.w));let right=normalize(vec3f(1,shape.z,0));let front=cross(right,up);
  let p=vec3f((position.x*c-position.z*s)*root.w,position.y*shape.x,(position.x*s+position.z*c)*root.w);
  let grass=kind.x>6.5;
  var sway=vec3f(0);
  if(grass){let bend=F.windP[0].xy*clamp(F.windP[0].z/12.0,0.0,2.2)*.035*shape.x*position.y*position.y*sin(F.camPos.w*1.8+angle);sway=vec3f(bend.x,0,bend.y);}
  let scaled=normal/max(vec3f(root.w,shape.x,root.w),vec3f(.001));
  let n=vec3f(scaled.x*c-scaled.z*s,scaled.y,scaled.x*s+scaled.z*c);
  var o:LandVertex;o.world=root.xyz+right*p.x+up*p.y+front*p.z+sway;o.normal=normalize(right*n.x+up*n.y+front*n.z);
  o.kind=kind;o.leafUV=leafUV;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
// The opaque call graph contains neither discard nor a leaf texture fetch.
// Keep that property for Apple's hidden-surface removal; a runtime branch in
// one shared cutout fragment would still make solid ground a feedback shader.
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,wet:f32,roughness:f32)->vec4f{
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let sunlight=textureSampleLevel(landLight,sampC,uv,0.0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7.0).rgb;
  var col=albedo*(1.0-wet*0.36)*(direct*diffuse/PI+ambient*ambientVisibility);
  let v=normalize(F.camPos.xyz-world);let h=normalize(v+F.sunDir.xyz);
  let specular=(0.004*(1.0-roughness)+wet*0.06)*pow(max(dot(n,h),0.0),mix(12.0,64.0,1.0-roughness));
  col+=direct*specular;
  col+=lightningSurface(n,v,albedo,roughness);
  col=surfaceAir(col,world);
  // Clip cloud integration at the land surface: clouds behind mountains stay
  // hidden; low clouds in front veil the slopes using the existing volume.
  let ray=marchCloudsTo(F.camPos.xyz*0.001,normalize(world-F.camPos.xyz),12u,0.5,
    sunIlluminance(),skyAtmo(vec3f(0,1,0)),distance(world,F.camPos.xyz)*0.001);
  return vec4f(col*(1.0-ray.color.a)+ray.color.rgb,1.0);
}
fn landOpaque(in:LandVertex)->vec4f{
  let world=in.world;var n=normalize(in.normal);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let dx=dpdx(world);let dy=dpdy(world);
  // Registered aerial RGB remains the regional colour seed. The neutral detail
  // below adds material scale, never a replacement green/brown island palette.
  let source=pow(textureSampleGrad(landAlbedo,landSampler,uv,dx.xz/LAND.domain.z,dy.xz/LAND.domain.z).rgb,vec3f(2.2));
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0.0).r;
  let footprint=max(length(dx),length(dy));
  let detailFade=1.0-smoothstep(0.25,2.5,footprint);
  var grain=0.0;
  if(in.kind.x<2.5){grain=landFilteredNoise(world.xz*0.019,landMaterialFootprint(dx.xz,dy.xz)*0.019);}
  let rocky=smoothstep(0.22,0.56,1.0-n.y+grain*0.07);
  let vertical=mix(world.zy,world.xy,smoothstep(0.35,0.65,abs(n.z)/(abs(n.x)+abs(n.z)+0.001)));
  let materialUV=mix(world.xz,vertical,rocky);
  // Different cliff projections and their blend can stretch coordinates much
  // faster than world position. Filter that actual mapping, before branching.
  let materialWidth=landMaterialFootprint(dpdx(materialUV),dpdy(materialUV));
  var albedo=source;var relief=0.0;var roughness=0.95;
  var ambientVisibility=0.42+0.35*max(n.y,0.0);
  let crown=in.kind.x>3.5;
  if(in.kind.x<2.5){
    // Ground and cliff projections keep metre-scale stone legible on slopes.
    // Two-dimensional analytic noise only; no 3D noise octave loop. Crowns and
    // bark never execute these ground-material evaluations.
    let blockWidth=materialWidth*.19;let blockWeight=landDetailWeight(blockWidth);
    var blockNoise=0.0;if(blockWeight>0.0){blockNoise=gnoise(materialUV*.19);}
    let blocks=blockNoise*blockWeight;
    let stone=landFilteredNoise(materialUV*.82,materialWidth*.82);
    let pores=landFilteredNoise(materialUV*5.4,materialWidth*5.4);
    let fissure=landFilteredFissure(materialUV*1.7+vec2f(13.1,7.7),materialWidth*1.7,.025,.11);
    // Reuse the raw block noise, not its faded value, without another noise call.
    let coarseFissure=(1.0-smoothstep(.025,.09,abs(blockNoise)))*landDetailWeight(blockWidth/.065);
    albedo=source*(1.0+blocks*.14+stone*0.10+pores*0.055-(fissure*.075+coarseFissure*.08)*rocky);
    let soil=stone*(0.025+vegetation*0.012)+pores*(0.006+vegetation*0.006);
    relief=mix(soil,stone*0.14+blocks*.22-fissure*0.065-coarseFissure*.10,rocky);
    roughness=clamp(0.89+vegetation*0.035+pores*0.055-rocky*0.08,0.65,0.98);
  }else if(!crown){
    let barkNoise=gnoise(in.leafUV*vec2f(38.0,9.0));
    let ridges=pow(0.5+0.5*sin(in.leafUV.x*PI*56.0+barkNoise*3.0),5.0);
    albedo=vec3f(0.095,0.068,0.038)*(0.82+barkNoise*0.18+in.kind.y*0.16);
    relief=(ridges-0.5)*0.010*(1.2-in.kind.y)*detailFade;roughness=0.92;
  }
  if(crown){
    let exposure=clamp(in.kind.y,0.0,1.0);
    let canopyGrain=gnoise(world.xz*0.32+vec2f(world.y*0.17));
    let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
    albedo=leafMean.rgb*mix(vec3f(1),regionalTint,0.2)*(0.78+exposure*0.30+canopyGrain*0.04);
    ambientVisibility=0.14+exposure*0.47+max(n.y,0.0)*0.08;
    relief=0.0;roughness=0.95;
  }
  let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  if(in.kind.x<2.5){n=landFilteredBump(n,dx,dy,reliefX,reliefY);}
  else{
    let sx=cross(dy,n);let sy=cross(n,dx);let det=dot(dx,sx);
    let gradient=(reliefX*sx+reliefY*sy)/max(abs(det),0.00001)*sign(det);
    n=normalize(n-clamp(gradient,vec3f(-0.42),vec3f(0.42)));
  }
  let wet=(1.0-smoothstep(0.5,3.5,world.y))*(0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02));
  roughness=mix(roughness,0.27,wet);
  return landFinish(world,n,albedo,max(dot(n,F.sunDir.xyz),0.0),ambientVisibility,wet,roughness);
}
@fragment fn fs(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{return landOpaque(in);}
@fragment fn opaqueFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{return landOpaque(in);}
// The props use local atmosphere and the terrain's cached cloud sunlight. A
// twelve-step volume integration per grass blade would defeat their budget.
@fragment fn groundFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let world=in.world;let grass=in.kind.x>6.5;
  var n=normalize(in.normal);if(grass){n*=select(-1.0,1.0,front);}
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+.5;
  let source=pow(textureSample(landAlbedo,landSampler,uv).rgb,vec3f(2.2));
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0).r;
  let luminance=dot(source,vec3f(.2126,.7152,.0722));
  let shade=.72+in.kind.y*.30;
  let rock=mix(vec3f(luminance)*vec3f(.95,.91,.85),source,.12)*shade;
  let dry=vec3f(.17,.145,.065);let green=mix(leafMean.rgb,source,.18);
  let foliage=mix(dry,green,smoothstep(.12,.7,vegetation))*shade;
  let albedo=select(rock,foliage,grass);
  let sunlight=textureSampleLevel(landLight,sampC,uv,0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let diffuse=max(dot(n,F.sunDir.xyz),0.0)+select(0.0,max(dot(-n,F.sunDir.xyz),0.0)*.35,grass);
  let visibility=select(.35+.28*max(n.y,0.0),.32+in.kind.y*.32,grass);
  let wet=(1.0-smoothstep(1.0,7.0,world.y))*.5;
  var color=albedo*(1.0-wet*.3)*(direct*diffuse/PI+ambient*visibility);
  color+=lightningSurface(n,normalize(F.camPos.xyz-world),albedo,.84);
  return vec4f(surfaceAir(color,world),1);
}
@fragment fn leafFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let world=in.world;var n=normalize(in.normal)*select(-1.0,1.0,front);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  // Derivative-dependent samples precede discard; this shader alone is cutout.
  let leaf=textureSampleBias(leafSpray,landSampler,in.leafUV,0.1);
  let source=pow(textureSample(landAlbedo,landSampler,uv).rgb,vec3f(2.2));
  let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
  let albedo=pow(leaf.rgb,vec3f(2.2))*mix(vec3f(1),regionalTint,0.2)*(0.78+in.kind.y*0.30);
  let exposure=clamp(in.kind.y,0.0,1.0);let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=(max(nDotL,0.0)+max(-nDotL,0.0)*0.48)*(0.22+0.78*exposure*exposure);
  let ambientVisibility=0.12+exposure*0.55+abs(n.y)*0.08;
  if(leaf.a<0.015){discard;}
  let color=landFinish(world,n,albedo,diffuse,ambientVisibility,0.0,0.95);
  return vec4f(color.rgb,leaf.a);
}
`;
