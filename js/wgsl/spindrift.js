import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL, FOAM_MODEL } from './common.js';
import { HULL_PROFILE } from './hull.js';
import { SHADOW_SAMPLE } from './shadows.js';

export const SPINDRIFT_COUNT = 1024;
export const SPINDRIFT_STRIDE = 96;
export const SPINDRIFT_STATE = /* wgsl */ `
struct CrestPlume {
  origin: vec4f, // birth position, age
  launch: vec4f, // initial velocity, lifetime (zero = vacant)
  crest: vec4f,  // crest tangent, initial half width
  shape: vec4f,  // strength, seed, birth wind x/z
  source: vec4f, // undisturbed crest x/z, release age, left foot height offset
  root: vec4f,   // tracked crest position, right foot height offset
};
// Aerodynamic entrainment of a mist parcel, with an authored settling rate.
// Birth data stays in world space when the camera or wind changes.
fn plumePosition(p: CrestPlume, t: f32) -> vec3f {
  let wind = vec3f(p.shape.z, 0.0, p.shape.w) * 0.68;
  let entrain = (1.0 - exp(-1.5 * t)) / 1.5;
  let horizontal = wind * t + (vec3f(p.launch.x, 0.0, p.launch.z) - wind) * entrain;
  return p.origin.xyz + horizontal + vec3f(0.0, p.launch.y * t - 1.25 * t * t, 0.0);
}
// A short emission burst stays connected to its moving wave, then detaches.
// The head always follows the original world-space ballistic trajectory.
fn plumeSheetPosition(p: CrestPlume, u: f32) -> vec3f {
  let tailAge = max(0.0, p.origin.w - p.source.z);
  let t = mix(tailAge, p.origin.w, u);
  let attached = (1.0 - smoothstep(0.0, 0.35, tailAge)) * (1.0-u) * (1.0-u);
  return plumePosition(p,t) + (p.root.xyz-p.origin.xyz)*attached;
}
`;

export const SPINDRIFT_UPDATE = /* wgsl */ `
${FRAME_WGSL}
${SPINDRIFT_STATE}
${FOAM_MODEL}
${NOISE_WGSL}
${HULL_PROFILE}
struct CrestControl { step: vec4f }; // dt, reset, amount, frame
struct CrestHull { right: vec4f, up: vec4f, forward: vec4f, size: vec4f, origin: vec4f, rig: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> C: CrestControl;
@group(0) @binding(2) var<uniform> hull: CrestHull;
@group(0) @binding(3) var displacement: texture_2d_array<f32>;
@group(0) @binding(4) var derivatives: texture_2d_array<f32>;
@group(0) @binding(5) var seaSampler: sampler;
@group(0) @binding(6) var<storage, read_write> plumes: array<CrestPlume>;
fn crestRandom(seed: u32) -> f32 { return f32(pcgHash(seed)) / 4294967296.0; }
fn crestDisplacement(q: vec2f) -> vec3f {
  var d = vec3f(0.0);
  for (var c = 0u; c < 6u; c++) {
    let invL = F.cascInvL[c >> 2u][c & 3u];
    let mip = max(0.0, log2(256.0 * invL * 0.65));
    d += textureSampleLevel(displacement, seaSampler, fract(q * invL), i32(c), mip).xyz;
  }
  return d;
}
struct CrestSample { d: vec4f, derivative: vec4f };
fn crestSample(q: vec2f) -> CrestSample {
  var s: CrestSample;
  for (var c = 0u; c < 6u; c++) {
    let invL = F.cascInvL[c >> 2u][c & 3u];
    let mip = max(0.0, log2(256.0 * invL * 0.65));
    s.d += textureSampleLevel(displacement, seaSampler, fract(q * invL), i32(c), mip);
    s.derivative += textureSampleLevel(derivatives, seaSampler, fract(q * invL), i32(c), mip);
  }
  return s;
}
fn crestBreaking(s: CrestSample) -> f32 {
  return breakingCompression(s.derivative.z, s.derivative.w, s.d.w, 0.45);
}
fn crestFootHeights(q: vec2f, tangent: vec2f, width: f32, height: f32) -> vec2f {
  return vec2f(crestDisplacement(q-tangent*width).y,
    crestDisplacement(q+tangent*width).y)-height;
}
fn crestInHull(world: vec3f) -> bool {
  if (hull.rig.z < 0.5) { return false; }
  let delta = world - hull.origin.xyz;
  let local = vec3f(dot(delta,hull.right.xyz)*3.6/hull.size.x,
    dot(delta,hull.up.xyz)/HULL_Y_SCALE,-dot(delta,hull.forward.xyz)*12.0/hull.size.y);
  return hullExcludesOcean(local);
}
// Fit a local ridge across the compressed direction, never a trough or slope.
// Returns the peak offset and its rise above the two shoulders (metres).
fn crestPeak(q: vec2f, normal: vec2f, height: f32) -> vec2f {
  let radius = 1.4;
  let lo = crestDisplacement(q-normal*radius).y;
  let hi = crestDisplacement(q+normal*radius).y;
  let curvature = 2.0*height-lo-hi;
  if (curvature <= 0.04) { return vec2f(0.0); }
  let offset = 0.5*radius*(hi-lo)/curvature;
  if (abs(offset) > radius) { return vec2f(0.0); }
  return vec2f(offset,curvature*0.5);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${SPINDRIFT_COUNT}u) { return; }
  var p = plumes[id.x];
  if (C.step.y > 0.5 || C.step.z <= 0.0) {
    p.launch.w = 0.0; plumes[id.x] = p; return;
  }
  let dt = C.step.x;
  if (p.launch.w > 0.0) {
    p.origin.w += dt;
    if (p.origin.w < p.source.z) {
      let q = p.source.xy;
      let normal = vec2f(-p.crest.z,p.crest.x);
      let peak = crestPeak(q,normal,crestDisplacement(q).y);
      let nextQ = q + normal*clamp(peak.x,-12.0*dt,12.0*dt);
      let s = crestSample(nextQ);
      let root = vec3f(nextQ.x+s.d.x,s.d.y+0.035,nextQ.y+s.d.z);
      if (peak.y < 0.035 || crestBreaking(s) < 0.15 || crestInHull(root)) {
        p.source.z = p.origin.w;
      } else {
        let feet = crestFootHeights(nextQ,p.crest.xz,p.crest.w,s.d.y);
        p.source = vec4f(nextQ,p.source.z,feet.x);
        p.root = vec4f(root,feet.y);
      }
    }
    let head = plumePosition(p, p.origin.w);
    var landed = false;
    // Stagger collision work. Two displacement samples invert the horizontal wave offset.
    if ((id.x + u32(C.step.w)) % 4u == 0u && p.origin.w > p.source.z + 0.15) {
      let q = head.xz - crestDisplacement(head.xz).xz;
      landed = head.y < crestDisplacement(q).y - 0.15;
    }
    if (p.origin.w >= p.launch.w || distance(head.xz, F.camPos.xz) > 85.0 || landed) { p.launch.w = 0.0; }
    plumes[id.x] = p;
    return;
  }
  let seed = pcgHash(id.x + u32(C.step.w) * 104729u);
  let wind = F.windP[0].xy * F.windP[0].z;
  // A smooth, authored onset: breaking alone does not make airborne spindrift.
  let windLift = smoothstep(8.0, 19.0, F.windP[0].z);
  if (windLift == 0.0 || crestRandom(seed) > 1.0 - exp(-5.0 * windLift * C.step.z * dt)) { return; }
  let cell = vec2f(f32(id.x % 32u), f32(id.x / 32u)) - 15.5;
  let worldCell = floor(F.camPos.xz / 4.0) + cell;
  // World-anchored search points: a moving wave encounters them, rather than
  // resampling a uniform cloud of unrelated points every frame.
  let cellSeed = pcgHash(bitcast<u32>(i32(floor(worldCell.x))) ^ pcgHash(bitcast<u32>(i32(floor(worldCell.y)))));
  let jitter = vec2f(crestRandom(cellSeed),crestRandom(cellSeed+1u))-0.5;
  var q = (worldCell+jitter*0.6)*4.0;
  if (distance(q, F.camPos.xz) > 70.0) { return; }
  // Reject samples behind the observer before fetching the six cascades.
  if (dot(vec3f(q.x, F.camPos.y, q.y) - F.camPos.xyz, F.camFwd.xyz) < -8.0) { return; }
  var s = crestSample(q);
  if (crestBreaking(s) < 0.2) { return; }
  // The least-compressed eigenvector runs ALONG the crest; its perpendicular
  // crosses the ridge. Compression by itself also occurs on wave faces.
  let angle = 0.5 * atan2(2.0*s.d.w,s.derivative.z-s.derivative.w);
  let tangent = vec3f(cos(angle),0.0,sin(angle));
  let normal = vec2f(-tangent.z,tangent.x);
  let peak = crestPeak(q,normal,s.d.y);
  if (peak.y < 0.055) { return; }
  q += normal*peak.x;
  s = crestSample(q);
  let shoulders = vec2f(crestDisplacement(q-normal*1.4).y,crestDisplacement(q+normal*1.4).y);
  let prominence = s.d.y-max(shoulders.x,shoulders.y);
  let breaking = crestBreaking(s);
  if (prominence < 0.035 || breaking < 0.2) { return; }
  let origin = vec3f(q.x+s.d.x,s.d.y+0.035,q.y+s.d.z);
  if (crestInHull(origin)) { return; }
  let strength = windLift * breaking * mix(0.55,1.0,smoothstep(0.06,0.4,prominence));
  p.origin = vec4f(origin, 0.0);
  p.launch = vec4f(wind.x*0.16,1.0+2.5*strength,
    wind.y*0.16,0.9+0.8*strength+crestRandom(seed+4u)*0.3);
  p.crest = vec4f(tangent,(0.8+1.4*strength)*mix(0.7,1.2,crestRandom(seed+5u)));
  p.shape = vec4f(strength, crestRandom(seed + 6u) * 100.0, wind);
  let feet = crestFootHeights(q,tangent.xz,p.crest.w,s.d.y);
  p.source = vec4f(q,0.28+0.32*strength,feet.x);
  p.root = vec4f(origin,feet.y);
  plumes[id.x] = p;
}
`;

export const SPINDRIFT_RENDER = /* wgsl */ `
${FRAME_WGSL}
${ATMO_CORE_WGSL}
${SPINDRIFT_STATE}
${NOISE_WGSL}
${SHADOW_SAMPLE}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> plumes: array<CrestPlume>;
@group(0) @binding(2) var environment: texture_cube<f32>;
@group(0) @binding(3) var lightSampler: sampler;
@group(0) @binding(4) var transmittance: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> sunVisibility: vec4f;
struct CrestVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) light: vec3f,
  @location(2) shape: vec3f, // opacity, seed, age
};
@vertex fn crestVS(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> CrestVertex {
  let p = plumes[instance];
  var o: CrestVertex;
  o.position = vec4f(2.0, 2.0, 0.0, 1.0); o.uv = vec2f(0.0); o.light = vec3f(0.0); o.shape = vec3f(0.0);
  if (p.launch.w <= 0.0) { return o; }
  let corner = array<vec2f, 6>(vec2f(0.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0))[vertex % 6u];
  let quad = vertex/6u;
  let u = (f32(quad/2u)+corner.x)/4.0;
  let v = f32(quad%2u)+(corner.y-1.0)*0.5;
  let age = p.origin.w;
  let head = plumePosition(p, age);
  let distanceToEye = length(head - F.camPos.xyz);
  let metresPerPixel = max(distanceToEye, 1.0) * 2.0 * length(F.camUp.xyz) * F.screen.w;
  let tail = plumeSheetPosition(p,0.0);
  let detached = smoothstep(p.source.z,p.source.z+0.6,age);
  let lengthLimit = min(1.0,150.0*metresPerPixel/max(length(head-tail),0.01));
  let sampleU = mix((1.0-lengthLimit)*detached,1.0,u);
  let center = plumeSheetPosition(p,sampleU);
  let view = normalize(F.camPos.xyz - center);
  let path = normalize(head - tail + vec3f(0.0, 0.01, 0.0));
  let across = cross(path, view);
  let facingSide = normalize(across + normalize(F.camRight.xyz) * 0.01);
  // Start spread along the actual crest, then billow toward the view as it disperses.
  let sideSign = select(-1.0,1.0,dot(p.crest.xyz,facingSide)>=0.0);
  let crestSide = p.crest.xyz*sideSign;
  let side = normalize(mix(crestSide,facingSide,0.15*u+0.55*detached));
  let spread = 1.0 + u*0.45 + detached*0.5;
  let width = min(p.crest.w*spread,metresPerPixel*65.0);
  // Scallop the sheet edge along the crest; turbulence grows after lift-off.
  let curl = sin(v*5.0+p.shape.y+u*7.0-age*5.0)*u*0.12;
  // Three sampled points curve the foot along the water instead of stretching
  // a straight billboard edge over an uneven crest.
  let footHeight = select(p.source.w,p.root.w,v*sideSign>=0.0)*abs(v);
  let footFollow = (1.0-u)*(1.0-u)*(1.0-detached)*min(1.0,width/p.crest.w);
  let world = center + side*v*width + vec3f(0.0,curl+footHeight*footFollow,0.0);
  o.position = F.viewProj * vec4f(world - F.camPos.xyz, 1.0);
  o.uv = vec2f(u,v);
  let sky = textureSampleLevel(environment, lightSampler, vec3f(0.0,1.0,0.0), 5.0).rgb;
  let sunlight = textureSampleLevel(transmittance, lightSampler, transRMuToUV(RG + F.atmo.y, F.sunDir.y), 0.0).rgb;
  let phase = 0.35 + 1.5 * pow(max(dot(-view, F.sunDir.xyz), 0.0), 12.0);
  let shadow = vesselShadow(center, vec3f(0.0,1.0,0.0));
  o.light = sky * 0.7 + sunlight * F.sunDir.w * sunVisibility.x * phase * shadow;
  let fade = smoothstep(0.0,0.08,age)*(1.0-smoothstep(0.45,1.0,age/p.launch.w));
  o.shape = vec3f((0.24+0.26*p.shape.x)*fade*smoothstep(1.0,4.0,distanceToEye)
    * (1.0 - smoothstep(55.0, 80.0, distanceToEye)), p.shape.y, age);
  return o;
}
@fragment fn crestFS(o: CrestVertex) -> @location(0) vec4f {
  let uv = o.uv;
  let flow = vec2f(uv.x*3.0-o.shape.z*1.6,uv.y*3.5)+o.shape.y;
  let noise = gnoise(flow)*0.65+gnoise(flow*2.7)*0.35;
  // Dense, irregular water at the foot grades into torn, translucent fingers.
  // Never fade out the root while it is attached to the crest.
  let edge = 1.0-smoothstep(0.45+noise*0.2,1.0,abs(uv.y));
  let tip = 1.0-smoothstep(0.45+noise*0.18,1.0,uv.x);
  let torn = mix(0.85,smoothstep(-0.35,0.35,noise),smoothstep(0.05,0.8,uv.x));
  let alpha = o.shape.x*edge*tip*torn;
  return vec4f(o.light * alpha, alpha);
}
`;
