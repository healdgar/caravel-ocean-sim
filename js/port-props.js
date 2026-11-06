// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Generated, textured models about a port, and where they go. This decides places once, when a port is
// laid out. js/props.js draws them. They are scenery: nothing moors to them and a shot passes through.
import { gltfAccessor, readGLB } from './gltf.js';

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
const JETTY_OUT_M = 5, JETTY_ROOT_HIGHEST_M = 3, JETTY_SLOPE_PROBE_M = 12;
const JETTY_BUILDING_GAP_M = 12, JETTY_APART_M = 70;
const CLEATED = Object.freeze({ timber_mole_pier: 'both', stone_quay_seawall: 'sea' });

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
    const top = inst.y + inst.height, count = Math.floor((inst.length - 2 * CLEAT_END_CLEARANCE_M) / CLEAT_SPACING_M);
    for (const edge of edges) for (let k = 0; k <= count; k++) {
      const along = -halfLength + CLEAT_END_CLEARANCE_M + k * CLEAT_SPACING_M, [x, z] = world(edge * (halfWidth - CLEAT_EDGE_INSET_M), along);
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

// A model read from its file, turned so its length runs along z, standing on y = 0 and centred. Positions
// are in real metres. The texture stays as compressed bytes for the browser to decode.
export function readPropModel(bytes, spec) {
  const asset = readGLB(bytes), json = asset.json, primitive = json.meshes[0].primitives[0];
  const positions = gltfAccessor(asset, primitive.attributes.POSITION), normals = gltfAccessor(asset, primitive.attributes.NORMAL), uvs = gltfAccessor(asset, primitive.attributes.TEXCOORD_0);
  const count = positions.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], positions[i * 3 + k]); hi[k] = Math.max(hi[k], positions[i * 3 + k]); }
  const scale = spec.metres / (hi[spec.sizeAxis] - lo[spec.sizeAxis]), mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], vertices = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) {
    const x = (positions[i * 3] - mid[0]) * scale, y = (positions[i * 3 + 1] - mid[1]) * scale, z = (positions[i * 3 + 2] - mid[2]) * scale;
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    vertices.set(spec.quarterTurn ? [z, y, -x, nz, ny, -nx] : [x, y, z, nx, ny, nz], i * 8);
    vertices.set([uvs[i * 2], uvs[i * 2 + 1]], i * 8 + 6);
  }
  const size = [(hi[0] - lo[0]) * scale, (hi[1] - lo[1]) * scale, (hi[2] - lo[2]) * scale];
  const image = json.images[json.textures[json.materials[primitive.material].pbrMetallicRoughness.baseColorTexture.index].source], view = json.bufferViews[image.bufferView];
  return {
    vertices, indices: Uint32Array.from(gltfAccessor(asset, primitive.indices)), image: new Uint8Array(asset.bin.buffer, asset.bin.byteOffset + (view.byteOffset ?? 0), view.byteLength), mime: image.mimeType,
    height: size[1], radius: Math.hypot(...size) / 2, standsAt: spec.deckShare ? JETTY_DECK_ABOVE_SEA_M - size[1] * spec.deckShare : 0,
  };
}
