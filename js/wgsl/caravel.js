import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
export const CARAVEL = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> sunVis: array<f32, 4>;
struct Hull { right: vec4f, up: vec4f, forward: vec4f, size: vec4f };
@group(0) @binding(6) var<uniform> hull: Hull;
@group(0) @binding(7) var waterScene: texture_2d<f32>;
@group(0) @binding(8) var dispTex: texture_2d_array<f32>;
@group(0) @binding(9) var repeatSamp: sampler;
@group(0) @binding(10) var oakAlbedo: texture_2d<f32>;
@group(0) @binding(11) var oakSampler: sampler;
` + SKY_RENDER_FUNCS + /* wgsl */ `
struct BoatVertex {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) material: u32,
  @location(4) normalLocal: vec3f,
  @location(5) uv: vec2f,
};
fn rotateHull(p: vec3f) -> vec3f {
  return hull.right.xyz * p.x + hull.up.xyz * p.y - hull.forward.xyz * p.z;
}
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) material: f32, @location(3) uv: vec2f) -> BoatVertex {
  var scale = vec3f(hull.size.x / 3.6, 1.0, hull.size.y / 12.0);
  var local = position; var localN = normal;
  if (material >= 7.0) {
    scale = vec3f(1.0);
    let angle = -hull.size.w / 35.0 * 6.2831853;
    let c = cos(angle); let s = sin(angle);
    let pivot = vec3f(0.0,1.43,-1.7);
    let q = position - pivot;
    local = vec3f(c*q.x-s*q.y,s*q.x+c*q.y,q.z)+pivot;
    localN = vec3f(c*normal.x-s*normal.y,s*normal.x+c*normal.y,normal.z);
  }
  let relative = rotateHull(local * scale - vec3f(0.0, hull.size.z, 0.0));
  var o: BoatVertex;
  o.pos = F.viewProj * vec4f(relative, 1.0);
  o.world = relative + F.camPos.xyz;
  o.normal = normalize(rotateHull(localN / scale));
  o.local = position;
  o.material = u32(material); o.normalLocal = normal; o.uv=uv;
  return o;
}
fn oceanHeight(p: vec2f) -> f32 {
  var h = 0.0;
  for (var c = 0u; c < 3u; c++) {
    h += textureSampleLevel(dispTex, repeatSamp, p * F.cascInvL[c >> 2u][c & 3u], c, 1.0).y;
  }
  return h;
}
// Roughness-filtered ocean radiance, with continuous screen-edge confidence.
fn waterLight(world: vec3f, direction: vec3f, roughness: f32) -> vec3f {
  let env = textureSampleLevel(envCube, sampC, direction, roughness * 8.0).rgb;
  let dy = min(direction.y, -0.03);
  let waterY = oceanHeight(world.xz);
  let t = clamp((waterY - world.y) / dy, 0.0, 100.0);
  let clip = F.viewProj * vec4f(world + direction * t - F.camPos.xyz, 1.0);
  let uv = clip.xy / max(clip.w, 0.0001) * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let confidence = smoothstep(0.015,0.14,edge) * smoothstep(0.0,0.5,clip.w)
      * smoothstep(0.025,0.16,-direction.y) * smoothstep(0.0,0.3,t);
  let lod = 1.5 + roughness * 5.0;
  let ocean = textureSampleLevel(waterScene, sampC, clamp(uv,vec2f(0.001),vec2f(0.999)), lod).rgb;
  // A rough timber reflection integrates light over a broad lobe. Individual
  // HDR sun glitter pixels must not behave as point emitters on the wood.
  let limit=env*4.0 + sunIlluminance()*sunVis[0]*0.08 + vec3f(0.02);
  let filteredOcean=min(ocean,limit);
  return mix(env,filteredOcean,confidence*0.55);
}
@fragment fn fs(in: BoatVertex, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let p = in.local;
  var n = normalize(in.normal) * select(-1.0,1.0,front);
  let grainUV = in.uv;
  let timber = pow(textureSample(oakAlbedo, oakSampler, grainUV).rgb, vec3f(2.2));
  let relief = dot(timber, vec3f(0.2126,0.7152,0.0722));
  let broad = gnoise(vec2f(grainUV.x * 18.0, grainUV.y * 0.7));
  let grain = gnoise(vec2f(grainUV.x * 180.0 + broad*3.0, grainUV.y * 5.0));
  let fine = gnoise(vec2f(grainUV.x * 700.0, grainUV.y * 24.0));
  let footprint = max(length(dpdx(grainUV)),length(dpdy(grainUV)));
  let bump = relief * 0.0009 + grain * 0.00012 * (1.0-smoothstep(0.0005,0.004,footprint));
  let dx = dpdx(in.world); let dy = dpdy(in.world);
  let sx = cross(dy,n); let sy = cross(n,dx);
  let det = dot(dx,sx);
  let gradient = (dpdx(bump)*sx + dpdy(bump)*sy) / max(abs(det), 0.000001) * sign(det);
  n = normalize(n - clamp(gradient,vec3f(-0.12),vec3f(0.12)) * select(1.0,0.1,in.material == 3u || in.material == 8u));
  var albedo = timber * vec3f(0.78,0.81,0.82);
  var rough = clamp(0.74 + (0.2-relief)*0.18,0.64,0.85); var metal = 0.0;
  let plank = floor((p.x+1.8)/0.18);
  albedo *= 0.82 + 0.2 * fract(sin(plank*74.17)*4321.1);
  // Fine end-grain joints, splits, and oxidised grain.
  let joint = abs(fract((p.z + fract(plank*0.413)*2.0)/2.3)-0.5);
  let jointAA = max(fwidth(joint),0.001);
  if(in.material==0u) { albedo *= mix(0.3,1.0,smoothstep(0.001,0.004+jointAA,joint)); }
  if(in.material == 1u || in.material == 5u || in.material == 6u) { albedo *= 0.8; rough = 0.67; }
  let ropeAA=fwidth(p.x+p.y+p.z);
  if(in.material == 2u) {
    let twist = sin((p.x+p.y+p.z)*100.0) * (1.0-smoothstep(0.02,0.12,ropeAA));
    albedo = vec3f(0.28,0.20,0.11) * (0.8+0.2*twist); rough=0.87;
  }
  if(in.material == 4u) { albedo=vec3f(0.012,0.009,0.006); rough=0.92; }
  if(in.material == 3u || in.material == 8u) { albedo=vec3f(0.065,0.07,0.071); rough=0.38; metal=0.85; }
  let v=normalize(F.camPos.xyz-in.world); let l=F.sunDir.xyz;
  let h=normalize(v+l); let nv=clamp(dot(n,v),0.001,1.0); let nl=clamp(dot(n,l),0.0,1.0);
  let nh=clamp(dot(n,h),0.0,1.0); let vh=clamp(dot(v,h),0.0,1.0);
  let a=rough*rough; let a2=a*a;
  let d=a2/(PI*pow(nh*nh*(a2-1.0)+1.0,2.0));
  let k=pow(rough+1.0,2.0)/8.0;
  let g=nv/(nv*(1.0-k)+k)*nl/(nl*(1.0-k)+k);
  let f0=mix(vec3f(0.04),albedo,metal);
  // Float dot products can exceed 1 by an ulp at a joint facing the eye.
  // pow(negative,5.0) is undefined in WGSL and can yield an HDR firefly.
  let fh=1.0-vh; let fh2=fh*fh;
  let fv=1.0-nv; let fv2=fv*fv;
  let fresnel=f0+(1.0-f0)*fh2*fh2*fh;
  // Analytic rail shadows on the deck; world sun is transformed into hull space.
  let localSun=vec3f(dot(l,hull.right.xyz),dot(l,hull.up.xyz),-dot(l,hull.forward.xyz));
  var shade=1.0;
  if(in.material==0u && p.y<1.3 && localSun.y>0.0) {
    let railHeight=1.45+0.52*pow(clamp(-p.z/6.4,0.0,1.0),3.0);
    let atRail=p.x+localSun.x*(railHeight-p.y)/max(localSun.y,0.001);
    let edge=1.8*sqrt(max(0.002,1.0-pow(max(0.0,-p.z)/6.4,2.0)));
    shade=mix(1.0,0.05,smoothstep(edge-0.08,edge+0.04,abs(atRail)));
  }
  let direct=sunIlluminance()*sunVis[0]*step(0.0,l.y)*shade;
  let sky=textureSampleLevel(envCube,sampC,n,${ENV_MIPS - 1}.0).rgb;
  let reflected=waterLight(in.world,reflect(-v,n),rough);
  let bounce=waterLight(in.world,normalize(vec3f(n.x,-0.65,n.z)),0.9);
  let ambient=sky*(0.65+0.35*max(n.y,0.0))+bounce*0.22*(1.0-max(n.y,0.0));
  let ao=mix(0.65,1.0,smoothstep(0.72,1.5,p.y));
  let spec=d*g*fresnel/(4.0*nv*max(nl,0.001));
  var col=(albedo*(1.0-metal)/PI+spec)*direct*nl;
  col+=albedo*(1.0-metal)*ambient*ao + reflected*F.windP[1].w*(f0+(1.0-f0)*(fv2*fv2*fv))*(1.0-rough*0.45);
  let fog=exp(-F.fogExt.rgb*length(in.world-F.camPos.xyz));
  col=col*fog+skyAtmo(normalize(vec3f(in.world.x-F.camPos.x,0.05,in.world.z-F.camPos.z)))*(1.0-fog);
  return vec4f(col,1.0);
}
`;

// HDR mip chain suppresses raw single-pixel sun glints in rough timber reflections.
export const WATER_FILTER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size=textureDimensions(dst); if(any(id.xy>=size)){return;}
  let extent=vec2i(textureDimensions(src))-1;
  let base=vec2i(id.xy)*2;
  let a=textureLoad(src,min(base,extent),0).rgb;
  let b=textureLoad(src,min(base+vec2i(1,0),extent),0).rgb;
  let c=textureLoad(src,min(base+vec2i(0,1),extent),0).rgb;
  let d=textureLoad(src,min(base+vec2i(1,1),extent),0).rgb;
  let weights=1.0/(vec4f(dot(a,vec3f(0.2126,0.7152,0.0722)),dot(b,vec3f(0.2126,0.7152,0.0722)),dot(c,vec3f(0.2126,0.7152,0.0722)),dot(d,vec3f(0.2126,0.7152,0.0722)))*0.03+1.0);
  let color=(a*weights.x+b*weights.y+c*weights.z+d*weights.w)/dot(weights,vec4f(1.0));
  textureStore(dst,vec2i(id.xy),vec4f(color,1.0));
}
`;
