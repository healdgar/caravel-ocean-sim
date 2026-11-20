// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// GPU pasture herds, 1550 mounted riders & road caravans manager: uploads static herd, caravan,
// and street-mount seeds once per coast/update, dispatches closed-form GPU pasture, caravan hitch,
// street-mount, stampede & casualty compute, and draws all 7 species (sheep, cattle, swine,
// Lusitano horses + sela à gineta tack, covered wain, coach, cargo ox-cart) through the one continuum
// (js/animal-continuum.js): the step stands each one's record and writes its joints, the one cut chooses its
// clusters, far body or splat and casts its shadow, and the herds' material shades whatever it chose.
import { requestOnce } from './gpu-program-cache.js';
import { ANIMAL_CONTINUUM_TYPES } from './animal-continuum.js';
import { requestAnimalContinuumAtlas, requestLivestockTextures, createAnimalScene } from './animal-scene.js';
import { requestContinuumPrograms, requestContinuumView } from './continuum-scene.js';
import { LAND_SHADOW_FORMAT } from './shadows.js';
import { ROUTE_STEP_M, WALKER_WORDS } from './town-streets.js';
import { continuumGroundView } from './continuum-ground.js';
import { worldBodiesForDevice } from './world-bodies.js';
import {
  HERD_CONTINUUM_MATERIAL_SPEC,
  HERD_FATE_FLOATS,
  HERD_ROUTE_HEADER,
  HERD_SEED_FLOATS,
  HERD_SHOT_FLOATS,
  HERD_SHOT_LIMIT,
  HERD_SHOTS_WORDS,
  HERD_SPECIES,
  HERD_STAMPEDE_RADIUS_M,
  HERDS_STEP_WGSL,
} from './wgsl/herds.js';

export const MAX_HERDS = 1536;
export const CARAVAN_YOKE_AHEAD_M = 4.05;
export const STREET_MOUNT_FLAG = 16;

const ACTIVE_HERDS_BY_DEVICE = new WeakMap();
export function getLivestockHerdsForDevice(device) {
  return device ? ACTIVE_HERDS_BY_DEVICE.get(device) ?? null : null;
}

const CARAVAN_CART_GAP_M = 15, CARAVAN_YOKE_SPREAD_M = 0.62, CARAVAN_DROVE_MOST = 16;
const CARAVAN_DROVE_SPECIES = Object.freeze({ sheep: 0, cattle: 1, swine: 2, horses: 3 });
const CARAVAN_COACH_GOODS = new Set([
  'cloth', 'silk', 'spice', 'spices', 'silver', 'gold', 'jewels', 'luxury',
  'tools', 'books', 'glass', 'merchants', 'passenger', 'passengers', 'envoys',
]);
const CARAVAN_OX_CART_GOODS = new Set([
  'timber', 'wood', 'ore', 'iron', 'stone', 'wine', 'oil', 'pottery', 'char', 'hay',
]);
const CARAVAN_CARGO_TINT = Object.freeze({
  grain: 0, wheat: 0, flour: 0, wine: 1, oil: 1, wool: 2, ore: 3, iron: 3, stone: 3,
  salt: 4, cloth: 5, silk: 5, merchants: 5, passenger: 5, timber: 6, wood: 6, pottery: 6, hay: 7, char: 3,
});
const caravanHash = (a, b) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
};

// Physical deck & sloped approach-ramp surface query matching rendered 3D geometry in js/old-world-works.js
// (WORKS_FOOTBRIDGE, WORKS_FOOTBRIDGE_RAMP, WORKS_STONE_BRIDGE, WORKS_STONE_BRIDGE_RAMP) 1:1.
export function bridgeSurfaceAt(wx, wz, bridges) {
  if (!bridges || !bridges.length) return null;
  let best = null;
  for (const b of bridges) {
    if (!b || b.collapsed || !Number.isFinite(b.deckY)) continue;
    const ux = b.ux || 0, uz = b.uz || 1;
    const halfLen = (b.length || 12) * 0.5;
    const maxRampRun = Math.max(b.ramps?.neg?.run || 0, b.ramps?.pos?.run || 0, 2.0);
    const dx = wx - b.x, dz = wz - b.z;
    const bound = halfLen + maxRampRun + 3.0;
    if (Math.abs(dx) > bound || Math.abs(dz) > bound) continue;
    const signedAlong = dx * ux + dz * uz;
    const along = Math.abs(signedAlong);
    const signedAcross = -dx * uz + dz * ux;
    const across = Math.abs(signedAcross);
    const deckTopOff = b.isStone ? 0.10 : 0.06;
    const railInset = b.isStone ? 0.42 : 0.24;
    const deckHalfW = Math.max(0.85, (b.halfWidth || 1.6) - (b.isStone ? 0.05 : 0.08));
    if (across > deckHalfW + 0.28) continue;

    let y = -Infinity;
    const endRamp = signedAlong >= 0 ? b.ramps?.pos : b.ramps?.neg;
    const s = along - halfLen;
    if (along <= halfLen) {
      // Main span deck top (wooden planks +0.06 m, stone paving +0.10 m); small outer apron when no ramp overlaps.
      y = (!b.isStone && !endRamp && along > halfLen - 1.05) ? (b.deckY - 0.02) : (b.deckY + deckTopOff);
    }
    if (endRamp && s >= -0.35 && s <= endRamp.run + 0.65) {
      const tRamp = Math.max(0, Math.min(1.06, (s + 0.25) / Math.max(0.5, endRamp.run)));
      const rampY = b.deckY + deckTopOff - tRamp * endRamp.drop;
      if (rampY > y) y = rampY;
    } else if (!endRamp && s > 0 && s <= 1.6) {
      // Short smooth threshold onto graded earthen embankment when no physical ramp was required.
      const sillY = b.deckY + (b.isStone ? 0.10 : -0.02) - 0.26 * (s / 1.6);
      if (sillY > y) y = sillY;
    }
    if (y > -1e5 && (!best || y > best.y)) {
      best = {
        y,
        bridge: b,
        halfWidth: Math.max(0.45, (b.halfWidth || 1.6) - railInset),
        deckHalfWidth: deckHalfW,
        signedAlong,
        signedAcross,
        across,
        onRamp: s > 0 && Boolean(endRamp),
      };
    }
  }
  return best;
}

export function bridgeDeckYAt(wx, wz, bridges) {
  return bridgeSurfaceAt(wx, wz, bridges)?.y ?? 0;
}

function segmentNearBridge(ax, az, bx, bz, bridges) {
  if (!bridges || !bridges.length) return false;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  for (const b of bridges) {
    if (!b || b.collapsed) continue;
    const reach = (b.length || 12) * 0.65 + 12;
    if (b.x >= minX - reach && b.x <= maxX + reach && b.z >= minZ - reach && b.z <= maxZ + reach) return true;
  }
  return false;
}

function pointOnCollapsedBridge(wx, wz, bridges) {
  if (!bridges || !bridges.length) return false;
  for (const b of bridges) {
    if (!b?.collapsed) continue;
    const reach = Math.max(7, (b.length || 12) * 0.48);
    if (Math.hypot(wx - b.x, wz - b.z) <= reach) return true;
  }
  return false;
}

function chooseRoadVehicleArchetype(good, key, cartIndex) {
  const roll = caravanHash(key, cartIndex * 17 + 5);
  if ((CARAVAN_COACH_GOODS.has(good) && roll < 0.88) || (!CARAVAN_OX_CART_GOODS.has(good) && roll < 0.36)) {
    return { vehicleSpecies: 5, draftSpecies: 3 }; // 4-wheel passenger/merchant coach (`coche`) + 2 harnessed horses
  }
  if (CARAVAN_OX_CART_GOODS.has(good) ? roll < 0.52 : roll < 0.62) {
    return { vehicleSpecies: 6, draftSpecies: 1 }; // 2-wheel heavy cargo ox-cart (`carro de bois`) + 2 yoked oxen
  }
  return { vehicleSpecies: 4, draftSpecies: 1 };   // 4-wheel covered freight wain (`carreta`) + 2 yoked oxen
}

// Travelling seeds and route buffer for the country model's road caravans & mounted envoys (`BOARD_MODEL.caravans`).
// Genuine droves (`qty >= 6 && !c.carts`) walk loose as herds of 6–16 head; mounted entries (`c.mode === 'rider'` or
// `c.mounted === true`) spawn saddled Lusitano horses (`species = 3`, `traits.x = 10 + coatSeed`); every other road
// consignment spawns a physical 1550 vehicle (`species = 4` wain, `5` coach, or `6` ox-cart) atomically coupled to
// its paired draft beasts (`species = 1` oxen or `species = 3` horses) via shared `behind` progress.
export function caravanHerdSeeds(list, origin, bridges = null) {
  const routes = [], seeds = [];
  const hasBridges = Boolean(bridges && bridges.length);
  for (const c of list ?? []) {
    const isRider = c?.mode === 'rider' || c?.mounted === true;
    if ((c?.mode !== 'cart' && !isRider) || !(c.points?.length >= 4) || !(c.arrive > c.depart)) continue;
    const header = routes.length / 4, n = c.points.length / 2;
    let along = 0;
    const pts = [];
    for (let k = 0; k < n; k++) {
      const x = origin.x + c.points[k * 2], z = origin.z + c.points[k * 2 + 1];
      if (hasBridges && pointOnCollapsedBridge(x, z, bridges)) break;
      if (pts.length) {
        const p = pts[pts.length - 1];
        const step = Math.hypot(x - p[0], z - p[1]);
        if (step < 0.05) continue;
        if (hasBridges && step > 4.5 && segmentNearBridge(p[0], p[1], x, z, bridges)) {
          const steps = Math.ceil(step / 4.0);
          let truncated = false;
          for (let s = 1; s < steps; s++) {
            const u = s / steps;
            const ix = p[0] + (x - p[0]) * u;
            const iz = p[1] + (z - p[1]) * u;
            if (pointOnCollapsedBridge(ix, iz, bridges)) { truncated = true; break; }
            pts.push([ix, iz, along + step * u, bridgeDeckYAt(ix, iz, bridges)]);
          }
          if (truncated) break;
        }
        along += step;
      }
      pts.push([x, z, along, hasBridges ? bridgeDeckYAt(x, z, bridges) : 0]);
    }
    if (pts.length < 2 || along < 1) continue;
    routes.push(c.depart, c.arrive, pts.length, along);
    for (const p of pts) routes.push(p[0], p[1], p[2], p[3]);
    const key = [...String(c.key ?? 'road')].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
    const rawPhase = Number(c.phaseOffset);
    const phaseOffset = Number.isFinite(rawPhase) ? (((rawPhase % 1) + 1) % 1) : 0;
    const roamSentinel = -1 - phaseOffset * 0.9999;

    if (isRider) {
      const riderCount = Math.max(1, Math.min(8, Math.round(c.riders || c.qty || 1)));
      for (let k = 0; k < riderCount; k++) {
        const behind = k * 4.2 + caravanHash(key, k + 7) * 0.6;
        const coatSeed = 0.02 + caravanHash(key, k + 41) * 0.96;
        const scale = 0.98 + caravanHash(key, k + 53) * 0.06;
        const lateral = riderCount > 1 ? ((k % 2 === 0 ? -1 : 1) * 0.62) : 0;
        seeds.push(header, behind, roamSentinel, caravanHash(key, k + 17), 10 + coatSeed, scale, 3, lateral);
      }
      continue;
    }

    const drove = CARAVAN_DROVE_SPECIES[c.good];
    const isGenuineDrove = drove !== undefined && (c.drove === true || (c.drove !== false && (c.qty ?? 0) >= 6 && !c.carts));
    if (isGenuineDrove) {
      const head = Math.max(6, Math.min(CARAVAN_DROVE_MOST, Math.round(c.qty || 6)));
      for (let k = 0; k < head; k++) {
        const u = caravanHash(key, k * 3 + 1), w = caravanHash(key, k * 3 + 2);
        seeds.push(header, 1.2 + k * 1.5 + u * 1.2, roamSentinel, caravanHash(key, k * 3 + 3), 1 + w, 0.9 + u * 0.2, drove, (w - 0.5) * 4.2);
      }
      continue;
    }

    const tint = ((CARAVAN_CARGO_TINT[c.good] ?? Math.floor(caravanHash(key, 99) * 8)) + 0.5) / 8;
    const vehicleCount = Math.max(1, c.carts | 0);
    for (let k = 0; k < vehicleCount; k++) {
      const { vehicleSpecies, draftSpecies } = chooseRoadVehicleArchetype(String(c.good ?? ''), key, k);
      const behind = k * CARAVAN_CART_GAP_M + caravanHash(key, k) * 3;
      // Vehicle seed and both paired draft beasts share identical `behind` (`anchor.y`) so `HERDS_STEP_WGSL`
      // advances and culls the entire hitch atomically (`yokeRolled = anchorRolled + CARAVAN_YOKE_AHEAD_M`).
      seeds.push(header, behind, roamSentinel, caravanHash(key, k + 40), tint, 1, vehicleSpecies, 0);
      for (const side of [-1, 1]) {
        seeds.push(
          header,
          behind,
          roamSentinel,
          caravanHash(key, k * 2 + (side > 0 ? 61 : 60)),
          caravanHash(key, k + 80 + (side > 0 ? 1 : 0)) * 0.98,
          0.96,
          draftSpecies,
          side * CARAVAN_YOKE_SPREAD_M,
        );
      }
    }
  }
  return { routes: new Float32Array(routes.length ? routes : [0, 1, 0, 0]), seeds: new Float32Array(seeds), header: HERD_ROUTE_HEADER };
}

// Build 1:1 GPU street-mount seeds & route slices matching every walker in `streets` flagged with `STREET_MOUNT_FLAG` (`16`).
// Strictly emits ZERO horses when `indigenous === true` (pre-contact Americas).
export function buildStreetMountSeeds(streets, { originOffset = { x: 0, z: 0 }, indigenous = false, maxPeople = Infinity } = {}) {
  if (indigenous || !streets?.walkers?.length || !streets?.samples?.length) {
    return { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0, walkerIndices: [] };
  }
  const f = streets.walkers instanceof Float32Array
    ? streets.walkers
    : new Float32Array(streets.walkers.buffer, streets.walkers.byteOffset, Math.floor(streets.walkers.byteLength / 4));
  const w = new Uint32Array(f.buffer, f.byteOffset, f.length);
  const totalWalkers = Math.min(streets.people ?? Math.floor(f.length / WALKER_WORDS), Math.floor(f.length / WALKER_WORDS), maxPeople);
  const samples = streets.samples;
  const routes = [], seeds = [], walkerIndices = [];
  const ox = originOffset?.x ?? 0, oz = originOffset?.z ?? 0;

  for (let i = 0; i < totalWalkers; i++) {
    const at = i * WALKER_WORDS;
    const flags = w[at + 11];
    if ((flags & STREET_MOUNT_FLAG) === 0) continue;
    const first = w[at], count = w[at + 1];
    if (count < 2 || (first + count) * 4 > samples.length) continue;
    const phase = f[at + 2], speed = f[at + 3], side = f[at + 4];
    const pauseAt = f[at + 5], pauseFor = f[at + 6], indoors = f[at + 7];
    const lengthM = f[at + 8], abroad = Math.max(0, Math.min(1, f[at + 9]));
    const look = w[at + 10];
    const header = routes.length / 4;
    routes.push(count, lengthM, speed, indoors);
    routes.push(pauseAt, pauseFor, side, flags);
    for (let k = 0; k < count; k++) {
      const so = (first + k) * 4;
      routes.push(samples[so] - ox, samples[so + 1], samples[so + 2] - oz, samples[so + 3]);
    }
    const coatSeed = 0.02 + caravanHash(look ^ (i * 131), 29) * 0.96;
    seeds.push(header, 0, -10 - abroad, phase, 10 + coatSeed, 1.0, 3, i);
    walkerIndices.push(i);
  }
  return {
    routes: new Float32Array(routes),
    seeds: new Float32Array(seeds),
    count: walkerIndices.length,
    walkerIndices,
  };
}

// Build coupled townsfolk way samples + walkers (`CLIP_RIDE`) + matching `herds` saddled horse seeds for mounted road envoys/travellers.
export function caravanRiderWaySeeds(list, origin, bridges = null, { heightAt = null, indigenous = false } = {}) {
  if (indigenous) {
    return {
      samples: new Float32Array(0),
      walkers: new Float32Array(0),
      people: 0,
      souls: [],
      mountSeeds: { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0, walkerIndices: [] },
    };
  }
  const sampleArr = [], walkerBuf = [], souls = [];
  const groundFn = typeof heightAt === 'function' ? heightAt : () => 2.0;
  for (const c of list ?? []) {
    const isRider = c?.mode === 'rider' || c?.mounted === true;
    if (!isRider || !(c.points?.length >= 4)) continue;
    const rawPts = [];
    for (let k = 0; k + 1 < c.points.length; k += 2) {
      const wx = origin.x + c.points[k], wz = origin.z + c.points[k + 1];
      if (bridges?.length && pointOnCollapsedBridge(wx, wz, bridges)) break;
      rawPts.push([wx, wz]);
    }
    if (rawPts.length < 2) continue;
    let totalLen = 0;
    const segLens = [];
    for (let k = 1; k < rawPts.length; k++) {
      const sl = Math.hypot(rawPts[k][0] - rawPts[k - 1][0], rawPts[k][1] - rawPts[k - 1][1]);
      segLens.push(sl);
      totalLen += sl;
    }
    const count = Math.floor(totalLen / ROUTE_STEP_M) + 1;
    if (count < 3) continue;
    const first = sampleArr.length / 4;
    let segIdx = 0, before = 0;
    for (let s = 0; s < count; s++) {
      const d = s * ROUTE_STEP_M;
      while (segIdx + 1 < segLens.length && d > before + segLens[segIdx]) {
        before += segLens[segIdx];
        segIdx++;
      }
      const span = segLens[segIdx] || 1;
      const t = Math.max(0, Math.min(1, (d - before) / span));
      const x = rawPts[segIdx][0] + (rawPts[segIdx + 1][0] - rawPts[segIdx][0]) * t;
      const z = rawPts[segIdx][1] + (rawPts[segIdx + 1][1] - rawPts[segIdx][1]) * t;
      const gy = groundFn(x, z);
      const dy = bridges?.length ? bridgeDeckYAt(x, z, bridges) : 0;
      sampleArr.push(x, Math.max(gy, dy), z, 0.35);
    }
    const key = [...String(c.key ?? 'envoy')].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
    const riderCount = Math.max(1, Math.min(8, Math.round(c.riders || c.qty || 1)));
    for (let r = 0; r < riderCount; r++) {
      const one = new ArrayBuffer(WALKER_WORDS * 4);
      const wf = new Float32Array(one), wu = new Uint32Array(one);
      wu[0] = first;
      wu[1] = count;
      wf[2] = (((Number(c.phaseOffset) || caravanHash(key, r + 3)) + r * 0.03) % 1 + 1) % 1;
      wf[3] = 2.85;
      wf[4] = riderCount > 1 ? (r % 2 === 0 ? 0.65 : -0.65) : 0.35;
      wf[5] = 0;
      wf[6] = 0;
      wf[7] = 0;
      wf[8] = (count - 1) * ROUTE_STEP_M;
      wf[9] = 0.96;
      wu[10] = Math.floor(caravanHash(key, r + 19) * 0xffff);
      const sexBit = c.sex === 'f' ? 1 : 0;
      wu[11] = sexBit | 2 | 4 | STREET_MOUNT_FLAG;
      walkerBuf.push(wf);
      souls.push({
        id: c.id ?? (900000 + Math.abs(key % 90000) + r),
        name: c.name ?? 'Correio Real',
        surname: c.surname ?? '',
        sex: c.sex ?? 'm',
        age: c.age ?? 31,
        role: c.role ?? 'envoy',
        goal: 'work',
        there: 'riding royal post',
        via: 'the king\'s highway',
        mounted: true,
        planned: true,
      });
    }
  }
  const walkers = new Float32Array(walkerBuf.length * WALKER_WORDS);
  walkerBuf.forEach((wf, idx) => walkers.set(wf, idx * WALKER_WORDS));
  const samples = new Float32Array(sampleArr);
  const streetsObj = { samples, walkers, people: walkerBuf.length, souls };
  return {
    ...streetsObj,
    mountSeeds: buildStreetMountSeeds(streetsObj, { indigenous: false }),
  };
}

// Pure CPU evaluation of a single herd / caravan / street-mount instance matching `HERDS_STEP_WGSL`.
function sampleRouteCPU(routes, header, s) {
  const h = header * 4;
  const count = Math.max(2, Math.round(routes[h + 2] || 2));
  const total = routes[h + 3] || 0;
  const d = Math.max(0, Math.min(total, s));
  let lo = 0, hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (routes[h + 4 + mid * 4 + 2] <= d) lo = mid;
    else hi = mid;
  }
  const ao = h + 4 + lo * 4, bo = h + 4 + hi * 4;
  const span = Math.max(1e-3, routes[bo + 2] - routes[ao + 2]);
  const t = Math.max(0, Math.min(1, (d - routes[ao + 2]) / span));
  const dx = routes[bo] - routes[ao], dz = routes[bo + 1] - routes[ao + 1];
  const dl = Math.hypot(dx, dz);
  return {
    x: routes[ao] + dx * t,
    z: routes[ao + 1] + dz * t,
    dirX: dl > 1e-4 ? dx / dl : 0,
    dirZ: dl > 1e-4 ? dz / dl : 1,
    deckY: routes[ao + 3] + (routes[bo + 3] - routes[ao + 3]) * t,
  };
}

function pastureWalkTimeCPU(t, phase) {
  const period = 28;
  const u = t + phase * 4.456;
  const cyc = Math.floor(u / period);
  const f = u - cyc * period;
  const moveWindow = 8.5;
  let localMove = moveWindow * 0.5, speed = 0;
  if (f < moveWindow) {
    const x = f / moveWindow;
    localMove = moveWindow * (x * x * (3 - 2 * x)) * 0.5;
    speed = 6 * x * (1 - x) * 0.5;
  }
  return { tau: cyc * moveWindow * 0.5 + localMove, moveAmt: Math.max(0, Math.min(1, speed / 0.75)) };
}

function herdLissajousCPU(tau, phase, flockAngle) {
  const lx = Math.sin(tau * 0.21 + phase) * 0.68 + Math.sin(tau * 0.09 + phase * 1.7) * 0.32;
  const lz = Math.cos(tau * 0.17 + phase * 1.3) * 0.68 + Math.sin(tau * 0.11 - phase * 0.8) * 0.32;
  const c = Math.cos(flockAngle), s = Math.sin(flockAngle);
  return [lx * c - lz * s, lx * s + lz * c];
}

function secondsSinceCPU(since, now) {
  const age = now - since;
  return age < 0 ? age + 600 : age;
}

const smoothstepCPU = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function evaluateHerdStateAt(seeds, routes, fates, idx, clock = 0, elevationFn = null) {
  const count = Math.floor((seeds?.length ?? 0) / HERD_SEED_FLOATS);
  if (idx < 0 || idx >= count) return null;
  const t = typeof clock === 'number' ? clock : (clock?.time ?? 0);
  const boardDay = typeof clock === 'object' && clock !== null ? (clock.boardDay ?? 0) : 0;
  const daysPerSecond = typeof clock === 'object' && clock !== null ? (clock.daysPerSecond ?? 0) : 0;
  const sunY = typeof clock === 'object' && clock !== null ? (clock.sunY ?? 1) : 1;
  const shiftX = typeof clock === 'object' && clock !== null ? (clock.shiftX ?? 0) : 0;
  const shiftZ = typeof clock === 'object' && clock !== null ? (clock.shiftZ ?? 0) : 0;
  const elev = typeof elevationFn === 'function' ? elevationFn : () => 2.0;

  const so = idx * HERD_SEED_FLOATS;
  const anchorX = seeds[so], anchorY = seeds[so + 1], roamR = seeds[so + 2], phase = seeds[so + 3];
  const rawTraitX = seeds[so + 4], scale = seeds[so + 5] || 1;
  const species = Math.min(HERD_SPECIES - 1, Math.max(0, Math.round(seeds[so + 6] || 0)));
  const traitW = seeds[so + 7] || 0;
  const isVehicle = species >= 4;
  const hasTack = species === 3 && rawTraitX >= 10;
  const isStreetMount = roamR <= -10;
  const travelling = roamR < 0 && !isStreetMount;
  const isDraftBeast = travelling && !isVehicle && rawTraitX < 1;
  const isHitch = travelling && (isVehicle || isDraftBeast);

  const fo = idx * HERD_FATE_FLOATS;
  const fState = fates ? fates[fo] : 0;
  const fTime = fates ? fates[fo + 1] : 0;
  const fDirX = fates ? fates[fo + 2] : 0;
  const fDirZ = fates ? fates[fo + 3] : 1;
  const fRolled = fates ? fates[fo + 4] : 0;
  const fSavedZ = fates ? fates[fo + 5] : 0;
  const fSavedX = fates ? fates[fo + 6] : 0;
  const fSavedYaw = fates ? fates[fo + 7] : 0;

  let flags = hasTack ? 1 : 0;
  let hitAge = 0, worldX = anchorX, worldZ = anchorY, walkYaw = traitW;
  let moveAmt = 0, rolled = 0, anchorRolled = 0, routeDeckY = 0, tonguePitch = 0;
  let hitchBase = -1, wayGroundY = -1000;

  if (isStreetMount) {
    const rh = Math.round(anchorX) * 4;
    if (!routes || rh + 8 > routes.length) return null;
    const sampleCount = Math.round(routes[rh]);
    const lengthM = routes[rh + 1], speed = Math.max(0.1, routes[rh + 2]), indoors = routes[rh + 3];
    const pauseAt = routes[rh + 4], pauseFor = routes[rh + 5], side = routes[rh + 6], wFlags = Math.round(routes[rh + 7]);
    const abroad = -roamR - 10;
    if (fState < 1.5) {
      if (abroad > 0.1 + 0.9 * smoothstepCPU(-0.1, 0.14, sunY)) return null;
      const walking = lengthM / speed;
      const leg = walking + pauseFor + indoors;
      const turns = t / (2 * leg) + phase;
      const turn = (turns - Math.floor(turns)) * 2 * leg;
      const back = turn >= leg;
      const inLeg = turn - (back ? leg : 0);
      const arrived = inLeg >= walking + pauseFor;
      if (arrived && ((wFlags >> (back ? 1 : 2)) & 1) === 0) return null;
      const stopAt = walking * pauseAt;
      const stopped = arrived || (pauseFor > 0 && inLeg >= stopAt && inLeg < stopAt + pauseFor);
      const walked = Math.min(lengthM, (Math.min(inLeg, stopAt) + Math.max(0, inLeg - stopAt - pauseFor)) * speed);
      const metres = back ? lengthM - walked : walked;
      const going = back ? -1 : 1;
      const along = metres / ROUTE_STEP_M;
      const si = Math.min(Math.max(0, Math.floor(along)), Math.max(0, sampleCount - 2));
      const frac = Math.max(0, Math.min(1, along - si));
      const a0 = rh + 8 + si * 4, a1 = a0 + 4;
      const ahead = rh + 8 + Math.min(si + 3, sampleCount - 1) * 4;
      const behind = rh + 8 + Math.max(si - 2, 0) * 4;
      const fx = routes[ahead] - routes[behind] + 1e-4, fz = routes[ahead + 2] - routes[behind + 2];
      const fl = Math.hypot(fx, fz) || 1;
      const decW = (raw) => {
        if (raw < 16) return [raw, 0];
        const v = Math.round(raw - 16);
        return [(v & 511) * 0.01, (v >> 9) * 0.001 - 0.5];
      };
      const [hw0, sl0] = decW(routes[a0 + 3]), [hw1, sl1] = decW(routes[a1 + 3]);
      const room = hw0 + (hw1 - hw0) * frac;
      const crossSlope = sl0 + (sl1 - sl0) * frac;
      const aside = going * side * room;
      worldX = routes[a0] + (routes[a1] - routes[a0]) * frac + (fz / fl) * aside;
      wayGroundY = routes[a0 + 1] + (routes[a1 + 1] - routes[a0 + 1]) * frac + aside * crossSlope;
      worldZ = routes[a0 + 2] + (routes[a1 + 2] - routes[a0 + 2]) * frac - (fx / fl) * aside;
      walkYaw = Math.atan2((fx / fl) * going, (fz / fl) * going);
      rolled = walked;
      moveAmt = stopped ? 0 : Math.max(0.35, Math.min(1, speed / 2.2));
    } else {
      wayGroundY = elev(fSavedX, fSavedZ);
    }
  } else if (travelling) {
    const header = Math.round(anchorX);
    const rh = header * 4;
    if (!routes || rh + 4 > routes.length || routes[rh + 2] < 2) return null;
    const dep = routes[rh], arr = routes[rh + 1], total = routes[rh + 3];
    const days = Math.max(1e-3, arr - dep);
    const share = Math.max(0, Math.min(1, (boardDay - dep) / days));
    const phaseOffset = Math.max(0, Math.min(0.9999, -roamR - 1));
    const phaseShare = (share + phaseOffset) - Math.floor(share + phaseOffset);
    const calSpeed = (total / days) * daysPerSecond;
    const basePace = hasTack ? 2.85 : 0.92;
    const paceFloor = Math.max(0, basePace - calSpeed);
    const cycle = Math.max(total + 48, 1);
    const rawDist = phaseShare * total + paceFloor * t;
    const wrappedDist = rawDist - cycle * Math.floor(rawDist / cycle);
    const headDist = calSpeed < basePace && total > 1 ? wrappedDist : phaseShare * total;

    const wander = !isHitch && !hasTack ? 1 : 0;
    const behind = anchorY + wander * 0.9 * Math.sin(t * 0.11 + phase * 3);
    anchorRolled = headDist - behind;
    const yokeRolled = anchorRolled + CARAVAN_YOKE_AHEAD_M;
    rolled = isDraftBeast ? yokeRolled : anchorRolled;

    const atVeh = sampleRouteCPU(routes, header, anchorRolled);
    const yokeS = sampleRouteCPU(routes, header, yokeRolled);
    const at = isDraftBeast ? yokeS : atVeh;
    routeDeckY = at.deckY;
    const lateral = traitW + wander * 1.1 * Math.sin(t * 0.13 + phase * 7);
    worldX = at.x + at.dirZ * lateral;
    worldZ = at.z - at.dirX * lateral;
    walkYaw = Math.atan2(at.dirX, at.dirZ) + wander * 0.25 * Math.sin(t * 0.21 + phase * 5);

    let hitchDamaged = fState >= 1.5;
    let unhitchedBolt = false;
    if (isHitch) {
      const vehIdx = isVehicle ? idx : (traitW < 0 ? idx - 1 : idx - 2);
      hitchBase = vehIdx;
      const draftL = vehIdx + 1, draftR = vehIdx + 2;
      if (fates && vehIdx >= 0 && draftR < count && Math.abs(seeds[vehIdx * HERD_SEED_FLOATS + 1] - anchorY) < 1e-3) {
        const vfo = vehIdx * HERD_FATE_FLOATS, dlfo = draftL * HERD_FATE_FLOATS, drfo = draftR * HERD_FATE_FLOATS;
        if (fates[vfo] >= 1.5) {
          hitchDamaged = true;
          if (isVehicle) {
            flags |= 4;
            hitAge = secondsSinceCPU(fates[vfo + 1], t);
            anchorRolled = fates[vfo + 4];
            worldX = fates[vfo + 6];
            worldZ = fates[vfo + 5];
            walkYaw = fates[vfo + 7];
          } else if (fState < 1.5) {
            unhitchedBolt = true;
            const boltAge = secondsSinceCPU(fates[vfo + 1], t);
            rolled = fates[vfo + 4] + CARAVAN_YOKE_AHEAD_M + Math.min(boltAge, 32) * 4.4;
            const bAt = sampleRouteCPU(routes, header, rolled);
            routeDeckY = bAt.deckY;
            const veer = traitW * (1 + 0.45 * smoothstepCPU(0, 2, boltAge));
            worldX = bAt.x + bAt.dirZ * veer;
            worldZ = bAt.z - bAt.dirX * veer;
            walkYaw = Math.atan2(bAt.dirX, bAt.dirZ);
          }
        } else if (fates[dlfo] >= 1.5 || fates[drfo] >= 1.5) {
          hitchDamaged = true;
          const hfo = fates[dlfo] >= 1.5 ? dlfo : drfo;
          anchorRolled = fates[hfo + 4] - CARAVAN_YOKE_AHEAD_M;
          const hVeh = sampleRouteCPU(routes, header, anchorRolled);
          const hYoke = sampleRouteCPU(routes, header, fates[hfo + 4]);
          if (isVehicle) {
            flags |= 8;
            hitAge = secondsSinceCPU(fates[hfo + 1], t);
            worldX = hVeh.x;
            worldZ = hVeh.z;
            routeDeckY = hVeh.deckY;
            walkYaw = Math.atan2(hVeh.dirX, hVeh.dirZ);
            tonguePitch = 0.34 * smoothstepCPU(0, 0.45, hitAge);
          } else if (fState < 1.5) {
            rolled = fates[hfo + 4];
            worldX = hYoke.x + hYoke.dirZ * traitW;
            worldZ = hYoke.z - hYoke.dirX * traitW;
            routeDeckY = hYoke.deckY;
            walkYaw = Math.atan2(hYoke.dirX, hYoke.dirZ);
          }
        }
      }
    }
    const spanOk = isHitch && !unhitchedBolt
      ? (anchorRolled > 0.5 && yokeRolled < total - 0.5)
      : (rolled > 0 && rolled < total);
    const onRoad = hitchDamaged || (boardDay >= dep && boardDay <= arr + 0.05 && spanOk);
    if (!onRoad) return null;
    moveAmt = unhitchedBolt ? 1 : ((flags & 12) !== 0 || hitchDamaged ? 0 : Math.max(0, Math.min(1, Math.max(calSpeed, basePace) / (hasTack ? 2.2 : 0.9))));
  } else {
    const pw = pastureWalkTimeCPU(t, phase);
    const off0 = herdLissajousCPU(pw.tau, phase, traitW);
    const off1 = herdLissajousCPU(pw.tau + 0.12, phase, traitW);
    worldX = anchorX + off0[0] * roamR;
    worldZ = anchorY + off0[1] * roamR;
    const vx = (off1[0] - off0[0]) * roamR, vz = (off1[1] - off0[1]) * roamR;
    walkYaw = Math.hypot(vx, vz) > 1e-4 ? Math.atan2(vx, vz) : traitW;
    moveAmt = pw.moveAmt;
  }

  if (!isVehicle && fState > 0.5 && fState < 1.5) {
    const panicAge = secondsSinceCPU(fTime, t);
    if (panicAge < 14) {
      const topSpeed = species === 3 ? 6.4 : 4.5;
      const runDist = topSpeed * (panicAge - 0.35 * panicAge * panicAge / 14);
      const rx = fSavedX + fDirX * runDist, rz = fSavedZ + fDirZ * runDist;
      const safe = elev(rx, rz) >= 0.45;
      const settle = smoothstepCPU(11.5, 14, panicAge);
      worldX = (safe ? rx : fSavedX) * (1 - settle) + worldX * settle;
      worldZ = (safe ? rz : fSavedZ) * (1 - settle) + worldZ * settle;
      walkYaw = Math.atan2(fDirX, fDirZ);
      moveAmt = 1 - settle + moveAmt * settle;
    }
  }

  if (!isVehicle && fState >= 1.5) {
    flags |= 2;
    hitAge = secondsSinceCPU(fTime, t);
    const fractP = (phase * 13.7 + 0.31) - Math.floor(phase * 13.7 + 0.31);
    const kbDist = (0.8 + 1.0 * fractP) * (1 - Math.exp(-hitAge * 5.5));
    worldX = fSavedX + fDirX * kbDist;
    worldZ = fSavedZ + fDirZ * kbDist;
    walkYaw = fSavedYaw;
    moveAmt = 0;
  }

  let wy = elev(worldX, worldZ);
  if (isStreetMount && fState < 1.5 && wayGroundY > -500) wy = wayGroundY;
  else if (isStreetMount && wayGroundY > -500) wy = Math.max(wy, wayGroundY);
  if (travelling && routeDeckY > 0.25) wy = Math.max(wy, routeDeckY);
  if (wy < 0.32 && !(travelling && routeDeckY > 0.25) && !isStreetMount) return null;

  return {
    x: worldX + shiftX,
    y: wy,
    z: worldZ + shiftZ,
    unshiftedX: worldX,
    unshiftedZ: worldZ,
    yaw: walkYaw,
    scale,
    species,
    hasTack,
    flags,
    hitAge,
    moveAmt,
    rolled,
    anchorRolled,
    tonguePitch,
    hitchBase,
    isVehicle,
    isHitch,
    isStreetMount,
  };
}

// Pure CPU shot sweep matching `HERDS_STEP_WGSL`: updates `fates` (felling/shattering struck targets
// and triggering 38 m near-miss stampedes) and returns the earliest bounding-volume impact for `gunnery-control.js`.
export function sweepHerdHit(seeds, routes, fates, clock, elevationFn, from, to, radius = 0.08) {
  const count = Math.floor((seeds?.length ?? 0) / HERD_SEED_FLOATS);
  if (!count || !from || !to) return null;
  const t = typeof clock === 'number' ? clock : (clock?.time ?? 0);
  const sx = to[0] - from[0], sy = to[1] - from[1], sz = to[2] - from[2];
  const segLen2 = sx * sx + sy * sy + sz * sz;
  const segLen = Math.sqrt(segLen2);

  let best = null;
  for (let idx = 0; idx < count; idx++) {
    const fo = idx * HERD_FATE_FLOATS;
    if (fates && fates[fo] >= 1.5) continue;
    const st = evaluateHerdStateAt(seeds, routes, fates, idx, clock, elevationFn);
    if (!st) continue;

    let hitH = 0.90 * st.scale, hitR = 0.48 * st.scale;
    if (st.species === 1) { hitH = 1.52 * st.scale; hitR = 0.88 * st.scale; }
    else if (st.species === 2) { hitH = 0.72 * st.scale; hitR = 0.44 * st.scale; }
    else if (st.species === 3) { hitH = (st.hasTack ? 2.20 : 1.75) * st.scale; hitR = 0.86 * st.scale; }
    else if (st.isVehicle) { hitH = 2.02 * st.scale; hitR = 1.45 * st.scale; }

    const cx = st.x, cy = st.y + hitH * 0.5, cz = st.z;
    const tSeg = segLen2 > 1e-8
      ? Math.max(0, Math.min(1, ((cx - from[0]) * sx + (cy - from[1]) * sy + (cz - from[2]) * sz) / segLen2))
      : 0;
    const px = from[0] + sx * tSeg, py = from[1] + sy * tSeg, pz = from[2] + sz * tSeg;
    const dx = cx - px, dz = cz - pz;
    const dyBox = Math.max(0, st.y - py, py - (st.y + hitH));
    const dist = Math.hypot(dx, dyBox, dz);

    if (dist <= hitR + radius) {
      let dirX = sx, dirZ = sz;
      if (Math.hypot(dirX, dirZ) <= 1e-4) { dirX = dx; dirZ = dz; }
      const dl = Math.hypot(dirX, dirZ) || 1;
      dirX /= dl; dirZ /= dl;

      if (fates && fo + 7 < fates.length) {
        fates[fo] = 2.0;
        fates[fo + 1] = t;
        fates[fo + 2] = dirX;
        fates[fo + 3] = dirZ;
        fates[fo + 4] = st.isVehicle ? st.anchorRolled : st.rolled;
        fates[fo + 5] = st.unshiftedZ;
        fates[fo + 6] = st.unshiftedX;
        fates[fo + 7] = st.yaw;
      }

      if (!best || tSeg < best.fraction) {
        const nxRaw = px - cx, nyRaw = py - cy, nzRaw = pz - cz;
        const nl = Math.hypot(nxRaw, nyRaw, nzRaw) || 1;
        const point = [px, py, pz];
        best = {
          fraction: tSeg,
          distance: tSeg * segLen,
          point,
          position: point,
          x: px,
          y: py,
          z: pz,
          normal: [nxRaw / nl, nyRaw / nl, nzRaw / nl],
          kind: st.isVehicle ? 'caravan' : 'livestock',
          species: st.species,
          herdIndex: idx,
          hitchBase: st.hitchBase,
        };
      }
    } else if (fates && !st.isVehicle && !st.isHitch && !st.isStreetMount && dist < HERD_STAMPEDE_RADIUS_M) {
      let fx = cx - px, fz = cz - pz;
      const fl = Math.hypot(fx, fz);
      if (fl > 1e-4) { fx /= fl; fz /= fl; }
      else { fx = Math.sin(st.yaw); fz = Math.cos(st.yaw); }
      if (fo + 7 < fates.length) {
        fates[fo] = 1.0;
        fates[fo + 1] = t;
        fates[fo + 2] = fx;
        fates[fo + 3] = fz;
        fates[fo + 4] = st.rolled;
        fates[fo + 5] = st.unshiftedZ;
        fates[fo + 6] = st.unshiftedX;
        fates[fo + 7] = st.yaw;
      }
    }
  }
  return best;
}

// The herds' programs: the step that stands every beast and writes its joints, the one cut's select and shadow, and
// the herds' material's view.
export function requestHerdsPipelines({ device, shader, format = 'rgba16float', samples = 4 }) {
  return requestOnce(device, `livestock herds continuum ${format} ${samples}`, async () => {
    const [programs, view, step] = await Promise.all([
      requestContinuumPrograms({ device, shader, shadowFormat: LAND_SHADOW_FORMAT }),
      requestContinuumView({ device, shader, material: HERD_CONTINUUM_MATERIAL_SPEC, format, samples }),
      shader(HERDS_STEP_WGSL, 'livestock herds step').then((module) => device.createComputePipelineAsync({ label: 'livestock herds step', layout: 'auto', compute: { module, entryPoint: 'main' } })),
    ]);
    return { programs, view, step };
  });
}

export async function createLivestockHerds({
  device,
  shader,
  format = 'rgba16float',
  samples = 4,
  frameUBO,
  landUniform,
  nearDomain,
  elevation,
  landShadowUniform,
  resources,
  clouds,
  initialHerds = null,
  initialBridges = null,
  isMobile = false,
}) {
  const B = GPUBufferUsage;
  const mkBuf = (label, data, usage) => {
    const buf = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    if (data.byteLength) device.queue.writeBuffer(buf, 0, data);
    return buf;
  };
  const [pipelines, atlas, livestockTex] = await Promise.all([
    requestHerdsPipelines({ device, shader, format, samples }),
    requestAnimalContinuumAtlas(device),
    requestLivestockTextures(device),
  ]);
  const cloudGroup = clouds.bindVolume(pipelines.view.pipeline, 'shadow');
  const herdTypes = ANIMAL_CONTINUUM_TYPES.map((_, t) => t).filter((t) => t < HERD_SPECIES);

  const shotsBytes = new ArrayBuffer(HERD_SHOTS_WORDS * 4);
  const shotsU32 = new Uint32Array(shotsBytes);
  const shotsF32 = new Float32Array(shotsBytes);
  const shotsBuf = mkBuf('livestock shots', shotsU32, B.UNIFORM);
  const cpuFates = new Float32Array(MAX_HERDS * HERD_FATE_FLOATS);
  const fatesBuf = mkBuf('livestock fates', cpuFates, B.STORAGE);
  const cpuAvoid = new Float32Array(MAX_HERDS * 4);
  const avoidBuf = mkBuf('livestock avoid', cpuAvoid, B.STORAGE);
  const worldBodies = worldBodiesForDevice(device);
  const shotFlights = new Map();
  let shotsSentLastFrame = 0;
  let simClockSec = 0;

  const wantedBindings = new Set([0, 1, 2, 3, 4, 19, 20, 21, 24]);
  let activeResources = resources;
  let state = null;
  let pastureHerds = initialHerds;
  let activeBridges = initialBridges;
  let lastCaravans = null;
  let travellers = { routes: new Float32Array([0, 1, 0, 0]), seeds: new Float32Array(0) };
  let streetMounts = { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0 };
  // HerdConfig: count, a spare word, boardDay, daysPerSecond.
  const clock = new ArrayBuffer(16), clockU = new Uint32Array(clock), clockF = new Float32Array(clock);

  function releaseState(immediate = false) {
    if (!state) return;
    const old = state;
    state = null;
    const drop = () => {
      old.seeds.destroy();
      old.routes.destroy();
      old.cfg.destroy();
      old.animals.destroy();
    };
    if (!immediate && typeof device.queue?.onSubmittedWorkDone === 'function') {
      device.queue.onSubmittedWorkDone().then(drop).catch(() => {});
    } else {
      drop();
    }
  }

  function rebuildGroups() {
    if (!state) return;
    const baseEntries = activeResources.filter(([id]) => wantedBindings.has(id)).map(([binding, resource]) => ({ binding, resource }));
    baseEntries.push(
      { binding: 11, resource: livestockTex.view },
      { binding: 12, resource: livestockTex.sampler },
    );
    state.viewGroup = device.createBindGroup({ label: 'livestock herds', layout: pipelines.view.pipeline.getBindGroupLayout(0), entries: baseEntries });
  }

  function resetFatesRange(startIdx = 0, endIdx = MAX_HERDS) {
    const s = Math.max(0, Math.min(MAX_HERDS, startIdx));
    const e = Math.max(s, Math.min(MAX_HERDS, endIdx));
    if (e <= s) return;
    cpuFates.fill(0, s * HERD_FATE_FLOATS, e * HERD_FATE_FLOATS);
    device.queue.writeBuffer(
      fatesBuf,
      s * HERD_FATE_FLOATS * 4,
      cpuFates,
      s * HERD_FATE_FLOATS,
      (e - s) * HERD_FATE_FLOATS,
    );
    cpuAvoid.fill(0, s * 4, e * 4);
    device.queue.writeBuffer(avoidBuf, s * 16, cpuAvoid, s * 4, (e - s) * 4);
  }

  function setHerds(herdData) {
    pastureHerds = herdData;
    resetFatesRange(0, MAX_HERDS);
    install();
  }
  function setCaravans(list, origin, bridges = activeBridges) {
    lastCaravans = list ? { list, origin } : null;
    if (bridges !== undefined && bridges !== null) activeBridges = bridges;
    travellers = caravanHerdSeeds(list, origin, activeBridges);
    if (state) resetFatesRange(state.pastureCount, MAX_HERDS);
    install();
  }
  function setStreetMounts(mountData, maybeRoutes) {
    let next;
    if (mountData instanceof Float32Array) {
      next = mountData.length
        ? { seeds: mountData, routes: maybeRoutes instanceof Float32Array ? maybeRoutes : new Float32Array(0), count: Math.floor(mountData.length / HERD_SEED_FLOATS) }
        : { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0 };
    } else if (mountData?.seeds?.length) {
      next = { ...mountData, count: mountData.count ?? Math.floor(mountData.seeds.length / HERD_SEED_FLOATS) };
    } else {
      next = { routes: new Float32Array(0), seeds: new Float32Array(0), count: 0 };
    }
    if (next.seeds.length === 0 && streetMounts.seeds.length === 0) return;
    streetMounts = next;
    if (state) resetFatesRange(state.pastureCount + state.caravanCount, MAX_HERDS);
    install();
  }
  function setBridges(bridges) {
    activeBridges = bridges || null;
    if (lastCaravans) {
      travellers = caravanHerdSeeds(lastCaravans.list, lastCaravans.origin, activeBridges);
      install();
    }
  }
  function install() {
    releaseState();
    const herdData = pastureHerds;
    const rawCount = herdData?.length ? Math.floor(herdData.length / HERD_SEED_FLOATS) : 0;
    const caravanSeedCount = Math.floor(travellers.seeds.length / HERD_SEED_FLOATS);
    const mountSeedCount = Math.floor(streetMounts.seeds.length / HERD_SEED_FLOATS);
    const caravanCount = Math.min(MAX_HERDS, caravanSeedCount);
    const mountCount = Math.min(Math.max(0, MAX_HERDS - caravanCount), mountSeedCount);
    const travelCount = caravanCount + mountCount;
    const rawPasture = isMobile ? Math.round(rawCount * 0.55) : rawCount;
    const pastureCount = Math.min(rawPasture, Math.max(0, MAX_HERDS - travelCount));
    const count = pastureCount + travelCount;
    worldBodies.setHerdCount(count);
    if (!count) return;

    const baseRouteVec4s = Math.floor(travellers.routes.length / 4);
    let combinedRoutes = travellers.routes;
    if (mountCount > 0 && streetMounts.routes.length > 0) {
      combinedRoutes = new Float32Array(travellers.routes.length + streetMounts.routes.length);
      combinedRoutes.set(travellers.routes, 0);
      combinedRoutes.set(streetMounts.routes, travellers.routes.length);
    }

    const sliceData = new Float32Array(count * HERD_SEED_FLOATS);
    if (pastureCount) sliceData.set(herdData.subarray(0, pastureCount * HERD_SEED_FLOATS), 0);
    if (caravanCount) sliceData.set(travellers.seeds.subarray(0, caravanCount * HERD_SEED_FLOATS), pastureCount * HERD_SEED_FLOATS);
    if (mountCount) {
      const dstBase = (pastureCount + caravanCount) * HERD_SEED_FLOATS;
      sliceData.set(streetMounts.seeds.subarray(0, mountCount * HERD_SEED_FLOATS), dstBase);
      for (let m = 0; m < mountCount; m++) {
        sliceData[dstBase + m * HERD_SEED_FLOATS] += baseRouteVec4s;
      }
    }

    const seeds = mkBuf('livestock seeds', sliceData, B.STORAGE);
    const routes = mkBuf('caravan routes', combinedRoutes, B.STORAGE);
    clockU[0] = count;
    const cfg = mkBuf('livestock config', clock, B.UNIFORM);
    // Every beast's record and joints, which the step writes and the one cut reads.
    const animals = createAnimalScene({ device, atlas, programs: pipelines.programs, view: pipelines.view, count, types: herdTypes, frame: frameUBO, shadowUniform: landShadowUniform, samples, label: 'livestock', profile: 'animals' });
    animals.setCount(count);

    const stepGroup = device.createBindGroup({
      label: 'livestock step',
      layout: pipelines.step.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: frameUBO } },
        { binding: 1, resource: { buffer: landUniform } },
        { binding: 2, resource: { buffer: nearDomain } },
        { binding: 3, resource: elevation.createView() },
        { binding: 4, resource: { buffer: cfg } },
        { binding: 5, resource: { buffer: seeds } },
        { binding: 6, resource: { buffer: animals.records } },
        { binding: 7, resource: { buffer: animals.poses } },
        { binding: 8, resource: { buffer: atlas.rig } },
        { binding: 9, resource: { buffer: routes } },
        { binding: 10, resource: { buffer: shotsBuf } },
        { binding: 11, resource: { buffer: fatesBuf } },
        // The ground the land draws, which a beast is drawn standing on (js/continuum-ground.js).
        { binding: 12, resource: continuumGroundView(device) },
        { binding: 13, resource: { buffer: avoidBuf } },
        { binding: 14, resource: { buffer: worldBodies.buffer } },
      ],
    });

    state = {
      count,
      pastureCount,
      caravanCount,
      mountCount,
      seeds,
      routes,
      cfg,
      animals,
      cpuSeeds: sliceData,
      cpuRoutes: combinedRoutes,
      stepGroup,
      viewGroup: null,
    };
    rebuildGroups();
  }

  function watchShot(from, to, best, projectile = null, land = null) {
    if (!state || !from || !to) return null;
    const maxFrac = best && Number.isFinite(best.fraction) ? Math.max(0, Math.min(1, best.fraction)) : 1;
    const end = [
      from[0] + (to[0] - from[0]) * maxFrac,
      from[1] + (to[1] - from[1]) * maxFrac,
      from[2] + (to[2] - from[2]) * maxFrac,
    ];
    const radius = projectile?.sweepRadius ?? projectile?.radius ?? 0.08;
    const key = projectile ?? Symbol('shot');
    const prev = shotFlights.get(key);
    if (prev) {
      prev.end = end;
    } else if (shotFlights.size < HERD_SHOT_LIMIT) {
      shotFlights.set(key, { start: [from[0], from[1], from[2]], end, radius, time: simClockSec });
    }

    const offset = land?.getWorldOffset?.() ?? { x: 0, z: 0 };
    const elevFn = typeof land?.surfaceHeight === 'function'
      ? (ux, uz) => land.surfaceHeight(ux + offset.x, uz + offset.z)
      : () => 2.0;
    const hit = sweepHerdHit(
      state.cpuSeeds,
      state.cpuRoutes,
      cpuFates,
      {
        time: simClockSec,
        boardDay: clockF[2],
        daysPerSecond: clockF[3],
        shiftX: offset.x,
        shiftZ: offset.z,
      },
      elevFn,
      from,
      end,
      radius,
    );
    if (!hit) return null;
    const fullLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
    const scaled = {
      ...hit,
      fraction: hit.fraction * maxFrac,
      distance: hit.fraction * maxFrac * fullLen,
    };
    if (best && typeof best === 'object' && scaled.fraction < (best.fraction ?? 1)) {
      Object.assign(best, scaled);
    }
    return scaled;
  }

  setHerds(initialHerds);

  const api = {
    get count() { return state?.count ?? 0; },
    get travellers() { return (travellers.seeds.length + streetMounts.seeds.length) / HERD_SEED_FLOATS; },
    get streetMounts() { return streetMounts.count ?? 0; },
    get activeCaravans() { return lastCaravans?.list ?? []; },
    get caravanOrigin() { return lastCaravans?.origin ?? null; },
    get fates() { return cpuFates; },
    setHerds,
    setCaravans,
    setStreetMounts,
    setBridges,
    watchShot,
    setSimClock(seconds) {
      if (Number.isFinite(seconds)) simClockSec = seconds;
    },
    setBoardClock(day, daysPerSecond) {
      clockF[2] = Number.isFinite(day) ? day : 0;
      clockF[3] = Number.isFinite(daysPerSecond) ? Math.max(0, daysPerSecond) : 0;
    },
    rebind(nextResources) {
      activeResources = nextResources;
      rebuildGroups();
    },
    encode(pass, timeSeconds = null) {
      if (Number.isFinite(timeSeconds)) simClockSec = timeSeconds;
      if (!state) return;
      if (travellers.seeds.length || streetMounts.seeds.length) {
        device.queue.writeBuffer(state.cfg, 8, clock, 8, 8);
      }
      const pendingCount = Math.min(HERD_SHOT_LIMIT, shotFlights.size);
      if (pendingCount > 0 || shotsSentLastFrame > 0) {
        shotsU32.fill(0, 0, 4);
        shotsU32[0] = pendingCount;
        let s = 0;
        for (const flight of shotFlights.values()) {
          if (s >= HERD_SHOT_LIMIT) break;
          const o = 4 + s * HERD_SHOT_FLOATS;
          shotsF32[o] = flight.start[0];
          shotsF32[o + 1] = flight.start[1];
          shotsF32[o + 2] = flight.start[2];
          shotsF32[o + 3] = flight.radius;
          shotsF32[o + 4] = flight.end[0];
          shotsF32[o + 5] = flight.end[1];
          shotsF32[o + 6] = flight.end[2];
          shotsF32[o + 7] = flight.time;
          s++;
        }
        shotFlights.clear();
        device.queue.writeBuffer(shotsBuf, 0, shotsU32, 0, 4 + pendingCount * HERD_SHOT_FLOATS);
        shotsSentLastFrame = pendingCount;
      }
      // Every beast placed, then every beast cut: the cut reads the places the step has just written.
      pass.setPipeline(pipelines.step);
      pass.setBindGroup(0, state.stepGroup);
      pass.dispatchWorkgroups(Math.ceil(state.count / 64));
      state.animals.encode(pass);
    },
    // The view's four lists, one pipeline.
    draw(pass) {
      if (!state) return;
      state.animals.draw(pass, state.viewGroup, cloudGroup);
    },
    // The main pass's indirect draws for the continuum census (js/continuum-census.js).
    continuumDraws() { return state ? state.animals.continuumDraws() : []; },
    // The beasts' scene of the one cut: their records, joints and the lists the cut fills.
    get animals() { return state?.animals ?? null; },
    // The beasts' cut for the land's shadow map, by the one cut's shadow program.
    drawShadow(pass) {
      if (!state) return;
      state.animals.drawShadow(pass);
    },
    destroy() {
      ACTIVE_HERDS_BY_DEVICE.delete(device);
      worldBodies.setHerdCount(0);
      releaseState(true);
      shotsBuf.destroy();
      fatesBuf.destroy();
      avoidBuf.destroy();
    },
  };
  if (device && typeof device === 'object') {
    ACTIVE_HERDS_BY_DEVICE.set(device, api);
  }
  return api;
}
