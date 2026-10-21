import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { DECK_PROFILE, DECK_SAMPLING } from './deck.js';
import { VESSEL_RIG, VESSEL_LIGHTING, CANVAS_OPTICS } from './vessel.js';
import { SHADOW_SAMPLE } from './shadows.js';

// Exact marker recognized by createSubmergedShader. Both hull and rudder retain
// their authored material IDs/finishes; only the surrounding optical medium
// changes in the capture variant. No new resource or vertex-layout contract.
export const VESSEL_MATERIAL_MEDIUM=/* wgsl */ `
const vesselWaterCapture=false;
fn vesselWoodDielectricF0()->f32 {
  let medium=select(1.0,1.333,vesselWaterCapture);
  let ratio=(1.5-medium)/(1.5+medium);return select(0.04,ratio*ratio,vesselWaterCapture);
}
fn vesselAirFilm(film:f32)->f32 {return select(film,0.0,vesselWaterCapture);}
fn vesselWoodMaterial(material:u32,paintedWood:bool)->bool {
  return paintedWood || material==0u || material==1u || material==5u || material==6u || material==7u || material==10u ||
    material==14u || material==15u || material==16u || material==17u || material==18u;
}
fn vesselWoodOptics(rough:f32,absorbed:f32,film:f32,relief:f32,grain:f32)->vec4f {
  let darkening=mix(1.0,0.58,absorbed);
  let intrinsic=mix(rough,max(0.62,rough-0.15),absorbed);
  // Once immersed there is no outer water/air boundary atop a wet board. Keep
  // absorption and grain, but do not varnish the submerged surface with that
  // air-side film lobe. This helper is shared by every timber material.
  let surfaceFilm=vesselAirFilm(film)*(0.35+0.65*(1.0-smoothstep(0.12,0.65,relief+grain*0.25)));
  return vec4f(darkening,mix(intrinsic,0.27+grain*0.09,surfaceFilm),vesselWoodDielectricF0(),surfaceFilm);
}
`;

// Authored aged/cast-iron finish, not a measured Victory conservation recipe.
// Oxide is a dark dielectric; exposed iron is a separate area fraction. A dark
// diffuse colour must not also stand in for the conductor's F0. Approximate
// linear bare-iron reflectance follows Filament's common-metal reference:
// https://google.github.io/filament/main/materials.html#materialmodels/litmodel/basecolor
// Water's IOR=1.33 gives about 2% normal-incidence reflectance. Its surface film
// is a second lobe, not absorbed timber moisture or a smoother metal substrate.
export const IRON_SURFACE = /* wgsl */ `
const vesselIronWaterF0=0.020059312;
struct VesselIronSurface {
  albedo:vec3f,f0:vec3f,rough:f32,bare:f32,relief:f32,film:f32,filmRough:f32,
};
fn vesselIronNoise(p:vec3f,frequency:f32)->f32 {
  return (gnoise(p.xy*frequency)+gnoise(p.yz*frequency+vec2f(7.1,3.9))+
    gnoise(p.zx*frequency+vec2f(13.7,19.3)))/3.0;
}
fn vesselIronSurface(p:vec3f,footprint:f32,film:f32)->VesselIronSurface {
  // Metres in the undeformed object frame keep the finish fixed to the gun.
  // Remove unresolved surface frequencies from colour, roughness AND relief.
  let coarse=vesselIronNoise(p,8.0)*(1.0-smoothstep(0.025,0.10,footprint));
  let pits=vesselIronNoise(p,85.0)*(1.0-smoothstep(0.002,0.008,footprint));
  var surface:VesselIronSurface;
  surface.bare=clamp(0.06+coarse*0.16,0.02,0.14);
  surface.albedo=vec3f(0.020,0.019,0.017)*(0.94+coarse*0.22);
  surface.f0=mix(vec3f(0.04),vec3f(0.55,0.57,0.57),surface.bare);
  surface.rough=clamp(0.73+coarse*0.16+pits*0.12,0.62,0.86);
  surface.relief=coarse*0.0007+pits*0.00016;
  surface.film=clamp(film,0.0,1.0);surface.filmRough=0.23+coarse*0.06;
  return surface;
}
fn vesselIronTransmission(film:f32,nv:f32,nl:f32)->f32 {
  let fv=vesselFresnel(vec3f(vesselIronWaterF0),nv).x;
  let fl=vesselFresnel(vec3f(vesselIronWaterF0),nl).x;
  return mix(1.0,(1.0-fv)*(1.0-fl),film);
}
`;
export const CARAVEL = FRAME_WGSL + ATMO_CORE_WGSL + DECK_PROFILE + VESSEL_RIG + VESSEL_LIGHTING + CANVAS_OPTICS + SHADOW_SAMPLE + VESSEL_MATERIAL_MEDIUM + IRON_SURFACE + /* wgsl */ `
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
  let footprint = max(length(dpdx(grainUV)),length(dpdy(grainUV)));
  // Plank seams follow the hull's girth and the cabin's horizontal strakes.
  // Unlike a painted line, their recessed height also breaks the light response.
  let paintedWood=hull.rig.w>.5 && (in.material==20u || in.material==21u || in.material==23u || in.material==24u || in.material==26u);
  let plankedWall=in.material==15u || (paintedWood && abs(in.normalLocal.y)<.5) || (in.material==1u && p.z>=2.699 && p.y<2.23 && abs(in.normalLocal.y)<.3);
  let course=select(p.y/.16,in.uv.x*18.0,in.material==15u);
  let board=floor(course);
  let edge=min(fract(course),1.0-fract(course));
  let seam=1.0-smoothstep(.008,.035+max(fwidth(course),.001),edge);
  let along=select(p.z,p.x,abs(in.normalLocal.z)>.75 && in.material!=15u);
  let buttCoord=(along+fract(sin(board*73.17)*4321.1)*2.6)/2.6;
  let butt=min(fract(buttCoord),1.0-fract(buttCoord));
  let buttSeam=1.0-smoothstep(.0008,.003+max(fwidth(buttCoord),.0003),butt);
  let join=select(0.0,max(seam,buttSeam*.8),plankedWall);
  let bump=relief*.006 + grain*.00065*(1.0-smoothstep(.0005,.004,footprint)) - join*.0018;
  let dx = dpdx(in.world); let dy = dpdy(in.world);
  // Shadow depth rasterizes flat triangles, while cloth lighting uses smooth
  // analytic normals. Receiver-plane filtering must follow the actual triangle
  // or a wide filter can turn that mismatch into a ladder of self-shadow acne.
  let triangleNormal=cross(dx,dy);
  let shadowNormal=triangleNormal/max(length(triangleNormal),.000000000001);
  let sx = cross(dy,n); let sy = cross(n,dx);
  let det = dot(dx,sx);
  let gradient = (dpdx(bump)*sx + dpdy(bump)*sy) / max(abs(det), 0.000001) * sign(det);
  let isWood=vesselWoodMaterial(in.material,paintedWood);
  n = normalize(n - clamp(gradient,vec3f(-.38),vec3f(.38))*select(0.0,1.0,isWood));
  let isIron=in.material==3u || in.material==8u;
  let materialPoint=p*vec3f(hull.size.x/3.6,hull.right.w,hull.size.y/12.0);
  let materialFootprint=max(length(dpdx(materialPoint)),length(dpdy(materialPoint)));
  var iron:VesselIronSurface;
  if(isIron){iron=vesselIronSurface(materialPoint,materialFootprint,vesselAirFilm(wet.y));}
  // Derivatives remain outside material-dependent control flow. They use the
  // same surface-gradient frame as timber but a separate, filtered cast relief.
  let ironGradient=(dpdx(iron.relief)*sx+dpdy(iron.relief)*sy)/max(abs(det),0.000001)*sign(det);
  if(isIron){n=normalize(n-clamp(ironGradient,vec3f(-.18),vec3f(.18)));}
  var albedo = timber * vec3f(1.02,.98,.88);
  var rough = clamp(.86 + (.2-relief)*.20 + (grain-.5)*.08,.78,.95); var metal = 0.0;
  let canvasDepth=canvasThickness(in.uv,in.material)*canvasWetDepth(wet.x);
  let plank=select(floor((p.x+1.8)/.145),board,plankedWall);
  albedo *= .88 + .16 * fract(sin(plank*74.17)*4321.1);
  albedo *= 1.0-join*.58;
  // Fine end-grain joints, splits, and oxidised grain.
  let joint = abs(fract((p.z + fract(plank*0.413)*2.0)/2.3)-0.5);
  let jointAA = max(fwidth(joint),0.001);
  let clothSeam=abs(fract(in.uv.x*10.0)-0.5);
  let clothAA=max(fwidth(clothSeam),0.001);
  let weaveAA=max(fwidth(in.uv.x+in.uv.y),0.001);
  let squareEdge=min(min(in.uv.x,1.0-in.uv.x),min(in.uv.y,1.0-in.uv.y));
  let triangleEdge=min(min(in.uv.x,in.uv.y),(1.0-in.uv.x-in.uv.y)*0.70710678);
  let clothEdge=select(squareEdge,triangleEdge,in.material==13u);
  let edgeAA=max(fwidth(clothEdge),0.0005);
  if(in.material==0u) { albedo *= mix(0.3,1.0,smoothstep(0.001,0.004+jointAA,joint)); }
  if(in.material == 1u || in.material == 5u || in.material == 6u) { albedo *= .87; }
  if(hull.rig.w>.5){
    if(in.material==20u){albedo=vec3f(.009,.008,.006);rough=.88;}
    if(in.material==21u){albedo=vec3f(.48,.265,.075);rough=.85;}
    if(in.material==22u){albedo=vec3f(.29,.115,.055);rough=.53;metal=.65;}
    if(in.material==23u){albedo=vec3f(.68,.65,.55);rough=.86;}
    if(in.material==24u){albedo=vec3f(.26,.028,.018);rough=.83;}
    if(in.material==25u){albedo=vec3f(.48,.28,.055);rough=.45;metal=.6;}
    if(in.material==26u){albedo=vec3f(.015,.035,.09);rough=.88;}
    if(paintedWood){albedo*=mix(.88,1.04,relief)*(1.0-join*.46);}
  }
  let ropeAA=fwidth(p.x+p.y+p.z);
  if(in.material == 2u || in.material == 12u || in.material==19u) {
    let twist = sin((p.x+p.y+p.z)*100.0) * (1.0-smoothstep(0.02,0.12,ropeAA));
    albedo = vec3f(0.28,0.20,0.11) * (0.8+0.2*twist); rough=0.87;
  }
  if(in.material == 4u) { albedo=vec3f(0.012,0.009,0.006); rough=0.92; }
  if(isIron){albedo=iron.albedo;rough=iron.rough;metal=iron.bare;}
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
  if(in.material == 14u) { albedo*=0.6; }
  if(in.material == 15u) {
    albedo*=.93;
    let tar=(1.0-smoothstep(-0.75,-0.2,p.y)); albedo=mix(albedo,vec3f(0.025,0.022,0.018),tar*0.9);
  }
  if(in.material == 16u) { albedo=timber*vec3f(.20,.18,.15); }
  if(in.material == 17u) { albedo=timber*vec3f(1.10,1.0,.80); }
  if(in.material==2u || in.material==12u || in.material==19u){
    albedo*=mix(1.0,.58,wet.x);rough=mix(rough,.65,wet.x);
  }else if(in.material==9u || in.material==13u){
    albedo*=mix(1.0,.72,wet.x);rough=mix(.95,.84,wet.x);
  }else if(in.material!=3u && in.material!=4u && in.material!=8u && in.material!=11u){
    // Absorbed moisture darkens coarse timber without varnishing it. Only the
    // transient surface film glints; grain valleys retain more water than ridges.
    let timberMoisture=vesselWoodOptics(rough,wet.x,wet.y,relief,grain);
    albedo*=timberMoisture.x;rough=timberMoisture.y;
  }
  let v=normalize(F.camPos.xyz-in.world); let l=F.sunDir.xyz;
  let nl=clamp(dot(n,l),0.0,1.0);
  var f0=mix(vec3f(0.04),albedo,metal);
  if(isWood){f0=vec3f(vesselWoodDielectricF0());}
  if(isIron){
    f0=iron.f0;
    // The oxide's dielectric boundary changes medium too. Bare-metal F0 stays
    // the bounded authored conductor approximation; complex-IOR recalibration
    // and underwater multiple scattering are not provided by this material.
    if(vesselWaterCapture){f0=mix(vec3f(vesselWoodDielectricF0()),vec3f(0.55,0.57,0.57),iron.bare);}
  }
  let direct=sunIlluminance()*sunVis[0]*step(0.0,l.y)*vesselShadow(in.world,shadowNormal);
  // The last cube mip is a face average, not diffuse irradiance. Sampling it
  // along a vertical timber normal mixes in the sea, then counts that green
  // light again below. Use separate sky/sea hemispheres and their projected
  // visibility instead; keep directional ocean reflections in the specular term.
  var sky:vec3f;var reflected:vec3f;var bounce:vec3f;
  if(vesselWaterCapture&&F.screen.x>=0.0){
    // Low-frequency transmitted-ambient proxy, subsequently attenuated on the
    // light/view water legs by the common optics passes. It intentionally has
    // no directionally reflected image of the AIR sky or ocean. Snell-window
    // IBL and offscreen underwater transport require a separate renderer.
    sky=skyAtmo(vec3f(0,1,0));bounce=sky*0.08;
    reflected=vesselAmbient(n,sky,bounce);
  }else{
    // The invalid-dimensions fallback keeps the original resources reachable
    // to automatic layout reflection, matching the capture fog bypass pattern.
    sky=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS - 1}.0).rgb;
    reflected=waterLight(in.world,reflect(-v,n),rough);
    bounce=waterLight(in.world,normalize(vec3f(n.x,-0.65,n.z)),0.9);
  }
  let skyVisibility=0.5+0.5*n.y;
  let ambient=vesselAmbient(n,sky,bounce);
  let ao=mix(0.65,1.0,smoothstep(0.72,1.5,p.y));
  let spec=vesselSpecular(n,v,l,rough,f0);
  var diffuse=albedo*(1.0-metal);
  var diffuseAmbient=diffuse;
  var directTransmission=1.0;var environmentTransmission=1.0;
  if(isIron){
    let halfVector=(v+l)/max(length(v+l),0.00001);
    let oxideF0=vesselWoodDielectricF0();
    diffuse*=vec3f(1)-vesselFresnel(vec3f(oxideF0),max(dot(v,halfVector),0.0));
    diffuseAmbient*=1.0-oxideF0;
    directTransmission=vesselIronTransmission(iron.film,max(dot(n,v),0.0),nl);
    // The host's environment mip chain is not GGX-convolved. This remains a
    // bounded two-pass attenuation approximation, not a split-sum IBL integral.
    environmentTransmission=vesselIronTransmission(iron.film,max(dot(n,v),0.0),max(dot(n,v),0.0));
  }
  var col=(diffuse/PI+spec)*direct*nl*directTransmission;
  col+=(diffuseAmbient*ambient*ao + reflected*F.windP[1].w*vesselEnvironment(n,v,rough,f0))*environmentTransmission;
  if(!vesselWaterCapture&&isIron&&iron.film>0.0001){
    let filmF0=vec3f(vesselIronWaterF0);
    col+=iron.film*vesselSpecular(n,v,l,iron.filmRough,filmF0)*direct*nl;
    let filmReflection=waterLight(in.world,reflect(-v,n),iron.filmRough);
    col+=iron.film*filmReflection*F.windP[1].w*vesselEnvironment(n,v,iron.filmRough,filmF0);
  }
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
  col+=lightningSurface(n,v,albedo,rough)+gunFlashSurface(in.world,n,v,albedo,rough);
  if(in.material==9u || in.material==13u){col+=lightningLight()*albedo*max(dot(-n,lightningDirection()),0.0)*.12;}
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
