// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings as the guns meet them. The plan stands tens of thousands of houses, churches, towers and
// lengths of wall (js/old-world-city.js), drawn on the GPU as blocks and as instances of their Cairn types
// (js/old-world-buildings.js). None of them is a building of the port until shot comes near it. Then its type's
// mesh is stood in the world where the plan put it, and from there it is a port building like any other:
// js/gunnery-control.js traces shot against it and counts its damage, js/building-fracture.js cuts it into
// pieces at the first hit, js/port-damage.js keeps what it suffered and has the town rebuild it.
//
// Nothing here runs unless a shot is in the air or being aimed, and then only for the buildings on its line.
import { noteBuildingMesh } from './building-fracture.js';
import { CITY_BUILDING_TYPES, CITY_TYPED_FLOATS, CITY_TYPES_BRIDGES, CITY_TYPES_SLIGHT, CITY_TYPES_STONE_SLIGHT, cityTypeTarget } from './old-world-buildings.js';

const CITY_TARGET_CELL_M = 32;
// How far a type's builder may stand anything past its plot (a church's towers beside its nave, eaves, a portal).
const CITY_TARGET_REACH_M = 6;
// How many buildings a shot has passed near, and not struck, are kept standing ready.
const CITY_TARGETS_READY = 48;
const CITY_TARGET_NAME = /^city_(\d+)$/;
const cityFraction = (value) => value - Math.floor(value);

// A type's mesh as the builder made it, stood where the plan put this building at its type's own size: turned and
// moved, as the continuum draws it, in the form a port's own mesh has. A masonry kind carries the building's turn in
// its fraction, as js/building-fracture.js writes the stone a breach lays bare; a window's carries its place in its pane.
export function standCityBuildingMesh(source, x, floor, z, yaw) {
  const from = source.vertices, out = new Float32Array(from.length), c = Math.cos(yaw), s = Math.sin(yaw), turn = yaw / Math.PI;
  for (let at = 0; at < from.length; at += 8) {
    const px = from[at], pz = from[at + 2], nx = from[at + 3], nz = from[at + 5];
    out[at] = x + px * c + pz * s;
    out[at + 1] = floor + from[at + 1];
    out[at + 2] = z - px * s + pz * c;
    out[at + 3] = nx * c + nz * s;
    out[at + 4] = from[at + 4];
    out[at + 5] = -nx * s + nz * c;
    const kind = from[at + 6], material = Math.floor(kind + 0.01);
    out[at + 6] = material === 14 ? kind : material + 0.02 + 0.46 * cityFraction((kind - material - 0.02) / 0.46 + turn);
    out[at + 7] = from[at + 7];
  }
  return out;
}

/**
 * The buildings of one city's plan, for one port. `types(id)` gives one compiled type with its source
 * (compileCityBuildingType), made when first asked; `port` is the coast's own, whose list a struck building joins.
 * `onStruck(index)` is told of every real shot that strikes one and of every one a save names, so that it is cut finer
 * from then on.
 */
export function createCityTargets({ city, types, port, onStruck = null }) {
  const typed = city?.typed, kinds = city?.typedTypes, count = city?.typedCount ?? 0, F = CITY_TYPED_FLOATS;
  const records = new Map(), ready = new Map();
  let grid = null, turns = null, seen = null, sweeps = 0;
  const typeOf = (index) => types(kinds[index]);
  const cellKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

  // Which buildings stand over each cell of the ground. Made at the first shot.
  const layOut = () => {
    grid = new Map(); turns = new Float32Array(count * 2); seen = new Uint32Array(count);
    for (let index = 0; index < count; index++) {
      // What hangs from a house's front is no building: shot and whoever walks pass it by, and it goes with its house.
      // Stone cairns, dry-stone field walls and headstones stand on the ground in their own right and shatter when struck.
      if (CITY_TYPES_SLIGHT.has(kinds[index]) && !CITY_TYPES_STONE_SLIGHT.has(kinds[index])) continue;
      // Its cells from its type's plot and all its builder may stand past it, so that no type is built until shot comes.
      const o = index * F, T = CITY_BUILDING_TYPES[kinds[index]], reach = Math.hypot(T.width, T.length) / 2 + CITY_TARGET_REACH_M;
      turns[index * 2] = Math.cos(typed[o + 3]); turns[index * 2 + 1] = Math.sin(typed[o + 3]);
      const x0 = typed[o] - reach, x1 = typed[o] + reach, z0 = typed[o + 2] - reach, z1 = typed[o + 2] + reach;
      for (let cx = Math.floor(x0 / CITY_TARGET_CELL_M); cx <= Math.floor(x1 / CITY_TARGET_CELL_M); cx++) {
        for (let cz = Math.floor(z0 / CITY_TARGET_CELL_M); cz <= Math.floor(z1 / CITY_TARGET_CELL_M); cz++) {
          const key = cellKey(cx, cz), list = grid.get(key);
          if (list) list.push(index); else grid.set(key, [index]);
        }
      }
    }
  };

  // Whether the line from-to passes through a building's box, in its own frame. Cheap, and exact enough to
  // say which buildings are worth standing up.
  const nearBox = (index, from, to, radius) => {
    const o = index * F, source = typeOf(index).source, c = turns[index * 2], s = turns[index * 2 + 1];
    const ax = from[0] - typed[o], az = from[2] - typed[o + 2], bx = to[0] - typed[o], bz = to[2] - typed[o + 2];
    const p = [ax * c - az * s, from[1] - typed[o + 1], ax * s + az * c], q = [bx * c - bz * s, to[1] - typed[o + 1], bx * s + bz * c];
    let enter = 0, leave = 1;
    for (let axis = 0; axis < 3; axis++) {
      const low = source.min[axis] - radius, high = source.max[axis] + radius, d = q[axis] - p[axis];
      if (Math.abs(d) < 1e-9) { if (p[axis] < low || p[axis] > high) return false; continue; }
      let t0 = (low - p[axis]) / d, t1 = (high - p[axis]) / d;
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > enter) enter = t0;
      if (t1 < leave) leave = t1;
      if (enter > leave) return false;
    }
    return true;
  };

  // The mesh a building is traced against and cut from. Dropped once it is in pieces, which keep their own.
  const meshOf = (record) => {
    if (record.world) return record.world;
    const o = record.index * F, source = typeOf(record.index).source;
    record.world = standCityBuildingMesh(source, typed[o], typed[o + 1], typed[o + 2], typed[o + 3]);
    noteBuildingMesh(record.instance, {
      vertices: record.world, indices: source.indices, firstIndex: 0, endIndex: source.indices.length,
      min: [source.min[0], typed[o + 1] + source.min[1], source.min[2]],
      max: [source.max[0], typed[o + 1] + source.max[1], source.max[2]],
    });
    return record.world;
  };
  const forget = (record) => { record.world = null; noteBuildingMesh(record.instance, null); };

  // One building of the plan as a building of the port: what a port's own instance is, and where its mesh is.
  const stand = (index) => {
    let record = records.get(index);
    if (record) {
      if (ready.delete(index)) ready.set(index, record);
      return record;
    }
    const o = index * F, type = kinds[index], T = typeOf(index), source = T.source, target = cityTypeTarget(type);
    const instance = {
      id: `city_${index}`, prefabId: target.prefabId, label: target.label,
      x: typed[o], y: typed[o + 1], baseY: typed[o + 1], z: typed[o + 2], yaw: typed[o + 3],
      width: T.width, depth: T.length, length: T.length, height: T.height,
      roofHeight: Math.max(0, source.max[1] - T.height), foundationDepth: Math.max(0, -source.min[1]),
      // Its tint, which its pieces wear as the city's continuum wears it whole.
      city: { index, type, tint: typed[o + 4] },
    };
    record = { index, instance, world: null, enrolled: false, port: { instances: [instance], center: { x: instance.x, z: instance.z } } };
    // What js/building-fracture.js cuts it from, made again if the town has rebuilt it since.
    instance.fractureSource = () => ({ vertices: meshOf(record), indices: source.indices, partAssembly: source.partAssembly });
    records.set(index, record); ready.set(index, record);
    if (ready.size > CITY_TARGETS_READY) {
      const [oldest, gone] = ready.entries().next().value;
      ready.delete(oldest); records.delete(oldest); forget(gone);
    }
    return record;
  };
  // A struck building joins the port's own: from here its fires burn, its damage is kept and its pieces drawn.
  const enrol = (record) => {
    if (record.enrolled) return;
    record.enrolled = true;
    ready.delete(record.index);
    if (!Array.isArray(port.instances)) port.instances = [];
    port.instances.push(record.instance);
  };

  // Every cell the line crosses on the ground, in order.
  const walk = (x0, z0, x1, z1, visit) => {
    const size = CITY_TARGET_CELL_M;
    let cx = Math.floor(x0 / size), cz = Math.floor(z0 / size);
    const ex = Math.floor(x1 / size), ez = Math.floor(z1 / size), dx = x1 - x0, dz = z1 - z0;
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tx = dx === 0 ? Infinity : ((cx + (dx > 0 ? 1 : 0)) * size - x0) / dx, tz = dz === 0 ? Infinity : ((cz + (dz > 0 ? 1 : 0)) * size - z0) / dz;
    const stepX = dx === 0 ? Infinity : size / Math.abs(dx), stepZ = dz === 0 ? Infinity : size / Math.abs(dz);
    for (let guard = Math.abs(ex - cx) + Math.abs(ez - cz) + 2; guard > 0; guard--) {
      visit(cellKey(cx, cz));
      if (cx === ex && cz === ez) return;
      if (tx < tz) { cx += sx; tx += stepX; } else { cz += sz; tz += stepZ; }
    }
  };

  return {
    count,
    // Whether a point of the ground stands within one of the city's buildings, or within `margin` (a metre at most)
    // of its walls: for whoever walks its streets.
    inside(x, z, margin = 0.35) {
      if (!count) return false;
      if (!grid) layOut();
      const list = grid.get(cellKey(Math.floor(x / CITY_TARGET_CELL_M), Math.floor(z / CITY_TARGET_CELL_M)));
      if (!list) return false;
      for (const index of list) {
        if (CITY_TYPES_BRIDGES.has(kinds[index]) || CITY_TYPES_SLIGHT.has(kinds[index])) continue;
        const o = index * F, dx = x - typed[o], dz = z - typed[o + 2], T = CITY_BUILDING_TYPES[kinds[index]];
        if (Math.hypot(dx, dz) > Math.hypot(T.width, T.length) / 2 + CITY_TARGET_REACH_M + margin) continue;
        const source = typeOf(index).source, c = turns[index * 2], s = turns[index * 2 + 1], lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (lx >= source.min[0] - margin && lx <= source.max[0] + margin && lz >= source.min[2] - margin && lz <= source.max[2] + margin) return true;
      }
      return false;
    },
    // What a shot on the line from-to meets among the city's buildings, as `sweepBuilding` (js/gunnery-control.js
    // sweepBuildingSegment) reports any building: the nearest, or null. A real shot's building joins the port.
    sweep(from, to, radius, options, sweepBuilding) {
      if (!count) return null;
      if (!grid) layOut();
      const stamp = ++sweeps;
      let best = null, bestRecord = null;
      walk(from[0], from[2], to[0], to[2], (key) => {
        const list = grid.get(key);
        if (!list) return;
        for (const index of list) {
          if (seen[index] === stamp) continue;
          seen[index] = stamp;
          if (!nearBox(index, from, to, radius + 0.25)) continue;
          const record = stand(index);
          if (!record.instance.damageState?.fracture) meshOf(record);
          const hit = sweepBuilding(from, to, radius, record.port, options);
          if (hit?.kind === 'building' && (!best || hit.fraction < best.fraction)) { best = hit; bestRecord = record; }
        }
      });
      if (bestRecord && options?.previewOnly !== true) { enrol(bestRecord); onStruck?.(bestRecord.index); }
      return best;
    },
    // Buildings a save names, stood before the port's damage is put back so that the record finds them.
    revive(names) {
      let revived = 0;
      for (const name of names ?? []) {
        const index = Number(CITY_TARGET_NAME.exec(name)?.[1] ?? -1);
        if (!(index >= 0 && index < count)) continue;
        enrol(stand(index));
        onStruck?.(index);
        revived++;
      }
      return revived;
    },
    // Told by the port's fractures: in pieces now, so its whole mesh is needed no more; or standing again.
    fractured(instance) { const record = records.get(instance?.city?.index); if (record?.instance === instance) forget(record); },
    get standing() { return records.size; },
  };
}
