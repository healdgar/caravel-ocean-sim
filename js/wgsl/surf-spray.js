// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Tier 3 GPU ballistic spray & curling-crest mist pass driven directly by 2D Shallow Water (SWE)
// breaking-surf and bridge-pier impact emitters (zero CPU per-frame loop).
import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHALLOW_WATER_LIMITS } from './shallow-water.js';

export const SURF_SPRAY_COUNT = SHALLOW_WATER_LIMITS.sprayParticles;
export const SURF_SPRAY_STRIDE = 48; // 3 x vec4f per particle

export const SURF_SPRAY_UPDATE_WGSL = FRAME_WGSL + NOISE_WGSL + /* wgsl */ `
struct SprayControl {
  step: vec4f, // dt, reset, frameCounter, active
};
struct SweSpraySpawn {
  posEnergy: vec4f, // wx, wy, wz, energy
  velKind: vec4f,   // u, v, upSpeed, kind (0=pier splash, 1=surf breaker)
};
struct SprayParticle {
  posAge: vec4f,    // x, y, z, age
  velLife: vec4f,   // vx, vy, vz, life (<= 0 means vacant)
  info: vec4f,      // size, energy, seed, kind
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> C: SprayControl;
@group(0) @binding(2) var<storage, read> spawnCount: array<u32, 1>;
@group(0) @binding(3) var<storage, read> spawns: array<SweSpraySpawn>;
@group(0) @binding(4) var<storage, read_write> particles: array<SprayParticle>;

fn spRand(seed: u32) -> f32 {
  return f32(pcgHash(seed)) / 4294967296.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let idx = id.x;
  if (idx >= ${SURF_SPRAY_COUNT}u) { return; }

  let dt = clamp(C.step.x, 0.0, 0.05);
  let doReset = C.step.y > 0.5 || C.step.w < 0.5;
  var p = particles[idx];

  if (doReset) {
    particles[idx] = SprayParticle(vec4f(0.0), vec4f(0.0), vec4f(0.0));
    return;
  }

  let frame = u32(max(0.0, C.step.z) + 0.5);
  if (p.velLife.w > 0.0) {
    let age = p.posAge.w + dt;
    if (age >= p.velLife.w) {
      p.velLife.w = 0.0;
    } else {
      let wind = vec3f(F.windP[0].x, 0.0, F.windP[0].y) * F.windP[0].z * 0.35;
      let drag = 1.6;
      var vel = p.velLife.xyz;
      vel.x += (wind.x - vel.x) * min(1.0, drag * dt);
      vel.z += (wind.z - vel.z) * min(1.0, drag * dt);
      vel.y -= 7.8 * dt; // slightly lofted mist gravity
      p.posAge = vec4f(p.posAge.xyz + vel * dt, age);
      p.velLife = vec4f(vel, p.velLife.w);
    }
  }

  // Respawn vacant particles directly from GPU-emitted SWE breaking crests & bridge-pier impacts
  if (p.velLife.w <= 0.0) {
    let nSpawns = min(spawnCount[0], ${SHALLOW_WATER_LIMITS.spraySpawns}u);
    if (nSpawns > 0u) {
      let baseSeed = (idx * 1664525u) ^ (frame * 1013904223u);
      // Rate-limit respawn per particle slot so plumes stream smoothly over time
      let chance = spRand(baseSeed);
      if (chance < 0.14) {
        let sIdx = pcgHash(baseSeed + 7u) % nSpawns;
        let sp = spawns[sIdx];
        let r1 = spRand(baseSeed + 19u) - 0.5;
        let r2 = spRand(baseSeed + 31u) - 0.5;
        let r3 = spRand(baseSeed + 47u);
        let r4 = spRand(baseSeed + 61u);
        let isSurf = sp.velKind.w > 0.5;
        let spread = select(0.55, 1.35, isSurf);
        let pos = vec3f(sp.posEnergy.x + r1 * spread, sp.posEnergy.y + 0.08 + r3 * 0.18, sp.posEnergy.z + r2 * spread);
        let vx = sp.velKind.x * select(0.55, 1.15, isSurf) + (r1 * 1.4);
        let vz = sp.velKind.y * select(0.55, 1.15, isSurf) + (r2 * 1.4);
        let vy = sp.velKind.z * (0.55 + 0.65 * r4);
        let life = mix(0.55, 1.25, r3) * select(0.85, 1.15, isSurf);
        let size = mix(0.28, 0.72, r4) * clamp(sp.posEnergy.w, 0.5, 1.4) * select(0.75, 1.35, isSurf);
        p = SprayParticle(
          vec4f(pos, 0.0),
          vec4f(vx, vy, vz, life),
          vec4f(size, sp.posEnergy.w, r3, sp.velKind.w)
        );
      }
    }
  }

  particles[idx] = p;
}
`;

export const SURF_SPRAY_RENDER_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var<storage, read> sunVis: array<f32, 4>;
` + SKY_RENDER_FUNCS + /* wgsl */ `
struct SprayParticle {
  posAge: vec4f,
  velLife: vec4f,
  info: vec4f,
};
@group(0) @binding(5) var<storage, read> particles: array<SprayParticle>;

struct SprayVSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) alphaEnergy: vec3f, // alpha, seed, kind
  @location(2) rel: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SprayVSOut {
  var o: SprayVSOut;
  let p = particles[ii];
  let life = p.velLife.w;
  if (life <= 0.0 || p.posAge.w >= life) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    o.uv = vec2f(0.0);
    o.alphaEnergy = vec3f(0.0);
    o.rel = vec3f(0.0);
    return o;
  }

  let u = clamp(p.posAge.w / life, 0.0, 1.0);
  let fadeIn = smoothstep(0.0, 0.14, u);
  let fadeOut = 1.0 - smoothstep(0.38, 1.0, u);
  let size = p.info.x * (0.55 + 1.15 * u);

  let rel = p.posAge.xyz - F.camPos.xyz;
  let dist = length(rel);
  if (dist > 280.0 || dist < 0.25) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    o.uv = vec2f(0.0);
    o.alphaEnergy = vec3f(0.0);
    o.rel = vec3f(0.0);
    return o;
  }

  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let c = corners[vi];
  // Extract camera right & up from viewProj transpose basis (world-up stabilized billboard)
  let viewDir = normalize(rel);
  let right = normalize(cross(viewDir, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-5, 0.0, 0.0));
  let up = normalize(cross(right, viewDir));
  let worldPos = earthCurve(rel, F.camPos.y) + (right * c.x + up * c.y) * size;

  o.pos = F.viewProj * vec4f(worldPos, 1.0);
  o.uv = c;
  let distFade = 1.0 - smoothstep(160.0, 275.0, dist);
  let alpha = fadeIn * fadeOut * distFade * clamp(p.info.y * 0.48, 0.14, 0.56);
  o.alphaEnergy = vec3f(alpha, p.info.z, p.info.w);
  o.rel = rel;
  return o;
}

@fragment
fn fs(in: SprayVSOut) -> @location(0) vec4f {
  let r2 = dot(in.uv, in.uv);
  if (r2 >= 1.0 || in.alphaEnergy.x <= 0.002) {
    return vec4f(0.0);
  }
  let n = gnoise(in.uv * 2.6 + vec2f(in.alphaEnergy.y * 17.3, in.alphaEnergy.z * 9.1));
  let puff = (1.0 - r2) * (1.0 - r2) * (0.62 + 0.52 * n);
  let a = clamp(puff * in.alphaEnergy.x, 0.0, 0.72);
  if (a <= 0.002) {
    return vec4f(0.0);
  }

  let V = normalize(-in.rel);
  let Ld = F.sunDir.xyz;
  let sunE = sunIlluminance() * sunVis[0];
  let skyCol = skyAtmo(vec3f(0.0, 0.7, 0.7));
  // Forward-scattered sunlit spray mist + diffuse sky bounce
  let fwd = pow(clamp(dot(-V, Ld), 0.0, 1.0), 4.0);
  let lit = (sunE * (0.28 + 0.45 * fwd) * max(Ld.y, 0.0) + skyCol * 1.15) * vec3f(0.88, 0.93, 0.96);
  let col = surfaceAir(lit, in.rel + F.camPos.xyz);
  return vec4f(col * a, a);
}
`;
