// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a ball meets on a ship: the triangles she is drawn with, and no stand-in for them.
//  - Hull, decks, masts, yards, guns and fittings stop it. A piece that has left, and a mast that has fallen, do not.
//  - Canvas and rope do not stop it. It goes through them and tears them on the way.
//  - Yards and hatch lids stand where the GPU has moved them. Each moves as one rigid body, so the line is taken
//    into that body's rest frame, using the same CPU evaluators the rest of the game poses the rig with.
// Design units throughout, because that is the space the GPU moves things in. A linear map keeps a point's
// fraction along a line, so a hit here is a hit at the same fraction in the world. Built once per model.
import { lateenClothPoint, lateenRestPoint, lateenYardPoint, SAIL_PLAN } from './lateen.js';
import { VICTORY_SAILS, victorySailPoint } from './models/victory.js';
import { victoryClothPoint, victoryPose, victoryYardPoint } from './victory-motion.js';
import { rigSurfacePose, surfaceClothPoint, surfaceRestPoint, surfaceYardPoint } from './rig-surface.js';
import { proceduralRigContext } from './additional-rig.js';
import { resolveShipTransform } from './ship-parts.js';
import { SHARD_KINDS, shipMastSpecs } from './ship-fracture.js';

// Cloth, rope, and the bolt rope sewn to a sail's edge.
const SHIP_COLLIDER_CLOTH = new Set([9, 13]), SHIP_COLLIDER_BOLT_ROPE = 19, SHIP_COLLIDER_ROPE = new Set([2, 12]);
const SHIP_COLLIDER_SPAR_MATERIAL = 10, SHIP_COLLIDER_HATCH_MATERIAL = 18, SHIP_COLLIDER_RUNNING_ROPE_UV = 100;
// Flags are cloth too, and the GPU moves oars and steering oars with the stroke.
const shipColliderIgnored = (id) => /^(flag\.|rowing\.(propulsor|station)|helm\.steering-oar)/.test(id);
const shipColliderIsSpar = (id) => /^(mast\.|yard\.|spar\.|lookout\.|tackle\.|bow\.bowsprit)/.test(id);
const SHIP_COLLIDER_LEAF_TRIANGLES = 4;

// One bounding volume tree over a list of triangles. Boxes are the triangles' own, so an empty corner of her costs
// nothing to pass through. A flat layout: the left child of an inner node is the next node.
function shipColliderTree(vertices, indices, list) {
  const count = list.length;
  if (!count) return null;
  const slots = new Uint32Array(count), lo = new Float32Array(count * 3), hi = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    slots[i] = i;
    const t = list[i] * 3;
    for (let c = 0; c < 3; c++) {
      const a = vertices[indices[t] * 9 + c], b = vertices[indices[t + 1] * 9 + c], d = vertices[indices[t + 2] * 9 + c];
      lo[i * 3 + c] = Math.min(a, b, d);
      hi[i * 3 + c] = Math.max(a, b, d);
    }
  }
  const boxes = new Float32Array(count * 2 * 6), links = new Int32Array(count * 2 * 2);
  let nodes = 0;
  const build = (first, n) => {
    const node = nodes++, box = node * 6;
    const cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c++) { boxes[box + c] = Infinity; boxes[box + 3 + c] = -Infinity; }
    for (let i = first; i < first + n; i++) {
      const s = slots[i] * 3;
      for (let c = 0; c < 3; c++) {
        if (lo[s + c] < boxes[box + c]) boxes[box + c] = lo[s + c];
        if (hi[s + c] > boxes[box + 3 + c]) boxes[box + 3 + c] = hi[s + c];
        const mid = (lo[s + c] + hi[s + c]) * 0.5;
        if (mid < cMin[c]) cMin[c] = mid;
        if (mid > cMax[c]) cMax[c] = mid;
      }
    }
    let left = 0;
    if (n > SHIP_COLLIDER_LEAF_TRIANGLES) {
      const size = [cMax[0] - cMin[0], cMax[1] - cMin[1], cMax[2] - cMin[2]];
      const axis = size[0] >= size[1] && size[0] >= size[2] ? 0 : size[1] >= size[2] ? 1 : 2;
      if (size[axis] > 1e-6) {
        const split = (cMin[axis] + cMax[axis]) * 0.5;
        let i = first, j = first + n - 1;
        while (i <= j) {
          const s = slots[i] * 3;
          if ((lo[s + axis] + hi[s + axis]) * 0.5 < split) i++;
          else { const swap = slots[i]; slots[i] = slots[j]; slots[j] = swap; j--; }
        }
        left = i - first;
      }
    }
    if (left > 0 && left < n) {
      build(first, left);
      links[node * 2] = 0;
      links[node * 2 + 1] = build(first + left, n - left);
    } else {
      links[node * 2] = -first - 1;
      links[node * 2 + 1] = n;
    }
    return node;
  };
  build(0, count);
  const triangles = new Uint32Array(count);
  for (let i = 0; i < count; i++) triangles[i] = list[slots[i]];
  return { triangles, boxes: boxes.slice(0, nodes * 6), links: links.slice(0, nodes * 2) };
}

// Where the line first enters a box grown by the ball, or Infinity.
function shipColliderBoxEntry(boxes, node, ox, oy, oz, ix, iy, iz, r, limit) {
  const at = node * 6;
  let near = 0, far = limit;
  let a = (boxes[at] - r - ox) * ix, b = (boxes[at + 3] + r - ox) * ix;
  if (a > b) { const swap = a; a = b; b = swap; }
  if (a > near) near = a;
  if (b < far) far = b;
  if (near > far) return Infinity;
  a = (boxes[at + 1] - r - oy) * iy; b = (boxes[at + 4] + r - oy) * iy;
  if (a > b) { const swap = a; a = b; b = swap; }
  if (a > near) near = a;
  if (b < far) far = b;
  if (near > far) return Infinity;
  a = (boxes[at + 2] - r - oz) * iz; b = (boxes[at + 5] + r - oz) * iz;
  if (a > b) { const swap = a; a = b; b = swap; }
  if (a > near) near = a;
  if (b < far) far = b;
  return near > far ? Infinity : near;
}

// A ball running along m + d t meets a straight edge from the edge's start, e long, at this t. m runs from that start.
function shipColliderSweepEdge(mx, my, mz, ex, ey, ez, dx, dy, dz, rr, best) {
  const ee = ex * ex + ey * ey + ez * ez, ed = ex * dx + ey * dy + ez * dz, em = ex * mx + ey * my + ez * mz;
  const dd = dx * dx + dy * dy + dz * dz, dm = dx * mx + dy * my + dz * mz, mm = mx * mx + my * my + mz * mz;
  const A = ee * dd - ed * ed, B = ee * dm - ed * em, C = ee * (mm - rr) - em * em;
  if (A > 1e-12) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      let t = (-B - Math.sqrt(disc)) / A;
      if (t < 0) t = C <= 0 ? 0 : Infinity;
      if (t < best) {
        const along = (em + t * ed) / ee;
        if (along >= 0 && along <= 1) return t;
      }
    }
  }
  // Past either end of the edge it can only touch a corner, and the start of this one is one.
  const c = mm - rr, disc = dm * dm - dd * c;
  if (disc < 0) return best;
  let t = (-dm - Math.sqrt(disc)) / dd;
  if (t < 0) t = c <= 0 ? 0 : Infinity;
  return t < best ? t : best;
}

// When a ball of radius r running along o + d t first touches a triangle, from either side, or Infinity.
function shipColliderSweepTriangle(V, I, t, ox, oy, oz, dx, dy, dz, r, limit) {
  const i0 = I[t * 3] * 9, i1 = I[t * 3 + 1] * 9, i2 = I[t * 3 + 2] * 9;
  const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
  const ex = V[i1] - ax, ey = V[i1 + 1] - ay, ez = V[i1 + 2] - az;
  const fx = V[i2] - ax, fy = V[i2 + 1] - ay, fz = V[i2 + 2] - az;
  let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length < 1e-12) return Infinity;
  nx /= length; ny /= length; nz /= length;
  const mx = ox - ax, my = oy - ay, mz = oz - az;
  const height = mx * nx + my * ny + mz * nz, off = Math.abs(height), side = height >= 0 ? 1 : -1;
  let t0 = 0, rest = height;
  if (off > r) {
    const closing = -(dx * nx + dy * ny + dz * nz) * side;
    if (closing <= 1e-12) return Infinity;
    t0 = (off - r) / closing;
    if (t0 >= limit) return Infinity;
    rest = side * r;
  }
  const px = mx + dx * t0 - nx * rest, py = my + dy * t0 - ny * rest, pz = mz + dz * t0 - nz * rest;
  const ee = ex * ex + ey * ey + ez * ez, ef = ex * fx + ey * fy + ez * fz, ff = fx * fx + fy * fy + fz * fz;
  const pe = px * ex + py * ey + pz * ez, pf = px * fx + py * fy + pz * fz, denominator = ee * ff - ef * ef;
  const u = (ff * pe - ef * pf) / denominator, v = (ee * pf - ef * pe) / denominator;
  if (u >= 0 && v >= 0 && u + v <= 1) return t0;
  if (r <= 0) return Infinity;
  const rr = r * r;
  let best = limit;
  best = shipColliderSweepEdge(mx, my, mz, ex, ey, ez, dx, dy, dz, rr, best);
  best = shipColliderSweepEdge(mx, my, mz, fx, fy, fz, dx, dy, dz, rr, best);
  best = shipColliderSweepEdge(mx - ex, my - ey, mz - ez, fx - ex, fy - ey, fz - ez, dx, dy, dz, rr, best);
  return best < limit ? best : Infinity;
}

const shipColliderStackNodes = new Int32Array(96), shipColliderStackEntries = new Float64Array(96);
let shipColliderStruck = -1;
// The first standing triangle of a tree on the line, nearest first. Sets shipColliderStruck and returns its t, or `limit`.
function shipColliderFirst(tree, collider, ox, oy, oz, dx, dy, dz, r, limit, broken, fallen) {
  const { boxes, links, triangles } = tree, { vertices, indices, vertexShards } = collider;
  const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
  shipColliderStruck = -1;
  let best = limit, top = 0, entry = shipColliderBoxEntry(boxes, 0, ox, oy, oz, ix, iy, iz, r, best);
  if (entry === Infinity) return best;
  shipColliderStackNodes[0] = 0; shipColliderStackEntries[0] = entry; top = 1;
  while (top > 0) {
    top--;
    if (shipColliderStackEntries[top] >= best) continue;
    const node = shipColliderStackNodes[top], link = links[node * 2];
    if (link < 0) {
      for (let i = -link - 1, end = i + links[node * 2 + 1]; i < end; i++) {
        const t = triangles[i], s = vertexShards[indices[t * 3]];
        if ((broken && broken[s]) || (fallen && fallen[s])) continue;
        const at = shipColliderSweepTriangle(vertices, indices, t, ox, oy, oz, dx, dy, dz, r, best);
        if (at < best) { best = at; shipColliderStruck = t; }
      }
      continue;
    }
    const left = node + 1, right = links[node * 2 + 1];
    const a = shipColliderBoxEntry(boxes, left, ox, oy, oz, ix, iy, iz, r, best), b = shipColliderBoxEntry(boxes, right, ox, oy, oz, ix, iy, iz, r, best);
    const nearer = a <= b ? left : right, farther = a <= b ? right : left, nearEntry = a <= b ? a : b, farEntry = a <= b ? b : a;
    if (farEntry !== Infinity) { shipColliderStackNodes[top] = farther; shipColliderStackEntries[top++] = farEntry; }
    if (nearEntry !== Infinity) { shipColliderStackNodes[top] = nearer; shipColliderStackEntries[top++] = nearEntry; }
  }
  return best;
}

// Every kind of rig, behind one shape: where a sail's spar and canvas stand now, and where its canvas lay at rest.
const shipColliderDefaultLateen = Object.freeze({ side: -1, opening: 0.3, dip: 0, fill: 0, deployed: 1, pressure: 1 });
const shipColliderDefaultVictory = Object.freeze({ squareYaw: 0, lateenYaw: 0, windSide: 0, windForward: 0, set: Object.freeze([1, 1, 1]), rig: Object.freeze([{ fill: 0 }, { fill: 0 }, { fill: 0 }]) });
function shipColliderSails(model) {
  if (model.id === 'nina') {
    return SAIL_PLAN.map((sail, mast) => ({
      code: sail.id, pivot: sail.pivot, corners: sail.corners.length,
      pose: (boat) => boat.sailState?.rig?.[mast] ?? shipColliderDefaultLateen,
      yard: (p, pose) => lateenYardPoint(mast, p, pose),
      cloth: (u, v, pose) => lateenClothPoint(mast, u, v, pose, 0, 0, false, null),
      rest: (u, v) => lateenRestPoint(mast, u, v),
    }));
  }
  if (model.id === 'victory') {
    return VICTORY_SAILS.map((sail) => ({
      code: sail.id, pivot: sail.pivot, corners: sail.corners.length,
      pose: (boat) => victoryPose(sail, boat.sailState?.rig ? boat.sailState : shipColliderDefaultVictory),
      yard: (p, pose) => victoryYardPoint(sail.id, p, pose),
      cloth: (u, v, pose) => victoryClothPoint(sail.id, u, v, pose, 0, 0),
      rest: (u, v) => victorySailPoint(sail.id, u, v),
    }));
  }
  return proceduralRigContext(model.id).surfaces.map((surface) => ({
    code: surface.id, pivot: surface.kind === 'headsail' || surface.kind === 'bermudan' ? surface.corners[0] : surface.pivot, corners: surface.corners.length,
    pose: (boat) => rigSurfacePose(surface, boat.sailState ?? {}),
    yard: (p, pose) => surfaceYardPoint(surface, p, pose),
    // No supports: a ball needs where the canvas is, not how it bears on a stay.
    cloth: (u, v, pose) => surfaceClothPoint(surface, u, v, pose, {}, 0, 0),
    rest: (u, v) => surfaceRestPoint(surface, u, v),
  }));
}

// The tag in a spar's or canvas's material: which sail it belongs to.
export const shipColliderSailCode = (model, material) => {
  const tag = material - Math.floor(material);
  return model.id === 'nina' ? Math.round(tag * 16) & 7 : Math.round(tag * 64);
};

// A sail's canvas at rest: u along its head, v down it, for a quadrilateral or a triangle.
const SHIP_COLLIDER_QUAD = Object.freeze([[0, 0], [1, 0], [1, 1], [0, 1]]), SHIP_COLLIDER_TRIANGLE = Object.freeze([[0, 0], [1, 0], [0, 1]]);

/**
 * Prepare a model's collision from the mesh and fracture table it was drawn from. The arrays are shared, not copied.
 * Triangle numbers are the mesh's, so a hit names its part straight from partAssembly.trianglePartIds.
 */
export function createShipCollider({ model, vertices, indices, groups, fracture }) {
  const triangles = indices.length / 3, specs = shipMastSpecs(model.id), { vertexShards, shards, sparMasts } = fracture;
  const leaf = new Int32Array(triangles).fill(-1);
  groups.map((g, index) => ({ index, first: Math.floor(g.firstVertex / 3), count: Math.floor(g.vertexCount / 3) })).filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index).forEach((r) => leaf.fill(r.index, r.first, Math.min(triangles, r.first + r.count)));
  const sails = shipColliderSails(model), sailByCode = new Map(sails.map((sail) => [sail.code, { ...sail, shard: -1, triangle: -1, mast: 0 }])), sparsOf = new Map();
  const mastNumberNear = (z) => (specs.length ? specs.reduce((best, spec, i) => (Math.abs(spec[1] - z) < Math.abs(specs[best][1] - z) ? i : best), 0) + 1 : 0);
  // Which mast a hit here hurts, numbered from 1, or 0 for what is her hull. Masts, yards and what hangs on them go
  // to the mast the fracture table hung them on, and otherwise a spar goes to the mast nearest.
  const mastOf = new Uint8Array(triangles);
  const mastNumberOf = (t, id, s) => {
    if (sparMasts[t]) return sparMasts[t];
    const named = shards[s]?.mast;
    if (named) return specs.findIndex((spec) => spec[0] === named) + 1;
    return shipColliderIsSpar(id) ? mastNumberNear(vertices[indices[t * 3] * 9 + 2]) : 0;
  };
  const solid = [], ropes = [], hatch = [];
  for (let t = 0; t < triangles; t++) {
    const id = leaf[t] >= 0 ? String(groups[leaf[t]].id) : '';
    if (shipColliderIgnored(id)) continue;
    const at = indices[t * 3] * 9, material = vertices[at + 6], kind = Math.floor(material), s = vertexShards[indices[t * 3]], shard = shards[s];
    const code = shipColliderSailCode(model, material);
    if (SHIP_COLLIDER_CLOTH.has(kind) && sailByCode.has(code)) {
      const sail = sailByCode.get(code);
      if (sail.triangle < 0) { sail.triangle = t; sail.shard = s; sail.mast = mastNumberOf(t, id, s); }
      continue;
    }
    if (SHIP_COLLIDER_CLOTH.has(kind) || kind === SHIP_COLLIDER_BOLT_ROPE) continue;
    // Running rope is moved line by line on the GPU, and a ball parts it only by luck. Standing rope stays put.
    if (kind === 12 && vertices[at + 7] >= SHIP_COLLIDER_RUNNING_ROPE_UV && !/shroud|stay/.test(id)) continue;
    const mastPart = /^mast\./.test(id);
    // Some standing lines are drawn in fitting material, but the fracture table knows them for rope.
    if (SHIP_COLLIDER_ROPE.has(kind) || (!mastPart && shard?.kind === SHARD_KINDS.line)) {
      // Cable and netting with no mast to answer for are no part of her rig.
      mastOf[t] = mastNumberOf(t, id, s);
      if (mastOf[t]) ropes.push(t);
      continue;
    }
    mastOf[t] = mastNumberOf(t, id, s);
    if (kind === SHIP_COLLIDER_SPAR_MATERIAL && sailByCode.has(code)) (sparsOf.get(code) ?? sparsOf.set(code, []).get(code)).push(t);
    else if (kind === SHIP_COLLIDER_HATCH_MATERIAL) hatch.push(t);
    else solid.push(t);
  }

  const vertexReach = (list, point) => {
    let reach = 0;
    for (const t of list) for (let k = 0; k < 3; k++) {
      const at = indices[t * 3 + k] * 9;
      reach = Math.max(reach, Math.hypot(vertices[at] - point[0], vertices[at + 1] - point[1], vertices[at + 2] - point[2]));
    }
    return reach;
  };
  // However a spar swings about its pivot it stays in this sphere, shifted as far as a lateen yard is ever carried.
  const carried = (sail) => {
    let most = 0;
    for (const side of [-1, 1]) for (const dip of [0, 1]) {
      const p = sail.yard(sail.pivot, { yaw: 0, side, dip, opening: 0, deployed: 1, fill: 0, pressure: 1 });
      most = Math.max(most, Math.hypot(p[0] - sail.pivot[0], p[1] - sail.pivot[1], p[2] - sail.pivot[2]));
    }
    return most;
  };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, softBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const include = (box, lo, hi) => { for (let c = 0; c < 3; c++) { box.min[c] = Math.min(box.min[c], lo[c]); box.max[c] = Math.max(box.max[c], hi[c]); } };
  const includeTree = (box, tree) => { if (tree) include(box, tree.boxes.slice(0, 3), tree.boxes.slice(3, 6)); };
  const includeSphere = (box, centre, r) => include(box, centre.map((v) => v - r), centre.map((v) => v + r));
  const solidTree = shipColliderTree(vertices, indices, solid), ropeTree = shipColliderTree(vertices, indices, ropes);
  includeTree(bounds, solidTree);
  includeTree(softBounds, ropeTree);
  const rig = [], canvas = [];
  for (const sail of sailByCode.values()) {
    const shift = carried(sail), spars = sparsOf.get(sail.code);
    if (spars) {
      const reach = vertexReach(spars, sail.pivot) + shift;
      rig.push({ sail, tree: shipColliderTree(vertices, indices, spars), reach });
      includeSphere(bounds, sail.pivot, reach);
    }
    if (sail.triangle >= 0) {
      const corners = sail.corners === 4 ? SHIP_COLLIDER_QUAD : SHIP_COLLIDER_TRIANGLE;
      const reach = Math.max(...corners.map(([u, v]) => { const p = sail.rest(u, v); return Math.hypot(p[0] - sail.pivot[0], p[1] - sail.pivot[1], p[2] - sail.pivot[2]); })) + shift;
      canvas.push({ sail, corners, reach });
      includeSphere(softBounds, sail.pivot, reach);
    }
  }
  // A hatch lid swings on its hinge, and an open one stands up off the deck.
  let hatchPart = null;
  if (hatch.length) {
    const { hinge } = shipColliderHatchFrame(model, 0), reach = vertexReach(hatch, hinge);
    hatchPart = { tree: shipColliderTree(vertices, indices, hatch), hinge, reach };
    includeSphere(bounds, hinge, reach);
  }
  include(softBounds, bounds.min, bounds.max);
  return Object.freeze({
    model, frame: model.designFrame, vertices, indices, vertexShards, mastOf, masts: specs.map((spec) => spec[0]), fracture,
    solidTree, ropeTree, rig, canvas, hatchPart, bounds, softBounds,
    // What the masts' falls take with them, for each stage they have reached, so a fallen mast costs one lookup.
    fallenByStage: new Map(),
  });
}

// A hatch lid turns about its own hinge, so the transform's position is that hinge.
export function shipColliderHatchFrame(model, hatchesClosed) {
  const { runtime } = model, { position: hinge, basis: [x, y, z] } = resolveShipTransform({ modelId: model.id, length: runtime.length, beam: runtime.beam, hatchesClosed }, 'hatch.main', { space: 'design' });
  return { hinge, frame: { origin: [0, 1, 2].map((c) => hinge[c] - (x[c] * hinge[0] + y[c] * hinge[1] + z[c] * hinge[2])), x, y, z } };
}

// The shards a fall has taken with it, or null while every mast stands. Fracture state or no: the masts' stages are
// damage, and a ship can lose a mast before anything has been cut up.
function shipColliderFallen(collider, mastState) {
  if (!mastState) return null;
  const masts = collider.masts;
  let key = 0;
  for (let i = 0; i < masts.length; i++) key = key * 3 + (mastState[masts[i]] ?? 0);
  if (!key) return null;
  let fallen = collider.fallenByStage.get(key);
  if (!fallen) {
    fallen = new Uint8Array(collider.fracture.shardCount);
    for (const name of masts) {
      const stage = mastState[name] ?? 0, mast = collider.fracture.masts[name];
      if (stage >= 1) for (const s of mast.upper) fallen[s] = 1;
      if (stage >= 2) for (const s of mast.lower) fallen[s] = 1;
    }
    collider.fallenByStage.set(key, fallen);
  }
  return fallen;
}

// How far a line's closest approach to a point is, within the segment, squared.
function shipColliderMissSquared(point, ox, oy, oz, dx, dy, dz) {
  const mx = point[0] - ox, my = point[1] - oy, mz = point[2] - oz;
  const t = Math.max(0, Math.min(1, (mx * dx + my * dy + mz * dz) / (dx * dx + dy * dy + dz * dz || 1)));
  const qx = mx - dx * t, qy = my - dy * t, qz = mz - dz * t;
  return qx * qx + qy * qy + qz * qz;
}

// What a rigid move does to the origin and the axes: q = origin + x px + y py + z pz.
function shipColliderFrameOf(move) {
  const origin = move([0, 0, 0]), a = move([1, 0, 0]), b = move([0, 1, 0]), c = move([0, 0, 1]);
  return { origin, x: [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]], y: [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]], z: [c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]] };
}

// A sail as she has it set just now. Yards and canvas shift slowly and a broadside asks hundreds of times over, so what
// follows from a pose is kept until the pose changes, per boat. Corners carry no belly, so nothing else moves them.
const shipColliderSetSails = new WeakMap();
function shipColliderSailNow(boat, sail) {
  const pose = sail.pose(boat), yaw = pose.yaw ?? 0, side = pose.side ?? 0, dip = pose.dip ?? 0, opening = pose.opening ?? 0, deployed = pose.deployed ?? 1;
  let sails = shipColliderSetSails.get(boat);
  if (!sails) shipColliderSetSails.set(boat, sails = new Map());
  let set = sails.get(sail);
  if (!set || set.yaw !== yaw || set.side !== side || set.dip !== dip || set.opening !== opening || set.deployed !== deployed) sails.set(sail, set = { yaw, side, dip, opening, deployed, pose: { ...pose }, frame: null, points: null });
  return set;
}

const shipColliderHit = { t: 0, triangle: -1, frame: null };
// The first standing solid of a moving part, taken in that part's rest frame. A rigid move keeps t and the ball's radius.
function shipColliderFirstMoved(tree, collider, frame, ox, oy, oz, dx, dy, dz, r, limit, broken, fallen) {
  const { origin, x, y, z } = frame, mx = ox - origin[0], my = oy - origin[1], mz = oz - origin[2];
  const at = shipColliderFirst(tree, collider,
    mx * x[0] + my * x[1] + mz * x[2], mx * y[0] + my * y[1] + mz * y[2], mx * z[0] + my * z[1] + mz * z[2],
    dx * x[0] + dy * x[1] + dz * x[2], dx * y[0] + dy * y[1] + dz * y[2], dx * z[0] + dy * z[1] + dz * z[2], r, limit, broken, fallen);
  if (shipColliderStruck >= 0) { shipColliderHit.t = at; shipColliderHit.triangle = shipColliderStruck; shipColliderHit.frame = frame; }
  return at;
}

/**
 * The first solid thing on a line through her, in design units. `boat` says where her rig stands and `damage` what
 * has left her. Returns the shared hit record, valid until the next call, or null.
 */
export function shipColliderTrace(collider, boat, damage, ox, oy, oz, dx, dy, dz, r) {
  const broken = damage?.fracture?.brokenCount > 0 ? damage.fracture.broken : null, fallen = shipColliderFallen(collider, damage?.mastState);
  shipColliderHit.triangle = -1;
  shipColliderHit.frame = null;
  let best = 1 + 1e-9;
  if (collider.solidTree) {
    best = shipColliderFirst(collider.solidTree, collider, ox, oy, oz, dx, dy, dz, r, best, broken, fallen);
    if (shipColliderStruck >= 0) { shipColliderHit.t = best; shipColliderHit.triangle = shipColliderStruck; }
  }
  for (const part of collider.rig) {
    const reach = part.reach + r;
    if (shipColliderMissSquared(part.sail.pivot, ox, oy, oz, dx, dy, dz) > reach * reach) continue;
    const { sail } = part, set = shipColliderSailNow(boat, sail);
    set.frame ??= shipColliderFrameOf((p) => sail.yard(p, set.pose));
    best = shipColliderFirstMoved(part.tree, collider, set.frame, ox, oy, oz, dx, dy, dz, r, best, broken, fallen);
  }
  const lid = collider.hatchPart;
  if (lid && shipColliderMissSquared(lid.hinge, ox, oy, oz, dx, dy, dz) <= (lid.reach + r) ** 2) {
    best = shipColliderFirstMoved(lid.tree, collider, shipColliderHatchFrame(collider.model, boat.hatchesClosed).frame, ox, oy, oz, dx, dy, dz, r, best, broken, fallen);
  }
  return shipColliderHit.triangle >= 0 ? shipColliderHit : null;
}

// A struck triangle's normal in her design frame, moved with the part it belongs to.
export function shipColliderNormal(collider, hit) {
  const V = collider.vertices, I = collider.indices, t = hit.triangle;
  const i0 = I[t * 3] * 9, i1 = I[t * 3 + 1] * 9, i2 = I[t * 3 + 2] * 9;
  const ex = V[i1] - V[i0], ey = V[i1 + 1] - V[i0 + 1], ez = V[i1 + 2] - V[i0 + 2];
  const fx = V[i2] - V[i0], fy = V[i2 + 1] - V[i0 + 1], fz = V[i2 + 2] - V[i0 + 2];
  const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
  const frame = hit.frame;
  if (!frame) return [nx, ny, nz];
  return [nx * frame.x[0] + ny * frame.y[0] + nz * frame.z[0], nx * frame.x[1] + ny * frame.y[1] + nz * frame.z[1], nx * frame.x[2] + ny * frame.y[2] + nz * frame.z[2]];
}

// Where a line meets the canvas of one sail, as it stands, or null. Corners carry no belly, so this is the plane of
// the sail, within its camber of the cloth. A sail that is furled has no area left to meet.
function shipColliderMeetCanvas(part, set, ox, oy, oz, dx, dy, dz, limit) {
  const { sail, corners } = part, points = (set.points ??= corners.map(([u, v]) => sail.cloth(u, v, set.pose)));
  for (let fan = 1; fan + 1 < points.length; fan++) {
    const a = points[0], b = points[fan], c = points[fan + 1];
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    const px = dy * fz - dz * fy, py = dz * fx - dx * fz, pz = dx * fy - dy * fx, det = ex * px + ey * py + ez * pz;
    if (Math.abs(det) < 1e-12) continue;
    const mx = ox - a[0], my = oy - a[1], mz = oz - a[2], s = (mx * px + my * py + mz * pz) / det;
    if (s < 0 || s > 1) continue;
    const qx = my * ez - mz * ey, qy = mz * ex - mx * ez, qz = mx * ey - my * ex, w = (dx * qx + dy * qy + dz * qz) / det;
    if (w < 0 || s + w > 1) continue;
    const t = (fx * qx + fy * qy + fz * qz) / det;
    if (t < 0 || t >= limit) continue;
    // Back to the canvas as it lay at rest, which is where a tear is marked. On a quadrilateral the fan splits it
    // into the corners 0-1-2 and 0-2-3.
    const quad = points.length === 4, u = quad ? (fan === 1 ? s + w : s) : s, v = quad ? (fan === 1 ? w : s + w) : w;
    return { t, rest: sail.rest(u, v) };
  }
  return null;
}

/**
 * What a line through her tears before `limit`: at most one crossing for each mast, canvas before rope, since a
 * crossing is a hit on that mast's rig however many lines it parts. Rope stands where she was built, and canvas where
 * its sail is set. Each crossing names its mast, the triangle whose part it hurts, and the rest position to mark.
 */
export function shipColliderCrossings(collider, boat, damage, ox, oy, oz, dx, dy, dz, r, limit) {
  const broken = damage?.fracture?.brokenCount > 0 ? damage.fracture.broken : null, fallen = shipColliderFallen(collider, damage?.mastState);
  const found = new Map();
  for (const part of collider.canvas) {
    const { sail } = part;
    if ((broken && broken[sail.shard]) || (fallen && fallen[sail.shard])) continue;
    const reach = part.reach + r;
    if (shipColliderMissSquared(sail.pivot, ox, oy, oz, dx, dy, dz) > reach * reach) continue;
    const met = shipColliderMeetCanvas(part, shipColliderSailNow(boat, sail), ox, oy, oz, dx, dy, dz, limit);
    if (!met) continue;
    const known = found.get(sail.mast);
    if (!known || met.t < known.t) found.set(sail.mast, { t: met.t, mast: collider.masts[sail.mast - 1] ?? null, triangle: sail.triangle, rest: met.rest, kind: 'canvas' });
  }
  if (collider.ropeTree) {
    const { boxes, links, triangles } = collider.ropeTree, { vertices, indices, vertexShards, mastOf } = collider;
    const ix = 1 / (dx || 1e-30), iy = 1 / (dy || 1e-30), iz = 1 / (dz || 1e-30);
    let top = 0;
    if (shipColliderBoxEntry(boxes, 0, ox, oy, oz, ix, iy, iz, r, limit) !== Infinity) { shipColliderStackNodes[0] = 0; top = 1; }
    while (top > 0) {
      const node = shipColliderStackNodes[--top], link = links[node * 2];
      if (link < 0) {
        for (let i = -link - 1, end = i + links[node * 2 + 1]; i < end; i++) {
          const t = triangles[i], s = vertexShards[indices[t * 3]], mast = mastOf[t];
          if (found.has(mast) || (broken && broken[s]) || (fallen && fallen[s])) continue;
          const at = shipColliderSweepTriangle(vertices, indices, t, ox, oy, oz, dx, dy, dz, r, limit);
          if (at < limit) found.set(mast, { t: at, mast: collider.masts[mast - 1] ?? null, triangle: t, rest: [ox + dx * at, oy + dy * at, oz + dz * at], kind: 'rope' });
        }
        continue;
      }
      const left = node + 1, right = links[node * 2 + 1];
      if (shipColliderBoxEntry(boxes, left, ox, oy, oz, ix, iy, iz, r, limit) !== Infinity) shipColliderStackNodes[top++] = left;
      if (shipColliderBoxEntry(boxes, right, ox, oy, oz, ix, iy, iz, r, limit) !== Infinity) shipColliderStackNodes[top++] = right;
    }
  }
  return [...found.values()].sort((a, b) => a.t - b.t);
}
