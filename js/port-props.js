// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Generated, textured models about a port, and where they go. This decides places once, when a port is
// laid out. js/props.js draws them. Every placed prop (cleats and beach jetties) partitions into rigid
// shards that break apart and fall under gravity when struck by cannonballs.
import { gltfAccessor, readGLB } from './gltf.js';
import {
  FRACTURE_GRAVITY,
  FRACTURE_RECORD_FLOATS,
  createShipFractureState,
  evaluateShardFlight,
  settleFinishedFlights,
  writeFlight,
} from './ship-fracture.js';

// `metres` along `sizeAxis` sets a model's real size, because a generated model comes out one unit long.
export const PROP_MODELS = Object.freeze([
  Object.freeze({ id: 'cleat', file: 'assets/props/cleat.glb', sizeAxis: 1, metres: 0.8 }),
  Object.freeze({ id: 'jetty-weathered', file: 'assets/props/jetty-weathered.glb', sizeAxis: 2, metres: 16, deckShare: 0.86 }),
  Object.freeze({ id: 'jetty-planked', file: 'assets/props/jetty-planked.glb', sizeAxis: 0, metres: 18, deckShare: 0.82, quarterTurn: true }),
]);
export const PROP_WORDS = 8;
const CLEAT = 0, FIRST_JETTY = 1, JETTY_KINDS = 2;
const CLEAT_SPACING_M = 9, CLEAT_END_CLEARANCE_M = 3, CLEAT_EDGE_INSET_M = 0.55;
const QUAY_SEA_PROBE_M = 3;
const JETTY_DECK_ABOVE_SEA_M = 1.5;
const JETTY_NEAREST_M = 60, JETTY_FURTHEST_M = 600, JETTY_WALK_M = 6, JETTY_BEARINGS = 96, JETTY_MOST = 2;
const JETTY_OUT_M = 5, JETTY_ROOT_HIGHEST_M = JETTY_DECK_ABOVE_SEA_M, JETTY_SLOPE_PROBE_M = 12;
const JETTY_BUILDING_GAP_M = 12, JETTY_APART_M = 70;
const CLEATED = Object.freeze({ timber_mole_pier: 'both', stone_quay_seawall: 'sea' });
// A timber pier as js/coastal-world.js builds it, measured along it from its middle. Its piles stand in bents, with
// a bollard post on every other bent. Its crane and its boarding brow take up part of its +x edge.
const PIER_BENT_INSET_M = 1.2, PIER_BAY_M = 4.8, PIER_FEWEST_BAYS = 4;
const PIER_CRANE_CLEAR_M = 2.2, PIER_BROW_CLEAR_M = 0.5;
export function pierBentStations(length) {
  const run = length - 2 * PIER_BENT_INSET_M, bays = Math.max(PIER_FEWEST_BAYS, Math.round(run / PIER_BAY_M));
  return Array.from({ length: bays + 1 }, (_, b) => -length / 2 + PIER_BENT_INSET_M + (b / bays) * run);
}
export const pierCraneStation = (length) => -length * 0.16;
export const pierBrowStations = (length) => [-length / 2 + 8.2, -length / 2 + 9.6];

const MAX_JETTY_TRI_EDGE_M = 4.6;
const JETTY_BAYS = 8;
const JETTY_ANCHOR_MAX_Y_M = 0.6;
const JETTY_LANDING_PASSES = 3;

// The models as last read, so a prop can be struck by anything that knows only where it stands.
const loadedPropModels = new Array(PROP_MODELS.length).fill(null);

const footprintRadius = (inst) => Math.hypot(inst.length ?? 20, inst.width ?? 16) / 2;

function layCleats(port, groundAt, add) {
  (port.instances ?? []).forEach((inst, owner) => {
    const sides = CLEATED[inst.prefabId];
    if (!sides) return;
    const halfLength = inst.length / 2, halfWidth = inst.width / 2, c = Math.cos(inst.yaw), s = Math.sin(inst.yaw);
    const world = (lx, lz) => [inst.x + lx * c + lz * s, inst.z - lx * s + lz * c];
    let edges = [-1, 1];
    if (sides === 'sea') {
      const low = (side) => { const [x, z] = world(side * (halfWidth + QUAY_SEA_PROBE_M), 0); return groundAt(x, z); };
      edges = [low(-1) < low(1) ? -1 : 1];
    }
    const top = inst.y + inst.height, stations = [];
    if (sides === 'both') {
      // Midway between bents in every other bay, so no cleat stands in a pile head or on a bollard post.
      const bents = pierBentStations(inst.length);
      for (let b = 1; b + 1 < bents.length; b += 2) stations.push((bents[b] + bents[b + 1]) / 2);
    } else {
      const count = Math.floor((inst.length - 2 * CLEAT_END_CLEARANCE_M) / CLEAT_SPACING_M);
      for (let k = 0; k <= count; k++) stations.push(-halfLength + CLEAT_END_CLEARANCE_M + k * CLEAT_SPACING_M);
    }
    const crane = pierCraneStation(inst.length), [browFrom, browTo] = pierBrowStations(inst.length);
    const taken = (edge, along) => sides === 'both' && edge > 0 && (Math.abs(along - crane) < PIER_CRANE_CLEAR_M || (along > browFrom - PIER_BROW_CLEAR_M && along < browTo + PIER_BROW_CLEAR_M));
    for (const edge of edges) for (const along of stations) {
      if (taken(edge, along)) continue;
      const [x, z] = world(edge * (halfWidth - CLEAT_EDGE_INSET_M), along);
      add(CLEAT, x, top, z, inst.yaw, owner);
    }
  });
}

// Out from the town along each bearing to where the ground meets the sea, nearest first.
function shoreSpots(centre, groundAt) {
  const spots = [];
  for (let b = 0; b < JETTY_BEARINGS; b++) {
    const bearing = (b / JETTY_BEARINGS) * Math.PI * 2, sx = Math.sin(bearing), sz = Math.cos(bearing);
    for (let radius = JETTY_NEAREST_M; radius <= JETTY_FURTHEST_M; radius += JETTY_WALK_M) {
      if (groundAt(centre.x + sx * radius, centre.z + sz * radius) > 0 && groundAt(centre.x + sx * (radius + JETTY_WALK_M), centre.z + sz * (radius + JETTY_WALK_M)) <= 0) {
        spots.push({ x: centre.x + sx * radius, z: centre.z + sz * radius, radius });
        break;
      }
    }
  }
  return spots.sort((p, q) => p.radius - q.radius);
}
function layJetties(port, groundAt, add) {
  // Plank jetties belong to colonial towns. Every port carries a settlement profile, so ask what it says.
  if (port.indigenousSettlement?.isSovereignPolity) return;
  const taken = [], instances = port.instances ?? [];
  const clearOfBuildings = (x, z) => instances.every((inst) => Math.hypot(inst.x - x, inst.z - z) > footprintRadius(inst) + JETTY_BUILDING_GAP_M);
  for (const { x, z } of shoreSpots(port.center, groundAt)) {
    if (taken.length >= JETTY_MOST) return;
    // Seaward is down the slope of the ground.
    const gx = groundAt(x + JETTY_SLOPE_PROBE_M, z) - groundAt(x - JETTY_SLOPE_PROBE_M, z), gz = groundAt(x, z + JETTY_SLOPE_PROBE_M) - groundAt(x, z - JETTY_SLOPE_PROBE_M), slope = Math.hypot(gx, gz);
    if (slope < 1e-3) continue;
    const seaX = -gx / slope, seaZ = -gz / slope, midX = x + seaX * JETTY_OUT_M, midZ = z + seaZ * JETTY_OUT_M;
    // Its root on the beach, its head in water, and not on a cliff.
    if (groundAt(x - seaX * JETTY_OUT_M, z - seaZ * JETTY_OUT_M) > JETTY_ROOT_HIGHEST_M || groundAt(midX + seaX * JETTY_OUT_M, midZ + seaZ * JETTY_OUT_M) >= 0) continue;
    if (!clearOfBuildings(midX, midZ) || taken.some((t) => Math.hypot(t[0] - midX, t[1] - midZ) < JETTY_APART_M)) continue;
    add(FIRST_JETTY + (taken.length % JETTY_KINDS), midX, null, midZ, Math.atan2(seaX, seaZ), -1);
    taken.push([midX, midZ]);
  }
}

// Each prop as model, place, turn and the building it stands on, if any: what goes with it when that goes.
export function layPortProps(port, groundAt) {
  const placed = [];
  const add = (model, x, y, z, yaw, owner) => placed.push({ model, x, y, z, yaw, owner });
  if (port?.instances?.length && port.center) {
    layCleats(port, groundAt, add);
    layJetties(port, groundAt, add);
  }
  return placed;
}

function partitionPropModel(rawVertices, rawIndices, height, spec = {}) {
  const isJetty = Boolean(spec.deckShare) || (spec.metres ?? 1) >= 4;
  const maxEdge = isJetty ? MAX_JETTY_TRI_EDGE_M : Math.max(0.18, (spec.metres ?? 0.8) * 0.55);
  const bays = isJetty ? JETTY_BAYS : 2;
  const deckY = isJetty ? height * (spec.deckShare ?? 0.84) : height * 0.5;
  const anchorMaxY = isJetty ? JETTY_ANCHOR_MAX_Y_M : height * 0.35;

  const verts = Array.from(rawVertices);
  const stack = [];
  for (let i = 0; i < rawIndices.length; i += 3) {
    stack.push([rawIndices[i], rawIndices[i + 1], rawIndices[i + 2]]);
  }
  const edgeLen2 = (a, b) => {
    const ao = a * 8, bo = b * 8;
    const dx = verts[ao] - verts[bo], dy = verts[ao + 1] - verts[bo + 1], dz = verts[ao + 2] - verts[bo + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const midCache = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const hit = midCache.get(key);
    if (hit !== undefined) return hit;
    const idx = verts.length / 8;
    const ao = a * 8, bo = b * 8;
    const nx = (verts[ao + 3] + verts[bo + 3]) * 0.5;
    const ny = (verts[ao + 4] + verts[bo + 4]) * 0.5;
    const nz = (verts[ao + 5] + verts[bo + 5]) * 0.5;
    const nl = Math.hypot(nx, ny, nz) || 1;
    verts.push(
      (verts[ao] + verts[bo]) * 0.5,
      (verts[ao + 1] + verts[bo + 1]) * 0.5,
      (verts[ao + 2] + verts[bo + 2]) * 0.5,
      nx / nl, ny / nl, nz / nl,
      (verts[ao + 6] + verts[bo + 6]) * 0.5,
      (verts[ao + 7] + verts[bo + 7]) * 0.5,
    );
    midCache.set(key, idx);
    return idx;
  };

  const maxLen2 = maxEdge * maxEdge;
  const subTris = [];
  while (stack.length) {
    const [a, b, c] = stack.pop();
    const lab = edgeLen2(a, b), lbc = edgeLen2(b, c), lca = edgeLen2(c, a);
    const m2 = Math.max(lab, lbc, lca);
    if (m2 <= maxLen2) {
      subTris.push([a, b, c]);
      continue;
    }
    if (lab >= lbc && lab >= lca) {
      const d = midpoint(a, b);
      stack.push([a, d, c], [d, b, c]);
    } else if (lbc >= lab && lbc >= lca) {
      const d = midpoint(b, c);
      stack.push([b, d, a], [d, c, a]);
    } else {
      const d = midpoint(c, a);
      stack.push([c, d, b], [d, a, b]);
    }
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 8) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const zSpan = Math.max(1e-4, maxZ - minZ);
  const shardsByKey = new Map();
  const shards = [];

  for (let t = 0; t < subTris.length; t++) {
    const [ia, ib, ic] = subTris[t];
    const a = ia * 8, b = ib * 8, c = ic * 8;
    const cx = (verts[a] + verts[b] + verts[c]) / 3;
    const cy = (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3;
    const cz = (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3;
    const tier = isJetty
      ? (cy < deckY * 0.48 ? 0 : cy < deckY * 0.80 ? 1 : 2)
      : (cy < deckY ? 0 : 2);
    const bay = Math.max(0, Math.min(bays - 1, Math.floor(((cz - minZ) / zSpan) * bays)));
    const side = cx < 0 ? 0 : 1;
    const key = `${tier}:${bay}:${side}`;
    let shard = shardsByKey.get(key);
    if (!shard) {
      shard = {
        id: shards.length,
        tier,
        bay,
        side,
        role: 'timber',
        anchored: false,
        maxSpan: 1,
        below: [],
        above: [],
        sideLinks: [],
        rawTris: [],
        vertexStart: 0,
        vertexCount: 0,
        indexStart: 0,
        indexCount: 0,
        minY: Infinity,
        center: new Float32Array(3),
        normal: new Float32Array(3),
        bounds: new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]),
      };
      shardsByKey.set(key, shard);
      shards.push(shard);
    }
    shard.rawTris.push([ia, ib, ic]);
  }

  // Unshare vertices across shards so each rigid shard poses cleanly without stretching UVs.
  const outVerts = [];
  const outIndices = [];
  const shardIds = [];

  for (const shard of shards) {
    shard.vertexStart = outVerts.length / 8;
    shard.indexStart = outIndices.length;
    const remap = new Map();
    let sx = 0, sy = 0, sz = 0;
    const b = shard.bounds;
    for (const tri of shard.rawTris) {
      for (let k = 0; k < 3; k++) {
        const oldIdx = tri[k];
        let localIdx = remap.get(oldIdx);
        if (localIdx === undefined) {
          localIdx = outVerts.length / 8;
          remap.set(oldIdx, localIdx);
          const o = oldIdx * 8;
          const x = verts[o], y = verts[o + 1], z = verts[o + 2];
          outVerts.push(x, y, z, verts[o + 3], verts[o + 4], verts[o + 5], verts[o + 6], verts[o + 7]);
          shardIds.push(shard.id);
          sx += x; sy += y; sz += z;
          if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
          if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
        }
        outIndices.push(localIdx);
      }
    }
    shard.vertexCount = outVerts.length / 8 - shard.vertexStart;
    shard.indexCount = outIndices.length - shard.indexStart;
    shard.minY = b[1];
    const invV = 1 / Math.max(1, shard.vertexCount);
    shard.center[0] = sx * invV;
    shard.center[1] = sy * invV;
    shard.center[2] = sz * invV;
    const nx = shard.center[0] || (shard.side === 0 ? -1 : 1);
    const ny = shard.tier === 2 ? 0.45 : 0.15;
    const nz = shard.center[2] * 0.15;
    const nl = Math.hypot(nx, ny, nz) || 1;
    shard.normal[0] = nx / nl;
    shard.normal[1] = ny / nl;
    shard.normal[2] = nz / nl;
    delete shard.rawTris;
  }

  for (const shard of shards) {
    shard.anchored = shard.tier === 0 && shard.minY <= anchorMaxY;
    shard.role = shard.tier === 2 ? 'deck' : shard.anchored ? 'piling' : 'brace';
  }
  for (const shard of shards) {
    if (shard.tier > 0) {
      const baseSame = shardsByKey.get(`0:${shard.bay}:${shard.side}`);
      const baseOther = shardsByKey.get(`0:${shard.bay}:${1 - shard.side}`);
      const baseHere = (baseSame?.anchored ? baseSame : null) ?? (baseOther?.anchored ? baseOther : null);
      if (baseHere) {
        const directBelow = shardsByKey.get(`${shard.tier - 1}:${shard.bay}:${shard.side}`)
          ?? shardsByKey.get(`${shard.tier - 1}:${shard.bay}:${1 - shard.side}`)
          ?? baseHere;
        if (directBelow && directBelow !== shard) {
          shard.below.push(directBelow.id);
          directBelow.above.push(shard.id);
        }
      }
    }
    for (const [db, ds] of [[-1, 0], [1, 0], [0, 1 - 2 * shard.side]]) {
      const nb = shardsByKey.get(`${shard.tier}:${shard.bay + db}:${shard.side + ds}`);
      if (nb && !shard.sideLinks.includes(nb.id)) shard.sideLinks.push(nb.id);
    }
    shard.maxSpan = shard.anchored || shard.below.length > 0 ? 0 : 1;
  }

  const standsAt = spec.deckShare ? JETTY_DECK_ABOVE_SEA_M - height * spec.deckShare : 0;
  return {
    vertices: new Float32Array(outVerts),
    indices: new Uint32Array(outIndices),
    fracture: {
      shards,
      shardOfVertex: new Uint32Array(shardIds),
      deckY,
      height,
      standsAt,
      bounds: new Float32Array([minX, minY, minZ, maxX, maxY, maxZ]),
    },
  };
}

// A model read from its file, turned so its length runs along z, standing on y = 0 and centred. Positions
// are in real metres. The texture stays as compressed bytes for the browser to decode.
export function readPropModel(bytes, spec = {}) {
  const asset = readGLB(bytes), json = asset.json, primitive = json.meshes[0].primitives[0];
  const positions = gltfAccessor(asset, primitive.attributes.POSITION), normals = gltfAccessor(asset, primitive.attributes.NORMAL), uvs = gltfAccessor(asset, primitive.attributes.TEXCOORD_0);
  const count = positions.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i * 3 + k]); hi[k] = Math.max(hi[k], positions[i * 3 + k]); }
  const sizeAxis = spec.sizeAxis ?? 1;
  const targetMetres = spec.metres ?? 1;
  const scale = targetMetres / Math.max(1e-5, hi[sizeAxis] - lo[sizeAxis]), mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], rawVertices = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const x = (positions[i * 3] - mid[0]) * scale, y = (positions[i * 3 + 1] - mid[1]) * scale, z = (positions[i * 3 + 2] - mid[2]) * scale;
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    rawVertices.set(spec.quarterTurn ? [z, y, -x, nz, ny, -nx] : [x, y, z, nx, ny, nz], i * 8);
    rawVertices.set([uvs[i * 2], uvs[i * 2 + 1]], i * 8 + 6);
  }
  const rawIndices = Uint32Array.from(gltfAccessor(asset, primitive.indices));
  const size = [(hi[0] - lo[0]) * scale, (hi[1] - lo[1]) * scale, (hi[2] - lo[2]) * scale];
  const image = json.images[json.textures[json.materials[primitive.material].pbrMetallicRoughness.baseColorTexture.index].source], view = json.bufferViews[image.bufferView];
  const radius = Math.hypot(...size) / 2;
  const standsAt = spec.deckShare ? JETTY_DECK_ABOVE_SEA_M - size[1] * spec.deckShare : 0;
  const partitioned = partitionPropModel(rawVertices, rawIndices, size[1], spec);
  const result = {
    vertices: partitioned.vertices,
    indices: partitioned.indices,
    image: new Uint8Array(asset.bin.buffer, asset.bin.byteOffset + (view.byteOffset ?? 0), view.byteLength),
    mime: image.mimeType,
    height: size[1],
    radius,
    standsAt,
    fracture: { ...partitioned.fracture, radius },
  };
  const modelIdx = PROP_MODELS.findIndex((m) => m.id === spec.id || m.file === spec.file);
  if (modelIdx >= 0) loadedPropModels[modelIdx] = result;
  return result;
}

export function jettyStandY(jetty, model = null) {
  if (Number.isFinite(jetty?.y)) return jetty.y;
  const m = model ?? jetty?.fracture?.model ?? loadedPropModels[jetty?.model];
  return m?.standsAt ?? 0;
}

export function jettyLocalToWorld(jetty, lx, ly, lz, model = null) {
  const c = Math.cos(jetty?.yaw ?? 0), s = Math.sin(jetty?.yaw ?? 0);
  const py = jettyStandY(jetty, model);
  return [
    (jetty?.x ?? 0) + lx * c + lz * s,
    py + ly,
    (jetty?.z ?? 0) + lz * c - lx * s,
  ];
}

export function jettyWorldToLocal(jetty, wx, wy, wz, model = null) {
  const c = Math.cos(jetty?.yaw ?? 0), s = Math.sin(jetty?.yaw ?? 0);
  const dx = wx - (jetty?.x ?? 0);
  const dy = wy - jettyStandY(jetty, model);
  const dz = wz - (jetty?.z ?? 0);
  return [dx * c - dz * s, dy, dx * s + dz * c];
}

export function jettyLocalToWorldDir(jetty, lx, ly, lz) {
  const c = Math.cos(jetty?.yaw ?? 0), s = Math.sin(jetty?.yaw ?? 0);
  return [lx * c + lz * s, ly, lz * c - lx * s];
}

export function jettyWorldToLocalDir(jetty, wx, wy, wz) {
  const c = Math.cos(jetty?.yaw ?? 0), s = Math.sin(jetty?.yaw ?? 0);
  return [wx * c - wz * s, wy, wx * s + wz * c];
}

function nextFractureRand(state) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

export function ensureJettyFracture(jetty, model = null, groundAt = null) {
  if (!jetty || !(jetty.model >= 0)) return null;
  if (jetty.fracture) {
    if (typeof groundAt === 'function') jetty.fracture.groundAt = groundAt;
    return jetty.fracture;
  }
  const m = model ?? loadedPropModels[jetty.model];
  if (!m?.fracture) return null;
  const shards = m.fracture.shards;
  const seed = (
    Math.imul(Math.round((jetty.x ?? 0) * 100), 73856093) ^
    Math.imul(Math.round((jetty.z ?? 0) * 100), 19349663) ^
    Math.imul(Math.round((jetty.yaw ?? 0) * 1000), 83492791) ^
    ((jetty.model + 1) * 2654435761)
  ) >>> 0;
  const state = {
    model: m,
    shards,
    alive: new Uint8Array(shards.length).fill(1),
    aliveCount: shards.length,
    flight: createShipFractureState({ shardCount: shards.length, scale: [1, 1, 1] }),
    now: 0,
    damaged: false,
    // Shards lying where they fell, and how far from the model the furthest of them and of those in the air get.
    kept: 0,
    reach: 0,
    flightReach: 0,
    // Told each time a shot breaks something off, so whoever draws it need not watch for it.
    onStruck: null,
    seed: seed || 1,
    groundAt: typeof groundAt === 'function' ? groundAt : () => 0,
  };
  jetty.fracture = state;
  if (jetty.savedDamage) {
    replayJettyDamage(jetty, state, jetty.savedDamage);
    delete jetty.savedDamage;
  }
  return state;
}

// How far out a prop must be drawn: nothing once what it stood on has gone or the last of it has sunk, and past its
// own size while timber is in the air or lies where it fell.
export function propDrawRadius(prop, model, ownerState = null) {
  if (ownerState === 'ruined' || ownerState === 'breached') return 0;
  const state = prop?.fracture;
  if (!state?.damaged) return model.radius;
  const flying = state.flight.flying.size > 0;
  if (state.aliveCount <= 0 && !flying && state.kept <= 0) return 0;
  return model.radius + Math.max(state.reach, flying ? state.flightReach : 0);
}

const SAVED_SHARD_NUMBERS = 7;
const savedNumber = (value) => +value.toFixed(3);
const propDamageState = (jetty, state) => (jetty.damageState ??= {
  materialClass: 'timber', hits: 0, breaches: 0, integrity: 1, state: 'intact', brokenShards: 0, collapsedShards: 0, totalShards: state.shards.length,
});
function gradeJettyDamage(damage, state) {
  damage.integrity = state.aliveCount / Math.max(1, state.shards.length);
  damage.state = state.aliveCount === 0 ? 'ruined' : damage.integrity < 0.55 ? 'breached' : state.damaged ? 'damaged' : 'intact';
}

// What a struck prop is saved as: `g` the shards gone, `k` each one lying where it fell as its id, how far it moved
// and the turn it took (an axis as long as the angle, in radians). One still in the air is saved where it will land.
// Null for a prop nothing has broken.
export function jettyDamageRecord(jetty) {
  if (jetty?.savedDamage) return jetty.savedDamage;
  const state = jetty?.fracture;
  if (!state?.damaged) return null;
  const records = state.flight.records, gone = [], kept = [];
  for (let s = 0; s < state.shards.length; s++) {
    if (state.alive[s]) continue;
    const at = s * FRACTURE_RECORD_FLOATS;
    if (records[at + 11] >= 0) { gone.push(s); continue; }
    const settle = records[at + 7], hinge = records[at + 12], free = Math.max(0, settle - hinge), rate = Math.hypot(records[at + 8], records[at + 9], records[at + 10]);
    const turn = (rate * free + (hinge > 0 ? 0.5 * rate * hinge : 0)) % (2 * Math.PI), perRate = rate > 1e-6 ? turn / rate : 0;
    kept.push(s,
      savedNumber(records[at + 4] * free), savedNumber(records[at + 5] * free - 0.5 * FRACTURE_GRAVITY * records[at + 13] * free * free), savedNumber(records[at + 6] * free),
      savedNumber(records[at + 8] * perRate), savedNumber(records[at + 9] * perRate), savedNumber(records[at + 10] * perRate));
  }
  const damage = jetty.damageState;
  const record = { m: PROP_MODELS[jetty.model]?.id ?? null, x: Math.round(jetty.x ?? 0), z: Math.round(jetty.z ?? 0), n: state.shards.length, i: +(state.aliveCount / Math.max(1, state.shards.length)).toFixed(4), h: damage?.hits ?? 0, a: damage?.lastHitDateMs ?? null };
  if (gone.length) record.g = gone;
  if (kept.length) record.k = kept;
  return record;
}

// Puts back what `jettyDamageRecord` saved, or holds it until the model is read. False if the record is of some
// other prop, or of this one cut into different shards: then it stands whole.
export function restoreJettyDamage(jetty, record) {
  if (!jetty || !record || record.m !== (PROP_MODELS[jetty.model]?.id ?? null)) return false;
  if (Math.abs(record.x - (jetty.x ?? 0)) > 1 || Math.abs(record.z - (jetty.z ?? 0)) > 1) return false;
  if (jetty.fracture) return replayJettyDamage(jetty, jetty.fracture, record);
  jetty.savedDamage = record;
  return true;
}

function replayJettyDamage(jetty, state, record) {
  const count = state.shards.length, kept = record.k ?? [], gone = record.g ?? [];
  if (record.n !== count || state.damaged || kept.length % SAVED_SHARD_NUMBERS) return false;
  const records = state.flight.records;
  const release = (s, flight) => {
    if (!(s >= 0 && s < count) || !state.alive[s]) return false;
    state.alive[s] = 0;
    state.aliveCount--;
    records.set(flight, s * FRACTURE_RECORD_FLOATS);
    state.flight.dirty.add(s);
    return true;
  };
  for (const s of gone) { const pivot = state.shards[s]?.center; if (pivot) release(s, [pivot[0], pivot[1], pivot[2], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]); }
  for (let k = 0; k < kept.length; k += SAVED_SHARD_NUMBERS) {
    const s = kept[k], pivot = state.shards[s]?.center;
    // A flight of one second with no gravity, stopped at its end: the shader and evaluateShardFlight pose it alike.
    if (pivot && release(s, [pivot[0], pivot[1], pivot[2], 0, kept[k + 1], kept[k + 2], kept[k + 3], 1, kept[k + 4], kept[k + 5], kept[k + 6], -1, 0, 0, 0, 1])) {
      state.kept++;
      state.reach = Math.max(state.reach, Math.hypot(kept[k + 1], kept[k + 2], kept[k + 3]));
    }
  }
  if (state.aliveCount === count) return false;
  state.damaged = true;
  const damage = propDamageState(jetty, state);
  damage.hits = record.h ?? 1;
  damage.breaches = Math.max(1, damage.breaches);
  damage.brokenShards = count - state.aliveCount;
  damage.lastHitDateMs = record.a ?? null;
  gradeJettyDamage(damage, state);
  return true;
}

export function preparePortJetties(port, models = loadedPropModels, groundAt = null) {
  if (!port || !Array.isArray(port.props)) return [];
  const gFn = typeof groundAt === 'function' ? groundAt : typeof port.groundAt === 'function' ? port.groundAt : null;
  if (Array.isArray(models)) {
    for (let i = 0; i < models.length; i++) if (models[i]) loadedPropModels[i] = models[i];
  }
  const prepared = [];
  for (const prop of port.props) {
    if (prop && prop.model >= 0) {
      const m = models?.[prop.model] ?? loadedPropModels[prop.model];
      const st = ensureJettyFracture(prop, m, gFn);
      if (st) prepared.push(prop);
    }
  }
  return prepared;
}

function scanJettySupport(state) {
  const { shards, alive } = state;
  const n = shards.length;
  const span = new Int16Array(n).fill(32767);
  const queue = [];
  for (let i = 0; i < n; i++) {
    if (alive[i] && shards[i].anchored) {
      span[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const shard = shards[i];
    const sp = span[i];
    if (sp === 0) {
      for (const aboveId of shard.above) {
        if (alive[aboveId] && span[aboveId] > 0) {
          span[aboveId] = 0;
          queue.push(aboveId);
        }
      }
    }
    const nextSpan = sp + 1;
    for (const nbId of shard.sideLinks) {
      if (alive[nbId] && nextSpan <= shards[nbId].maxSpan && nextSpan < span[nbId]) {
        span[nbId] = nextSpan;
        queue.push(nbId);
      }
    }
  }
  return span;
}

function releaseJettyShard(jetty, state, shardId, direct, localHit, shotDir, energyScale) {
  if (!state.alive[shardId]) return false;
  state.alive[shardId] = 0;
  state.aliveCount = Math.max(0, state.aliveCount - 1);
  const shard = state.shards[shardId];
  const pivot = shard.center;

  let dx = pivot[0] - localHit[0];
  let dy = pivot[1] - localHit[1];
  let dz = pivot[2] - localHit[2];
  const dist = Math.hypot(dx, dy, dz) || 1;
  dx /= dist; dy /= dist; dz /= dist;

  let vx, vy, vz, omega;
  if (direct) {
    const falloff = 1 / (1 + dist * 0.35);
    const speed = (6.2 + nextFractureRand(state) * 7.8) * energyScale * falloff;
    const outX = dx * 0.55 + (shotDir[0] ?? 0) * 0.65 + shard.normal[0] * 0.35;
    const outY = Math.max(0.28, dy * 0.35 + 0.48 + nextFractureRand(state) * 0.42);
    const outZ = dz * 0.55 + (shotDir[2] ?? 0) * 0.65 + shard.normal[2] * 0.35;
    const ol = Math.hypot(outX, outY, outZ) || 1;
    vx = (outX / ol) * speed;
    vy = (outY / ol) * speed;
    vz = (outZ / ol) * speed;
    omega = (3.8 + nextFractureRand(state) * 4.6) * Math.min(1.5, energyScale);
  } else {
    // Structural collapse when supporting pilings are shot away: tips outward and drops under gravity.
    const tipX = (shard.side === 0 ? -1 : 1) * (0.45 + nextFractureRand(state) * 0.65) + dx * 0.35;
    const tipZ = dz * (0.35 + nextFractureRand(state) * 0.45);
    vx = tipX;
    vy = 0.15 + nextFractureRand(state) * 0.35;
    vz = tipZ;
    omega = 1.15 + nextFractureRand(state) * 1.45;
  }

  let ax = -vz, ay = (nextFractureRand(state) - 0.5) * 0.4, az = vx;
  const al = Math.hypot(ax, ay, az);
  if (al > 1e-4) {
    ax /= al; ay /= al; az /= al;
  } else {
    ax = 1; ay = 0; az = 0;
  }

  // It comes down where it is thrown to, which may be beach when it left from over water, or the other way about:
  // the time of flight says where, and the ground there says the time, so go round until they agree.
  const worldPivot = jettyLocalToWorld(jetty, pivot[0], pivot[1], pivot[2], state.model), [worldVx, , worldVz] = jettyLocalToWorldDir(jetty, vx, vy, vz);
  let landX = worldPivot[0], landZ = worldPivot[2], settleTime = 0, drop = 0, overBeach = false;
  for (let pass = 0; pass < JETTY_LANDING_PASSES; pass++) {
    const rawGround = Number(state.groundAt?.(landX, landZ)), groundY = Number.isFinite(rawGround) ? rawGround : 0;
    overBeach = groundY > 0.05;
    drop = Math.max(0.25, worldPivot[1] - (overBeach ? groundY : Math.max(groundY, -0.25)));
    settleTime = (vy + Math.sqrt(vy * vy + 2 * FRACTURE_GRAVITY * drop)) / FRACTURE_GRAVITY;
    landX = worldPivot[0] + worldVx * settleTime;
    landZ = worldPivot[2] + worldVz * settleTime;
  }
  const hold = 3.2 + nextFractureRand(state) * 1.4;
  // What lands on the beach lies there. What lands in water goes under while it lingers, then is gone.
  const sinkDepth = overBeach ? 0 : 0.85, thrown = Math.hypot(vx, vz) * settleTime;
  if (!state.flight.flying.size) state.flightReach = 0;
  state.flightReach = Math.max(state.flightReach, thrown + Math.max(0, vy) * vy / (2 * FRACTURE_GRAVITY) + sinkDepth);
  if (overBeach) {
    state.kept++;
    state.reach = Math.max(state.reach, Math.hypot(thrown, drop));
  }

  writeFlight(
    state.flight,
    shardId,
    {
      pivot,
      velocity: [vx, vy, vz],
      spin: [ax * omega, ay * omega, az * omega],
      settle: settleTime,
      sink: sinkDepth / Math.max(0.1, hold),
      linger: hold,
      keep: overBeach,
    },
    state.now,
  );
  return true;
}

function segmentIntersectsBounds(p0, p1, bounds, pad = 0) {
  let tmin = 0, tmax = 1;
  for (let k = 0; k < 3; k++) {
    const start = p0[k], dir = p1[k] - start;
    const lo = bounds[k] - pad, hi = bounds[k + 3] + pad;
    if (Math.abs(dir) < 1e-8) {
      if (start < lo || start > hi) return false;
    } else {
      let t1 = (lo - start) / dir, t2 = (hi - start) / dir;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  return true;
}

function rayHitsShardTriangles(vertices, indices, shard, from, to, maxFraction = 1, radius = 0.08) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const segLen = Math.hypot(dx, dy, dz);
  if (segLen < 1e-6) return null;
  let bestT = maxFraction;
  let bestNormal = null;
  const end = shard.indexStart + shard.indexCount;
  // Small barycentric slack proportional to projectile radius so grazing shots catch plank edges.
  const baryTol = Math.min(0.08, Math.max(0.002, radius * 0.04));

  for (let i = shard.indexStart; i < end; i += 3) {
    const a = indices[i] * 8, b = indices[i + 1] * 8, c = indices[i + 2] * 8;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
    const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-8) continue;
    const inv = 1 / det;
    const tx = from[0] - ax, ty = from[1] - ay, tz = from[2] - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -baryTol || u > 1 + baryTol) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -baryTol || u + v > 1 + baryTol) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 0 || t >= bestT) continue;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    if (nx * dx + ny * dy + nz * dz > 0) {
      nx = -nx; ny = -ny; nz = -nz;
    }
    bestT = t;
    bestNormal = [nx, ny, nz];
  }
  return bestNormal ? { fraction: bestT, localNormal: bestNormal } : null;
}

export function sweepJettySegment(from, to, radius = 0.08, port, options = null) {
  const props = port?.props;
  if (!Array.isArray(props) || !props.length) return null;
  const r = Number.isFinite(radius) && radius >= 0 ? radius : 0.08;
  const mx = (from[0] + to[0]) * 0.5, my = (from[1] + to[1]) * 0.5, mz = (from[2] + to[2]) * 0.5;
  const halfSeg = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.5;
  let best = null;

  for (let propIndex = 0; propIndex < props.length; propIndex++) {
    const prop = props[propIndex];
    if (!prop || !(prop.model >= 0)) continue;
    if (options?.ignore === prop) continue;
    if (prop.owner >= 0) {
      const ownerState = port.instances?.[prop.owner]?.damageState?.state;
      if (ownerState === 'ruined' || ownerState === 'breached') continue;
    }
    const model = prop.fracture?.model ?? loadedPropModels[prop.model];
    if (!model?.fracture) continue;
    const state = ensureJettyFracture(prop, model, port?.groundAt);
    if (!state || state.aliveCount <= 0) continue;

    const py = jettyStandY(prop, model);
    const cy = py + model.height * 0.5;
    const reach = model.radius + r + halfSeg + 1.0;
    if (Math.hypot(mx - prop.x, my - cy, mz - prop.z) > reach) continue;

    const localFrom = jettyWorldToLocal(prop, from[0], from[1], from[2], model);
    const localTo = jettyWorldToLocal(prop, to[0], to[1], to[2], model);
    if (!segmentIntersectsBounds(localFrom, localTo, model.fracture.bounds, r)) continue;

    const maxF = best ? best.fraction : 1.0001;
    const { vertices, indices } = model;
    const { shards, alive } = state;

    for (let s = 0; s < shards.length; s++) {
      if (!alive[s]) continue;
      const shard = shards[s];
      if (!segmentIntersectsBounds(localFrom, localTo, shard.bounds, r)) continue;
      const hit = rayHitsShardTriangles(vertices, indices, shard, localFrom, localTo, maxF, r);
      if (hit && (!best || hit.fraction < best.fraction)) {
        const t = Math.max(0, Math.min(1, hit.fraction));
        const lx = localFrom[0] + (localTo[0] - localFrom[0]) * t;
        const ly = localFrom[1] + (localTo[1] - localFrom[1]) * t;
        const lz = localFrom[2] + (localTo[2] - localFrom[2]) * t;
        const wn = jettyLocalToWorldDir(prop, hit.localNormal[0], hit.localNormal[1], hit.localNormal[2]);
        best = {
          fraction: t,
          kind: 'jetty',
          materialClass: 'timber',
          jetty: prop,
          building: prop,
          propIndex,
          port,
          shardId: s,
          localPosition: [lx, ly, lz],
          normal: wn,
        };
      }
    }
  }
  return best;
}

export function applyJettyImpactDamage(jetty, event = {}, options = {}) {
  if (!jetty || !(jetty.model >= 0)) return null;
  if (event?.ammo === 'arrow' || event?.ammo === 'fire-arrow') return null;
  const port = options?.port ?? event?.port ?? null;
  const terrain = options?.terrain ?? null;
  const groundAt = options?.groundAt ?? port?.groundAt ?? (terrain?.groundSample ? (x, z) => terrain.groundSample(x, z) : terrain?.height ? (x, z) => terrain.height(x, z) : null);
  const state = ensureJettyFracture(jetty, null, groundAt);
  if (!state) return null;

  const worldHit = event.surfacePosition ?? event.position ?? jettyLocalToWorld(jetty, ...(event.localPosition ?? [0, state.model.fracture.deckY, 0]), state.model);
  const localHit = Array.isArray(event.localPosition) && event.localPosition.length === 3
    ? event.localPosition
    : jettyWorldToLocal(jetty, worldHit[0], worldHit[1], worldHit[2], state.model);

  const vel = Array.isArray(event.velocity) && event.velocity.length === 3 ? event.velocity : [0, 0, -300];
  const localVel = jettyWorldToLocalDir(jetty, vel[0], vel[1], vel[2]);
  const speed = Math.hypot(localVel[0], localVel[1], localVel[2]) || 1;
  const dir = [localVel[0] / speed, localVel[1] / speed, localVel[2] / speed];
  const mass = Number.isFinite(event.mass) && event.mass > 0 ? event.mass : 10.9;
  const energy = Number.isFinite(event.energy) && event.energy > 0 ? event.energy : 0.5 * mass * speed * speed;
  const energyScale = Math.max(0.65, Math.min(1.65, Math.cbrt(energy / 350000)));
  const blastRadius = 1.55 * energyScale;

  const deckY = state.model.fracture.deckY;
  const hitShard = Number.isFinite(event.shardId) ? state.shards[event.shardId] : null;
  const isJetty = jetty.model >= FIRST_JETTY || state.model.height >= 2.0;
  const lowPilingShot = isJetty && (hitShard ? hitShard.tier < 2 : localHit[1] < deckY * 0.78) && Math.abs(dir[1]) < 0.35;

  // Chord along the shot line through the prop so a roundshot punches cleanly through the bay it hits.
  const chordStart = [localHit[0] - dir[0] * 0.75, localHit[1] - dir[1] * 0.75, localHit[2] - dir[2] * 0.75];
  const chordEnd = [localHit[0] + dir[0] * 6.2, localHit[1] + dir[1] * 6.2, localHit[2] + dir[2] * 6.2];

  const directIds = new Set();
  if (hitShard && state.alive[hitShard.id]) directIds.add(hitShard.id);

  for (let s = 0; s < state.shards.length; s++) {
    if (!state.alive[s]) continue;
    const shard = state.shards[s];
    if (lowPilingShot && shard.tier === 2) continue;
    const c = shard.center;
    const d = Math.hypot(c[0] - localHit[0], c[1] - localHit[1], c[2] - localHit[2]);
    if (d <= blastRadius && Math.abs(c[1] - localHit[1]) <= 1.65) {
      directIds.add(s);
      continue;
    }
    if (segmentIntersectsBounds(chordStart, chordEnd, shard.bounds, 0.25)) {
      if (rayHitsShardTriangles(state.model.vertices, state.model.indices, shard, chordStart, chordEnd, 1.0001, 0.14)) {
        directIds.add(s);
      }
    }
  }

  const releasedShards = [];
  for (const id of directIds) {
    if (releaseJettyShard(jetty, state, id, true, localHit, dir, energyScale)) {
      releasedShards.push(id);
    }
  }

  const collapsedShards = [];
  if (releasedShards.length > 0) {
    const span = scanJettySupport(state);
    for (let s = 0; s < state.shards.length; s++) {
      if (state.alive[s] && span[s] > state.shards[s].maxSpan) {
        if (releaseJettyShard(jetty, state, s, false, localHit, dir, energyScale)) {
          collapsedShards.push(s);
        }
      }
    }
  }

  const totalReleased = releasedShards.length + collapsedShards.length;
  if (totalReleased > 0) state.damaged = true;

  const damage = propDamageState(jetty, state);
  damage.hits++;
  damage.brokenShards += releasedShards.length;
  damage.collapsedShards += collapsedShards.length;
  if (totalReleased > 0) damage.breaches++;
  gradeJettyDamage(damage, state);
  if (totalReleased > 0) state.onStruck?.(jetty);

  return {
    kind: 'jetty',
    materialClass: 'timber',
    jetty,
    hits: damage.hits,
    breaches: damage.breaches,
    integrity: damage.integrity,
    state: damage.state,
    releasedShards,
    collapsedShards,
    totalReleased,
    aliveShards: state.aliveCount,
    totalShards: state.shards.length,
    energyKj: +(energy / 1000).toFixed(2),
  };
}

export function stepJettyFracture(jetty, dt = 1 / 60) {
  const state = jetty?.fracture;
  if (!state || !state.damaged) return false;
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.25, dt) : 0;
  if (step > 0) {
    state.now += step;
    settleFinishedFlights(state.flight, state.now);
  }
  return state.flight.flying.size > 0;
}

// Where a shard is and how it lies, for a test or a tool to ask. The game draws from the same record on the GPU.
export function evaluateJettyShardPose(jetty, shardId, now = jetty?.fracture?.now ?? 0) {
  const state = jetty?.fracture;
  if (!state || shardId < 0 || shardId >= state.shards.length) return null;
  const shard = state.shards[shardId];
  const pivot = shard.center;
  const records = state.flight.records;
  const base = shardId * FRACTURE_RECORD_FLOATS;
  const record = records.subarray(base, base + FRACTURE_RECORD_FLOATS);
  const frozen = record[15];

  if (frozen < -1.5) {
    const worldPosition = jettyLocalToWorld(jetty, pivot[0], pivot[1], pivot[2], state.model);
    const worldNormal = jettyLocalToWorldDir(jetty, shard.normal[0], shard.normal[1], shard.normal[2]);
    return {
      shardId,
      role: shard.role,
      tier: shard.tier,
      bay: shard.bay,
      side: shard.side,
      standing: true,
      inFlight: false,
      settled: false,
      retired: false,
      alive: 1,
      angle: 0,
      localPosition: [pivot[0], pivot[1], pivot[2]],
      worldPosition,
      worldNormal,
    };
  }

  const clock = now - state.flight.epoch;
  const age = frozen >= 0 ? frozen : Math.max(0, clock - record[3]);
  const settleTime = record[7];
  const hideAt = record[11];
  const omega = Math.hypot(record[8], record[9], record[10]);
  if (hideAt >= 0 && age >= hideAt) {
    return {
      shardId,
      role: shard.role,
      tier: shard.tier,
      bay: shard.bay,
      side: shard.side,
      standing: false,
      inFlight: false,
      settled: true,
      retired: true,
      alive: 0,
      angle: omega * settleTime,
      localPosition: [pivot[0], pivot[1], pivot[2]],
      worldPosition: jettyLocalToWorld(jetty, pivot[0], pivot[1], pivot[2], state.model),
      worldNormal: [0, 1, 0],
    };
  }

  const flightDt = Math.min(age, settleTime);
  const localPosition = evaluateShardFlight(record, clock, pivot, [1, 1, 1]);
  return {
    shardId,
    role: shard.role,
    tier: shard.tier,
    bay: shard.bay,
    side: shard.side,
    standing: false,
    inFlight: age < settleTime,
    settled: age >= settleTime,
    retired: false,
    alive: 1,
    angle: omega * flightDt,
    localPosition,
    worldPosition: jettyLocalToWorld(jetty, localPosition[0], localPosition[1], localPosition[2], state.model),
    worldNormal: jettyLocalToWorldDir(jetty, shard.normal[0], shard.normal[1], shard.normal[2]),
  };
}
