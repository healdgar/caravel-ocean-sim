// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { createGunneryState, prepareGunnery, fireGunnery, stepGunnery, gunnerySummary, resolveGunneryImpact } from './gunnery-state.js';
import { createGunDefinitions, gunMuzzlePose, gunElevationRange } from './gunnery-models.js';
import { GUNNERY_ORDER_SECONDS } from './gunnery-audio.js';
import { boatRotate } from './boat.js';
import { SHIP_MODELS } from './ship-models.js';
import { createShipAssetCache } from './ship-mesh.js';
import { PORT_PREFABS, getBuildingParts } from './coastal-world.js';
import { locatePartAtLocalPoint } from './part-assembly.js';

let gunneryShipAssetCache = null;

function resolveShipHitPart(targetBoat, localPosition, hitZone) {
  if (!targetBoat || !Array.isArray(localPosition)) return null;
  const modelId = targetBoat.model?.id ?? targetBoat.modelId;
  const model = modelId ? SHIP_MODELS[modelId] : null;
  if (!model || model.status !== 'ready') return null;
  try {
    if (!gunneryShipAssetCache) gunneryShipAssetCache = createShipAssetCache();
    const asset = gunneryShipAssetCache.get(modelId);
    if (!asset?.partAssembly) return null;
    const f = model.designFrame;
    const L = targetBoat.length ?? f?.length ?? 20;
    const B = targetBoat.beam ?? f?.beam ?? 6;
    const sx = f?.beam ? B / f.beam : 1;
    const sy = f?.verticalScale ?? 1;
    const sz = f?.length ? L / f.length : 1;
    const designPt = [
      localPosition[0] / (sx || 1),
      localPosition[1] / (sy || 1),
      localPosition[2] / (sz || 1),
    ];
    const subAssemblies =
      hitZone === 'rigging'
        ? ['masts-and-spars', 'rigging-and-sails']
        : ['keel-and-frame', 'decks-and-interior', 'ordnance-and-helm', 'hull-and-bulwarks'];
    return locatePartAtLocalPoint(asset.partAssembly, designPt, { subAssemblies });
  } catch {
    return null;
  }
}

function resolveBuildingHitPart(building, localPosition) {
  if (!building || !building.prefabId || !PORT_PREFABS[building.prefabId] || !Array.isArray(localPosition)) {
    return null;
  }
  try {
    const adapter = getBuildingParts(building.prefabId);
    return adapter.locatePartAtLocalPoint(localPosition);
  } catch {
    return null;
  }
}

export function applyRigidHullImpulse(boat, worldPosition, impulse) {
  const h = boat?.hydrodynamics;
  if (!h || !worldPosition || !impulse) return;
  const centre = [0, 0, 0];
  boatRotate(centre, 0, h.centreOfGravity - (h.draft - h.sinkage), 0, (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0);
  const r = worldPosition.map((x, i) => x - ([boat.x ?? 0, boat.heave ?? 0, boat.z ?? 0][i] + centre[i]));
  const heading = (boat.heading ?? 0) * Math.PI / 180, sn = Math.sin(heading), cs = Math.cos(heading);
  boat.surgeVelocity = (boat.surgeVelocity ?? 0) + (impulse[0] * sn - impulse[2] * cs) / (h.mass + h.addedMass);
  boat.leewayVelocity = (boat.leewayVelocity ?? 0) + (impulse[0] * cs + impulse[2] * sn) / (h.mass * 1.8);
  boat.heaveVelocity = (boat.heaveVelocity ?? 0) + impulse[1] / (h.mass + h.addedMass);
  const torque = [r[1] * impulse[2] - r[2] * impulse[1], r[2] * impulse[0] - r[0] * impulse[2], r[0] * impulse[1] - r[1] * impulse[0]];
  const axis = (x, y, z) => { const a = [0, 0, 0]; boatRotate(a, x, y, z, (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0); return a; };
  const dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0);
  const yawI = h.mass * ((boat.length ?? 20) ** 2 + (boat.beam ?? 6) ** 2) / 12 * 1.5;
  const axes = [axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1)], inertia = [h.pitchInertia, yawI, h.rollInertia];
  const omega = [0, 0, 0];
  for (let j = 0; j < 3; j++) { const d = dot(torque, axes[j]) / inertia[j]; for (let i = 0; i < 3; i++) omega[i] += axes[j][i] * d; }
  // Convert a principal-axis angular impulse back to this integrator's Euler
  // rates. Directly adding body-axis rates is wrong on a pitched/heeled ship.
  const cosPitch = Math.max(0.1, Math.cos(boat.pitch ?? 0));
  const omegaH = [cs * omega[0] + sn * omega[2], omega[1], -sn * omega[0] + cs * omega[2]], dRoll = omegaH[2] / cosPitch;
  boat.pitchVelocity = (boat.pitchVelocity ?? 0) + omegaH[0];
  boat.rollVelocity = (boat.rollVelocity ?? 0) + dRoll;
  boat.yawRate = (boat.yawRate ?? 0) - omegaH[1] - Math.sin(boat.pitch ?? 0) * dRoll;
}

export function createVesselDamageState(boat) {
  if (boat.damage) {
    if (!boat.damage.partDamage) boat.damage.partDamage = {};
    return boat.damage;
  }
  const mass = boat.hydrodynamics?.mass ?? 120000;
  boat.damage = {
    maxHullEnergy: Math.max(400000, mass * 18),
    maxRigEnergy: Math.max(150000, mass * 6),
    hullIntegrity: 1,
    rigIntegrity: 1,
    mastIntegrity: { fore: 1, main: 1, mizzen: 1 },
    hullDamageJoules: 0,
    rigDamageJoules: 0,
    hits: 0,
    hullHits: 0,
    rigHits: 0,
    breaches: 0,
    floodingTonnes: 0,
    sunk: false,
    partDamage: {},
    lastHit: null,
  };
  return boat.damage;
}

function vesselWorldToLocal(boat, worldPt) {
  const dx = worldPt[0] - (boat.x ?? 0), dy = worldPt[1] - (boat.heave ?? 0), dz = worldPt[2] - (boat.z ?? 0);
  const yaw = (boat.heading ?? 0) * Math.PI / 180, pitch = boat.pitch ?? 0, roll = boat.roll ?? 0;
  const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
  boatRotate(ax, 1, 0, 0, yaw, pitch, roll);
  boatRotate(ay, 0, 1, 0, yaw, pitch, roll);
  boatRotate(az, 0, 0, 1, yaw, pitch, roll);
  return [
    dx * ax[0] + dy * ax[1] + dz * ax[2],
    dx * ay[0] + dy * ay[1] + dz * ay[2],
    dx * az[0] + dy * az[1] + dz * az[2],
  ];
}

function vesselLocalToWorldNormal(boat, localNormal) {
  const out = [0, 0, 0];
  boatRotate(out, localNormal[0], localNormal[1], localNormal[2], (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0);
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len];
}

export function sweepShipSegment(from, to, radius = 0.08, targetBoat, sourceBoat = null) {
  if (!targetBoat || targetBoat === sourceBoat || targetBoat.showProw === false) return null;
  const L = targetBoat.length ?? 20, B = targetBoat.beam ?? 6;
  const boundR = Math.max(L, B) * 1.1 + 12;
  const midX = (from[0] + to[0]) * 0.5 - (targetBoat.x ?? 0);
  const midZ = (from[2] + to[2]) * 0.5 - (targetBoat.z ?? 0);
  const segLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (Math.hypot(midX, midZ) > boundR + segLen) return null;

  const p0 = vesselWorldToLocal(targetBoat, from);
  const p1 = vesselWorldToLocal(targetBoat, to);
  const halfL = L * 0.52 + radius;
  const halfB = B * 0.52 + radius;
  const draft = (targetBoat.hydrodynamics?.draft ?? 2.2) + radius;
  const baseFreeboard = Math.max(4.6, (targetBoat.hydrodynamics?.freeboard ?? 1.8) * 2.1 + B * 0.35) + radius;
  const mastTop = Math.max(14, L * 0.85) + radius;

  const classifyLocal = (lx, ly, lz) => {
    const castleLift = lz > L * 0.1 ? B * 0.28 : lz < -L * 0.22 ? B * 0.16 : 0;
    const freeboard = baseFreeboard + castleLift;
    if (Math.abs(lz) <= halfL && ly >= -draft && ly <= freeboard) {
      const taper = Math.max(0.32, 1 - 0.55 * (lz / halfL) ** 2);
      const maxX = halfB * taper;
      if (Math.abs(lx) <= maxX) {
        const nx = lx / Math.max(0.2, maxX), ny = (ly - (freeboard - draft) * 0.5) / Math.max(0.5, (freeboard + draft) * 0.5), nz = lz / halfL;
        return { hitZone: 'hull', mastGroup: null, localNormal: [nx, ny * 0.35, nz * 0.4] };
      }
    }
    if (ly > baseFreeboard - radius && ly <= mastTop && (targetBoat.model?.rig?.sails?.length ?? 1) > 0) {
      const mastW = B * 0.85 + radius, mastD = L * 0.14 + radius;
      for (const [group, zCenter] of [['fore', -L * 0.26], ['main', 0], ['mizzen', L * 0.26]]) {
        if (Math.abs(lx) <= mastW && Math.abs(lz - zCenter) <= mastD) {
          return { hitZone: 'rigging', mastGroup: group, localNormal: [lx >= 0 ? 1 : -1, 0.15, (lz - zCenter) / mastD] };
        }
      }
    }
    return null;
  };

  const steps = Math.min(48, Math.max(4, Math.ceil(segLen / 0.45)));
  let prevT = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lx = p0[0] + (p1[0] - p0[0]) * t;
    const ly = p0[1] + (p1[1] - p0[1]) * t;
    const lz = p0[2] + (p1[2] - p0[2]) * t;
    const hit = classifyLocal(lx, ly, lz);
    if (hit) {
      let low = prevT, high = t, bestHit = hit, bestLocal = [lx, ly, lz];
      if (i > 0) {
        for (let b = 0; b < 10; b++) {
          const mid = (low + high) * 0.5;
          const mx = p0[0] + (p1[0] - p0[0]) * mid;
          const my = p0[1] + (p1[1] - p0[1]) * mid;
          const mz = p0[2] + (p1[2] - p0[2]) * mid;
          const mHit = classifyLocal(mx, my, mz);
          if (mHit) { high = mid; bestHit = mHit; bestLocal = [mx, my, mz]; } else { low = mid; }
        }
      }
      const hitPart = resolveShipHitPart(targetBoat, bestLocal, bestHit.hitZone);
      return {
        fraction: high,
        kind: 'ship',
        targetBoat,
        targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
        targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
        hitZone: bestHit.hitZone,
        mastGroup: bestHit.mastGroup,
        hitPartId: hitPart?.id ?? null,
        hitSubAssembly: hitPart?.subAssembly ?? null,
        hitLayer: hitPart?.layer ?? null,
        waterline: bestHit.hitZone === 'hull' && bestLocal[1] <= 0.75,
        localPosition: bestLocal,
        normal: vesselLocalToWorldNormal(targetBoat, bestHit.localNormal),
      };
    }
    prevT = t;
  }
  return null;
}

export function applyShipImpactDamage(targetBoat, event) {
  if (!targetBoat || !event) return null;
  const damage = createVesselDamageState(targetBoat);
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? [targetBoat.x ?? 0, targetBoat.heave ?? 0, targetBoat.z ?? 0];
  const scale = event.hitZone === 'rigging' ? 0.35 : 1.0;
  applyRigidHullImpulse(targetBoat, pos, [vel[0] * mass * scale, vel[1] * mass * scale, vel[2] * mass * scale]);

  const localPos = event.localPosition ?? vesselWorldToLocal(targetBoat, pos);
  const resolvedPart = event.hitPartId
    ? { id: event.hitPartId, subAssembly: event.hitSubAssembly ?? null, layer: event.hitLayer ?? null }
    : resolveShipHitPart(targetBoat, localPos, event.hitZone);
  const hitPartId = resolvedPart?.id ?? (event.hitZone === 'rigging' ? `sail.${event.mastGroup ?? 'main'}` : 'hull.shell');
  const hitSubAssembly =
    resolvedPart?.subAssembly ?? (event.hitZone === 'rigging' ? 'rigging-and-sails' : 'hull-and-bulwarks');

  damage.hits++;
  if (event.hitZone === 'rigging') {
    damage.rigHits++;
    damage.rigDamageJoules += energy;
    const group = event.mastGroup && Object.hasOwn(damage.mastIntegrity, event.mastGroup) ? event.mastGroup : 'main';
    damage.mastIntegrity[group] = Math.max(0, damage.mastIntegrity[group] - (energy / damage.maxRigEnergy) * 1.8);
    damage.rigIntegrity = (damage.mastIntegrity.fore + damage.mastIntegrity.main + damage.mastIntegrity.mizzen) / 3;
    const sailKey = group === 'fore' ? 'sailFore' : group === 'mizzen' ? 'sailMizzen' : 'sailMain';
    if (typeof targetBoat[sailKey] === 'number') {
      targetBoat[sailKey] = Math.min(targetBoat[sailKey], damage.mastIntegrity[group]);
    }
  } else {
    damage.hullHits++;
    damage.hullDamageJoules += energy;
    damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
    const nearWaterline = event.waterline || pos[1] <= (targetBoat.heave ?? 0) + 0.85;
    if (nearWaterline) {
      damage.breaches++;
      const floodAdd = (mass / 12) * (1.2 + (1 - damage.hullIntegrity) * 2.4);
      damage.floodingTonnes = +(damage.floodingTonnes + floodAdd).toFixed(3);
      targetBoat.cargoTonnes = Math.min(80, (targetBoat.cargoTonnes ?? 0) + floodAdd);
      targetBoat.revision = (targetBoat.revision ?? 0) + 1;
    }
    if (damage.hullIntegrity <= 0) damage.sunk = true;
  }

  const partBudget = (event.hitZone === 'rigging' ? damage.maxRigEnergy : damage.maxHullEnergy) * 0.25;
  const prevPartDamage = damage.partDamage[hitPartId] ?? 0;
  const nextPartDamage = Math.min(1, +(prevPartDamage + energy / Math.max(10000, partBudget)).toFixed(3));
  damage.partDamage[hitPartId] = nextPartDamage;

  const report = {
    kind: 'ship',
    targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
    targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
    hitZone: event.hitZone ?? 'hull',
    mastGroup: event.mastGroup ?? null,
    hitPartId,
    hitSubAssembly,
    partDamage: nextPartDamage,
    hullIntegrity: +damage.hullIntegrity.toFixed(3),
    rigIntegrity: +damage.rigIntegrity.toFixed(3),
    breaches: damage.breaches,
    floodingTonnes: damage.floodingTonnes,
    sunk: damage.sunk,
    energyKj: +(energy / 1000).toFixed(1),
  };
  damage.lastHit = report;
  return report;
}

export function sweepBuildingSegment(from, to, radius = 0.08, port) {
  const instances = port?.instances;
  if (!Array.isArray(instances) || !instances.length) return null;
  let best = null;
  for (const inst of instances) {
    const cs = Math.cos(-(inst.yaw ?? 0)), sn = Math.sin(-(inst.yaw ?? 0));
    const baseY = inst.baseY ?? inst.y ?? 0;
    const depthZ = inst.depth ?? inst.length ?? 20;
    const roofExtra = inst.roofHeight ?? inst.roofPitch ?? 0;
    const toLocal = (p) => {
      const dx = p[0] - inst.x, dy = p[1] - baseY, dz = p[2] - inst.z;
      return [dx * cs - dz * sn, dy, dx * sn + dz * cs];
    };
    const p0 = toLocal(from), p1 = toLocal(to);
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const minB = [-inst.width * 0.5 - radius, -radius, -depthZ * 0.5 - radius];
    const maxB = [inst.width * 0.5 + radius, inst.height + roofExtra + radius, depthZ * 0.5 + radius];
    let tMin = 0, tMax = 1, hitAxis = 0, hitSign = 1;
    let valid = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (p0[a] < minB[a] || p0[a] > maxB[a]) { valid = false; break; }
      } else {
        let t1 = (minB[a] - p0[a]) / d[a], t2 = (maxB[a] - p0[a]) / d[a], s = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
        if (t1 > tMin) { tMin = t1; hitAxis = a; hitSign = s; }
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) { valid = false; break; }
      }
    }
    if (!valid || tMin < 0 || tMin > 1) continue;
    if (!best || tMin < best.fraction) {
      const ln = [0, 0, 0]; ln[hitAxis] = hitSign;
      const wcs = Math.cos(inst.yaw ?? 0), wsn = Math.sin(inst.yaw ?? 0);
      const normal = [ln[0] * wcs - ln[2] * wsn, ln[1], ln[0] * wsn + ln[2] * wcs];
      const localPosition = [p0[0] + d[0] * tMin, p0[1] + d[1] * tMin, p0[2] + d[2] * tMin];
      const hitPart = resolveBuildingHitPart(inst, localPosition);
      best = {
        fraction: tMin,
        kind: 'building',
        building: inst,
        buildingId: inst.id,
        buildingName: inst.label ?? inst.prefabId,
        prefabId: inst.prefabId,
        hitPartId: hitPart?.id ?? null,
        hitSubAssembly: hitPart?.subAssembly ?? null,
        hitLayer: hitPart?.layer ?? null,
        localPosition,
        normal,
      };
    }
  }
  return best;
}

export function applyBuildingImpactDamage(building, event) {
  if (!building || !event) return null;
  if (!building.damageState) {
    const isBastion = building.prefabId === 'stone_sea_bastion' || building.prefabId === 'bastion_trace_fortress';
    const isTimber = building.prefabId === 'timber_mole_pier' || building.prefabId === 'careening_shed';
    building.damageState = {
      maxEnergy: isBastion ? 25000000 : isTimber ? 2500000 : 8500000,
      integrity: 1,
      damageJoules: 0,
      hits: 0,
      state: 'intact',
      partDamage: {},
    };
  }
  if (!building.damageState.partDamage) building.damageState.partDamage = {};
  const d = building.damageState;
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  d.hits++;
  d.damageJoules += energy;
  d.integrity = Math.max(0, 1 - d.damageJoules / d.maxEnergy);
  d.state = d.integrity > 0.75 ? 'intact' : d.integrity > 0.4 ? 'damaged' : d.integrity > 0.1 ? 'breached' : 'ruined';

  const resolvedPart = event.hitPartId
    ? { id: event.hitPartId, subAssembly: event.hitSubAssembly ?? null, layer: event.hitLayer ?? null }
    : resolveBuildingHitPart(building, event.localPosition);
  const hitPartId = resolvedPart?.id ?? `${building.prefabId ?? 'building'}:walls`;
  const hitSubAssembly = resolvedPart?.subAssembly ?? 'walls-and-bastions';
  const partBudget = d.maxEnergy * 0.18;
  const prevPartDamage = d.partDamage[hitPartId] ?? 0;
  const nextPartDamage = Math.min(1, +(prevPartDamage + energy / Math.max(25000, partBudget)).toFixed(3));
  d.partDamage[hitPartId] = nextPartDamage;

  return {
    kind: 'building',
    buildingId: building.id,
    buildingName: building.label ?? building.prefabId,
    prefabId: building.prefabId,
    hitPartId,
    hitSubAssembly,
    partDamage: nextPartDamage,
    integrity: +d.integrity.toFixed(3),
    state: d.state,
    hits: d.hits,
    energyKj: +(energy / 1000).toFixed(1),
  };
}

export function sweepTerrainSegment(from, to, radius = 0.08, terrain) {
  const sampleFn = terrain?.groundSample ?? terrain?.height;
  if (typeof sampleFn !== 'function') return null;
  const segLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const steps = Math.min(64, Math.max(1, Math.ceil(segLen / 0.75)));
  const sampleH = (x, z) => sampleFn(x, z);
  let prevT = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    const z = from[2] + (to[2] - from[2]) * t;
    const h = sampleH(x, z);
    if (h > 0.05 && y - radius <= h) {
      let low = prevT, high = t;
      if (i > 0) {
        for (let b = 0; b < 12; b++) {
          const mid = (low + high) * 0.5;
          const mx = from[0] + (to[0] - from[0]) * mid;
          const my = from[1] + (to[1] - from[1]) * mid;
          const mz = from[2] + (to[2] - from[2]) * mid;
          const mh = sampleH(mx, mz);
          if (mh > 0.05 && my - radius <= mh) high = mid; else low = mid;
        }
      }
      const hx = from[0] + (to[0] - from[0]) * high;
      const hz = from[2] + (to[2] - from[2]) * high;
      const elevation = sampleH(hx, hz);
      const dx = (sampleH(hx - 1, hz) - sampleH(hx + 1, hz)) * 0.5;
      const dz = (sampleH(hx, hz - 1) - sampleH(hx, hz + 1)) * 0.5;
      const nLen = Math.hypot(dx, 1, dz) || 1;
      return {
        fraction: high,
        kind: 'terrain',
        elevation,
        normal: [dx / nLen, 1 / nLen, dz / nLen],
      };
    }
    prevT = t;
  }
  return null;
}

export function applyTerrainImpactDamage(terrain, event) {
  if (!terrain || !event) return null;
  terrain.landImpacts ??= [];
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? [0, 0, 0];
  const craterRadius = +(0.35 * Math.cbrt(mass / 5.4) * Math.max(0.7, Math.cbrt(energy / 120000))).toFixed(2);
  const record = {
    position: [...pos],
    normal: event.normal ?? [0, 1, 0],
    energyKj: +(energy / 1000).toFixed(1),
    craterRadius,
    elevation: +(event.elevation ?? pos[1] ?? 0).toFixed(1),
    time: event.time ?? 0,
  };
  if (terrain.landImpacts.length >= 64) terrain.landImpacts.shift();
  terrain.landImpacts.push(record);
  return {
    kind: 'terrain',
    craterCount: terrain.landImpacts.length,
    craterRadius,
    elevation: record.elevation,
    energyKj: record.energyKj,
  };
}

export function createGunnerySolidSweep({ sourceBoat, getVessels = () => [], getTerrain = () => null } = {}) {
  return function sweep(from, to, projectile) {
    const radius = projectile?.radius ?? 0.08;
    let best = null;
    const vessels = getVessels() ?? [];
    for (const entry of vessels) {
      const targetBoat = entry?.boat ?? entry;
      const hit = sweepShipSegment(from, to, radius, targetBoat, sourceBoat);
      if (hit && (!best || hit.fraction < best.fraction)) best = hit;
    }
    const terrain = getTerrain();
    if (terrain?.port) {
      const bHit = sweepBuildingSegment(from, to, radius, terrain.port);
      if (bHit && (!best || bHit.fraction < best.fraction)) best = bHit;
    }
    if (terrain) {
      const tHit = sweepTerrainSegment(from, to, radius, terrain);
      if (tHit && (!best || tHit.fraction < best.fraction)) best = tHit;
    }
    return best;
  };
}

export function resolveSolidGunneryImpact(event, { getTerrain = () => null } = {}) {
  if (!event || event.type !== 'impact') return null;
  if (event.kind === 'ship' && event.targetBoat) {
    return applyShipImpactDamage(event.targetBoat, event);
  }
  if (event.kind === 'building' && event.building) {
    return applyBuildingImpactDamage(event.building, event);
  }
  if (event.kind === 'terrain') {
    const terrain = getTerrain();
    if (terrain) return applyTerrainImpactDamage(terrain, event);
  }
  return null;
}

// Explicit orders govern the drill. There is no automatic reload or repeated
// firing. The captain's spoken order has the same duration with sound muted.
export function createShipGunnery(boat,{onEvent=()=>{},onOrder=()=>{},muzzleBlock=()=>null,getVessels=()=>[],getTerrain=()=>null,sweep=null}={}){
  const state=createGunneryState(createGunDefinitions(boat));boat.gunnery=state;
  createVesselDamageState(boat);
  const previousStages=new Array(state.guns.length);
  const solidSweep=sweep??createGunnerySolidSweep({sourceBoat:boat,getVessels,getTerrain});
  const damageLog=[];
  let pending=null,prepared=false,lastReady=false,flash=null,lastDamageReport=null;
  const attended=gun=>!gun.visibleCrew||boat.gunneryAttendance?.has(gun.id)===true;
  const sideValid=side=>side==='port'||side==='starboard';
  const canFire=side=>sideValid(side)&&boat.gunnerySide===side&&!pending&&!state.queue.length&&
    state.guns.filter(g=>g.side===side).every(g=>g.stage==='ready'&&attended(g)&&!muzzleBlock(g,gunMuzzlePose(g,boat)));
  function recoil(event){
    applyRigidHullImpulse(boat,event.position,event.impulse);
  }
  return {
    state,
    damageLog,
    get lastDamageReport(){return lastDamageReport;},
    prepare(side){
      if(!sideValid(side))return false;
      if(pending||state.queue.length||state.guns.some(g=>g.loading&&g.side!==side))return false;
      const changed=boat.gunnerySide!==side;
      boat.gunnerySide=side;prepared=true;lastReady=false;
      const count=prepareGunnery(state,side);if(count||changed)onOrder('prepare',boat);
      return count>0||changed;
    },
    fire(side){
      if(!canFire(side))return false;
      const order='fire-'+side;pending={side,at:state.time+GUNNERY_ORDER_SECONDS[order]};onOrder(order,boat);return true;
    },
    cease(){
      pending=null;state.queue.length=0;for(const g of state.guns)g.queued=false;
      onOrder('cease',boat);
    },
    standDown(){
      pending=null;state.queue.length=0;boat.gunnerySide=null;lastReady=false;
      for(const g of state.guns){g.queued=false;g.loading=false;}
    },
    update(dt,wind){
      if(pending&&state.time+1e-8>=pending.at){fireGunnery(state,pending.side);pending=null;}
      for(const gun of state.guns)previousStages[gun.index]=gun.stage;
      const events=stepGunnery(state,dt,{deferSeaCollision:true,
        windVelocity:wind,muzzle:gun=>gunMuzzlePose(gun,boat),
        sweep:solidSweep,
        gunAttended:attended,canFire:(gun,pose)=>attended(gun)&&!muzzleBlock(gun,pose),
        onEvent:event=>{
          if(event.type==='shot'){recoil(event);flash={gunId:event.gunId,side:event.gun.sideSign,time:event.time,mass:event.mass};}
          if(event.type==='impact'&&event.kind!=='water'){
            const report=resolveSolidGunneryImpact(event,{getTerrain});
            if(report){event.damageReport=report;lastDamageReport=report;if(damageLog.length>=32)damageLog.shift();damageLog.push(report);}
          }
          if(event.type!=='ready')onEvent(event);
        },
      });
      for(const gun of state.guns)if(previousStages[gun.index]!==gun.stage&&(gun.stage==='ram'||gun.stage==='runout')){
        onEvent({type:gun.stage==='ram'?'load':'run-out',gun,position:gunMuzzlePose(gun,boat).position});
      }
      const s=gunnerySummary(state,boat.gunnerySide),ready=prepared&&s.total>0&&s.ready===s.total&&
        state.guns.filter(g=>g.side===boat.gunnerySide).every(attended);
      if(ready&&!lastReady)onEvent({type:'ready',position:[boat.x,boat.heave+3,boat.z]});
      lastReady=ready;return events;
    },
    impact(contact){return resolveGunneryImpact(state,contact.shotId??contact.id,contact);},
    summary(side){return gunnerySummary(state,side);},
    canFire,
    blockedReason(side){
      if(side!==boat.gunnerySide)return null;
      for(const gun of state.guns.filter(g=>g.side===side)){
        if(!attended(gun))return 'Manning guns';
        const reason=muzzleBlock(gun,gunMuzzlePose(gun,boat));if(reason)return reason;
      }return null;
    },
    get selectedSide(){return boat.gunnerySide??null;},
    get ordered(){return pending?.side??null;},
    get elevation(){return boat.gunneryElevation??0;},
    get elevationRange(){return gunElevationRange(state.guns[0]);},
    setElevation(degrees){
      const range=gunElevationRange(state.guns[0]);
      const next=Number.isFinite(Number(degrees))?Math.max(range.min,Math.min(range.max,Number(degrees))):0;
      boat.gunneryElevation=next;for(const g of state.guns)g.elevation=next;return next;
    },
    // Reuse the two previously reserved Hull axis padding floats. GPU lighting
    // resolves the actual attachment, with no additional binding or larger UBO.
    get flash(){const age=flash?state.time-flash.time:1;return age>=0&&age<.085?{gunId:flash.gunId,energy:flash.side*Math.min(1,Math.cbrt(flash.mass/12))*Math.sin(Math.PI*age/.085)}:null;},
  };
}
