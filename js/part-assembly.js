// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Unified Part-Identity, Sub-Assembly, Exploded-View, Cutaway and Per-Part
// State abstraction shared across procedural ships and 1550 port buildings.
// Every merged vertex retains its owning partNumber, pivot, explodedOffset and
// structural layer so assembly, exploded views, cutaways and localized damage
// run from compact per-part state without re-merging geometry at runtime.

import { deepFreeze } from './rig-definition.js';
import { PART_ASSEMBLY_POSE_UPDATE } from './wgsl/part-assembly.js';

export const SHIP_SUB_ASSEMBLIES = Object.freeze([
  Object.freeze({ id: 'keel-and-frame', index: 0, layer: 0, label: 'Keel, Stem, Sternpost & Frames' }),
  Object.freeze({ id: 'decks-and-interior', index: 1, layer: 1, label: 'Decks, Bulkheads, Stairs & Hold' }),
  Object.freeze({ id: 'ordnance-and-helm', index: 2, layer: 2, label: 'Ordnance, Steering, Anchors & Oars' }),
  Object.freeze({ id: 'hull-and-bulwarks', index: 3, layer: 3, label: 'Outer Planking, Wales, Bulwarks & Galleries' }),
  Object.freeze({ id: 'masts-and-spars', index: 4, layer: 4, label: 'Masts, Bowsprit, Yards & Spars' }),
  Object.freeze({ id: 'rigging-and-sails', index: 5, layer: 5, label: 'Standing/Running Rigging & Sails' }),
]);

export const BUILDING_SUB_ASSEMBLIES = Object.freeze([
  Object.freeze({ id: 'foundation-and-pilings', index: 0, layer: 0, label: 'Foundations, Plinths, Pilings & Cutwaters' }),
  Object.freeze({ id: 'structural-core', index: 1, layer: 1, label: 'Terreplein, Courtyards, Vaults & Slipway Frames' }),
  Object.freeze({ id: 'walls-and-bastions', index: 2, layer: 2, label: 'Load-Bearing Walls, Quoins, Buttresses & Bastions' }),
  Object.freeze({ id: 'arcades-and-fortifications', index: 3, layer: 3, label: 'Arcades, Portals, Balconies, Parapets & Garitas' }),
  Object.freeze({ id: 'ordnance-and-fittings', index: 4, layer: 4, label: 'Cannon Batteries, Cranes, Beacons & Bollards' }),
  Object.freeze({ id: 'roof-and-canopy', index: 5, layer: 5, label: 'Roof Trusses, Rafters, Barrel Tiles, Thatch & Domes' }),
]);

export const PART_CUTAWAY_MODES = Object.freeze({
  none: 0,
  layer: 1,
  port: 2,
  west: 2,
  starboard: 3,
  east: 3,
  axial: 4,
});

const partAssemblySmoothstep = (edge0, edge1, x) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function partAssemblyClassifyShip(group, bounds) {
  const id = String(group.id ?? '');
  const motionType = group.motion?.type ?? null;
  const isMoving = Boolean(
    motionType ||
      id === 'helm.rudder' ||
      id === 'helm.tiller' ||
      id === 'helm.wheel' ||
      id === 'helm.steering-oar' ||
      id === 'hatch.main' ||
      id === 'hatch.cover' ||
      id.startsWith('sail.') ||
      id.startsWith('yard.') ||
      id.startsWith('spar.') ||
      id.startsWith('gunnery.recoil.') ||
      id.startsWith('rowing.propulsor.')
  );
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const side =
    id.includes('port') || id.includes(':-1') || id.includes('.-1')
      ? -1
      : id.includes('starboard') || id.includes(':1') || id.includes('.1')
        ? 1
        : Math.abs(cx) > 0.22
          ? Math.sign(cx)
          : 0;

  if (
    id.includes('keel') ||
    id.includes('frames') ||
    id.includes('sternpost') ||
    id.includes('stems') ||
    id === 'bow.stem' ||
    id === 'bow.knee' ||
    id === 'bow.cutwater'
  ) {
    return { subAssembly: 'keel-and-frame', subAssemblyIndex: 0, layer: 0, cutawaySide: 0, isMoving, motionType };
  }
  if (
    id.startsWith('deck.') ||
    id === 'stairs' ||
    id.startsWith('stair:') ||
    id.startsWith('hatch.') ||
    id === 'rowing.benches'
  ) {
    return { subAssembly: 'decks-and-interior', subAssemblyIndex: 1, layer: 1, cutawaySide: 0, isMoving, motionType };
  }
  if (
    id.startsWith('gun.') ||
    id.startsWith('gun:') ||
    id.startsWith('gunnery.recoil.') ||
    id.startsWith('helm.') ||
    id.startsWith('anchor.') ||
    id.startsWith('anchor:') ||
    id.startsWith('boat.waist.') ||
    id.startsWith('rowing.')
  ) {
    return { subAssembly: 'ordnance-and-helm', subAssemblyIndex: 2, layer: 2, cutawaySide: side, isMoving, motionType };
  }
  if (
    id.startsWith('mast.') ||
    id === 'bow.bowsprit' ||
    id.startsWith('lookout.') ||
    id.startsWith('yard.') ||
    id.startsWith('spar.') ||
    id.startsWith('tackle.')
  ) {
    return { subAssembly: 'masts-and-spars', subAssemblyIndex: 4, layer: 4, cutawaySide: 0, isMoving, motionType };
  }
  if (
    id.startsWith('rig.') ||
    id.startsWith('rope.') ||
    id.startsWith('fitting.') ||
    id.startsWith('sail.') ||
    id.startsWith('flag.')
  ) {
    return { subAssembly: 'rigging-and-sails', subAssemblyIndex: 5, layer: 5, cutawaySide: side, isMoving, motionType };
  }
  return { subAssembly: 'hull-and-bulwarks', subAssemblyIndex: 3, layer: 3, cutawaySide: side, isMoving, motionType };
}

function partAssemblyClassifyBuilding(group, bounds) {
  const rawId = String(group.partKey ?? group.id ?? '');
  const id = rawId.includes(':') ? rawId.split(':').at(-1) : rawId;
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const side = Math.abs(cx) > 0.35 ? Math.sign(cx) : 0;

  if (
    id.startsWith('foundation') ||
    id.includes('plinth') ||
    id.includes('pilings') ||
    id.includes('sleepers') ||
    id.includes('cutwaters') ||
    id.includes('bridge-piers') ||
    id.includes('bridge_piers') ||
    id.includes('apron') ||
    id.includes('slipway')
  ) {
    return { subAssembly: 'foundation-and-pilings', subAssemblyIndex: 0, layer: 0, cutawaySide: 0, isMoving: false, motionType: null };
  }
  if (
    id.startsWith('interior') ||
    id.startsWith('courtyard') ||
    id.includes('terreplein') ||
    id.includes('fountain') ||
    id.includes('wellhead') ||
    id.includes('trough') ||
    id.includes('vault_core') ||
    id.includes('stringers') ||
    id.includes('cross-beams') ||
    id.includes('cross_beams') ||
    id.includes('keel') ||
    id.includes('rib-frames') ||
    id.includes('rib_frames') ||
    id.includes('barracks') ||
    id.includes('magazine') ||
    id.includes('polvorin') ||
    id.includes('keep') ||
    id.includes('deck_slab') ||
    id.includes('tier_decks')
  ) {
    return { subAssembly: 'structural-core', subAssemblyIndex: 1, layer: 1, cutawaySide: 0, isMoving: false, motionType: null };
  }
  if (
    id.startsWith('arcade') ||
    id.startsWith('facade') ||
    id.startsWith('balcony') ||
    id.includes('arch') ||
    id.includes('column') ||
    id.includes('portal') ||
    id.includes('gatehouse') ||
    id.includes('parapet') ||
    id.includes('merlon') ||
    id.includes('garita') ||
    id.includes('steps') ||
    id.includes('curbs') ||
    id.includes('balustrade') ||
    id.includes('mirador')
  ) {
    return { subAssembly: 'arcades-and-fortifications', subAssemblyIndex: 3, layer: 3, cutawaySide: side, isMoving: false, motionType: null };
  }
  if (
    id.startsWith('ordnance') ||
    id.startsWith('fittings') ||
    id.includes('cannon') ||
    id.includes('embrasure') ||
    id.includes('bollard') ||
    id.includes('mooring') ||
    id.includes('crane') ||
    id.includes('beacon') ||
    id.includes('farol') ||
    id.includes('lantern') ||
    id.includes('pitch') ||
    id.includes('cauldron') ||
    id.includes('bell') ||
    id.includes('sheerlegs')
  ) {
    return { subAssembly: 'ordnance-and-fittings', subAssemblyIndex: 4, layer: 4, cutawaySide: side, isMoving: false, motionType: null };
  }
  if (
    id.startsWith('roof') ||
    id.startsWith('canopy') ||
    id.startsWith('palm') ||
    id.includes('truss') ||
    id.includes('rafter') ||
    id.includes('eaves') ||
    id.includes('slopes') ||
    id.includes('ridge') ||
    id.includes('cupola') ||
    id.includes('dome') ||
    id.includes('finial') ||
    id.includes('spire')
  ) {
    return { subAssembly: 'roof-and-canopy', subAssemblyIndex: 5, layer: 5, cutawaySide: side, isMoving: false, motionType: null };
  }
  return { subAssembly: 'walls-and-bastions', subAssemblyIndex: 2, layer: 2, cutawaySide: side, isMoving: false, motionType: null };
}

function partAssemblyComputeExplodedOffset(domain, subAssemblyIndex, layer, centroid, modelCenter, modelSpan, cutawaySide) {
  const dx = centroid[0] - modelCenter[0];
  const dy = centroid[1] - modelCenter[1];
  const dz = centroid[2] - modelCenter[2];
  const sx = Math.max(1.5, modelSpan[0]);
  const sy = Math.max(1.5, modelSpan[1]);
  const sz = Math.max(1.5, modelSpan[2]);

  if (domain === 'ship') {
    if (subAssemblyIndex === 0) {
      // Keel & frames drop slightly downward so the structural spine is clear beneath the hull
      return [0, -sy * 0.28, dz * 0.08];
    }
    if (subAssemblyIndex === 1) {
      // Decks & bulkheads lift vertically in tiers
      return [dx * 0.18, sy * (0.22 + Math.max(0, dy / sy) * 0.35), dz * 0.12];
    }
    if (subAssemblyIndex === 2) {
      // Ordnance, rudder, anchors & oars slide radially outward from their stations
      const outX = cutawaySide !== 0 ? cutawaySide * sx * 0.65 : dx * 0.45;
      return [outX, dy * 0.20 + sy * 0.12, dz * 0.22];
    }
    if (subAssemblyIndex === 3) {
      // Outer hull planking, wales, bulwarks & stern galleries separate port/starboard and aft
      const latSign = cutawaySide !== 0 ? cutawaySide : Math.abs(dx) > 0.08 ? Math.sign(dx) : 0;
      const vertLift = latSign === 0 ? sy * 0.26 + Math.max(0, dy) * 0.15 : dy * 0.15;
      return [latSign * sx * 0.55 + dx * 0.25, vertLift, dz * 0.18];
    }
    if (subAssemblyIndex === 4) {
      // Masts, bowsprit & yards lift high above the weather deck
      return [dx * 0.22, sy * 0.62 + Math.max(0, dy) * 0.25, dz * 0.20];
    }
    // Rigging & sails lift and step forward/outward
    return [dx * 0.38 + cutawaySide * sx * 0.25, sy * 0.82 + Math.max(0, dy) * 0.30, dz * 0.28 - sz * 0.08];
  }

  // Building domain exploded offsets
  if (subAssemblyIndex === 0) {
    // Foundations & pilings stay anchored at the base (slight downward step)
    return [0, -sy * 0.18, 0];
  }
  if (subAssemblyIndex === 1) {
    // Structural core, courtyard & terreplein lift slightly
    return [dx * 0.12, sy * 0.16, dz * 0.12];
  }
  if (subAssemblyIndex === 2) {
    // Load-bearing walls, bastions & quoins expand outward from building center
    return [dx * 0.42, sy * 0.28 + Math.max(0, dy) * 0.18, dz * 0.42];
  }
  if (subAssemblyIndex === 3) {
    // Arcades, portals, facade bays, balconies & garitas step further outward
    return [dx * 0.62, sy * 0.42 + Math.max(0, dy) * 0.22, dz * 0.62];
  }
  if (subAssemblyIndex === 4) {
    // Cannon batteries, cranes, bollards & beacons lift and step outward
    return [dx * 0.72, sy * 0.58 + Math.max(0, dy) * 0.25, dz * 0.72];
  }
  // Roof trusses, barrel-tile / thatch slopes & domes lift cleanly upward off the walls
  return [dx * 0.20, sy * 0.95 + Math.max(0, dy) * 0.35, dz * 0.20];
}

export function createPartAssemblyCatalog({
  domain = 'ship',
  modelId = 'unknown',
  variantMask = 1,
  vertices,
  vertexStride = 9,
  indices = null,
  groups = [],
} = {}) {
  if (!(vertices instanceof Float32Array) || vertices.length % vertexStride !== 0) {
    throw new Error(`Part assembly catalog requires Float32Array vertices with stride ${vertexStride}`);
  }
  const vertexCount = vertices.length / vertexStride;
  const hasIndices = indices instanceof Uint32Array || indices instanceof Uint16Array;
  const indexCount = hasIndices ? indices.length : vertexCount;
  const triangleCount = Math.floor(indexCount / 3);
  const taxonomy = domain === 'building' ? BUILDING_SUB_ASSEMBLIES : SHIP_SUB_ASSEMBLIES;

  // Normalize group index ranges (groups in ships use firstVertex/vertexCount in raw stream = index offsets)
  const rawRanges = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const firstIndex = Number.isInteger(g.firstIndex) ? g.firstIndex : (g.firstVertex ?? 0);
    const count = Number.isInteger(g.indexCount) ? g.indexCount : (g.vertexCount ?? 0);
    const clampedFirst = Math.max(0, Math.min(indexCount, firstIndex));
    const clampedEnd = Math.max(clampedFirst, Math.min(indexCount, firstIndex + count));
    if (clampedEnd <= clampedFirst) continue;
    rawRanges.push({
      sourceIndex: i,
      group: g,
      firstIndex: clampedFirst,
      endIndex: clampedEnd,
      span: clampedEnd - clampedFirst,
    });
  }

  // Resolve parent-child containment for nested groups in O(P log P) via an ancestor interval stack
  const parentSourceIndex = new Int32Array(rawRanges.length).fill(-1);
  const sortedForTree = rawRanges
    .map((r, idx) => ({ ...r, idx }))
    .sort((a, b) => a.firstIndex - b.firstIndex || b.span - a.span || a.idx - b.idx);
  const ancestorStack = [];
  for (let k = 0; k < sortedForTree.length; k++) {
    const cur = sortedForTree[k];
    while (ancestorStack.length > 0) {
      const top = ancestorStack[ancestorStack.length - 1];
      const encloses =
        top.firstIndex <= cur.firstIndex &&
        top.endIndex >= cur.endIndex &&
        (top.span > cur.span || (top.span === cur.span && top.idx < cur.idx));
      if (encloses) break;
      ancestorStack.pop();
    }
    if (ancestorStack.length > 0) {
      parentSourceIndex[cur.idx] = ancestorStack[ancestorStack.length - 1].idx;
    }
    ancestorStack.push(cur);
  }

  // Assign every triangle to the most specific (smallest span, latest authored) enclosing group
  const trianglePartIds = new Uint16Array(triangleCount);
  const triAssigned = new Uint8Array(triangleCount);
  for (let k = 0; k < sortedForTree.length; k++) {
    const r = sortedForTree[k];
    const t0 = Math.floor(r.firstIndex / 3);
    const t1 = Math.floor(r.endIndex / 3);
    if (t1 > t0) {
      trianglePartIds.fill(r.idx, t0, t1);
      triAssigned.fill(1, t0, t1);
    }
  }

  // If any triangles were emitted outside named groups, add a fallback structural part
  let hasUncovered = false;
  for (let t = 0; t < triangleCount; t++) {
    if (!triAssigned[t]) {
      hasUncovered = true;
      break;
    }
  }
  if (hasUncovered || rawRanges.length === 0) {
    const fallbackIdx = rawRanges.length;
    rawRanges.push({
      sourceIndex: fallbackIdx,
      group: {
        id: domain === 'building' ? `${modelId}:structure.body` : 'hull.structure',
        nodeId: domain === 'building' ? modelId : 'hull',
        firstVertex: 0,
        vertexCount: indexCount,
      },
      firstIndex: 0,
      endIndex: indexCount,
      span: indexCount,
    });
    for (let t = 0; t < triangleCount; t++) {
      if (!triAssigned[t]) {
        triAssigned[t] = 1;
        trianglePartIds[t] = fallbackIdx;
      }
    }
  }

  const partCount = rawRanges.length;

  // Compute model-wide bounding box and per-part bounding boxes
  const modelBounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  for (let v = 0; v < vertexCount; v++) {
    const at = v * vertexStride;
    const x = vertices[at], y = vertices[at + 1], z = vertices[at + 2];
    if (x < modelBounds.min[0]) modelBounds.min[0] = x;
    if (x > modelBounds.max[0]) modelBounds.max[0] = x;
    if (y < modelBounds.min[1]) modelBounds.min[1] = y;
    if (y > modelBounds.max[1]) modelBounds.max[1] = y;
    if (z < modelBounds.min[2]) modelBounds.min[2] = z;
    if (z > modelBounds.max[2]) modelBounds.max[2] = z;
  }
  if (!Number.isFinite(modelBounds.min[0])) {
    modelBounds.min = [0, 0, 0];
    modelBounds.max = [0, 0, 0];
  }
  const modelCenter = [
    (modelBounds.min[0] + modelBounds.max[0]) * 0.5,
    (modelBounds.min[1] + modelBounds.max[1]) * 0.5,
    (modelBounds.min[2] + modelBounds.max[2]) * 0.5,
  ];
  const modelSpan = [
    Math.max(0.01, modelBounds.max[0] - modelBounds.min[0]),
    Math.max(0.01, modelBounds.max[1] - modelBounds.min[1]),
    Math.max(0.01, modelBounds.max[2] - modelBounds.min[2]),
  ];

  // Assign each vertex to the most specific leaf part that touches it
  const vertexPartIds = new Uint16Array(vertexCount);
  const vertexSpanBest = new Uint32Array(vertexCount).fill(0xffffffff);
  const leafTriCounts = new Uint32Array(partCount);

  for (let t = 0; t < triangleCount; t++) {
    const pIdx = trianglePartIds[t];
    leafTriCounts[pIdx]++;
    const span = rawRanges[pIdx].span;
    const base = t * 3;
    for (let k = 0; k < 3; k++) {
      const vIdx = hasIndices ? indices[base + k] : base + k;
      if (vIdx < vertexCount && span <= vertexSpanBest[vIdx]) {
        vertexSpanBest[vIdx] = span;
        vertexPartIds[vIdx] = pIdx;
      }
    }
  }

  // Compute bounds and centroids for each part over its full index range [firstIndex, endIndex)
  const rawParts = [];
  for (let p = 0; p < partCount; p++) {
    const r = rawRanges[p];
    const g = r.group;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let idx = r.firstIndex; idx < r.endIndex; idx++) {
      const vIdx = hasIndices ? indices[idx] : idx;
      const at = vIdx * vertexStride;
      const x = vertices[at], y = vertices[at + 1], z = vertices[at + 2];
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
    if (!Number.isFinite(min[0])) {
      min[0] = min[1] = min[2] = 0;
      max[0] = max[1] = max[2] = 0;
    }
    const bounds = { min, max };
    const centroid = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
    const classification =
      domain === 'building'
        ? partAssemblyClassifyBuilding(g, bounds)
        : partAssemblyClassifyShip(g, bounds);
    const explicitPivot = Array.isArray(g.pivot)
      ? g.pivot
      : Array.isArray(g.motion?.pivot)
        ? g.motion.pivot
        : Array.isArray(g.motion?.point)
          ? g.motion.point
          : null;
    const pivot = explicitPivot
      ? [explicitPivot[0], explicitPivot[1], explicitPivot[2]]
      : [centroid[0], classification.layer === 0 ? centroid[1] : min[1], centroid[2]];
    const explodedOffset = partAssemblyComputeExplodedOffset(
      domain,
      classification.subAssemblyIndex,
      classification.layer,
      centroid,
      modelCenter,
      modelSpan,
      classification.cutawaySide
    );
    rawParts.push({
      partNumber: p,
      id: String(g.id ?? `part.${p}`),
      nodeId: String(g.nodeId ?? g.prefabId ?? modelId),
      prefabId: g.prefabId ?? null,
      instanceId: g.instanceId ?? null,
      instanceIndex: g.instanceIndex ?? 0,
      partKey: g.partKey ?? String(g.id ?? `part.${p}`),
      parentPartNumber: parentSourceIndex[p] ?? -1,
      firstIndex: r.firstIndex,
      indexCount: r.span,
      triangleCount: leafTriCounts[p],
      totalTriangleCount: Math.floor(r.span / 3),
      ...classification,
      variantMask: g.variantMask ?? variantMask,
      bounds: { min: Object.freeze(min), max: Object.freeze(max) },
      centroid: Object.freeze(centroid),
      pivot: Object.freeze(pivot),
      explodedOffset: Object.freeze(explodedOffset),
    });
  }

  // Assign deterministic procedural assembly timing windows [appearStart, appearEnd] in [0, 1]
  // Ordered by structural layer (0..5), then vertical elevation (bottom-up), then fore-to-aft
  const sortedForAssembly = [...rawParts].sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (Math.abs(a.pivot[1] - b.pivot[1]) > 0.05) return a.pivot[1] - b.pivot[1];
    if (Math.abs(a.pivot[2] - b.pivot[2]) > 0.05) return a.pivot[2] - b.pivot[2];
    return a.partNumber - b.partNumber;
  });

  const assemblyWindows = new Array(partCount);
  const windowDuration = Math.min(0.22, Math.max(0.06, 1.6 / Math.max(1, partCount)));
  for (let rank = 0; rank < sortedForAssembly.length; rank++) {
    const p = sortedForAssembly[rank];
    const layerBase = (p.layer / 6) * 0.72;
    const rankFrac = sortedForAssembly.length > 1 ? rank / (sortedForAssembly.length - 1) : 0;
    const start = Math.min(1 - windowDuration, layerBase * 0.55 + rankFrac * (1 - windowDuration - layerBase * 0.55));
    const end = Math.min(1.0, start + windowDuration);
    assemblyWindows[p.partNumber] = Object.freeze([+start.toFixed(5), +end.toFixed(5)]);
  }

  const parts = rawParts.map((p) =>
    Object.freeze({
      ...p,
      assemblyWindow: assemblyWindows[p.partNumber],
    })
  );
  const partsById = Object.fromEntries(parts.map((p) => [p.id, p]));

  // Build GPU-ready per-vertex attribute buffer (2 vec4f = 8 floats per vertex)
  // attr0: [partNumber, explodedOffset.x, explodedOffset.y, explodedOffset.z]
  // attr1: [pivot.x, pivot.y, pivot.z, packedMeta]
  const vertexPartBuffer = new Float32Array(vertexCount * 8);
  for (let v = 0; v < vertexCount; v++) {
    const pIdx = vertexPartIds[v];
    const part = parts[pIdx];
    const base = v * 8;
    const packedMeta =
      part.layer +
      part.subAssemblyIndex * 8 +
      (part.cutawaySide + 1) * 64 +
      (part.isMoving ? 256 : 0);
    vertexPartBuffer[base + 0] = pIdx;
    vertexPartBuffer[base + 1] = part.explodedOffset[0];
    vertexPartBuffer[base + 2] = part.explodedOffset[1];
    vertexPartBuffer[base + 3] = part.explodedOffset[2];
    vertexPartBuffer[base + 4] = part.pivot[0];
    vertexPartBuffer[base + 5] = part.pivot[1];
    vertexPartBuffer[base + 6] = part.pivot[2];
    vertexPartBuffer[base + 7] = packedMeta;
  }

  // Build GPU-ready per-part descriptor table (2 vec4f = 8 floats per part)
  // desc0: [appearStart, appearEnd, layer, subAssemblyIndex]
  // desc1: [pivot.x, pivot.y, pivot.z, cutawaySide]
  const partDescriptors = new Float32Array(partCount * 8);
  for (let p = 0; p < partCount; p++) {
    const part = parts[p];
    const base = p * 8;
    partDescriptors[base + 0] = part.assemblyWindow[0];
    partDescriptors[base + 1] = part.assemblyWindow[1];
    partDescriptors[base + 2] = part.layer;
    partDescriptors[base + 3] = part.subAssemblyIndex;
    partDescriptors[base + 4] = part.pivot[0];
    partDescriptors[base + 5] = part.pivot[1];
    partDescriptors[base + 6] = part.pivot[2];
    partDescriptors[base + 7] = part.cutawaySide;
  }

  // Build sub-assembly & layer summaries
  const subAssemblies = taxonomy.map((meta) => {
    const matching = parts.filter((p) => p.subAssemblyIndex === meta.index);
    return Object.freeze({
      ...meta,
      partCount: matching.length,
      partNumbers: Object.freeze(matching.map((p) => p.partNumber)),
      partIds: Object.freeze(matching.map((p) => p.id)),
      triangleCount: matching.reduce((sum, p) => sum + p.triangleCount, 0),
    });
  });

  const layers = Array.from({ length: 6 }, (_, layer) => {
    const matching = parts.filter((p) => p.layer === layer);
    return Object.freeze({
      layer,
      label: taxonomy[layer]?.label ?? `Layer ${layer}`,
      partCount: matching.length,
      partNumbers: Object.freeze(matching.map((p) => p.partNumber)),
      partIds: Object.freeze(matching.map((p) => p.id)),
    });
  });

  const catalog = {
    version: 1,
    domain,
    modelId,
    variantMask,
    partCount,
    vertexCount,
    vertexStride,
    triangleCount,
    bounds: Object.freeze({
      min: Object.freeze([...modelBounds.min]),
      max: Object.freeze([...modelBounds.max]),
    }),
    center: Object.freeze(modelCenter),
    span: Object.freeze(modelSpan),
    parts: Object.freeze(parts),
    partsById: Object.freeze(partsById),
    subAssemblies: Object.freeze(subAssemblies),
    layers: Object.freeze(layers),
    trianglePartIds,
    vertexPartIds,
    vertexPartBuffer,
    partDescriptors,
    createState(options = {}) {
      return createPartAssemblyState(catalog, options);
    },
    resolvePartAtPoint(localPoint, { filterSubAssembly = null } = {}) {
      if (!Array.isArray(localPoint) || localPoint.length < 3) return null;
      const [px, py, pz] = localPoint;
      let bestPart = null;
      let bestScore = Infinity;
      for (const p of parts) {
        if (filterSubAssembly && p.subAssembly !== filterSubAssembly) continue;
        // Prefer leaf parts that actually own triangles
        const min = p.bounds.min, max = p.bounds.max;
        const dx = px < min[0] ? min[0] - px : px > max[0] ? px - max[0] : 0;
        const dy = py < min[1] ? min[1] - py : py > max[1] ? py - max[1] : 0;
        const dz = pz < min[2] ? min[2] - pz : pz > max[2] ? pz - max[2] : 0;
        const boxDist = Math.hypot(dx, dy, dz);
        const centDist = Math.hypot(px - p.centroid[0], py - p.centroid[1], pz - p.centroid[2]);
        const specificityBonus = p.triangleCount > 0 ? 0 : 0.25;
        const score = boxDist * 4.0 + centDist * 0.15 + specificityBonus;
        if (score < bestScore) {
          bestScore = score;
          bestPart = p;
        }
      }
      return bestPart;
    },
  };

  return Object.freeze(catalog);
}

export function createPartAssemblyState(catalog, options = {}) {
  if (!catalog || !Array.isArray(catalog.parts)) {
    throw new Error('createPartAssemblyState requires a valid PartAssemblyCatalog');
  }
  const partCount = catalog.partCount;
  // Per-part state: [appear, explode, wearAndDamage, cutawayVisibility]
  const partState = new Float32Array(partCount * 4);
  for (let p = 0; p < partCount; p++) {
    partState[p * 4 + 0] = 1.0;
    partState[p * 4 + 1] = 0.0;
    partState[p * 4 + 2] = 0.0;
    partState[p * 4 + 3] = 1.0;
  }

  // Uniform: control [assemblyProgress, explodeFactor, cutawayThreshold, cutawayMode],
  //          params  [flyInScale, flyInArcLift, globalWear, xrayOpacity]
  const uniform = new Float32Array([
    options.assemblyProgress ?? 1.0,
    options.explodeFactor ?? 0.0,
    options.cutawayThreshold ?? 0.0,
    typeof options.cutawayMode === 'string'
      ? (PART_CUTAWAY_MODES[options.cutawayMode] ?? 0)
      : (options.cutawayMode ?? 0),
    options.flyInScale ?? 1.35,
    options.flyInArcLift ?? 1.2,
    options.globalWear ?? 0.0,
    options.xrayOpacity ?? 0.0,
  ]);

  let revision = 0;
  let hasPartOverrides = false;
  let hasImpactSites = false;
  const impactSites = new Float32Array(24 * 4);

  const resolvePartIndex = (partIdOrNumber) => {
    if (typeof partIdOrNumber === 'number') {
      return partIdOrNumber >= 0 && partIdOrNumber < partCount ? partIdOrNumber : -1;
    }
    const found = catalog.partsById[partIdOrNumber];
    return found ? found.partNumber : -1;
  };

  const state = {
    catalog,
    partState,
    uniform,
    impactSites,
    get revision() {
      return revision;
    },
    isDefaultIntact() {
      return (
        !hasPartOverrides &&
        !hasImpactSites &&
        Math.abs(uniform[0] - 1.0) < 1e-6 &&
        Math.abs(uniform[1]) < 1e-6 &&
        (Math.abs(uniform[2]) < 1e-6 || uniform[3] === 0) &&
        Math.abs(uniform[6]) < 1e-6
      );
    },
    setAssemblyProgress(progress) {
      const clamped = Math.max(0, Math.min(1, Number(progress)));
      uniform[0] = clamped;
      for (let p = 0; p < partCount; p++) {
        const [start, end] = catalog.parts[p].assemblyWindow;
        partState[p * 4 + 0] = partAssemblySmoothstep(start, end, clamped);
      }
      revision++;
      return state;
    },
    setExplodeFactor(factor, { subAssembly = null } = {}) {
      const val = Math.max(0, Number(factor));
      if (subAssembly) {
        hasPartOverrides = true;
        for (let p = 0; p < partCount; p++) {
          if (catalog.parts[p].subAssembly === subAssembly) {
            partState[p * 4 + 1] = val;
          }
        }
      } else {
        uniform[1] = val;
      }
      revision++;
      return state;
    },
    setCutaway({ threshold = 0, mode = 'layer', maxLayer = null, side = null, xrayOpacity = null } = {}) {
      const modeCode = typeof mode === 'string' ? (PART_CUTAWAY_MODES[mode] ?? 1) : Number(mode);
      uniform[2] = Math.max(0, Math.min(1, Number(threshold)));
      uniform[3] = modeCode;
      if (xrayOpacity !== null) uniform[7] = Math.max(0, Math.min(1, Number(xrayOpacity)));
      for (let p = 0; p < partCount; p++) {
        const part = catalog.parts[p];
        let vis = 1.0;
        if (maxLayer !== null && part.layer > maxLayer && part.layer > 0) {
          vis = 0.0;
          hasPartOverrides = true;
        } else if (side !== null && part.layer >= 2 && part.cutawaySide === side) {
          vis = 0.0;
          hasPartOverrides = true;
        }
        partState[p * 4 + 3] = vis;
      }
      revision++;
      return state;
    },
    setPartDamage(partIdOrNumber, damageValue, { mode = 'add', radius = 0, localPoint = null } = {}) {
      const idx = resolvePartIndex(partIdOrNumber);
      if (idx >= 0) {
        const at = idx * 4 + 2;
        const next = mode === 'set' ? Number(damageValue) : partState[at] + Number(damageValue);
        partState[at] = Math.max(0, Math.min(1, next));
        hasPartOverrides = true;
      }
      if (radius > 0 && Array.isArray(localPoint)) {
        for (let p = 0; p < partCount; p++) {
          if (p === idx) continue;
          const c = catalog.parts[p].centroid;
          const d = Math.hypot(localPoint[0] - c[0], localPoint[1] - c[1], localPoint[2] - c[2]);
          if (d <= radius) {
            const falloff = 1 - d / radius;
            const at = p * 4 + 2;
            partState[at] = Math.max(0, Math.min(1, partState[at] + Number(damageValue) * falloff * 0.65));
            hasPartOverrides = true;
          }
        }
      }
      revision++;
      return state;
    },
    setPartState(partIdOrNumber, { appear, explode, wearAndDamage, cutawayVisibility } = {}) {
      const idx = resolvePartIndex(partIdOrNumber);
      if (idx < 0) throw new Error(`Unknown part in ${catalog.modelId}: ${partIdOrNumber}`);
      const base = idx * 4;
      if (appear !== undefined) partState[base + 0] = Math.max(0, Math.min(1, Number(appear)));
      if (explode !== undefined) partState[base + 1] = Math.max(0, Number(explode));
      if (wearAndDamage !== undefined) partState[base + 2] = Math.max(0, Math.min(1, Number(wearAndDamage)));
      if (cutawayVisibility !== undefined) partState[base + 3] = Math.max(0, Math.min(1, Number(cutawayVisibility)));
      hasPartOverrides = true;
      revision++;
      return state;
    },
    reset() {
      uniform[0] = 1.0;
      uniform[1] = 0.0;
      uniform[2] = 0.0;
      uniform[3] = 0.0;
      uniform[6] = 0.0;
      uniform[7] = 0.0;
      for (let p = 0; p < partCount; p++) {
        partState[p * 4 + 0] = 1.0;
        partState[p * 4 + 1] = 0.0;
        partState[p * 4 + 2] = 0.0;
        partState[p * 4 + 3] = 1.0;
      }
      impactSites.fill(0);
      hasPartOverrides = false;
      hasImpactSites = false;
      revision++;
      return state;
    },
    syncVesselDamage(damage) {
      const partDamage = damage?.partDamage ?? null;
      const sites = Array.isArray(damage?.impactSites) ? damage.impactSites : null;
      const hasAnyPartDamage = partDamage && Object.keys(partDamage).length > 0;
      const hasAnySites = sites && sites.length > 0;
      if (!hasAnyPartDamage && !hasAnySites && !hasPartOverrides && !hasImpactSites) {
        return false;
      }
      let changed = false;
      let anyOverrides = false;
      for (let p = 0; p < partCount; p++) {
        const part = catalog.parts[p];
        const dmg = hasAnyPartDamage ? Math.max(0, Math.min(1, Number(partDamage[part.id] ?? 0))) : 0;
        const isContinuousSkin =
          part.layer === 0 ||
          part.id.startsWith('hull.planking') ||
          part.id.startsWith('hull.wales') ||
          part.id.startsWith('deck.');
        const isBreakable =
          !isContinuousSkin &&
          part.triangleCount > 0 &&
          part.triangleCount <= 450 &&
          part.layer >= 2 &&
          part.layer <= 3;
        const nextAppear = isBreakable && dmg >= 0.78 ? 0.0 : 1.0;
        const nextExplode = !isContinuousSkin && dmg > 0.12 && part.triangleCount <= 1500 ? dmg * 0.14 : 0.0;
        const nextWear = isContinuousSkin ? Math.min(0.32, dmg * 0.4) : dmg;
        const base = p * 4;
        if (
          Math.abs(partState[base + 0] - nextAppear) > 1e-5 ||
          Math.abs(partState[base + 1] - nextExplode) > 1e-5 ||
          Math.abs(partState[base + 2] - nextWear) > 1e-5
        ) {
          partState[base + 0] = nextAppear;
          partState[base + 1] = nextExplode;
          partState[base + 2] = nextWear;
          changed = true;
        }
        if (nextAppear < 0.999 || nextExplode > 1e-5 || nextWear > 1e-5 || partState[base + 3] < 0.999) {
          anyOverrides = true;
        }
      }
      let anySites = false;
      const count = hasAnySites ? Math.min(24, sites.length) : 0;
      for (let i = 0; i < 24; i++) {
        const base = i * 4;
        const s = i < count ? sites[i] : null;
        const x = s ? Number(s[0]) || 0 : 0;
        const y = s ? Number(s[1]) || 0 : 0;
        const z = s ? Number(s[2]) || 0 : 0;
        const w = s ? Math.max(0, Math.min(1, Number(s[3]) || 0)) : 0;
        if (
          Math.abs(impactSites[base + 0] - x) > 1e-5 ||
          Math.abs(impactSites[base + 1] - y) > 1e-5 ||
          Math.abs(impactSites[base + 2] - z) > 1e-5 ||
          Math.abs(impactSites[base + 3] - w) > 1e-5
        ) {
          impactSites[base + 0] = x;
          impactSites[base + 1] = y;
          impactSites[base + 2] = z;
          impactSites[base + 3] = w;
          changed = true;
        }
        if (w > 1e-5) anySites = true;
      }
      hasPartOverrides = anyOverrides;
      hasImpactSites = anySites;
      if (changed) revision++;
      return changed;
    },
    evaluatePartPose(partIdOrNumber) {
      const idx = resolvePartIndex(partIdOrNumber);
      if (idx < 0) throw new Error(`Unknown part in ${catalog.modelId}: ${partIdOrNumber}`);
      const part = catalog.parts[idx];
      const base = idx * 4;
      const [appearStart, appearEnd] = part.assemblyWindow;
      const windowAppear = partAssemblySmoothstep(appearStart, appearEnd, uniform[0]);
      const appear = Math.max(0, Math.min(1, Math.min(windowAppear, partState[base + 0])));
      const explode = Math.max(0, uniform[1] + partState[base + 1]);
      const wearAndDamage = Math.max(0, Math.min(1, uniform[6] + partState[base + 2]));
      let cutawayVis = Math.max(0, Math.min(1, partState[base + 3]));
      const mode = uniform[3], threshold = uniform[2];
      if (mode > 0.5 && threshold > 0.001) {
        const minKeepLayer = 5.0 - threshold * 4.5;
        if (mode < 1.5) {
          if (part.layer > minKeepLayer && part.layer >= 0.5) cutawayVis = 0.0;
        } else if (mode < 2.5) {
          if (part.layer >= 2.5 && part.cutawaySide < -0.05 && part.layer > minKeepLayer * 0.5) cutawayVis = 0.0;
        } else if (mode < 3.5) {
          if (part.layer >= 2.5 && part.cutawaySide > 0.05 && part.layer > minKeepLayer * 0.5) cutawayVis = 0.0;
        }
      }
      const visible = appear > 0.0001 && (cutawayVis > 0.0001 || uniform[7] > 0.001);
      const flyIn = 1.0 - appear;
      const scale = visible ? partAssemblySmoothstep(0.0, 0.28, appear) : 0.0;
      const arcLift = Math.sin(appear * Math.PI) * flyIn * uniform[5];
      const dispScale = explode + flyIn * uniform[4] + wearAndDamage * 0.045;
      const translation = visible
        ? [
            part.explodedOffset[0] * dispScale,
            part.explodedOffset[1] * dispScale + arcLift,
            part.explodedOffset[2] * dispScale,
          ]
        : [0, 0, 0];
      return {
        partNumber: idx,
        id: part.id,
        subAssembly: part.subAssembly,
        layer: part.layer,
        appear,
        explode,
        wearAndDamage,
        cutawayVisibility: cutawayVis,
        visible,
        scale,
        pivot: part.pivot,
        translation,
      };
    },
    applyToVertices(sourceVertices, targetVertices = new Float32Array(sourceVertices), stride = catalog.vertexStride ?? 9) {
      const vCount = Math.min(catalog.vertexCount, Math.floor(sourceVertices.length / stride));
      const poses = Array.from({ length: partCount }, (_, p) => state.evaluatePartPose(p));
      for (let v = 0; v < vCount; v++) {
        const pIdx = catalog.vertexPartIds[v];
        const pose = poses[pIdx];
        const at = v * stride;
        if (!pose.visible) {
          targetVertices[at + 0] = pose.pivot[0];
          targetVertices[at + 1] = pose.pivot[1];
          targetVertices[at + 2] = pose.pivot[2];
          continue;
        }
        const px = sourceVertices[at + 0], py = sourceVertices[at + 1], pz = sourceVertices[at + 2];
        targetVertices[at + 0] = pose.pivot[0] + (px - pose.pivot[0]) * pose.scale + pose.translation[0];
        targetVertices[at + 1] = pose.pivot[1] + (py - pose.pivot[1]) * pose.scale + pose.translation[1];
        targetVertices[at + 2] = pose.pivot[2] + (pz - pose.pivot[2]) * pose.scale + pose.translation[2];
      }
      return targetVertices;
    },
  };

  if (options.assemblyProgress !== undefined) {
    state.setAssemblyProgress(options.assemblyProgress);
  }
  return state;
}

const partAssemblyGPUOwners = new WeakMap();

export async function createPartAssemblyGPU({ device, computePipe, posedBuffer, catalog, shared = null }) {
  if (!catalog || !(catalog.vertexPartBuffer instanceof Float32Array) || !(catalog.partDescriptors instanceof Float32Array)) {
    throw new Error('GPU part assembly requires a valid PartAssemblyCatalog');
  }
  if (!posedBuffer) {
    throw new Error('GPU part assembly requires a posed vertex buffer');
  }
  let assets = shared;
  let owner = shared && partAssemblyGPUOwners.get(shared);
  if (shared) {
    if (shared.device !== device) throw new Error('GPU part assembly assets belong to another graphics device');
    if (!owner || owner.destroyed) throw new Error('GPU part assembly assets are no longer available');
    if (shared.catalog !== catalog) throw new Error('GPU part assembly assets belong to another model catalog');
  } else {
    const pipeline = await computePipe(PART_ASSEMBLY_POSE_UPDATE, 'shared part assembly deformation');
    const vertexAttrsBuffer = device.createBuffer({
      label: `${catalog.modelId} vertex part attributes`,
      size: catalog.vertexPartBuffer.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexAttrsBuffer, 0, catalog.vertexPartBuffer);
    const descriptorsBuffer = device.createBuffer({
      label: `${catalog.modelId} part descriptors`,
      size: catalog.partDescriptors.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(descriptorsBuffer, 0, catalog.partDescriptors);
    assets = Object.freeze({
      device,
      pipeline,
      catalog,
      vertexAttrsBuffer,
      descriptorsBuffer,
      vertexCount: catalog.vertexCount,
      partCount: catalog.partCount,
    });
    owner = { references: 0, destroyed: false };
    partAssemblyGPUOwners.set(assets, owner);
  }

  const stateController = createPartAssemblyState(catalog);
  const stateBuffer = device.createBuffer({
    label: `${catalog.modelId} per-part live state`,
    size: stateController.partState.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(stateBuffer, 0, stateController.partState);

  const uniformUpload = new Float32Array(8 + 24 * 4);
  uniformUpload.set(stateController.uniform, 0);
  uniformUpload.set(stateController.impactSites, 8);
  const uniformBuffer = device.createBuffer({
    label: `${catalog.modelId} part assembly uniform`,
    size: uniformUpload.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformUpload);

  let group;
  try {
    group = device.createBindGroup({
      layout: assets.pipeline.getBindGroupLayout(0),
      entries: [posedBuffer, assets.vertexAttrsBuffer, assets.descriptorsBuffer, stateBuffer, uniformBuffer].map(
        (buffer, binding) => ({ binding, resource: { buffer } })
      ),
    });
  } catch (error) {
    stateBuffer.destroy();
    uniformBuffer.destroy();
    if (!owner.references) {
      assets.vertexAttrsBuffer.destroy();
      assets.descriptorsBuffer.destroy();
      owner.destroyed = true;
    }
    throw error;
  }

  owner.references++;
  let destroyed = false;
  let uploadedRevision = -1;
  let active = false;

  return {
    assets,
    state: stateController,
    update(nextState = stateController) {
      if (destroyed) return false;
      active = !nextState.isDefaultIntact();
      if (nextState.revision === uploadedRevision) return false;
      uniformUpload.set(nextState.uniform, 0);
      if (nextState.impactSites) uniformUpload.set(nextState.impactSites, 8);
      else uniformUpload.fill(0, 8);
      device.queue.writeBuffer(stateBuffer, 0, nextState.partState);
      device.queue.writeBuffer(uniformBuffer, 0, uniformUpload);
      uploadedRevision = nextState.revision;
      return true;
    },
    encode(pass, enabled = true) {
      if (!enabled || destroyed || !active) return false;
      pass.setPipeline(assets.pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(assets.vertexCount / 64));
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stateBuffer.destroy();
      uniformBuffer.destroy();
      owner.references--;
      if (!owner.references) {
        assets.vertexAttrsBuffer.destroy();
        assets.descriptorsBuffer.destroy();
        owner.destroyed = true;
      }
    },
  };
}

export function locatePartAtLocalPoint(catalog, localPoint, options = {}) {
  if (!catalog || !Array.isArray(catalog.parts) || !catalog.parts.length || !Array.isArray(localPoint)) {
    return null;
  }
  const px = Number(localPoint[0]) || 0;
  const py = Number(localPoint[1]) || 0;
  const pz = Number(localPoint[2]) || 0;
  const allowedSubAssemblies = Array.isArray(options.subAssemblies) && options.subAssemblies.length
    ? new Set(options.subAssemblies)
    : null;

  let bestPart = null;
  let bestScore = Infinity;

  const evaluateCandidate = (part, requireLeaf) => {
    if (requireLeaf && !part.isLeaf) return;
    if (part.triangleCount <= 0) return;
    if (allowedSubAssemblies && !allowedSubAssemblies.has(part.subAssembly)) return;
    const min = part.bounds.min;
    const max = part.bounds.max;
    const dx = px < min[0] ? min[0] - px : px > max[0] ? px - max[0] : 0;
    const dy = py < min[1] ? min[1] - py : py > max[1] ? py - max[1] : 0;
    const dz = pz < min[2] ? min[2] - pz : pz > max[2] ? pz - max[2] : 0;
    const boxDist = Math.hypot(dx, dy, dz);
    const c = part.centroid;
    const centroidDist = Math.hypot(px - c[0], py - c[1], pz - c[2]);
    const sx = Math.max(0.25, max[0] - min[0]);
    const sy = Math.max(0.25, max[1] - min[1]);
    const sz = Math.max(0.25, max[2] - min[2]);
    const diag = Math.hypot(sx, sy, sz);
    const score = boxDist * 10.0 + centroidDist * 0.35 + diag * 0.04;
    if (score < bestScore) {
      bestScore = score;
      bestPart = part;
    }
  };

  for (const part of catalog.parts) {
    evaluateCandidate(part, true);
  }
  if (!bestPart) {
    for (const part of catalog.parts) {
      evaluateCandidate(part, false);
    }
  }
  return bestPart;
}
