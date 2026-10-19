import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { DECK_PROFILE, DECK_SAMPLING } from './deck.js';
import { VESSEL_RIG, CANVAS_OPTICS } from './vessel.js';
import { SHADOW_SAMPLE } from './shadows.js';
export const CARAVEL = FRAME_WGSL + ATMO_CORE_WGSL + DECK_PROFILE + VESSEL_RIG + CANVAS_OPTICS + SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> sunVis: array<f32, 4>;
@group(0) @binding(6) var<uniform> hull: Hull;
@group(0) @binding(7) var waterScene: texture_2d<f32>;
@group(0) @binding(8) var dispTex: texture_2d_array<f32>;
@group(0) @binding(9) var repeatSamp: sampler;
@group(0) @binding(10) var oakAlbedo: texture_2d<f32>;
@group(0) @binding(11) var oakSampler: sampler;
@group(0) @binding(12) var deckWater: texture_2d<f32>;
@group(0) @binding(13) var<storage,read> moisture:array<vec2f>;
@group(0) @binding(14) var<storage,read> wetLookup:array<u32>;
` + SKY_RENDER_FUNCS + DECK_SAMPLING + /* wgsl */ `
struct BoatVertex {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) material: u32,
  @location(4) normalLocal: vec3f,
  @location(5) uv: vec2f,
  @location(6) wet:vec2f,
};
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) material: f32, @location(3) uv: vec2f,@builtin(vertex_index) index:u32) -> BoatVertex {
  let rig=rigVertex(position,normal,material,uv);
  let relative = rotateHull(rig.position * rig.scale) + hull.origin.xyz - F.camPos.xyz;
  var o: BoatVertex;
  o.pos = F.viewProj * vec4f(relative, 1.0);
  o.world = relative + F.camPos.xyz;
  o.normal = normalize(rotateHull(rig.normal / rig.scale));
  o.local = position;
  o.material = u32(material); o.normalLocal = normal; o.uv=uv;o.wet=moisture[wetLookup[index]];
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
  var wet=clamp(in.wet,vec2f(0),vec2f(1));
  if(in.material==0u && abs(p.y-deckFloor(p.z))<0.08){wet.x=max(wet.x,sampleDeck(deckUV(p)).z);}
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
  var albedo = timber * vec3f(1.08,0.94,0.74);
  var rough = clamp(0.74 + (0.2-relief)*0.18,0.64,0.85); var metal = 0.0;
  let canvasDepth=canvasThickness(in.uv,in.material)*canvasWetDepth(wet.x);
  let plank = floor((p.x+1.8)/0.18);
  albedo *= 0.82 + 0.2 * fract(sin(plank*74.17)*4321.1);
  // Fine end-grain joints, splits, and oxidised grain.
  let joint = abs(fract((p.z + fract(plank*0.413)*2.0)/2.3)-0.5);
  let jointAA = max(fwidth(joint),0.001);
  let hullSeamAA=max(fwidth(in.uv.x*18.0),0.001);
  let clothSeam=abs(fract(in.uv.x*10.0)-0.5);
  let clothAA=max(fwidth(clothSeam),0.001);
  let weaveAA=max(fwidth(in.uv.x+in.uv.y),0.001);
  let squareEdge=min(min(in.uv.x,1.0-in.uv.x),min(in.uv.y,1.0-in.uv.y));
  let triangleEdge=min(min(in.uv.x,in.uv.y),(1.0-in.uv.x-in.uv.y)*0.70710678);
  let clothEdge=select(squareEdge,triangleEdge,in.material==13u);
  let edgeAA=max(fwidth(clothEdge),0.0005);
  if(in.material==0u) { albedo *= mix(0.3,1.0,smoothstep(0.001,0.004+jointAA,joint)); }
  if(in.material == 1u || in.material == 5u || in.material == 6u) { albedo *= 0.8; rough = 0.67; }
  let ropeAA=fwidth(p.x+p.y+p.z);
  if(in.material == 2u || in.material == 12u || in.material==19u) {
    let twist = sin((p.x+p.y+p.z)*100.0) * (1.0-smoothstep(0.02,0.12,ropeAA));
    albedo = vec3f(0.28,0.20,0.11) * (0.8+0.2*twist); rough=0.87;
  }
  if(in.material == 4u) { albedo=vec3f(0.012,0.009,0.006); rough=0.92; }
  if(in.material == 3u || in.material == 8u) { albedo=vec3f(0.065,0.07,0.071); rough=0.38; metal=0.85; }
  if(in.material == 9u || in.material == 13u) {
    let weave=sin(in.uv.x*1400.0)*sin(in.uv.y*1800.0)*(1.0-smoothstep(0.0004,0.003,weaveAA));
    let aged=0.94+0.045*gnoise(in.uv*vec2f(21.0,16.0));
    let seam=1.0-smoothstep(0.004,0.013+clothAA,clothSeam);
    let hem=1.0-smoothstep(0.006,0.014+edgeAA,clothEdge);
    // Optical depth: overlapped stitching and doubled edge cloth block more
    // light. Broad folds and filtered weave avoid a uniformly luminous sheet.
    albedo=vec3f(0.58,0.55,0.48)*aged*(1.0-0.12*seam-0.08*hem)*(1.0+0.025*weave);
    n=normalize(in.normal)*select(-1.0,1.0,front); rough=0.95;
  }
  if(in.material == 11u) { albedo=vec3f(0.018,0.035,0.033); rough=0.3; metal=0.25; }
  if(in.material == 14u) { albedo*=0.6; rough=0.75; }
  if(in.material == 15u) {
    let hullSeam=abs(fract(in.uv.x*18.0)-0.5);
    albedo*=mix(0.7,0.93,smoothstep(0.004,0.035+hullSeamAA,hullSeam)); rough=0.82;
    let tar=(1.0-smoothstep(-0.75,-0.2,p.y)); albedo=mix(albedo,vec3f(0.025,0.022,0.018),tar*0.9);
  }
  if(in.material == 16u) { albedo=timber*vec3f(0.13,0.12,0.10); rough=0.85; }
  if(in.material == 17u) { albedo=timber*vec3f(1.3,1.02,0.62); rough=0.62; }
  if(in.material==2u || in.material==12u || in.material==19u){
    albedo*=mix(1.0,.58,wet.x);rough=mix(rough,.65,wet.x);
  }else if(in.material==9u || in.material==13u){
    albedo*=mix(1.0,.72,wet.x);rough=mix(.95,.84,wet.x);
  }else if(in.material!=3u && in.material!=4u && in.material!=8u && in.material!=11u){
    // Water fills fine grain before the absorbed colour dries. Keep broad timber relief.
    albedo*=mix(1.0,.55,wet.x);
    rough=mix(rough,.32,wet.x);rough=mix(rough,.22,wet.y*.65);
    n=normalize(mix(n,normalize(in.normal)*select(-1.0,1.0,front),wet.y*.55));
  }
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
  let direct=sunIlluminance()*sunVis[0]*step(0.0,l.y)*vesselShadow(in.world,normalize(in.normal));
  // The last cube mip is a face average, not diffuse irradiance. Sampling it
  // along a vertical timber normal mixes in the sea, then counts that green
  // light again below. Use separate sky/sea hemispheres and their projected
  // visibility instead; keep directional ocean reflections in the specular term.
  let sky=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS - 1}.0).rgb;
  let reflected=waterLight(in.world,reflect(-v,n),rough);
  let bounce=waterLight(in.world,normalize(vec3f(n.x,-0.65,n.z)),0.9);
  let skyVisibility=0.5+0.5*n.y;
  let ambient=sky*skyVisibility+bounce*0.22*(1.0-skyVisibility);
  let ao=mix(0.65,1.0,smoothstep(0.72,1.5,p.y));
  let spec=d*g*fresnel/(4.0*nv*max(nl,0.001));
  var col=(albedo*(1.0-metal)/PI+spec)*direct*nl;
  col+=albedo*(1.0-metal)*ambient*ao + reflected*F.windP[1].w*(f0+(1.0-f0)*(fv2*fv2*fv))*(1.0-rough*0.45);
  if(in.material == 9u || in.material == 13u) {
    let through=max(dot(-n,l),0.0);
    // Thin canvas transmits light without revealing the background. Beer
    // attenuation makes grazing rays and doubled cloth denser; blue absorption
    // gives unbleached canvas a warm glow. These are authored, not measured,
    // fabric coefficients. The view-facing normal makes both sides equivalent.
    let opticalDepth=vec3f(0.90,1.15,1.60)*canvasDepth;
    let transmitted=canvasTransmission(canvasDepth,through);
    let alignment=max(dot(-v,l),0.0);
    // A diffuse lobe plus a broad, normalized forward lobe around the sun.
    let scatter=0.70/PI+0.30*(34.0/(2.0*PI))*pow(alignment,32.0);
    col+=direct*transmitted*through*scatter;
    let behind=sky*(1.0-skyVisibility)+bounce*0.22*skyVisibility;
    col+=behind*exp(-opticalDepth)*0.7;
  }
  col=surfaceAir(col,in.world);
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
