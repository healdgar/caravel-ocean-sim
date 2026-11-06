// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How a building comes apart. The part catalog says what a piece is; damage says how much it has taken;
// fracture says which pieces leave. A vertex never moves on its own here. Every piece moves as one rigid
// body, in the same flight records ships use, and lands on the ground beneath it to stay as rubble.
//
// Built once per building, the first time it is struck:
//  - shard 0 is everything that stays: what is buried or always under water, floors, gun decks.
//  - A wall face is cut into stone blocks along the courses, where the Voronoi cells of the masonry
//    change. Each block is a closed solid. The sides hidden inside the wall show raw stone once a
//    neighbour has gone, and a fort has a rubble core behind its facing.
//  - Small fittings are one shard. Guns are one shard. Everything else breaks up by cell.
//  - Touching shards are linked, and a link knows which shard rests on which. See supportScan.
//
// At runtime JavaScript runs only when a building is hit. It writes one flight record per released shard,
// and BUILDING_FRACTURE_POSE_UPDATE evaluates the flights on the GPU only while something is in the air.
// The last pose stays in the vertex buffer, so a ruin costs what its triangles cost and nothing more.

import { depthInOutline } from './fort-plan.js';
import { sampleVoronoiBlockCell } from './part-assembly.js';
import { FRACTURE_GRAVITY, FRACTURE_RECORD_FLOATS, createShipFractureState, settleFinishedFlights, writeFlight } from './ship-fracture.js';
import { BUILDING_FRACTURE_POSE_UPDATE } from './wgsl/ship-fracture.js';

export const BUILDING_SHARD_KINDS = Object.freeze({ block: 1, whole: 2, cell: 3, gun: 4 });
const STRIDE = 8;
// A longer normal reads as damaged in the land shader: raw stone, raw wood.
const RAW_SURFACE = 1.6, RAW_LENGTH_SQUARED = 2;
const TOUCH = 0.09;
const NOT_HELD = 255, TIE_REACH = 1.5;

const TIMBER_KINDS = new Set([10, 15, 17]);
const ROOF_KINDS = new Set([13, 15]);
const STAYING_PLATE = /(^|_)(floor|plaza|terreplein|courtyard|cobble|apron|slipway|batey|earthwork|mounds?|sleepers|adarve)(_|$)/;
const ONE_PIECE = /garita|bollard|crane|capstan|dome|cupola|lantern|farol|spire|chimney|bell_chamber|monolith|firepit|altar|trough|beacon|canoe|rollers|hearth|mooring|espadana|turret/;
const GUN = /cannon_embrasure/;
// The outer edge of a traced fort's rampart walk, and its cordon: these go with the wall under them.
const WALK_EDGE = /rampart_walk_edge|scarp_cordon_cornice/;

const PART_SMALL = 3.2, ISLAND_SMALL = 2.6, ONE_PIECE_LIMIT = 9;
// Metres behind the face, by what the wall is made of. Thin walls are limited by their own thickness.
const FACING_DEPTH = Object.freeze({ fortified: 1.05, masonry: 0.48, stucco: 0.34, timber: 0.11, roof: 0.1, opening: 0.05 });
const CORE_DEPTH = 1.4, RAMPART_EDGE = 2.1;
// The earth behind a fort's facing, in great clods, two deep, harder to shift than stone.
const EARTH_CELL_M = 3, EARTH_THICK_M = 1.6, EARTH_LAYERS = 2, EARTH_HARDNESS = 2.2;
// A building past this many blocks gets bigger blocks. A palisade fort would otherwise be thirty thousand of them.
const SHARD_BUDGET = 3200;

const blockNoise = (s, salt) => { const x = Math.sin(s * 12.9898 + salt * 78.233) * 43758.5453; return x - Math.floor(x); };
const vectorBetween = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossOf = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dotOf = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unitOf = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

function surfaceOf(kind, fortified) {
  if (ROOF_KINDS.has(kind)) return { scale: 1.7, timber: TIMBER_KINDS.has(kind), depth: FACING_DEPTH.roof, span: 4 };
  if (TIMBER_KINDS.has(kind)) return { scale: 1, timber: true, depth: FACING_DEPTH.timber, span: 3 };
  if (kind === 14) return { scale: 1, timber: false, depth: FACING_DEPTH.opening, span: 1 };
  if (kind === 12) return { scale: 1.15, timber: false, depth: FACING_DEPTH.stucco, span: 1 };
  return { scale: 1, timber: false, depth: fortified ? FACING_DEPTH.fortified : FACING_DEPTH.masonry, span: 1 };
}

// Which faces there are: the emitters' unshared quads, and any other triangles one by one.
function facesOfInstance(indices, vertices, trianglePartIds, firstTriangle, endTriangle) {
  const faces = [];
  for (let t = firstTriangle; t < endTriangle;) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2], part = trianglePartIds[t];
    if (t + 1 < endTriangle && b === a + 1 && c === a + 2 && trianglePartIds[t + 1] === part
      && indices[t * 3 + 3] === a && indices[t * 3 + 4] === c && indices[t * 3 + 5] === a + 3) {
      faces.push({ v: [a, b, c, a + 3], part });
      t += 2;
    } else {
      faces.push({ v: [a, b, c], part });
      t += 1;
    }
  }
  for (const face of faces) {
    const min = face.min = [Infinity, Infinity, Infinity], max = face.max = [-Infinity, -Infinity, -Infinity];
    for (const v of face.v) for (let c = 0; c < 3; c++) {
      const value = vertices[v * STRIDE + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
    face.kind = Math.floor(vertices[face.v[0] * STRIDE + 6]);
  }
  return faces;
}

// Two centimetres to the unit, within 300 metres of the building, packed into 45 bits.
const positionKey = (vertices, v, originX, originZ) => {
  const at = v * STRIDE;
  return (Math.round((vertices[at] - originX) * 50) + 16384) * 1073741824 + (Math.round(vertices[at + 1] * 50) + 16384) * 32768 + (Math.round((vertices[at + 2] - originZ) * 50) + 16384);
};

// One box, spar or fitting is one connected island of faces.
function islandsOf(faces, vertices, originX, originZ) {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const next = parent.get(x); parent.set(x, r); x = next; }
    return r;
  };
  const keys = faces.map((face) => face.v.map((v) => positionKey(vertices, v, originX, originZ)));
  for (const list of keys) {
    for (const key of list) if (!parent.has(key)) parent.set(key, key);
    for (let k = 1; k < list.length; k++) parent.set(find(list[k]), find(list[0]));
  }
  const islands = new Map();
  faces.forEach((face, i) => {
    const root = find(keys[i][0]);
    let island = islands.get(root);
    if (!island) islands.set(root, island = { faces: [], min: [...face.min], max: [...face.max] });
    island.faces.push(face);
    for (let c = 0; c < 3; c++) {
      if (face.min[c] < island.min[c]) island.min[c] = face.min[c];
      if (face.max[c] > island.max[c]) island.max[c] = face.max[c];
    }
  });
  return [...islands.values()];
}

const spanOf = (min, max) => Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

/**
 * Prepare one building's fracture from the port's merged mesh and part catalog. Nothing in the port's own
 * arrays changes. Returns the building's own vertices and indices, and the fracture table.
 *   groundAt(x, z)  what the terrain or seabed is at, in the same frame as the vertices.
 */
export function prepareBuildingFracture(options) {
  const steps = prepareBuildingFractureSteps(options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// The same work in pieces, so a game frame can stop between them. It yields often and cheaply.
export function* prepareBuildingFractureSteps({ vertices, indices, catalog, instanceIndex, instance, materialClass = 'masonry', groundAt = () => 0 }) {
  const parts = catalog.parts, ownParts = parts.filter((p) => p.instanceIndex === instanceIndex && p.indexCount > 0);
  let firstIndex = Infinity, endIndex = 0;
  for (const part of ownParts) {
    if (part.firstIndex < firstIndex) firstIndex = part.firstIndex;
    if (part.firstIndex + part.indexCount > endIndex) endIndex = part.firstIndex + part.indexCount;
  }
  if (!ownParts.length) return null;
  const fortified = materialClass === 'fortified-stone';
  // A rampart has earth under it, up to its own height. A keep standing on it does not.
  const rampartTop = (instance.baseY ?? instance.y ?? 0) + (instance.height ?? Infinity) + 0.2;
  const cosY = Math.cos(instance.yaw ?? 0), sinY = Math.sin(instance.yaw ?? 0), originX = instance.x ?? 0, originZ = instance.z ?? 0;
  const toLocal = (x, y, z) => { const dx = x - originX, dz = z - originZ; return [dx * cosY - dz * sinY, y, dx * sinY + dz * cosY]; };
  const toWorld = (x, y, z) => [originX + x * cosY + z * sinY, y, originZ - x * sinY + z * cosY];

  const faces = facesOfInstance(indices, vertices, catalog.trianglePartIds, firstIndex / 3, endIndex / 3);
  const facesByPart = new Map();
  for (const face of faces) (facesByPart.get(face.part) ?? facesByPart.set(face.part, []).get(face.part)).push(face);

  const shards = [null];
  const geometry = [{ faces: [], blocks: [], cores: [] }];
  const shardsByKey = new Map();
  const newShard = (kind, part, surface) => {
    const index = shards.length;
    shards.push({
      index, kind, partId: part.id, partKey: part.partKey, timber: surface.timber, span: surface.span,
      min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
      volume: 0, normalSum: [0, 0, 0], links: [], above: [], below: [], side: [], anchored: false,
    });
    geometry.push({ faces: [], blocks: [], cores: [] });
    return index;
  };
  const keyed = (key, kind, part, surface) => {
    let s = shardsByKey.get(key);
    if (s === undefined) shardsByKey.set(key, s = newShard(kind, part, surface));
    return s;
  };

  const staysBecauseLow = (min, max) => max[1] < Math.max(groundAt((min[0] + max[0]) * 0.5, (min[2] + max[2]) * 0.5), -0.6) + 0.02;
  const faceNormal = (face) => {
    const at = face.v[0] * STRIDE;
    return unitOf([vertices[at + 3], vertices[at + 4], vertices[at + 5]]);
  };

  // Floors rubble can land on, by one-metre cell, in the building's frame.
  const floors = new Map(), plates = new Map();
  const floorKey = (x, z) => (Math.floor(x) + 32768) * 65536 + (Math.floor(z) + 32768);
  const noteLevel = (grid, x0, x1, z0, z1, top) => {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
      const key = floorKey(x, z), had = grid.get(key);
      if (had) { if (!had.includes(top)) had.push(top); } else grid.set(key, [top]);
    }
  };
  const faceSpan = (face) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
    for (const v of face.v) {
      const c = toLocal(vertices[v * STRIDE], vertices[v * STRIDE + 1], vertices[v * STRIDE + 2]);
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[2] < z0) z0 = c[2];
      if (c[2] > z1) z1 = c[2];
      if (c[1] > top) top = c[1];
    }
    return [x0, x1, z0, z1, top];
  };
  const localCorners = (face) => face.v.map((v) => toLocal(vertices[v * STRIDE], 0, vertices[v * STRIDE + 2]));
  // Whether a quad's corners stand on its own box, so that its box is its shape.
  const squareOnto = (corners, frame) => {
    const a = corners.map(([x, , z]) => (frame ? [x * frame.cos - z * frame.sin, x * frame.sin + z * frame.cos] : [x, z]));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of a) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    return a.every(([x, z]) => (Math.abs(x - x0) < 0.02 || Math.abs(x - x1) < 0.02) && (Math.abs(z - z0) < 0.02 || Math.abs(z - z1) < 0.02));
  };
  const recordFloor = (face) => {
    const corners = localCorners(face), span = faceSpan(face);
    if (corners.length === 4 && squareOnto(corners)) { noteLevel(floors, ...span); return; }
    // A floor at an angle to the building: only the cells it really covers, or stones would lie on air beside it.
    const [x0, x1, z0, z1, top] = span;
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
      let inside = false;
      for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
        const [ax, , az] = corners[i], [bx, , bz] = corners[j];
        if ((az > z + 0.5) !== (bz > z + 0.5) && x + 0.5 < ((bx - ax) * (z + 0.5 - az)) / (bz - az) + ax) inside = !inside;
      }
      if (inside) noteLevel(floors, x, x, z, z, top);
    }
  };
  // A set of faces' shape in the building's own frame: on a building set at an angle, the world's box says little.
  const localBounds = (list) => {
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const face of list) {
      const [x0, x1, z0, z1] = faceSpan(face);
      if (x0 < bounds.min[0]) bounds.min[0] = x0;
      if (x1 > bounds.max[0]) bounds.max[0] = x1;
      if (z0 < bounds.min[2]) bounds.min[2] = z0;
      if (z1 > bounds.max[2]) bounds.max[2] = z1;
      if (face.min[1] < bounds.min[1]) bounds.min[1] = face.min[1];
      if (face.max[1] > bounds.max[1]) bounds.max[1] = face.max[1];
    }
    return bounds;
  };
  // The frame of a box set at an angle in the building, from the longest level edge of its broadest top. Null if square.
  const islandFrame = (list) => {
    let longest = 0, ux = 1, uz = 0;
    for (const face of list) {
      if (face.v.length !== 4 || Math.abs(faceNormal(face)[1]) < 0.7) continue;
      const c = localCorners(face);
      for (let i = 0; i < 4; i++) {
        const dx = c[(i + 1) % 4][0] - c[i][0], dz = c[(i + 1) % 4][2] - c[i][2], length = Math.hypot(dx, dz);
        if (length > longest) { longest = length; ux = dx / length; uz = dz / length; }
      }
    }
    if (!longest || Math.abs(ux * uz) < 0.01) return null;
    return { cos: ux, sin: -uz };
  };
  const boundsAlong = (list, frame) => {
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const face of list) for (const [x, , z] of localCorners(face)) {
      const fx = x * frame.cos - z * frame.sin, fz = x * frame.sin + z * frame.cos;
      if (fx < bounds.min[0]) bounds.min[0] = fx;
      if (fx > bounds.max[0]) bounds.max[0] = fx;
      if (fz < bounds.min[2]) bounds.min[2] = fz;
      if (fz > bounds.max[2]) bounds.max[2] = fz;
    }
    for (const face of list) {
      if (face.min[1] < bounds.min[1]) bounds.min[1] = face.min[1];
      if (face.max[1] > bounds.max[1]) bounds.max[1] = face.max[1];
    }
    return bounds;
  };
  const stay = (face) => {
    // The underside of a box was never seen. Once the walls have gone it is the ground they stood on.
    if (faceNormal(face)[1] < -0.7) face.groundUp = true;
    geometry[0].faces.push(face);
  };

  // The flat of a fort's rampart stays, with earth under it, but not its outer edge: that stands on the facing.
  // The part beyond the core is cut away from what stays. It falls with the wall if nothing covers it, and
  // if another plate lies on top of it, nobody will ever see it and it is simply not drawn.
  const rampartPlate = (face, bounds, part, surface) => {
    // Not square to the building: a fort drawn to its ground. Its walk's outer edge is cut separately, so what is here stays.
    if (!squareOnto(localCorners(face))) { stay(face); recordFloor(face); return; }
    const x0 = bounds.min[0] + RAMPART_EDGE, x1 = bounds.max[0] - RAMPART_EDGE, z0 = bounds.min[2] + RAMPART_EDGE, z1 = bounds.max[2] - RAMPART_EDGE;
    const [qx0, qx1, qz0, qz1, y] = faceSpan(face);
    if (qx0 >= x0 && qx1 <= x1 && qz0 >= z0 && qz1 <= z1) { stay(face); recordFloor(face); return; }
    const at = face.v[0] * STRIDE;
    const rect = (ax, bx, az, bz) => [[ax, az], [bx, az], [bx, bz], [ax, bz]].map(([x, z]) => {
      const w = toWorld(x, y, z), out = new Float32Array(STRIDE);
      out[0] = w[0]; out[1] = y; out[2] = w[2];
      out[3] = vertices[at + 3]; out[4] = vertices[at + 4]; out[5] = vertices[at + 5]; out[6] = vertices[at + 6]; out[7] = vertices[at + 7];
      return out;
    });
    const midX = Math.max(qx0, x0), midX1 = Math.min(qx1, x1), midZ = Math.max(qz0, z0), midZ1 = Math.min(qz1, z1);
    if (midX < midX1 && midZ < midZ1) {
      geometry[0].blocks.push({ corners: rect(midX, midX1, midZ, midZ1), depth: 0 });
      noteLevel(floors, midX, midX1, midZ, midZ1, y);
    }
    const covered = (plates.get(floorKey((qx0 + qx1) * 0.5, (qz0 + qz1) * 0.5)) ?? []).some((h) => h > y + 0.05 && h < y + 2.5);
    if (covered) return;
    const strips = [[qx0, Math.min(qx1, x0), qz0, qz1], [Math.max(qx0, x1), qx1, qz0, qz1], [midX, midX1, qz0, Math.min(qz1, z0)], [midX, midX1, Math.max(qz0, z1), qz1]];
    for (const [ax, bx, az, bz] of strips) {
      if (bx - ax < 0.05 || bz - az < 0.05) continue;
      // Paving along the strip, each a block with a little thickness to it.
      const along = bx - ax >= bz - az, length = along ? bx - ax : bz - az, pieces = Math.max(1, Math.round(length / (1.45 * blockScale)));
      for (let i = 0; i < pieces; i++) {
        const piece = along
          ? rect(ax + (length * i) / pieces, ax + (length * (i + 1)) / pieces, az, bz)
          : rect(ax, bx, az + (length * i) / pieces, az + (length * (i + 1)) / pieces);
        geometry[newShard(BUILDING_SHARD_KINDS.block, part, surface)].blocks.push({ corners: piece, depth: 0.24 });
      }
    }
  };

  // A face too small to cut goes with the other small faces in its cell. Those break off together.
  const cellShard = (face, partIndex, part, surface) => {
    const x = (face.min[0] + face.max[0]) * 0.5, y = (face.min[1] + face.max[1]) * 0.5, z = (face.min[2] + face.max[2]) * 0.5;
    const [lx, ly, lz] = toLocal(x, y, z), k = 1 / (surface.scale * blockScale);
    const cell = sampleVoronoiBlockCell(lx * k, ly * k, lz * k, surface.timber);
    const number = (Math.round(cell.sx * 10) + 8192) * 268435456 + (Math.round(cell.sy * 10) + 8192) * 16384 + (Math.round(cell.sz * 10) + 8192);
    return keyed(`cell:${partIndex}:${number}`, BUILDING_SHARD_KINDS.cell, part, surface);
  };

  // Cut one wall quad into blocks. Courses are level on an upright wall, and each course breaks where the
  // Voronoi cell of the masonry changes, so joints do not line up from one course to the next.
  const cutQuad = (face, part, surface, thickness) => {
    const [a, b, c, d] = face.v, A = a * STRIDE, B = b * STRIDE, C = c * STRIDE, D = d * STRIDE;
    const ux = vertices[B] - vertices[A], uy = vertices[B + 1] - vertices[A + 1], uz = vertices[B + 2] - vertices[A + 2];
    const vx = vertices[D] - vertices[A], vy = vertices[D + 1] - vertices[A + 1], vz = vertices[D + 2] - vertices[A + 2];
    const lengthU = Math.hypot(ux, uy, uz), lengthV = Math.hypot(vx, vy, vz), n = faceNormal(face);
    const coursesOnV = Math.abs(n[1]) < 0.7 ? Math.abs(vy) >= Math.abs(uy) : lengthV <= lengthU;
    const size = surface.scale * blockScale;
    const courseHeight = (surface.timber ? 0.65 : 0.9) * size, blockLength = (surface.timber ? 1.8 : 1.45) * size;
    const across = coursesOnV ? lengthU : lengthV, along = coursesOnV ? lengthV : lengthU;
    const courses = Math.max(1, Math.round(along / courseHeight));
    const corner = (across01, along01) => {
      const u = coursesOnV ? across01 : along01, v = coursesOnV ? along01 : across01, out = new Float32Array(STRIDE);
      const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w11 = u * v, w01 = (1 - u) * v;
      for (let i = 0; i < STRIDE; i++) out[i] = w00 * vertices[A + i] + w10 * vertices[B + i] + w11 * vertices[C + i] + w01 * vertices[D + i];
      const length = Math.hypot(out[3], out[4], out[5]) || 1;
      out[3] /= length; out[4] /= length; out[5] /= length;
      return out;
    };
    const step = Math.max(1, Math.ceil(across / (blockLength * 0.34))), minimum = Math.min(0.5 * blockLength, across), k = 1 / size;
    const inner = Math.min(surface.depth, thickness > 0 ? thickness * 0.48 : surface.depth);
    for (let row = 0; row < courses; row++) {
      const v0 = row / courses, v1 = (row + 1) / courses, cuts = [0], mid = (v0 + v1) * 0.5;
      let last = null;
      for (let i = 0; i < step; i++) {
        const t = (i + 0.5) / step, u = coursesOnV ? t : mid, v = coursesOnV ? mid : t;
        // A wall is near enough flat that its corners' average is the point on it.
        const x = vertices[A] + ux * u + vx * v, y = vertices[A + 1] + uy * u + vy * v, z = vertices[A + 2] + uz * u + vz * v;
        const dx = x - originX, dz = z - originZ;
        const cell = sampleVoronoiBlockCell((dx * cosY - dz * sinY) * k, y * k, (dx * sinY + dz * cosY) * k, surface.timber);
        const id = cell.sx * 7 + cell.sy * 131 + cell.sz * 2053;
        if (last !== null && id !== last) {
          const at = i / step;
          if ((at - cuts[cuts.length - 1]) * across >= minimum && (1 - at) * across >= minimum) cuts.push(at);
        }
        last = id;
      }
      cuts.push(1);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const q00 = corner(cuts[i], v0), q10 = corner(cuts[i + 1], v0), q11 = corner(cuts[i + 1], v1), q01 = corner(cuts[i], v1);
        // Keep the source quad's turning order, so a wall's faces wind as they did before they were cut.
        const corners = coursesOnV ? [q00, q10, q11, q01] : [q00, q01, q11, q10];
        const top = Math.max(q00[1], q10[1], q11[1], q01[1]), low = Math.min(q00[1], q10[1], q11[1], q01[1]);
        const midX = (q00[0] + q11[0]) * 0.5, midZ = (q00[2] + q11[2]) * 0.5;
        if (staysBecauseLow([midX, low, midZ], [midX, top, midZ])) {
          geometry[0].blocks.push({ corners, depth: 0 });
          continue;
        }
        const s = newShard(BUILDING_SHARD_KINDS.block, part, surface);
        geometry[s].blocks.push({ corners, depth: inner * (0.8 + 0.4 * blockNoise(s, 9)) });
      }
    }
  };

  // How large to cut them: wall area over the area of a block, against the budget.
  let blocksAtFullSize = 0;
  for (const face of faces) {
    if (face.v.length !== 4 || face.kind === 18) continue;
    const at = face.v[0] * STRIDE, up = face.v[1] * STRIDE, across = face.v[3] * STRIDE, surface = surfaceOf(face.kind, fortified);
    const area = Math.hypot(vertices[up] - vertices[at], vertices[up + 1] - vertices[at + 1], vertices[up + 2] - vertices[at + 2]) * Math.hypot(vertices[across] - vertices[at], vertices[across + 1] - vertices[at + 1], vertices[across + 2] - vertices[at + 2]);
    if (faceNormal(face)[1] > 0.7 && area > 4 && !ROOF_KINDS.has(face.kind)) continue;
    blocksAtFullSize += area / ((surface.timber ? 1.17 : 1.3) * surface.scale * surface.scale);
  }
  const blockScale = Math.max(1, Math.sqrt(blocksAtFullSize / SHARD_BUDGET));
  yield 'faces';

  if (fortified) {
    for (const face of faces) if (face.v.length === 4 && face.kind !== 18 && !ROOF_KINDS.has(face.kind) && Math.abs(faceNormal(face)[1]) > 0.7) {
      const span = faceSpan(face);
      if (span[1] - span[0] > 1 && span[3] - span[2] > 1) noteLevel(plates, ...span);
    }
  }
  for (const [partIndex, partFaces] of facesByPart) {
    yield 'part';
    const part = parts[partIndex];
    const partBounds = localBounds(partFaces), partMin = partBounds.min, partMax = partBounds.max;
    const middle = toWorld((partMin[0] + partMax[0]) * 0.5, 0, (partMin[2] + partMax[2]) * 0.5);
    const lowest = Math.max(groundAt(middle[0], middle[2]), -0.6);
    const partRooted = partMin[1] < lowest - 0.5, partKey = String(part.partKey ?? '');
    const partSpan = spanOf(partMin, partMax), mostly = surfaceOf(partFaces[0].kind, fortified);
    if (GUN.test(partKey)) {
      const s = keyed(`gun:${partIndex}`, BUILDING_SHARD_KINDS.gun, part, { ...mostly, span: 1 });
      for (const face of partFaces) geometry[s].faces.push(face);
      continue;
    }
    if (!partRooted && (partSpan <= PART_SMALL || (ONE_PIECE.test(partKey) && partSpan <= ONE_PIECE_LIMIT))) {
      const s = keyed(`whole:${partIndex}`, BUILDING_SHARD_KINDS.whole, part, mostly);
      for (const face of partFaces) geometry[s].faces.push(face);
      continue;
    }
    for (const [islandIndex, island] of islandsOf(partFaces, vertices, originX, originZ).entries()) {
      const islandGround = Math.max(groundAt((island.min[0] + island.max[0]) * 0.5, (island.min[2] + island.max[2]) * 0.5), -0.6);
      // A box set at an angle in the building is measured along its own sides.
      const frame = islandFrame(island.faces), bounds = frame ? boundsAlong(island.faces, frame) : localBounds(island.faces);
      if (island.min[1] >= islandGround - 0.5 && spanOf(bounds.min, bounds.max) <= ISLAND_SMALL) {
        const s = keyed(`island:${partIndex}:${islandIndex}`, BUILDING_SHARD_KINDS.whole, part, surfaceOf(island.faces[0].kind, fortified));
        for (const face of island.faces) geometry[s].faces.push(face);
        continue;
      }
      const spanX = bounds.max[0] - bounds.min[0], spanY = bounds.max[1] - bounds.min[1], spanZ = bounds.max[2] - bounds.min[2];
      const platform = Math.min(spanX, spanZ) > 4;
      // A post or a beam has no wall to cut. It breaks into lengths by cell.
      const spar = spanX + spanY + spanZ - Math.max(spanX, spanY, spanZ) - Math.min(spanX, spanY, spanZ) < 0.9;
      for (const face of island.faces) {
        const surface = surfaceOf(face.kind, fortified);
        if (staysBecauseLow(face.min, face.max)) { stay(face); continue; }
        const n = faceNormal(face), horizontal = Math.abs(n[1]) > 0.7;
        if (horizontal && instance.trace && WALK_EDGE.test(partKey) && face.v.length === 4) {
          cutQuad(face, part, { ...surface, scale: Math.max(surface.scale, 1.6) }, 0.5);
          continue;
        }
        if (fortified && !horizontal && platform && face.v.length === 4) geometry[0].cores.push({ face, part });
        const longest = Math.max(face.max[0] - face.min[0], face.max[1] - face.min[1], face.max[2] - face.min[2]);
        // A paved floor at ground level stays, and so does the flat of a fort's rampart, which has earth under it.
        if (horizontal && !ROOF_KINDS.has(face.kind) && !surface.timber
          && (fortified ? (platform || face.kind === 16) && face.max[1] <= rampartTop : (face.kind === 16 || STAYING_PLATE.test(partKey) || platform) && face.max[1] <= islandGround + 1.6)) {
          if (fortified && platform && face.v.length === 4) rampartPlate(face, bounds, part, surface);
          else { stay(face); recordFloor(face); }
          continue;
        }
        // Any other floor comes down in big slabs that hang from each other, held by the walls around them.
        if (horizontal && platform && !ROOF_KINDS.has(face.kind)) {
          const slab = { ...surface, scale: Math.max(surface.scale, 3.2), span: 4 };
          // One broad quad has no cells to fall into, so it is cut like a wall, or it would come down whole.
          if (face.v.length === 4 && longest > 1.45 * slab.scale * blockScale) cutQuad(face, part, slab, spanY);
          else geometry[cellShard(face, partIndex, part, slab)].faces.push(face);
          continue;
        }
        // A post driven into the ground stays in it, whatever goes from on top of it.
        if (face.min[1] < islandGround - 0.5 && (spar || face.v.length !== 4)) { stay(face); continue; }
        if (spar) {
          geometry[cellShard(face, partIndex, part, surface)].faces.push(face);
          continue;
        }
        const big = longest >= 0.8 * (surface.timber ? 1.8 : 1.45) * surface.scale * blockScale;
        if (face.v.length === 4 && big && face.kind !== 18) {
          // How thick is this wall, along its own normal? An island's span there, when it is a plain box.
          const buildingNormal = [n[0] * cosY - n[2] * sinY, n[1], n[0] * sinY + n[2] * cosY];
          const localNormal = frame ? [buildingNormal[0] * frame.cos - buildingNormal[2] * frame.sin, buildingNormal[1], buildingNormal[0] * frame.sin + buildingNormal[2] * frame.cos] : buildingNormal;
          const thickness = Math.abs(localNormal[0]) * spanX + Math.abs(localNormal[1]) * spanY + Math.abs(localNormal[2]) * spanZ;
          cutQuad(face, part, surface, thickness);
          continue;
        }
        if (face.min[1] < islandGround - 0.5) { stay(face); continue; }
        const s = cellShard(face, partIndex, part, surface);
        geometry[s].faces.push(face);
      }
    }
  }

  // Lay the mesh out shard by shard, so each owns a run of vertices.
  // A fort's facing stands in front of rubble and earth, and that is what a breach shows first. The surface is
  // rough but whole: clods that share a corner push it back by the same amount. Behind the last of it is the fort.
  for (const { face, part } of geometry[0].cores) {
    const n = faceNormal(face), corner = face.v.map((v) => [vertices[v * STRIDE], vertices[v * STRIDE + 1], vertices[v * STRIDE + 2]]);
    const cellsAcross = Math.max(1, Math.round(Math.hypot(corner[1][0] - corner[0][0], corner[1][1] - corner[0][1], corner[1][2] - corner[0][2]) / (EARTH_CELL_M * blockScale)));
    const cellsUp = Math.max(1, Math.round(Math.hypot(corner[3][0] - corner[0][0], corner[3][1] - corner[0][1], corner[3][2] - corner[0][2]) / (EARTH_CELL_M * blockScale)));
    const earthAt = (i, j, layer) => {
      const u = i / cellsAcross, w = j / cellsUp, q = new Float32Array(STRIDE);
      for (let c = 0; c < 3; c++) q[c] = (1 - w) * ((1 - u) * corner[0][c] + u * corner[1][c]) + w * ((1 - u) * corner[3][c] + u * corner[2][c]);
      const depth = CORE_DEPTH + 0.75 * blockNoise(Math.round(q[0] * 2) * 3.1 + Math.round(q[1] * 2) * 7.7 + Math.round(q[2] * 2) * 13.3, 7) + layer * EARTH_THICK_M;
      for (let c = 0; c < 3; c++) { q[c] -= n[c] * depth; q[3 + c] = n[c] * RAW_SURFACE; }
      q[6] = 16.125; q[7] = 0.46;
      return q;
    };
    for (let layer = 0; layer < EARTH_LAYERS; layer++) for (let j = 0; j < cellsUp; j++) for (let i = 0; i < cellsAcross; i++) {
      const corners = [earthAt(i, j, layer), earthAt(i + 1, j, layer), earthAt(i + 1, j + 1, layer), earthAt(i, j + 1, layer)];
      // In a fort drawn to its ground a wall may stand close across a bastion from another: earth stays inside the line.
      if (instance.trace && corners.some((q) => { const [lx, , lz] = toLocal(q[0], q[1], q[2]); return depthInOutline(instance.trace.outline, lx, lz) < EARTH_THICK_M * 0.6; })) continue;
      const top = Math.max(corners[0][1], corners[1][1], corners[2][1], corners[3][1]);
      if (top < Math.max(groundAt(corners[0][0], corners[0][2]), -0.6) + 0.02) continue;
      const clod = newShard(BUILDING_SHARD_KINDS.block, part, { timber: false, span: 1 });
      shards[clod].earth = true;
      geometry[clod].blocks.push({ corners, depth: EARTH_THICK_M / RAW_SURFACE });
    }
  }
  geometry[0].cores.length = 0;
  let vertexRoom = 0, indexRoom = 0;
  for (const { faces: ownFaces, blocks, cores } of geometry) {
    for (const face of ownFaces) { vertexRoom += face.v.length; indexRoom += face.v.length === 4 ? 6 : 3; }
    for (const { depth } of blocks) { vertexRoom += depth > 0 ? 24 : 4; indexRoom += depth > 0 ? 36 : 6; }
  }
  const out = new Float32Array(vertexRoom * STRIDE), outIndices = new Uint32Array(indexRoom), vertexShards = new Uint32Array(vertexRoom);
  let vertexCount = 0, indexCount = 0;
  const pushVertex = (s, x, y, z, nx, ny, nz, kind, shade) => {
    const at = vertexCount * STRIDE;
    out[at] = x; out[at + 1] = y; out[at + 2] = z; out[at + 3] = nx; out[at + 4] = ny; out[at + 5] = nz; out[at + 6] = kind; out[at + 7] = shade;
    vertexShards[vertexCount] = s;
    return vertexCount++;
  };
  const pushQuadIndices = (v) => {
    outIndices[indexCount] = v; outIndices[indexCount + 1] = v + 1; outIndices[indexCount + 2] = v + 2;
    outIndices[indexCount + 3] = v; outIndices[indexCount + 4] = v + 2; outIndices[indexCount + 5] = v + 3;
    indexCount += 6;
  };
  const noteBounds = (shard, x, y, z) => {
    if (x < shard.min[0]) shard.min[0] = x;
    if (y < shard.min[1]) shard.min[1] = y;
    if (z < shard.min[2]) shard.min[2] = z;
    if (x > shard.max[0]) shard.max[0] = x;
    if (y > shard.max[1]) shard.max[1] = y;
    if (z > shard.max[2]) shard.max[2] = z;
  };
  const emitQuad = (s, p, nx, ny, nz, kind, shade) => {
    const v = pushVertex(s, p[0][0], p[0][1], p[0][2], nx, ny, nz, kind, shade);
    pushVertex(s, p[1][0], p[1][1], p[1][2], nx, ny, nz, kind, shade);
    pushVertex(s, p[2][0], p[2][1], p[2][2], nx, ny, nz, kind, shade);
    pushVertex(s, p[3][0], p[3][1], p[3][2], nx, ny, nz, kind, shade);
    pushQuadIndices(v);
    if (s) for (let i = 0; i < 4; i++) noteBounds(shards[s], p[i][0], p[i][1], p[i][2]);
  };
  for (let s = 0; s < geometry.length; s++) {
    if (s % 256 === 0) yield 'mesh';
    const shard = shards[s], { faces: ownFaces, blocks, cores } = geometry[s];
    const remap = new Map();
    for (const face of ownFaces) {
      const ids = face.v.map((v) => {
        let mapped = remap.get(v);
        if (mapped === undefined) {
          const at = v * STRIDE;
          const up = face.groundUp ? -1 : 1;
          mapped = pushVertex(s, vertices[at], vertices[at + 1], vertices[at + 2], vertices[at + 3] * up, vertices[at + 4] * up, vertices[at + 5] * up, vertices[at + 6], face.groundUp ? Math.max(vertices[at + 7], 0.72) : vertices[at + 7]);
          remap.set(v, mapped);
          if (shard) noteBounds(shard, vertices[at], vertices[at + 1], vertices[at + 2]);
        }
        return mapped;
      });
      if (ids.length === 4) { outIndices.set([ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]], indexCount); indexCount += 6; }
      else { outIndices.set(ids, indexCount); indexCount += 3; }
      if (shard) {
        const at = face.v[0] * STRIDE;
        const size = (face.max[0] - face.min[0]) + (face.max[1] - face.min[1]) + (face.max[2] - face.min[2]);
        shard.normalSum[0] += vertices[at + 3] * size;
        shard.normalSum[1] += vertices[at + 4] * size;
        shard.normalSum[2] += vertices[at + 5] * size;
      }
    }
    for (const { corners: front, depth } of blocks) {
      const rawKind = front[0][6] >= 19.5 ? 11.125 : front[0][6];
      const v = pushVertex(s, front[0][0], front[0][1], front[0][2], front[0][3], front[0][4], front[0][5], front[0][6], front[0][7]);
      for (let i = 1; i < 4; i++) pushVertex(s, front[i][0], front[i][1], front[i][2], front[i][3], front[i][4], front[i][5], front[i][6], front[i][7]);
      pushQuadIndices(v);
      if (shard) for (const q of front) noteBounds(shard, q[0], q[1], q[2]);
      if (depth <= 0) continue;
      const back = front.map((q) => [q[0] - q[3] * depth, q[1] - q[4] * depth, q[2] - q[5] * depth]);
      const n = unitOf([front[0][3] + front[2][3], front[0][4] + front[2][4], front[0][5] + front[2][5]]);
      const shade = Math.min(front[0][7], front[1][7], front[2][7], front[3][7]) * 0.82;
      emitQuad(s, [back[3], back[2], back[1], back[0]], -n[0] * RAW_SURFACE, -n[1] * RAW_SURFACE, -n[2] * RAW_SURFACE, rawKind, shade);
      const midX = (front[0][0] + front[2][0]) * 0.5, midY = (front[0][1] + front[2][1]) * 0.5, midZ = (front[0][2] + front[2][2]) * 0.5;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4, ax = front[i], bx = front[j];
        let side = unitOf(crossOf([bx[0] - ax[0], bx[1] - ax[1], bx[2] - ax[2]], n));
        if (side[0] * (ax[0] - midX) + side[1] * (ax[1] - midY) + side[2] * (ax[2] - midZ) < 0) side = [-side[0], -side[1], -side[2]];
        emitQuad(s, [[ax[0], ax[1], ax[2]], [bx[0], bx[1], bx[2]], back[j], back[i]], side[0] * RAW_SURFACE, side[1] * RAW_SURFACE, side[2] * RAW_SURFACE, rawKind, shade);
      }
      if (shard) {
        shard.volume += Math.hypot(front[1][0] - front[0][0], front[1][1] - front[0][1], front[1][2] - front[0][2]) * Math.hypot(front[3][0] - front[0][0], front[3][1] - front[0][1], front[3][2] - front[0][2]) * depth;
        shard.normalSum[0] += n[0]; shard.normalSum[1] += n[1]; shard.normalSum[2] += n[2];
      }
    }
  }
  yield 'mesh';

  // What each shard is, in the building's own frame.
  for (let s = 1; s < shards.length; s++) {
    const shard = shards[s];
    const a = toLocal(shard.min[0], shard.min[1], shard.min[2]), b = toLocal(shard.max[0], shard.min[1], shard.min[2]);
    const c = toLocal(shard.min[0], shard.max[1], shard.max[2]), d = toLocal(shard.max[0], shard.max[1], shard.max[2]);
    shard.localMin = [Math.min(a[0], b[0], c[0], d[0]), shard.min[1], Math.min(a[2], b[2], c[2], d[2])];
    shard.localMax = [Math.max(a[0], b[0], c[0], d[0]), shard.max[1], Math.max(a[2], b[2], c[2], d[2])];
    shard.centroid = [(shard.min[0] + shard.max[0]) * 0.5, (shard.min[1] + shard.max[1]) * 0.5, (shard.min[2] + shard.max[2]) * 0.5];
    if (!shard.volume) shard.volume = Math.max(0.02, (shard.max[0] - shard.min[0]) * (shard.max[1] - shard.min[1]) * (shard.max[2] - shard.min[2]) * 0.4);
    shard.normal = unitOf(shard.normalSum);
    delete shard.normalSum;
  }

  yield* linkShards(shards);
  // The highest floor at or below a height: a storey can stand over the place a stone comes down.
  const floorAt = (x, z, below = Infinity) => {
    const [lx, , lz] = toLocal(x, 0, z), list = floors.get(floorKey(lx, lz));
    let best = -Infinity;
    if (list) for (const y of list) if (y <= below && y > best) best = y;
    return best;
  };
  anchorShards(shards, groundAt, floorAt);
  yield 'anchors';

  const rest = out.slice(0, vertexCount * STRIDE);
  // What was inside the wall is not drawn while the wall stands: its triangles begin as points, and open
  // when the pose pass first reaches a shard that a break has exposed. So the tiler pays for none of them.
  const initial = rest.slice();
  for (let v = 0; v < vertexCount; v++) {
    const s = vertexShards[v];
    // The earth touches no stone to tell it the facing in front has gone, so it is always there.
    if (!s || shards[s].earth) continue;
    const at = v * STRIDE;
    if (rest[at + 3] * rest[at + 3] + rest[at + 4] * rest[at + 4] + rest[at + 5] * rest[at + 5] < RAW_LENGTH_SQUARED) continue;
    const c = shards[s].centroid;
    initial[at] = c[0]; initial[at + 1] = c[1]; initial[at + 2] = c[2];
  }
  const finalIndices = outIndices.slice(0, indexCount);
  const fracture = Object.freeze({
    instanceIndex, prefabId: instance.prefabId ?? null,
    firstIndex, indexCount: endIndex - firstIndex, blockScale,
    surface: Object.freeze({ vertices: rest, indices: finalIndices }),
    reach: reachOfSurface(rest, finalIndices, toLocal),
    scale: Object.freeze([1, 1, 1]),
    toughness: fortified ? 1.4 : materialClass === 'timber' ? 0.8 : 1,
    shardCount: shards.length, vertexShards: vertexShards.slice(0, vertexCount),
    shards: Object.freeze(shards),
    strikable: Object.freeze(shards.filter(Boolean).map((s) => s.index)),
    guns: Object.freeze(shards.filter((s) => s?.kind === BUILDING_SHARD_KINDS.gun).map((s) => s.index)),
    toLocal, toWorld, groundAt, floorAt, originX, originZ,
  });
  return { vertices: rest, initial, indices: finalIndices, fracture };
}

function reachOfSurface(vertices, indices, toLocal) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i] * STRIDE, local = toLocal(vertices[at], vertices[at + 1], vertices[at + 2]);
    for (let c = 0; c < 3; c++) {
      if (local[c] < min[c]) min[c] = local[c];
      if (local[c] > max[c]) max[c] = local[c];
    }
  }
  return Object.freeze({ min, max });
}

// Touching shards are linked. A link says whether one rests on the other, or only stands beside it.
function* linkShards(shards) {
  const cell = 2.5, grid = new Map();
  const key = (x, y, z) => (x + 1024) * 4398046511104 + (y + 1024) * 2097152 + (z + 1024);
  for (let s = 1; s < shards.length; s++) {
    const shard = shards[s], lo = shard.localMin, hi = shard.localMax;
    const x0 = Math.floor((lo[0] - TOUCH) / cell), x1 = Math.floor((hi[0] + TOUCH) / cell);
    const y0 = Math.floor((lo[1] - TOUCH) / cell), y1 = Math.floor((hi[1] + TOUCH) / cell);
    const z0 = Math.floor((lo[2] - TOUCH) / cell), z1 = Math.floor((hi[2] + TOUCH) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = key(x, y, z), list = grid.get(k);
      if (list) list.push(s); else grid.set(k, [s]);
    }
    if (s % 512 === 0) yield 'links';
  }
  const seen = new Set();
  let visited = 0;
  for (const list of grid.values()) {
    if (++visited % 128 === 0) yield 'links';
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const lowIndex = Math.min(list[i], list[j]), highIndex = Math.max(list[i], list[j]), pair = lowIndex * 1048576 + highIndex;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const a = shards[lowIndex], b = shards[highIndex];
      const overX = Math.min(a.localMax[0], b.localMax[0]) - Math.max(a.localMin[0], b.localMin[0]);
      const overY = Math.min(a.localMax[1], b.localMax[1]) - Math.max(a.localMin[1], b.localMin[1]);
      const overZ = Math.min(a.localMax[2], b.localMax[2]) - Math.max(a.localMin[2], b.localMin[2]);
      if (overX < -TOUCH || overY < -TOUCH || overZ < -TOUCH) continue;
      a.links.push(b.index);
      b.links.push(a.index);
      // Sharing a footprint and clear of each other in height: one rests on the other.
      const sharedFootprint = Math.max(overX, overZ) > 0.12 && Math.min(overX, overZ) > -TOUCH;
      const heightA = a.localMax[1] - a.localMin[1], heightB = b.localMax[1] - b.localMin[1];
      const stacked = sharedFootprint && overY < Math.max(TOUCH, 0.3 * Math.min(heightA, heightB));
      if (stacked && a.centroid[1] > b.centroid[1]) { a.below.push(b.index); b.above.push(a.index); }
      else if (stacked && b.centroid[1] > a.centroid[1]) { b.below.push(a.index); a.above.push(b.index); }
      else if (overY > 0.2 * Math.min(heightA, heightB)) { a.side.push(b.index); b.side.push(a.index); }
    }
  }
}

/**
 * What holds. Support climbs from what is anchored, up through whatever rests on what. A stone can also
 * hang from the stone beside it, for its span and no further, and the stone on top of that one is a step
 * better off. So a small hole stands as an arch, and a wide breach brings down a triangle of wall above it.
 * Returns how far each shard hangs from its support, NOT_HELD if nothing holds it.
 */
export function supportScan(fracture, broken) {
  const shards = fracture.shards, hang = new Uint8Array(shards.length).fill(NOT_HELD), stack = [];
  for (let s = 1; s < shards.length; s++) if (!broken[s] && shards[s].anchored) { hang[s] = 0; stack.push(s); }
  while (stack.length) {
    const s = stack.pop(), reach = hang[s], shard = shards[s];
    const onTop = reach > 0 ? reach - 1 : 0;
    for (const t of shard.above) if (!broken[t] && onTop < hang[t]) { hang[t] = onTop; stack.push(t); }
    const beside = reach + 1;
    for (const t of shard.side) if (!broken[t] && beside <= shards[t].span && beside < hang[t]) { hang[t] = beside; stack.push(t); }
  }
  return hang;
}

function anchorShards(shards, groundAt, floorAt) {
  for (let s = 1; s < shards.length; s++) {
    const shard = shards[s], x = shard.centroid[0], z = shard.centroid[2];
    const ground = Math.max(groundAt(x, z), -0.6), lowest = shard.min[1];
    if (lowest <= ground + 0.4) { shard.anchored = true; continue; }
    if (!shard.below.length && lowest - floorAt(x, z, lowest + 0.6) < 0.6) shard.anchored = true;
  }
  // An intact building stands, whatever the geometry says. A roof's eaves overhang the walls they sit on, so what
  // nothing holds yet is first tied to what stands just under it. Only with nothing there is it fixed where it is.
  const broken = new Uint8Array(shards.length);
  for (let pass = 0; pass < 6; pass++) {
    const hang = supportScan({ shards }, broken), seen = new Uint8Array(shards.length);
    let loose = false;
    for (let s = 1; s < shards.length; s++) {
      if (hang[s] !== NOT_HELD || seen[s]) continue;
      loose = true;
      const stack = [s], component = [];
      seen[s] = 1;
      while (stack.length) {
        const shard = shards[stack.pop()];
        component.push(shard);
        for (const n of shard.links) if (!seen[n] && hang[n] === NOT_HELD) { seen[n] = 1; stack.push(n); }
      }
      const base = Math.min(...component.map((shard) => shard.min[1]));
      const lowest = component.filter((shard) => shard.min[1] <= base + 0.5);
      let tied = false;
      for (const shard of lowest) {
        const lo = shard.localMin, hi = shard.localMax;
        for (let c = 1; c < shards.length; c++) {
          const t = shards[c];
          if (hang[c] === NOT_HELD || t.localMax[1] > lo[1] + 0.3 || t.localMax[1] < lo[1] - TIE_REACH) continue;
          if (t.localMax[0] < lo[0] - TIE_REACH || t.localMin[0] > hi[0] + TIE_REACH || t.localMax[2] < lo[2] - TIE_REACH || t.localMin[2] > hi[2] + TIE_REACH) continue;
          if (shard.links.includes(c)) { if (!shard.below.includes(c)) { shard.below.push(c); t.above.push(shard.index); } tied = true; continue; }
          shard.links.push(c); t.links.push(shard.index);
          shard.below.push(c); t.above.push(shard.index);
          tied = true;
        }
      }
      if (!tied) for (const shard of lowest) shard.anchored = true;
    }
    if (!loose) return;
  }
  const hang = supportScan({ shards }, broken);
  for (let s = 1; s < shards.length; s++) if (hang[s] === NOT_HELD) shards[s].anchored = true;
}

export function createBuildingFractureState(fracture) {
  const state = createShipFractureState(fracture);
  state.scorch = new Float32Array(fracture.shardCount);
  state.scorchDirty = false;
  state.heap = new Map();
  return state;
}

export function buildingFractureStateOf(damage, fracture) {
  if (!damage || !fracture) return null;
  if (damage.fracture?.fracture !== fracture) damage.fracture = createBuildingFractureState(fracture);
  return damage.fracture;
}

function breakBuildingShard(state, s) {
  if (state.broken[s]) return false;
  state.broken[s] = 1;
  state.brokenCount++;
  return true;
}

// Rubble lands on rubble. The heap is coarse and only ever grows, and it is read only when a block lets go.
const HEAP_CELL = 1.5, HEAP_REPOSE = 0.55, SHOCK_REACH_M = 6, STRUCK_M = 0.3;
const heapKey = (x, z) => (Math.floor(x / HEAP_CELL) + 32768) * 65536 + (Math.floor(z / HEAP_CELL) + 32768);

function rollDownHeap(state, x, z) {
  for (let step = 0; step < 8; step++) {
    const here = state.heap.get(heapKey(x, z)) ?? 0;
    let bestX = x, bestZ = z, best = here - HEAP_REPOSE;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue;
      const nx = x + dx * HEAP_CELL, nz = z + dz * HEAP_CELL, there = state.heap.get(heapKey(nx, nz)) ?? 0;
      if (there < best) { best = there; bestX = nx; bestZ = nz; }
    }
    if (bestX === x && bestZ === z) break;
    x = bestX; z = bestZ;
  }
  return [x, z];
}

function restHeight(fracture, shard, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), pivot = shard.centroid, lo = shard.localMin, hi = shard.localMax;
  let lowest = 0;
  for (let i = 0; i < 8; i++) {
    const w = fracture.toWorld(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
    const r = [w[0] - pivot[0], w[1] - pivot[1], w[2] - pivot[2]], k = dotOf(axis, r), m = crossOf(axis, r);
    const y = r[1] * c + m[1] * s + axis[1] * k * (1 - c);
    if (y < lowest) lowest = y;
  }
  return -lowest;
}

// A shard that has lost a neighbour shows the faces that were hidden against it. Any scorch above zero makes
// the pose pass draw them, so a touch of it is enough.
function exposeNeighbours(state, shard) {
  for (const n of shard.links) {
    if (state.scorch[n] > 0) continue;
    state.scorch[n] = 1e-3;
    state.scorchDirty = true;
  }
}

// A piece leaves. It lands on whatever is beneath the place it comes down, lying more or less flat, and
// it stays there. Timber over water floats a while instead, then is gone.
function releaseShard(state, s, now, { direction = null, power = 1, up = 1, drop = false, delay = 0 } = {}) {
  const fracture = state.fracture, shard = fracture.shards[s];
  if (!shard || !breakBuildingShard(state, s)) return false;
  exposeNeighbours(state, shard);
  const a = blockNoise(s, 1), b = blockNoise(s, 2), c = blockNoise(s, 3);
  const out = direction ?? shard.normal, pivot = shard.centroid;
  const velocity = drop
    ? [out[0] * (0.2 + 0.7 * a) + (b - 0.5) * 0.5, 0, out[2] * (0.2 + 0.7 * a) + (c - 0.5) * 0.5]
    : [out[0] * (0.5 + 1.8 * a) * power + (b - 0.5) * 1.4, (0.3 + 1.6 * b) * up * power, out[2] * (0.5 + 1.8 * a) * power + (c - 0.5) * 1.4];
  // Turn about a level axis across the way it goes. A block off a wall lands on its broad face, a quarter or
  // three quarters of a turn over. A slab of roof or floor stays about as flat as it was. All a little off true.
  const across = unitOf(crossOf([0, 1, 0], [out[0] || 1e-3, 0, out[2]])), tilt = (a - 0.5) * 0.32;
  const axis = unitOf([across[0] + tilt * 0.5, tilt, across[2] - tilt * 0.5]);
  const flat = Math.abs(shard.normal[1]) > 0.5, off = (c - 0.5) * 0.7;
  const angle = (flat ? (b > 0.72 ? Math.PI : 0) : (b > 0.72 ? 1.5 * Math.PI : 0.5 * Math.PI)) + off;
  const half = restHeight(fracture, shard, axis, angle);
  const bury = Math.min(0.05, half * 0.15);
  // It comes down about here. Then it rolls off whatever heap is already there, down to the angle of repose.
  let settle = 0.2, landX = pivot[0], landZ = pivot[2], restY = pivot[1], water = false;
  for (let i = 0; i < 3; i++) {
    if (i === 2) [landX, landZ] = rollDownHeap(state, landX, landZ);
    const ground = Math.max(fracture.groundAt(landX, landZ), fracture.floorAt(landX, landZ, pivot[1]));
    water = shard.timber && ground < -0.2;
    const heap = water ? 0 : state.heap.get(heapKey(landX, landZ)) ?? 0;
    // It never lands higher than it started.
    restY = Math.min(pivot[1], (water ? 0.02 : ground + heap) + half - bury);
    settle = Math.max(0.16, (velocity[1] + Math.sqrt(velocity[1] * velocity[1] + 2 * FRACTURE_GRAVITY * (pivot[1] - restY))) / FRACTURE_GRAVITY);
    if (i < 2) {
      landX = pivot[0] + velocity[0] * settle;
      landZ = pivot[2] + velocity[2] * settle;
    }
  }
  velocity[0] = (landX - pivot[0]) / settle;
  velocity[2] = (landZ - pivot[2]) / settle;
  // The clock takes it from here to exactly its resting height. The record has no bounce to carry.
  const fall = pivot[1] + velocity[1] * settle - 0.5 * FRACTURE_GRAVITY * settle * settle - restY;
  const gravity = 1 + (2 * fall) / (FRACTURE_GRAVITY * settle * settle);
  if (!water) {
    const key = heapKey(landX, landZ);
    state.heap.set(key, (state.heap.get(key) ?? 0) + (shard.volume * 1.4) / (HEAP_CELL * HEAP_CELL));
  }
  const rate = angle / settle;
  writeFlight(state, s, {
    pivot, velocity, spin: axis.map((v) => v * rate), gravity, settle, delay,
    keep: !water, sink: water ? 0.05 : 0, linger: water ? 25 + 25 * a : 0,
  }, now);
  return true;
}

function releaseUnsupportedBlocks(state, now) {
  const fracture = state.fracture, hang = supportScan(fracture, state.broken);
  let released = 0;
  for (const s of fracture.strikable) {
    if (state.broken[s] || hang[s] !== NOT_HELD) continue;
    if (releaseShard(state, s, now, { drop: true, delay: 0.04 + 0.5 * blockNoise(s, 4) })) released++;
  }
  return released;
}

function distanceMetres(shard, local) {
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const d = local[c] < shard.localMin[c] ? shard.localMin[c] - local[c] : local[c] > shard.localMax[c] ? local[c] - shard.localMax[c] : 0;
    // A shock travels up a wall more easily than down it.
    sum += c === 1 ? (d * (local[1] < shard.localMin[1] ? 0.7 : 1.1)) ** 2 : d * d;
  }
  return Math.sqrt(sum);
}

// A ball that has struck what cannot break, not a piece: how far off the nearest thing still standing lies, if
// near enough to feel the shock, so what stands round the hole goes on falling.
function rimOfBreach(state, point) {
  const { shards, strikable, toLocal } = state.fracture, local = toLocal(point[0], point[1], point[2]);
  let nearest = Infinity;
  for (const s of strikable) {
    if (state.broken[s]) continue;
    const d = distanceMetres(shards[s], local);
    if (d < STRUCK_M) return 0;
    if (d < nearest) nearest = d;
  }
  return nearest < SHOCK_REACH_M ? nearest : 0;
}

function strikeBuilding(state, point, normal, { radius, amount, power, now, drop = false, radial = false, above = -Infinity }) {
  const { shards, strikable, toLocal } = state.fracture, local = toLocal(point[0], point[1], point[2]);
  let broke = 0;
  for (const s of strikable) {
    if (state.broken[s]) continue;
    const shard = shards[s];
    if (shard.max[1] < above) continue;
    const d = distanceMetres(shard, local);
    if (d >= radius) continue;
    state.touched = true;
    const fall = 1 - (d / radius) ** 2, burn = (amount * fall) / (shard.earth ? EARTH_HARDNESS : 1);
    state.wear[s] += burn;
    state.scorch[s] = Math.min(0.5, state.scorch[s] + burn * 0.35);
    state.scorchDirty = true;
    if (state.wear[s] < 1) continue;
    const away = radial ? unitOf(vectorBetween(shard.centroid, point)) : dotOf(shard.normal, normal) > -0.25 ? shard.normal : normal;
    if (releaseShard(state, s, now, { direction: away, power, drop, delay: drop ? 0.03 + 0.35 * blockNoise(s, 8) : 0 })) broke++;
  }
  return broke;
}

// Knocked off its trucks, and left where it lands.
function dismountBuildingGun(state, point, side, now) {
  const { shards, guns } = state.fracture;
  let best = -1, bestDistance = 6;
  for (const s of guns) {
    if (state.broken[s]) continue;
    const c = shards[s].centroid, d = Math.hypot(c[0] - point[0], c[1] - point[1], c[2] - point[2]);
    if (d < bestDistance) { bestDistance = d; best = s; }
  }
  if (best < 0 || !breakBuildingShard(state, best)) return 0;
  const slew = blockNoise(best, 6) >= 0.5 ? 1 : -1, shard = shards[best];
  writeFlight(state, best, { pivot: shard.centroid, velocity: [-side[0] * 1.6, -0.5, -side[2] * 1.6], spin: [0.5 * slew, 1.6 * slew, 0.7], gravity: 0, settle: 0.32, keep: true }, now);
  return 1;
}

/**
 * Turn damage events into releases. Events are the `damageState.pendingBakes` the gunnery code queues. Pure
 * JavaScript with no graphics device, called only when a building is hit.
 */
export function applyBuildingFractureEvents(fracture, damage, events, now = 0) {
  const state = buildingFractureStateOf(damage, fracture);
  if (!state) return 0;
  let total = 0;
  for (const raw of events) {
    if (!raw) continue;
    // Rounded as the save rounds it, so a replay lands every piece exactly here.
    const text = encodeBuildingEvent(raw, fracture.originX, fracture.originZ), event = decodeBuildingEvent(text, 0, fracture.originX, fracture.originZ);
    const point = [event.x, event.y, event.z];
    const normal = unitOf([event.nx, event.ny, event.nz || 0.001]);
    const severity = Math.max(0.25, event.severity || 0.6);
    let released = 0;
    state.touched = false;
    if (event.kind === 'cannon-dismount') {
      released = dismountBuildingGun(state, point, normal, now);
      if (released) state.touched = true;
    } else if (event.kind === 'building-explosion') {
      const powder = Math.max(0.25, Math.min(1, event.powderFraction || 0.85));
      released = strikeBuilding(state, point, normal, { radius: Math.max(9.5, Math.min(18, (event.radius || 8.5) * 1.25)), amount: (1.2 + 1.6 * powder) / fracture.toughness, power: 1.4 + 2 * powder, now, radial: true });
    } else if (event.kind === 'building-collapse') {
      // The floors and roof give way where the wall has been pounded. It falls, it is not thrown.
      released = strikeBuilding(state, point, normal, { radius: Math.max(4.5, Math.min(10.5, (event.radius || 5.5) * 1.05)), amount: (0.45 + 0.5 * severity) / (fracture.toughness * fracture.toughness), power: 0.5, now, drop: true, above: point[1] - 1.5 });
    } else {
      const penetrating = event.stepDepth >= 0.4;
      const radius = (penetrating ? 1.75 : 1.15) * Math.max(0.7, Math.min(1.25, severity));
      const amount = ((penetrating ? 1.5 : 0.5) * severity) / fracture.toughness;
      // Into bare earth, the shock reaches what stands round the hole, so a breach goes on widening.
      released = strikeBuilding(state, point, normal, { radius: radius + rimOfBreach(state, point), amount, power: 0.7 + severity * 0.55, now });
    }
    // Support is settled after each hit, so it makes no difference how they were batched.
    if (released) released += releaseUnsupportedBlocks(state, now);
    total += released;
    // A hit on what has already gone changes nothing, and is not worth keeping.
    if (state.touched) damage.fractureLog = (damage.fractureLog ?? '') + text;
  }
  return total;
}

// What rubble or a falling man comes to rest on at a place, from a given height: the ground, a floor under him,
// and whatever heap is there already. Read when something lets go, never by the frame.
export function restingHeightUnder(state, x, z, below = Infinity) {
  const { fracture } = state;
  return Math.max(fracture.groundAt(x, z), fracture.floorAt(x, z, below)) + (state.heap.get(heapKey(x, z)) ?? 0);
}

const FOOT_MARGIN = 0.2, FOOT_REACH = 1.1;
// What a man at a point of this building has under his feet, in its own frame. `shards` narrows the search.
// `stood` says the building ever had anything there, and `stands` that it still does. `floor` is what stays
// within a step below him, if that is all that is left.
export function footingUnder(state, localX, y, localZ, shards = state.fracture.shards) {
  const { fracture, broken } = state;
  let stood = false, stands = false;
  for (const shard of shards) {
    if (!shard) continue;
    const lo = shard.localMin, hi = shard.localMax;
    if (lo[1] > y + FOOT_MARGIN || hi[1] < y - FOOT_REACH) continue;
    if (localX < lo[0] - FOOT_MARGIN || localX > hi[0] + FOOT_MARGIN || localZ < lo[2] - FOOT_MARGIN || localZ > hi[2] + FOOT_MARGIN) continue;
    stood = true;
    if (!broken[shard.index]) { stands = true; break; }
  }
  const world = fracture.toWorld(localX, y, localZ), level = fracture.floorAt(world[0], world[2], y + FOOT_MARGIN);
  const floor = y - level <= FOOT_REACH ? level : null;
  return { stood: stood || floor !== null, stands: stands || floor !== null, floor: stands ? null : floor };
}

// Where a line enters a box, along it, or Infinity. The line runs both ways: `t` may lie behind its start.
// The nearest triangle ahead on the line from-to, as a fraction of it. `standing` says which triangles are still there.
function lineEntersTriangles(from, to, vertices, indices, firstIndex, endIndex, standing = null) {
  const ox = from[0], oy = from[1], oz = from[2], dx = to[0] - ox, dy = to[1] - oy, dz = to[2] - oz;
  let nearest = Infinity;
  for (let i = firstIndex; i < endIndex; i += 3) {
    if (standing && !standing(indices[i])) continue;
    const a = indices[i] * STRIDE, b = indices[i + 1] * STRIDE, c = indices[i + 2] * STRIDE;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
    const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const f = 1 / det, sx = ox - ax, sy = oy - ay, sz = oz - az;
    const u = f * (sx * px + sy * py + sz * pz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) continue;
    const t = f * (e2x * qx + e2y * qy + e2z * qz);
    if (t >= 0 && t < nearest) nearest = t;
  }
  return nearest;
}

/**
 * What a shot meets on the line from `from` to `to`, in world metres, given what has left. A building is one box
 * to the sweep, and the pieces decide here. `t` is the next thing standing, as a fraction along from-to, and
 * Infinity if it passes clean through. Null means there are no pieces to ask.
 */
export function traceShotThroughBreach(state, from, to) {
  if (!state) return null;
  const { fracture, broken } = state, { shards, surface, vertexShards } = fracture;
  // A dismounted gun lies on the deck, still in the way.
  const standing = (vertex) => {
    const s = vertexShards[vertex];
    return !broken[s] || shards[s]?.kind === BUILDING_SHARD_KINDS.gun;
  };
  return { t: lineEntersTriangles(from, to, surface.vertices, surface.indices, 0, surface.indices.length, state.brokenCount ? standing : null) };
}

const buildingMeshes = new WeakMap();

// Until a building has been cut into pieces, a shot meets the mesh it was drawn from.
export function noteBuildingMeshes(port, geometry) {
  const instances = port?.instances, parts = geometry?.partAssembly?.parts;
  if (!Array.isArray(instances) || !parts || !geometry.vertices || !geometry.indices) return;
  const ranges = new Map();
  for (const part of parts) {
    if (!(part.indexCount > 0)) continue;
    const range = ranges.get(part.instanceIndex);
    if (!range) ranges.set(part.instanceIndex, [part.firstIndex, part.firstIndex + part.indexCount]);
    else { range[0] = Math.min(range[0], part.firstIndex); range[1] = Math.max(range[1], part.firstIndex + part.indexCount); }
  }
  for (const [index, [firstIndex, endIndex]] of ranges) {
    const instance = instances[index];
    if (!instance) continue;
    const cosY = Math.cos(instance.yaw ?? 0), sinY = Math.sin(instance.yaw ?? 0), originX = instance.x ?? 0, originZ = instance.z ?? 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = firstIndex; i < endIndex; i++) {
      const at = geometry.indices[i] * STRIDE, dx = geometry.vertices[at] - originX, dz = geometry.vertices[at + 2] - originZ;
      const lx = dx * cosY - dz * sinY, ly = geometry.vertices[at + 1], lz = dx * sinY + dz * cosY;
      if (lx < min[0]) min[0] = lx; if (lx > max[0]) max[0] = lx;
      if (ly < min[1]) min[1] = ly; if (ly > max[1]) max[1] = ly;
      if (lz < min[2]) min[2] = lz; if (lz > max[2]) max[2] = lz;
    }
    buildingMeshes.set(instance, { vertices: geometry.vertices, indices: geometry.indices, firstIndex, endIndex, min, max });
  }
}

// How far a building really reaches, in its own frame with heights as they stand: its nominal box does not say.
export function buildingReach(instance) {
  const pieces = instance?.damageState?.fracture?.fracture?.reach;
  return pieces ?? buildingMeshes.get(instance) ?? null;
}

// What a shot meets on its way through a building. Null if it is known only by its box.
export function traceShotAtBuilding(instance, from, to) {
  const state = instance?.damageState?.fracture;
  if (state) return traceShotThroughBreach(state, from, to);
  const mesh = buildingMeshes.get(instance);
  return mesh ? { t: lineEntersTriangles(from, to, mesh.vertices, mesh.indices, mesh.firstIndex, mesh.endIndex) } : null;
}

// A building's damage is the hits it took. Replaying them gives every shard back exactly, so a save holds the
// hits and nothing else: sixteen characters each, close enough that the live hit is rounded the same way.
const LOG_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOG_KINDS = ['stone-crater', 'timber-splinter', 'cannon-dismount', 'building-explosion', 'building-collapse'];
const LOG_EVENT_LENGTH = 16;
const logDigits = (value, count) => {
  let out = '';
  for (let i = count - 1; i >= 0; i--) out += LOG_DIGITS[Math.floor(value / 64 ** i) % 64];
  return out;
};
const logValue = (text, at, count) => {
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 64 + LOG_DIGITS.indexOf(text[at + i]);
  return value;
};
const logClamp = (value, top) => Math.max(0, Math.min(top, Math.round(Number(value) || 0)));

export function encodeBuildingEvent(event, originX, originZ) {
  const kind = Math.max(0, LOG_KINDS.indexOf(event.kind));
  return logDigits(kind, 1)
    + logDigits(logClamp(((Number(event.x) || 0) - originX) * 50 + 131072, 262143), 3)
    + logDigits(logClamp(((Number(event.y) || 0) + 50) * 10, 4095), 2)
    + logDigits(logClamp(((Number(event.z) || 0) - originZ) * 50 + 131072, 262143), 3)
    + logDigits(logClamp(((Number(event.nx) || 0) + 1) * 31.5, 63), 1)
    + logDigits(logClamp(((Number(event.ny) || 0) + 1) * 31.5, 63), 1)
    + logDigits(logClamp(((Number(event.nz) || 0) + 1) * 31.5, 63), 1)
    + logDigits(logClamp((Number(event.severity) || 0) * 20, 63), 1)
    + logDigits(logClamp((Number(event.stepDepth) || 0) * 50, 63), 1)
    + logDigits(logClamp((Number(event.radius) || 0) * 2, 63), 1)
    + logDigits(logClamp((Number(event.powderFraction) || 0) * 63, 63), 1);
}

export function decodeBuildingEvent(text, at, originX, originZ) {
  return {
    kind: LOG_KINDS[logValue(text, at, 1)] ?? LOG_KINDS[0],
    x: (logValue(text, at + 1, 3) - 131072) / 50 + originX,
    y: logValue(text, at + 4, 2) / 10 - 50,
    z: (logValue(text, at + 6, 3) - 131072) / 50 + originZ,
    nx: logValue(text, at + 9, 1) / 31.5 - 1,
    ny: logValue(text, at + 10, 1) / 31.5 - 1,
    nz: logValue(text, at + 11, 1) / 31.5 - 1,
    severity: logValue(text, at + 12, 1) / 20,
    stepDepth: logValue(text, at + 13, 1) / 50,
    radius: logValue(text, at + 14, 1) / 2,
    powderFraction: logValue(text, at + 15, 1) / 63,
  };
}

// Every hit a saved building took, one after another. Nothing is seen to fall: each piece is simply where it lay.
export function replayBuildingFracture(fracture, damage, log, now = 0) {
  const state = buildingFractureStateOf(damage, fracture), events = [];
  for (let at = 0; at + LOG_EVENT_LENGTH <= log.length; at += LOG_EVENT_LENGTH) events.push(decodeBuildingEvent(log, at, fracture.originX, fracture.originZ));
  damage.fractureLog = '';
  applyBuildingFractureEvents(fracture, damage, events, now);
  settleFinishedFlights(state, Infinity);
  return state.brokenCount;
}

const fracturePipelines = new WeakMap();
export function buildingFracturePipeline(device) {
  let pipeline = fracturePipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipelineAsync({
      label: 'building fracture', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'building fracture', code: BUILDING_FRACTURE_POSE_UPDATE }), entryPoint: 'main' },
    });
    fracturePipelines.set(device, pipeline);
  }
  return pipeline;
}

// One building's own buffers, made when it is first struck. It replaces its range of the port's mesh.
export function createBuildingFractureGPU({ device, pipeline, prepared, state }) {
  const { fracture } = prepared, U = GPUBufferUsage;
  const upload = (data, usage, label) => {
    const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | U.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const name = `${fracture.prefabId ?? 'building'} ${fracture.instanceIndex}`;
  const vertices = upload(prepared.initial, U.VERTEX | U.STORAGE, `${name} fracture vertices`);
  const rest = upload(prepared.vertices, U.STORAGE, `${name} rest vertices`);
  const indices = upload(prepared.indices, U.INDEX, `${name} fracture indices`);
  const vertexShards = upload(fracture.vertexShards, U.STORAGE, `${name} vertex shards`);
  const records = upload(state.records, U.STORAGE, `${name} shard flights`);
  const scorch = upload(state.scorch, U.STORAGE, `${name} shard scorch`);
  const clockData = new Float32Array([0, FRACTURE_GRAVITY, 0, 0, 1, 1, 1, 0]);
  const clock = upload(clockData, U.UNIFORM, `${name} fracture clock`);
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [vertices, rest, vertexShards, records, clock, scorch].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const workgroups = Math.ceil(fracture.vertexShards.length / 64), indexCount = prepared.indices.length;
  let pose = false, destroyed = false;
  return {
    state, fracture, indexCount,
    get posing() { return pose; },
    // Once a frame. Nothing is written unless something changed, and only flights in the air need the clock.
    tick(now) {
      if (destroyed) return;
      const flying = state.flying.size > 0;
      if (flying) settleFinishedFlights(state, now);
      pose = flying;
      if (state.dirty.size) {
        const list = [...state.dirty].sort((a, b) => a - b);
        for (let i = 0; i < list.length;) {
          let j = i + 1;
          while (j < list.length && list[j] === list[j - 1] + 1) j++;
          device.queue.writeBuffer(records, list[i] * FRACTURE_RECORD_FLOATS * 4, state.records, list[i] * FRACTURE_RECORD_FLOATS, (j - i) * FRACTURE_RECORD_FLOATS);
          i = j;
        }
        state.dirty.clear();
        pose = true;
      }
      if (state.scorchDirty) {
        device.queue.writeBuffer(scorch, 0, state.scorch);
        state.scorchDirty = false;
        pose = true;
      }
      if (pose) {
        clockData[0] = now - state.epoch;
        device.queue.writeBuffer(clock, 0, clockData, 0, 1);
      }
    },
    encode(pass) {
      if (destroyed || !pose) return false;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(workgroups);
      return true;
    },
    draw(pass) {
      if (destroyed) return;
      pass.setVertexBuffer(0, vertices);
      pass.setIndexBuffer(indices, 'uint32');
      pass.drawIndexed(indexCount);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const buffer of [vertices, rest, indices, vertexShards, records, scorch, clock]) buffer.destroy();
    },
  };
}

/**
 * The fractured buildings of one port. A building joins the first time it is struck. Its mesh is built once,
 * its range of the port's index buffer is cleared once, and from then on a hit only writes flight records.
 */
export function createPortFractures({ device, port, geometry, portIndices, groundAt, damageStore = null, buildMillisecondsPerFrame = 3 }) {
  const live = new Map(), building = new Map();
  let pipeline = null, starting = null, frame = 0, lastNow = 0;
  noteBuildingMeshes(port, geometry);
  const finish = (instance, prepared) => {
    if (!prepared) { live.set(instance, null); return; }
    const damage = instance.damageState;
    const state = buildingFractureStateOf(damage, prepared.fracture);
    if (damage.replayLog) {
      replayBuildingFracture(prepared.fracture, damage, damage.replayLog, lastNow);
      damage.replayLog = null;
    }
    live.set(instance, createBuildingFractureGPU({ device, pipeline, prepared, state }));
    // From this frame the building draws from its own buffers. Once only.
    device.queue.writeBuffer(portIndices, prepared.fracture.firstIndex * 4, new Uint32Array(prepared.fracture.indexCount));
  };
  const stepsFor = (instance, instanceIndex) => prepareBuildingFractureSteps({
    vertices: geometry.vertices, indices: geometry.indices, catalog: geometry.partAssembly, instanceIndex, instance,
    materialClass: instance.damageState.materialClass ?? 'masonry', groundAt,
  });
  // A first hit waits a few frames in the queue while its building is cut, so nothing stalls a frame.
  const continueBuilding = () => {
    const deadline = performance.now() + buildMillisecondsPerFrame;
    for (const [instance, steps] of building) {
      for (;;) {
        const step = steps.next();
        if (step.done) { building.delete(instance); finish(instance, step.value); break; }
        if (performance.now() >= deadline) return;
      }
    }
  };
  // A rebuilt building draws from the port's mesh again, as it did before it was struck.
  const rebuild = (instance) => {
    const gpu = live.get(instance);
    if (gpu) {
      device.queue.writeBuffer(portIndices, gpu.fracture.firstIndex * 4, geometry.indices, gpu.fracture.firstIndex, gpu.fracture.indexCount);
      gpu.destroy();
    }
    live.delete(instance);
    building.delete(instance);
    damageStore?.rebuilt(port, instance);
  };
  return {
    // Before a port is first seen: anything saved as ruined is a ruin already, with no fall to watch.
    async restoreNow() {
      const instances = port?.instances ?? [];
      if (!instances.some((instance) => instance?.damageState?.replayLog)) return 0;
      pipeline ??= await buildingFracturePipeline(device);
      let restored = 0;
      for (let i = 0; i < instances.length; i++) {
        if (!instances[i]?.damageState?.replayLog || live.has(instances[i])) continue;
        const steps = stepsFor(instances[i], i);
        let step = steps.next();
        while (!step.done) step = steps.next();
        finish(instances[i], step.value);
        restored++;
      }
      return restored;
    },
    rebuild,
    // Once a frame, before the compute pass. Costs nothing until a building has been hit.
    update(now) {
      lastNow = now;
      const instances = port?.instances;
      if (Array.isArray(instances)) for (let i = 0; i < instances.length; i++) {
        const instance = instances[i], damage = instance?.damageState, pending = damage?.pendingBakes;
        if (!pending?.length && !damage?.replayLog) continue;
        if (!pipeline) {
          starting ??= buildingFracturePipeline(device).then((ready) => { pipeline = ready; }, (error) => console.error('Building fracture pipeline failed', error));
          continue;
        }
        if (!live.has(instance)) {
          if (!building.has(instance)) building.set(instance, stepsFor(instance, i));
          continue;
        }
        const gpu = live.get(instance);
        if (!pending?.length) continue;
        const events = pending.splice(0, pending.length);
        if (gpu) applyBuildingFractureEvents(gpu.fracture, damage, events, now);
        damageStore?.noteHit(damage);
      }
      if (building.size) continueBuilding();
      for (const gpu of live.values()) gpu?.tick(now);
      // Now and then, whether a town has finished rebuilding what was shot down.
      if (damageStore && Array.isArray(instances) && ++frame % 240 === 0) {
        for (const instance of instances) if (instance?.damageState?.hits && damageStore.rebuildDue(instance)) rebuild(instance);
      }
    },
    encode(pass) { for (const gpu of live.values()) gpu?.encode(pass); },
    draw(pass) { for (const gpu of live.values()) gpu?.draw(pass); },
    destroy() { for (const gpu of live.values()) gpu?.destroy(); live.clear(); building.clear(); },
  };
}
