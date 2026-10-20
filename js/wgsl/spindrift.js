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
  source: vec4f, // undisturbed crest x/z, release age, reserved
  root: vec4f,   // tracked crest position, reserved
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
        p.source = vec4f(nextQ,p.source.z,0.0);
        p.root = vec4f(root,0.0);
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
  p.launch = vec4f(wind.x*0.16,0.4+1.0*strength,
    wind.y*0.16,0.9+0.8*strength+crestRandom(seed+4u)*0.3);
  p.crest = vec4f(tangent,(0.8+1.4*strength)*mix(0.7,1.2,crestRandom(seed+5u)));
  p.shape = vec4f(strength, crestRandom(seed + 6u) * 100.0, wind);
  p.source = vec4f(q,0.28+0.32*strength,0.0);
  p.root = vec4f(origin,0.0);
  plumes[id.x] = p;
}
`;

// Shared with the GPU silhouette regression. Density vanishes on the complete
// volume boundary, including its underside; the raster quad carries no opacity.
export const SPINDRIFT_VOLUME = /* wgsl */ `
fn mistInterval(origin:vec3f,direction:vec3f)->vec2f {
  let a=dot(direction,direction);let middle=-dot(origin,direction)/a;
  // Closest-point form avoids subtracting two large squared distances when
  // looking at a thin mist volume from the far end of the emission radius.
  let closest=origin+direction*middle;
  let halfSquared=(1.0-dot(closest,closest))/a;
  if(halfSquared<=0.0){return vec2f(0);}
  let halfSpan=sqrt(halfSquared);
  return vec2f(max(0.0,middle-halfSpan),max(0.0,middle+halfSpan));
}
fn mistDensity(p:vec3f,seed:f32,age:f32)->f32 {
  let radial=max(0.0,1.0-dot(p,p));
  let flow=vec2f(p.x*3.1+p.z*.7,p.y*4.5-p.z*.55-age*.35)+seed;
  let breakup=smoothstep(-.22,.32,gnoise(flow));
  return radial*radial*(.18+.82*breakup);
}
fn mistOpticalDepth(origin:vec3f,direction:vec3f,seed:f32,age:f32)->vec2f {
  let span=mistInterval(origin,direction);let step=(span.y-span.x)/3.0;
  var density=0.0;
  for(var i=0u;i<3u;i++){
    density+=mistDensity(origin+direction*(span.x+(f32(i)+.5)*step),seed,age);
  }
  return vec2f(density*step,span.x);
}
`;

export const SPINDRIFT_RENDER = /* wgsl */ `
${FRAME_WGSL}
${ATMO_CORE_WGSL}
${SPINDRIFT_STATE}
${NOISE_WGSL}
${SPINDRIFT_VOLUME}
${SHADOW_SAMPLE}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> plumes: array<CrestPlume>;
@group(0) @binding(2) var environment: texture_cube<f32>;
@group(0) @binding(3) var lightSampler: sampler;
@group(0) @binding(4) var transmittance: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> sunVisibility: vec4f;
struct CrestVertex {
  @builtin(position) position: vec4f,
  @location(0) ray:vec3f,
  @location(1) @interpolate(flat) center:vec3f,
  @location(2) @interpolate(flat) radii:vec3f,
  @location(3) @interpolate(flat) wind:vec2f,
  @location(4) @interpolate(flat) light:vec3f,
  @location(5) @interpolate(flat) shape:vec3f,
};
@vertex fn crestVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->CrestVertex {
  let p=plumes[instance];var o:CrestVertex;
  o.position=vec4f(2,2,0,1);o.radii=vec3f(1);o.shape=vec3f(0);
  if(p.launch.w<=0.0){return o;}
  // Four overlapping parcels fill one continuous, crest-born burst. Their
  // world-space ellipsoids do not turn into planes when the camera moves.
  let parcel=f32(vertex/6u);let u=(parcel+.5)/4.0;
  let corner=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1))[vertex%6u];
  let age=p.origin.w;let detached=smoothstep(p.source.z,p.source.z+.6,age);
  let tail=plumeSheetPosition(p,0.0);let head=plumeSheetPosition(p,1.0);
  let wind=normalize(p.shape.zw+vec2f(.00001,0));
  let along=vec3f(wind.x,0,wind.y);let across=vec3f(wind.y,0,-wind.x);
  let center=plumeSheetPosition(p,u)+p.crest.xyz*(sin(p.shape.y+parcel*2.4)*p.crest.w*.20)
    +vec3f(0,.035+u*.06,0);
  let relative=center-F.camPos.xyz;let distanceToEye=length(relative);
  let metresPerPixel=max(distanceToEye,1.0)*2.0*length(F.camUp.xyz)*F.screen.w;
  var radii=vec3f(p.crest.w*(.40+.12*u+.15*detached),.10+.16*u+.12*detached,
    .20+length(head-tail)*.24+.12*detached);
  radii*=min(1.0,metresPerPixel*65.0/max(max(radii.x,radii.y),radii.z));
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);let forward=normalize(F.camFwd.xyz);
  let r=vec3f(dot(right,across),right.y,dot(right,along))*radii;
  let v=vec3f(dot(up,across),up.y,dot(up,along))*radii;
  let d=vec3f(dot(forward,across),forward.y,dot(forward,along))*radii;
  let depth=length(d);let padding=distanceToEye/max(distanceToEye-depth,.1);
  let ray=relative+right*corner.x*length(r)*padding+up*corner.y*length(v)*padding-forward*depth;
  o.position=F.viewProj*vec4f(ray,1);o.ray=ray;o.center=relative;o.radii=radii;o.wind=wind;
  let view=normalize(-relative);
  let sky=textureSampleLevel(environment,lightSampler,vec3f(0,1,0),5.0).rgb;
  let sunlight=textureSampleLevel(transmittance,lightSampler,transRMuToUV(RG+F.atmo.y,F.sunDir.y),0.0).rgb;
  // Normalized scattering replaces the unbounded orange sheet illumination.
  let phase=phaseMie(dot(-view,F.sunDir.xyz),.5);
  o.light=sky*.85+sunlight*F.sunDir.w*sunVisibility.x*phase*vesselShadow(center,vec3f(0,1,0))+vec3f(.65,.78,1.0)*F.reserved.z*1.5;
  let fade=smoothstep(0.0,.08,age)*(1.0-smoothstep(.35,1.0,age/p.launch.w));
  o.shape=vec3f((.65+.70*p.shape.x)*fade*smoothstep(1.0,4.0,distanceToEye)
    *(1.0-smoothstep(55.0,80.0,distanceToEye)),p.shape.y+parcel*7.1,age);
  return o;
}
struct CrestFragment { @location(0) color:vec4f,@builtin(frag_depth) depth:f32 };
@fragment fn crestFS(o:CrestVertex)->CrestFragment {
  if(o.shape.x<=0.0){discard;}
  let direction=normalize(o.ray);let across=vec3f(o.wind.y,0,-o.wind.x);let along=vec3f(o.wind.x,0,o.wind.y);
  let origin=vec3f(dot(-o.center,across),-o.center.y,dot(-o.center,along))/o.radii;
  let ray=vec3f(dot(direction,across),direction.y,dot(direction,along))/o.radii;
  let integrated=mistOpticalDepth(origin,ray,o.shape.y,o.shape.z);
  let alpha=(1.0-exp(-integrated.x*o.shape.x))*exp(-dot(F.fogExt.rgb,vec3f(.333333))*integrated.y);
  if(alpha<.001){discard;}
  let clip=F.viewProj*vec4f(direction*integrated.y,1);
  var out:CrestFragment;out.color=vec4f(o.light*alpha,alpha);out.depth=clip.z/clip.w;return out;
}
`;
