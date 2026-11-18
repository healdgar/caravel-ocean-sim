// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The buildings a place's record pins at their sites: the crown's houses of trade, its yards, the great religious houses
// and the waterworks the views of a city show where they stood (Braun and Hogenberg's Lisbon of 1572 and Seville of
// 1588). Each is one city type of the one atlas (js/old-world-buildings.js), stood by its board's country before the
// model's houses (js/old-world-board.js layBoardCountry), and drawn, struck and walked as any other.
import { CITY_BUILDING_TYPES, CITY_TYPE, CITY_TYPED_ROOF } from './old-world-buildings.js';
import { CITY_ROOF, footprint } from './old-world-city.js';
import { worldOfPosition } from './harbour-defences.js';

// By the coast whose board holds the city (its `port`): [name, latitude, longitude, family, built, gone, facing, to].
// `facing` 'water' turns its front (local -z) to the nearest water; a number is the bearing its front looks along, in
// degrees. `to`, a [latitude, longitude], lays it as a run of whole spans from its site to there, as an aqueduct's arches.
// Positions are to some tens of metres; where the river has since been filled, the site moves inland onto dry ground.
export const PLACE_LANDMARKS = Object.freeze({
  lisbon: Object.freeze([
    // On the Ribeira west of the Terreiro do Paço: the crown's house of the Indies trade, its storehouses, its yard.
    ['Casa da Índia', 38.7071, -9.1381, 'CUSTOMHOUSE', 1503, null, 'water'],
    ['Armazéns da Guiné e Índia', 38.7072, -9.1396, 'WAREHOUSE', 1503, null, 'water'],
    ['Ribeira das Naus', 38.7070, -9.1418, 'ARSENAL', 1500, null, 'water'],
    // Belém, over the strand the fleets of the Indies sailed from.
    ['Mosteiro dos Jerónimos', 38.6979, -9.2064, 'JERONIMOS', 1517, null, 'water'],
    // The friaries the views show above the Baixa: the Carmo on its hill, São Domingos by the Rossio, São Francisco.
    ['Convento do Carmo', 38.7121, -9.1406, 'CLOISTER', 1423, null, 'water'],
    ['Convento de São Domingos', 38.7149, -9.1384, 'CLOISTER', 1241, null, 'water'],
    ['Convento de São Francisco', 38.7098, -9.1418, 'CLOISTER', 1246, null, 'water'],
  ].map(Object.freeze)),
  seville: Object.freeze([
    // In the Alcázar's Cuarto del Almirante, by the Puerta de la Montería.
    ['Casa de la Contratación', 37.3836, -5.9917, 'CUSTOMHOUSE', 1503, null, 'water'],
    // The Reales Atarazanas, between the walls and the Arenal.
    ['Reales Atarazanas', 37.3843, -5.9961, 'ARSENAL', 1252, null, 'water'],
    // Herrera's exchange beside the cathedral, finished in 1598.
    ['Casa Lonja de Mercaderes', 37.3845, -5.9931, 'LONJA', 1598, null, 'water'],
    // The Caños de Carmona, coming in to the Puerta de Carmona along the road from Alcalá.
    ['Caños de Carmona', 37.3887, -5.9772, 'AQUEDUCT', 1172, null, 0, [37.3893, -5.9852]],
  ].map(Object.freeze)),
});

// A site is moved inland up to this far to find dry ground no other building holds, a step at a time.
const LANDMARK_SLIDE_M = 160, LANDMARK_STEP_M = 4;
// Ground that falls more than this across a building's footprint is too steep to stand it on.
const LANDMARK_STEEP_M = 9;

/**
 * Stands the landmarks the record pins for `port` in `year` on its board's ground. `inlandAt(x, z)` answers the distance
 * inland of the water's edge, `heightAt` the ground; `inside(x, z, pad)` whether a point is on the board; `taken(f, gap)`
 * whether a footprint meets anything stood. The masons' seatBlock, pushBlock and pushTyped stand each type; keep and
 * occupy mark its footprint. Answers the records, each { name, key, type, piece, x, y, z, yaw, width, length }.
 */
export function layPlaceLandmarks({ port, year, region, heightAt, inlandAt, inside, taken, keep, occupy, seatBlock, pushBlock, pushTyped, typedTypes, rr = Math.random }) {
  const out = [];
  const list = PLACE_LANDMARKS[port];
  if (!list || !region) return out;
  // The way to the water at a point: down the slope of the distance inland.
  const toWater = (x, z) => {
    const e = 4, gx = inlandAt(x + e, z) - inlandAt(x - e, z), gz = inlandAt(x, z + e) - inlandAt(x, z - e), L = Math.hypot(gx, gz);
    return L > 1e-4 ? [-gx / L, -gz / L] : null;
  };
  // Its footprint at (x, z) turned to `yaw`, if the ground there is dry, not too steep, on the board and free.
  const site = (T, x, z, yaw) => {
    if (!inside(x, z, Math.hypot(T.width, T.length) / 2 + 8)) return null;
    const f = footprint(x, z, T.width, T.length, yaw);
    let lo = Infinity, hi = -Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const lx = i * T.width / 2, lz = j * T.length / 2, h = heightAt(x + lx * f.c + lz * f.s, z - lx * f.s + lz * f.c);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (lo < 0.4 || hi - lo > LANDMARK_STEEP_M || taken(f, 1.5)) return null;
    return f;
  };
  const stand = (name, key, type, T, f) => {
    const base = seatBlock(f), tone = 0.86 + 0.1 * rr();
    pushBlock(f, T.height, 0, CITY_ROOF.FLAT + CITY_TYPED_ROOF, T.materialKind === 12 ? 12 : 11, tone, base);
    pushTyped(type, f.x, base.floor, f.z, f.yaw, tone);
    keep(f); occupy(f);
    out.push({ name, key, type, piece: typedTypes.length - 1, x: f.x, y: base.floor, z: f.z, yaw: f.yaw, width: T.width, length: T.length });
  };
  const yawFacing = (facing, x, z) => {
    if (facing === 'water') {
      const w = toWater(x, z);
      return w ? Math.atan2(-w[0], -w[1]) : 0;
    }
    // Its front (local -z) looks along the bearing: local +z is (sin yaw, cos yaw), north is -z.
    return -(facing * Math.PI) / 180;
  };

  for (const [name, latitude, longitude, key, built, gone, facing, to] of list) {
    if (year < built || (gone != null && year >= gone)) continue;
    const type = CITY_TYPE[key], T = CITY_BUILDING_TYPES[type];
    const at = worldOfPosition(region, latitude, longitude);
    if (to) {
      // A run of whole spans, end to end along its line, each on its own ground; a span the ground refuses is left out.
      const end = worldOfPosition(region, to[0], to[1]), L = Math.hypot(end.x - at.x, end.z - at.z);
      if (L < T.width) continue;
      const ux = (end.x - at.x) / L, uz = (end.z - at.z) / L, yaw = Math.atan2(-uz, ux), spans = Math.floor(L / T.width);
      for (let k = 0; k < spans; k++) {
        const t = (k + 0.5) * T.width, f = site(T, at.x + ux * t, at.z + uz * t, yaw);
        if (f) stand(name, key, type, T, f);
      }
      continue;
    }
    // Its site, or the nearest dry and free ground inland of it.
    let [x, z] = [at.x, at.z];
    for (let moved = 0; moved <= LANDMARK_SLIDE_M; moved += LANDMARK_STEP_M) {
      const f = site(T, x, z, yawFacing(facing, x, z));
      if (f) { stand(name, key, type, T, f); break; }
      const w = toWater(x, z);
      if (!w) break;
      x -= w[0] * LANDMARK_STEP_M; z -= w[1] * LANDMARK_STEP_M;
    }
  }
  return out;
}
