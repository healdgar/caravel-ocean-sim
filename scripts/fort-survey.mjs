// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A report on every fort in every port and year: what it guards, how far from the mouth and the anchorage, how much of
// its fire really reaches the water it is there for, and whether it runs into its neighbours. Uses the game's own
// gun definitions and its own test for a fouled line, on real coasts when given them and on the made-up ones otherwise.
//   node scripts/fort-survey.mjs --coasts tests/data/harbours --years 1550,1600,1650,1689 --json report.json
//   node scripts/fort-survey.mjs --procedural --ports havana,boston
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HISTORICAL_COLONIAL_PORTS, buildPortPrefabGeometry, placeCoastalPort, resolveGlobalCoastalRegion, smoothCoastlineAndForeshoreBeaches, synthesizeCoastalTerrain } from '../js/coastal-world.js';
import { terrainSurfaceSample } from '../js/terrain-model.js';
import { HARBOUR_GUN_RANGE_M, readHarbourGeography } from '../js/harbour-geography.js';
import { enclosurePlan } from '../js/fort-plan.js';
import { fortRecordsFor } from '../js/fort-records.js';
import { noteBuildingMeshes } from '../js/building-fracture.js';
import * as gunnery from '../js/gunnery-control.js';

const argument = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const FORTS = new Set(['bastion_trace_fortress', 'stone_sea_bastion', 'english_triangular_palisade_fort']);
const ENCLOSING = new Set(['english_triangular_palisade_fort', 'indigenous_palisade_ring']);

export function readCoastFile(file) {
  const all = zlib.gunzipSync(fs.readFileSync(file)), length = all.readUInt32LE(0), header = JSON.parse(all.subarray(4, 4 + length).toString());
  const words = new Int16Array(all.buffer.slice(all.byteOffset + 4 + length, all.byteOffset + all.length));
  const heights = new Float32Array(words.length);
  for (let i = 0; i < words.length; i++) heights[i] = words[i] / 10;
  return { header, heights };
}

const bearingOf = (dx, dz) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Which guns a battery would lay on this mark, as the game decides it.
function gunsOnMark(fort, guns, x, z) {
  if (gunnery.buildingGunBears) return guns.filter((gun) => gunnery.buildingGunBears(gun, fort, x, z));
  const cos = Math.cos(fort.yaw), sin = Math.sin(fort.yaw), dx = x - fort.x, dz = z - fort.z, side = dx * sin + dz * cos <= 0 ? 'port' : 'starboard';
  return guns.filter((gun) => gun.side === side);
}

function gunReaches(gun, fort, x, z, port, heights, region) {
  const cos = Math.cos(fort.yaw), sin = Math.sin(fort.yaw), dx = x - fort.x, dz = z - fort.z, length = Math.hypot(dx, dz) || 1;
  gun.aimDirectionLocal = [(dx * cos - dz * sin) / length, 0, (dx * sin + dz * cos) / length];
  const pose = gunnery.buildingGunMuzzlePose({ ...gun, elevation: 0, offset: 0 }, fort), from = pose.position, to = [x, 1.1, z];
  const range = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
  // Guns do not depress further than this.
  if ((from[1] - to[1]) / Math.hypot(to[0] - from[0], to[2] - from[2]) > Math.tan((8 * Math.PI) / 180)) return false;
  // The ball leaves over its own parapet, as lineFouled has it.
  const share = Math.min(1, 6 / range), clear = [0, 1, 2].map((c) => from[c] + (to[c] - from[c]) * share);
  if (gunnery.sweepBuildingSegment(clear, to, 0.08, port, { previewOnly: true, exact: true })) return false;
  const steps = Math.ceil(range / 10);
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (t < share) continue;
    if (terrainSurfaceSample(heights, from[0] + (to[0] - from[0]) * t, from[2] + (to[2] - from[2]) * t, region) > from[1] + (to[1] - from[1]) * t) return false;
  }
  return true;
}

// How far anything the geometry builder draws for a fort stands inside another building's footprint, and the reverse.
function worstOverlap(fort, port, drawn) {
  let worst = { metres: 0, with: null };
  const stride = drawn.vertices.length / (Math.max(...drawn.indices) + 1);
  for (const other of port.instances) {
    if (other === fort || ENCLOSING.has(other.prefabId) || other.homeFortId) continue;
    const cos = Math.cos(other.yaw), sin = Math.sin(other.yaw), hw = other.width / 2, hl = other.length / 2, reach = Math.hypot(hw, hl);
    if (Math.hypot(other.x - fort.x, other.z - fort.z) > reach + Math.hypot(fort.width, fort.length) / 2 + 30) continue;
    for (let v = 0; v < drawn.vertices.length; v += stride) {
      const dx = drawn.vertices[v] - other.x, dz = drawn.vertices[v + 2] - other.z;
      const inside = Math.min(hw - Math.abs(dx * cos - dz * sin), hl - Math.abs(dx * sin + dz * cos));
      if (inside > worst.metres) worst = { metres: inside, with: other.prefabId };
    }
  }
  return worst;
}

function piersOverlapping(port) {
  const piers = port.instances.filter((i) => i.prefabId === 'timber_mole_pier');
  const corners = (i) => {
    const c = Math.cos(i.yaw), s = Math.sin(i.yaw), hw = i.width / 2, hl = i.length / 2;
    return [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]].map(([lx, lz]) => [i.x + lx * c + lz * s, i.z - lx * s + lz * c]);
  };
  const apart = (a, b) => {
    for (const shape of [a, b]) for (let i = 0; i < 4; i++) {
      const [px, pz] = shape[i], [qx, qz] = shape[(i + 1) % 4], nx = pz - qz, nz = qx - px;
      const span = (list) => list.reduce(([low, high], [x, z]) => [Math.min(low, x * nx + z * nz), Math.max(high, x * nx + z * nz)], [Infinity, -Infinity]);
      const [al, ah] = span(a), [bl, bh] = span(b);
      if (al >= bh || bl >= ah) return true;
    }
    return false;
  };
  let count = 0;
  for (let i = 0; i < piers.length; i++) for (let j = i + 1; j < piers.length; j++) if (!apart(corners(piers[i]), corners(piers[j]))) count++;
  return count;
}

export function surveyPort(region, source, { preserveRealCoast = false, coastIsReal = false } = {}) {
  const heights = new Float32Array(source);
  smoothCoastlineAndForeshoreBeaches(heights, region, {});
  const pristine = new Float32Array(heights);
  const port = placeCoastalPort(region, heights, { preserveRealCoast, coastIsReal });
  // What the port itself read, if it read anything. Older layouts did not, so this reads the same coast the same way.
  const told = fortRecordsFor(region.colonyGrowth?.portId ?? region.id, 1800);
  const position = told.anchorage && coastIsReal ? { x: region.x + (told.anchorage[1] - region.longitude) * 111195 * Math.cos((region.latitude * Math.PI) / 180), z: region.z - (told.anchorage[0] - region.latitude) * 111195 } : null;
  const harbour = port.harbour ?? readHarbourGeography(pristine, region, { town: port.center, seaward: told.seaward, anchorageAt: position, seawardHint: ((region.shoreBearing ?? 112) + 180) % 360 });
  const approachPoints = (harbour.approach ?? []).map((p) => (Array.isArray(p) ? { x: p[0], z: p[1] } : p));
  const geometry = buildPortPrefabGeometry(port);
  noteBuildingMeshes(port, geometry);
  const forts = port.instances.filter((i) => FORTS.has(i.prefabId));
  const marks = harbour.targets;
  const total = marks.reduce((sum, m) => sum + m.weight, 0);
  const held = new Set();
  const rows = forts.map((fort) => {
    const guns = gunnery.createBuildingGunDefinitions(fort);
    let reached = 0, inRange = 0, weightedFire = 0;
    marks.forEach((mark, index) => {
      if (Math.hypot(mark.x - fort.x, mark.z - fort.z) > HARBOUR_GUN_RANGE_M) return;
      inRange += mark.weight;
      const firing = gunsOnMark(fort, guns, mark.x, mark.z).filter((gun) => gunReaches(gun, fort, mark.x, mark.z, port, heights, region)).length;
      weightedFire += mark.weight * firing / (guns.length || 1);
      if (firing) { reached += mark.weight; held.add(index); }
    });
    const drawn = buildPortPrefabGeometry({ instances: [fort] });
    const overlap = worstOverlap(fort, port, drawn);
    const anchorage = harbour.anchorage ? Math.hypot(harbour.anchorage.x - fort.x, harbour.anchorage.z - fort.z) : null;
    const mouth = harbour.mouth ? Math.hypot(harbour.mouth.x - fort.x, harbour.mouth.z - fort.z) : null;
    const route = approachPoints.length ? Math.min(...approachPoints.map((p) => Math.hypot(p.x - fort.x, p.z - fort.z))) : null;
    // Which way its guns and its gate look, against the water and the land.
    const seaFace = fort.guards?.faceBearing ?? bearingOf(-Math.sin(fort.yaw), -Math.cos(fort.yaw));
    let waterBearing = null;
    if (marks.length) {
      let sumX = 0, sumZ = 0;
      for (const m of marks) {
        const d = Math.hypot(m.x - fort.x, m.z - fort.z) || 1;
        if (d > HARBOUR_GUN_RANGE_M * 1.5) continue;
        sumX += ((m.x - fort.x) / d) * m.weight / d;
        sumZ += ((m.z - fort.z) / d) * m.weight / d;
      }
      if (sumX || sumZ) waterBearing = bearingOf(sumX, sumZ);
    }
    const trace = fort.trace ?? null, gateOf = trace?.gate ?? enclosurePlan(fort)?.gate ?? null;
    const gateOut = gateOf ? [gateOf.nx, gateOf.nz] : [0, -1];
    const gateC = Math.cos(fort.yaw), gateS = Math.sin(fort.yaw);
    const gateBearing = bearingOf(gateOut[0] * gateC + gateOut[1] * gateS, -gateOut[0] * gateS + gateOut[1] * gateC);
    // How far its guns have water before them at all, near or on the way in: the share of guns with a mark within 600 m.
    let openGuns = 0;
    for (const gun of guns) {
      const cos = gateC, sin = gateS, lx = gun.localPosition[0] + gun.directionDesign[0] * 350, lz = gun.localPosition[2] + gun.directionDesign[2] * 350;
      const wx = fort.x + lx * cos + lz * sin, wz = fort.z - lx * sin + lz * cos;
      if (terrainSurfaceSample(heights, wx, wz, region) < 0 && gunReaches(gun, fort, wx, wz, port, heights, region)) openGuns++;
    }
    const townBearing = bearingOf(port.center.x - fort.x, port.center.z - fort.z);
    return {
      prefab: fort.prefabId, label: fort.label, x: Math.round(fort.x), z: Math.round(fort.z), yaw: +fort.yaw.toFixed(3), width: +fort.width.toFixed(1), length: +fort.length.toFixed(1),
      guards: fort.guards?.what ?? null, role: fort.guards?.role ?? null, source: fort.guards?.source ?? null, shape: trace?.shape ?? null, guns: guns.length,
      toMouth: mouth === null ? null : Math.round(mouth), toAnchorage: anchorage === null ? null : Math.round(anchorage), toRoute: route === null ? null : Math.round(route),
      reaches: inRange ? +(reached / total).toFixed(3) : 0,
      fire: inRange ? +(weightedFire / inRange).toFixed(3) : 0,
      faceOff: waterBearing === null ? null : Math.round(angleBetween(seaFace, waterBearing)),
      overWater: guns.length ? +(openGuns / guns.length).toFixed(3) : 0,
      gateOff: waterBearing === null ? null : Math.round(Math.min(180 - angleBetween(gateBearing, waterBearing), angleBetween(gateBearing, townBearing))),
      overlap: +overlap.metres.toFixed(2), overlapWith: overlap.with,
    };
  });
  return {
    kind: harbour.kind, mouthWidth: harbour.mouth ? Math.round(harbour.mouth.width) : null, anchorage: harbour.anchorage,
    held: total ? +([...held].reduce((sum, i) => sum + marks[i].weight, 0) / total).toFixed(3) : 0,
    pierOverlaps: piersOverlapping(port), forts: rows,
  };
}

const median = (list) => {
  const sorted = list.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : null;
};

async function main() {
  const coasts = argument('coasts'), years = (argument('years', '1550,1600,1650,1689')).split(',').map(Number);
  const only = argument('ports')?.split(',') ?? null, grid = { size: 257, biomeSize: 256, albedoSize: 512, vegetationCandidates: 400 };
  const reports = [];
  for (const port of HISTORICAL_COLONIAL_PORTS) {
    if (only && !only.includes(port.id)) continue;
    let fixture = null;
    if (coasts) {
      const file = path.join(coasts, `${port.id}.bin.gz`);
      if (fs.existsSync(file)) fixture = readCoastFile(file);
      else if (!process.argv.includes('--procedural')) continue;
    }
    for (const year of years) {
      if (year < port.foundedYear) continue;
      const region = resolveGlobalCoastalRegion({ id: port.id, year, ...grid, ...(fixture ? { latitude: fixture.header.latitude, longitude: fixture.header.longitude, shoreBearing: fixture.header.shoreBearing } : {}) });
      if (region.hasColonialPort === false) continue;
      const source = fixture ? fixture.heights : synthesizeCoastalTerrain(region);
      const report = surveyPort(region, source, { preserveRealCoast: Boolean(fixture), coastIsReal: Boolean(fixture) });
      reports.push({ id: port.id, year, coast: fixture ? 'real' : 'made-up', ...report });
    }
  }
  const forts = reports.flatMap((r) => r.forts.map((f) => ({ ...f, id: r.id, year: r.year, kind: r.kind })));
  if (process.argv.includes('--table')) {
    for (const r of reports) {
      console.log(`${r.id} ${r.year} [${r.kind}${r.mouthWidth ? ` ${r.mouthWidth} m` : ''}] held ${(r.held * 100).toFixed(0)}%${r.pierOverlaps ? ` PIERS OVERLAP ${r.pierOverlaps}` : ''}`);
      for (const f of r.forts) {
        console.log(`  ${(f.label ?? f.prefab).slice(0, 46).padEnd(46)} ${String(f.shape ?? f.prefab).slice(0, 14).padEnd(14)} ${String(f.source ?? '-').padEnd(6)} guards ${String(f.guards ?? '-').slice(0, 22).padEnd(22)} mouth ${String(f.toMouth ?? '-').padStart(5)} anch ${String(f.toAnchorage ?? '-').padStart(5)} route ${String(f.toRoute ?? '-').padStart(5)} reach ${(f.reaches * 100).toFixed(0).padStart(3)}% fire ${(f.fire * 100).toFixed(0).padStart(3)}% face ${String(f.faceOff ?? '-').padStart(3)} gate ${String(f.gateOff ?? '-').padStart(3)} overlap ${f.overlap}${f.overlapWith ? ` ${f.overlapWith}` : ''}`);
      }
    }
  }
  const noFort = reports.filter((r) => !r.forts.length).length;
  const summary = {
    portYears: reports.length, portYearsWithoutFort: noFort, forts: forts.length,
    medianToAnchorage: median(forts.map((f) => f.toAnchorage)), medianToRoute: median(forts.map((f) => f.toRoute)),
    medianToMouth: median(forts.filter((f) => f.toMouth !== null).map((f) => f.toMouth)),
    medianFire: median(forts.map((f) => f.fire)), medianReaches: median(forts.map((f) => f.reaches)), medianOverWater: median(forts.map((f) => f.overWater)),
    firelessForts: forts.filter((f) => f.fire === 0).length,
    medianPortHeld: median(reports.filter((r) => r.forts.length).map((r) => r.held)),
    medianFaceOff: median(forts.map((f) => f.faceOff)), medianGateOff: median(forts.map((f) => f.gateOff)),
    faceOver45: forts.filter((f) => f.faceOff !== null && f.faceOff > 45).length, gateOver90: forts.filter((f) => f.gateOff !== null && f.gateOff > 90).length,
    overlapping: forts.filter((f) => f.overlap > 0.05).length, worstOverlap: Math.max(0, ...forts.map((f) => f.overlap)),
    pierOverlapPortYears: reports.filter((r) => r.pierOverlaps).length,
  };
  console.log(JSON.stringify(summary, null, 1));
  const out = argument('json');
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, reports }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await main();
