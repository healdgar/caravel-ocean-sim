// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Universal Boat Part Taxonomy and Non-Rubberband Archetype Scaling.
// Classifies every ship mesh group and structural node across all 9 playable
// archetypes into canonical taxonomy categories and scaling modes:
//   1. 'fixed-human'       - Ergonomic/human-scaled fittings (wheels, tillers,
//                            cannons, anchors, hatches, waist boats, oars) that
//                            preserve fixed physical size around their pivot.
//   2. 'section-loft'      - Hull and deck structure where midships waist bays
//                            expand/contract to absorb length changes while bow
//                            entrance and stern run keep natural aspect ratios.
//   3. 'proportional-spar' - Masts, yards, spars, and sails that scale height
//                            from the weather deck while keeping spar sections.
//   4. 'discrete-modular'  - Masts, sail tiers, gunports/batteries, and oar
//                            stations that are added or removed in whole units.

import { SHIP_MODELS } from './ship-models.js';
import { RIG_LINES } from './lateen.js';
import { VICTORY_DESIGN, VICTORY_SAILS, VICTORY_RUNNING_LINES } from './models/victory.js';
import { additionalRigContext } from './additional-rig.js';
import { laterSailRigContext } from './additional-rig.js';

export const PART_SCALING_MODES = Object.freeze({
  'fixed-human': Object.freeze({
    id: 'fixed-human',
    code: 1,
    label: 'Fixed Human / Ergonomic Size',
    description: 'Remains essentially fixed physical size around its local pivot when the hull scales.',
  }),
  'section-loft': Object.freeze({
    id: 'section-loft',
    code: 2,
    label: 'Section-Lofted Hull & Deck',
    description: 'Midships waist bays expand or contract first while bow entrance and stern run preserve shape.',
  }),
  'proportional-spar': Object.freeze({
    id: 'proportional-spar',
    code: 3,
    label: 'Proportional Rig & Spars',
    description: 'Scales elevation above the weather deck proportionally and prunes discrete masts/tiers.',
  }),
  'discrete-modular': Object.freeze({
    id: 'discrete-modular',
    code: 4,
    label: 'Discrete Modular Repeat',
    description: 'Added or removed in discrete whole units (masts, sail tiers, gunports, oar stations).',
  }),
});

export const UNIVERSAL_PART_TAXONOMY = Object.freeze({
  'hull.planking': Object.freeze({
    id: 'hull.planking',
    category: 'hull',
    subAssembly: 'hull-shell',
    layer: 1,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Outer hull planking, clinker strakes, or dugout shell.',
  }),
  'hull.keel': Object.freeze({
    id: 'hull.keel',
    category: 'hull',
    subAssembly: 'keel-backbone',
    layer: 0,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Longitudinal keel spine and ballast fin.',
  }),
  'hull.stem': Object.freeze({
    id: 'hull.stem',
    category: 'hull',
    subAssembly: 'keel-backbone',
    layer: 0,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Bow stempost, cutwater, knee of the head, and headrails.',
  }),
  'hull.sternpost': Object.freeze({
    id: 'hull.sternpost',
    category: 'hull',
    subAssembly: 'keel-backbone',
    layer: 0,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Aft sternpost and transom frame.',
  }),
  'hull.frames': Object.freeze({
    id: 'hull.frames',
    category: 'hull',
    subAssembly: 'keel-backbone',
    layer: 0,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Transverse hull ribs, futtocks, and deck support beams.',
  }),
  'hull.wales': Object.freeze({
    id: 'hull.wales',
    category: 'hull',
    subAssembly: 'hull-shell',
    layer: 1,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Thickened longitudinal hull wales, gunwales, and copper sheathing.',
  }),
  'hull.port-lid': Object.freeze({
    id: 'hull.port-lid',
    category: 'hull',
    subAssembly: 'hull-shell',
    layer: 1,
    scalingMode: 'discrete-modular',
    scalingModeCode: 4,
    description: 'Hinged gunport lid that seals omitted gunports flush with the hull planking.',
  }),
  'deck.weather': Object.freeze({
    id: 'deck.weather',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Main weather deck, forecastle, quarterdeck, poop deck, and waterways.',
  }),
  'deck.internal': Object.freeze({
    id: 'deck.internal',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Internal lower, middle, upper gun decks and orlop platform.',
  }),
  'deck.bulkhead': Object.freeze({
    id: 'deck.bulkhead',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Transverse cabin and raised-deck bulkheads.',
  }),
  'deck.stair': Object.freeze({
    id: 'deck.stair',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Companionway ladders and deck stair flights.',
  }),
  'deck.hatch-coaming': Object.freeze({
    id: 'deck.hatch-coaming',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Structural deck hatch coaming framed into the deck planking.',
  }),
  'deck.hatch-cover': Object.freeze({
    id: 'deck.hatch-cover',
    category: 'deck',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Hinged hatch cover and grating.',
  }),
  'deck.fittings': Object.freeze({
    id: 'deck.fittings',
    category: 'fitting',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Capstans, bitts, binnacles, and deck stores.',
  }),
  'superstructure.cabin': Object.freeze({
    id: 'superstructure.cabin',
    category: 'superstructure',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Deckhouse, coachroof, or quarterdeck cabin trunk.',
  }),
  'superstructure.gallery': Object.freeze({
    id: 'superstructure.gallery',
    category: 'superstructure',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Stern galleries, quarter badges, and transom windows.',
  }),
  'superstructure.bulwark': Object.freeze({
    id: 'superstructure.bulwark',
    category: 'superstructure',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Topside bulwark planking, rails, and stanchions.',
  }),
  'helm.rudder': Object.freeze({
    id: 'helm.rudder',
    category: 'helm',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Pintle-hung stern rudder blade and stock.',
  }),
  'helm.tiller': Object.freeze({
    id: 'helm.tiller',
    category: 'helm',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Human-gripped tiller spar or steering oar.',
  }),
  'helm.wheel': Object.freeze({
    id: 'helm.wheel',
    category: 'helm',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Human-scaled ship wheel, spokes, drum, and pedestal.',
  }),
  'ordnance.gunport': Object.freeze({
    id: 'ordnance.gunport',
    category: 'ordnance',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'discrete-modular',
    scalingModeCode: 4,
    description: 'Discrete gunport recess, sill/lintel reveals, and carriage.',
  }),
  'ordnance.recoil': Object.freeze({
    id: 'ordnance.recoil',
    category: 'ordnance',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Fixed-caliber cannon barrel and recoiling gun assembly.',
  }),
  'ground-tackle.anchor': Object.freeze({
    id: 'ground-tackle.anchor',
    category: 'ground-tackle',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Cathead and bower/spare anchors.',
  }),
  'fitting.boat': Object.freeze({
    id: 'fitting.boat',
    category: 'fitting',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Ship launch, cutter, or pinnace stowed on the waist skid beams.',
  }),
  'interior.magazine': Object.freeze({
    id: 'interior.magazine',
    category: 'interior',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Orlop powder magazines and shot lockers.',
  }),
  'propulsion.bench': Object.freeze({
    id: 'propulsion.bench',
    category: 'propulsion',
    subAssembly: 'decks-bulkheads',
    layer: 2,
    scalingMode: 'section-loft',
    scalingModeCode: 2,
    description: 'Rowing thwarts and benches.',
  }),
  'propulsion.oar': Object.freeze({
    id: 'propulsion.oar',
    category: 'propulsion',
    subAssembly: 'superstructure-ordnance',
    layer: 3,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Discrete human-scaled oar,loom, blade, or paddle.',
  }),
  'rig.bowsprit': Object.freeze({
    id: 'rig.bowsprit',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Bowsprit, jibboom, and flying jibboom.',
  }),
  'rig.mast': Object.freeze({
    id: 'rig.mast',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Stepped vertical mast, topmast, topgallant mast, and fighting top.',
  }),
  'rig.lookout': Object.freeze({
    id: 'rig.lookout',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'fixed-human',
    scalingModeCode: 1,
    description: 'Human-scaled crow\'s nest / lookout basket.',
  }),
  'rig.yard': Object.freeze({
    id: 'rig.yard',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Square yard, lateen yard, boom, or gaff spar.',
  }),
  'rig.chainwale': Object.freeze({
    id: 'rig.chainwale',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Channel / chainwale spreading standing shrouds.',
  }),
  'rig.standing': Object.freeze({
    id: 'rig.standing',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Shrouds, ratlines, forestays, backstays, and stay fittings.',
  }),
  'rig.running': Object.freeze({
    id: 'rig.running',
    category: 'rig',
    subAssembly: 'rig-masts-spars',
    layer: 4,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Halyards, sheets, tacks, braces, lifts, and falls.',
  }),
  'rig.sail': Object.freeze({
    id: 'rig.sail',
    category: 'rig',
    subAssembly: 'sails-canvas',
    layer: 5,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Woven sail canvas and bolt-ropes.',
  }),
  'rig.flag': Object.freeze({
    id: 'rig.flag',
    category: 'rig',
    subAssembly: 'sails-canvas',
    layer: 5,
    scalingMode: 'proportional-spar',
    scalingModeCode: 3,
    description: 'Ensign, pennant, or commission flag.',
  }),
});

const MAST_INDEX_TO_ID = Object.freeze(['fore', 'main', 'mizzen']);

function inferSailTierFromName(name = '') {
  const s = String(name).toLowerCase();
  if (s.includes('skysail')) return 5;
  if (s.includes('royal') || s.includes('flying-jib')) return 4;
  if (s.includes('topgallant') || s.includes('outer-jib')) return 3;
  if (s.includes('topsail') || s.includes('topmast') || s.includes('spritsail')) return 2;
  return 1;
}

function inferMastGroupFromName(modelId, rawId = '', nodeId = '') {
  const combined = `${rawId} ${nodeId}`.toLowerCase();
  if (combined.includes('fore') && !combined.includes('forecastle')) {
    if (combined.includes('staysail') || combined.includes('jib') || combined.includes('spritsail')) {
      return 'fore';
    }
    return 'fore';
  }
  if (combined.includes('mizzen') || combined.includes('spanker') || combined.includes('crossjack')) {
    return 'mizzen';
  }
  if (combined.includes('main') && !combined.includes('deck.main') && !combined.includes('hatch.main')) {
    return 'main';
  }
  if (combined.includes('jib') || combined.includes('staysail') || combined.includes('spritsail')) {
    return modelId === 'gipsy-moth-iv' ? 'main' : 'fore';
  }
  if (modelId === 'nina') {
    const m = /^rope\.(\d+)\./.exec(rawId);
    if (m) {
      const lineIdx = Number(m[1]);
      const line = RIG_LINES[lineIdx];
      if (line && Number.isInteger(line.mast)) {
        return MAST_INDEX_TO_ID[line.mast] ?? 'main';
      }
    }
  }
  return null;
}

/**
 * Expand coarse mesh groups into fine-grained virtual child part ranges for
 * `createPartAssemblyCatalog` without mutating `asset.groups` or `asset.vertices`.
 * - Splits `victory` lower/middle/upper gunport lids into `gun.lid.<deck>.<side>.<index>`
 * - Splits `rig.standing` and `rig.running` into per-mast / per-tier sub-parts
 */
export function expandShipPartGroups(modelId, groups, vertices, indices) {
  if (!Array.isArray(groups) || groups.length === 0) return groups;
  const expanded = [...groups];

  if (modelId === 'victory') {
    // 1. Extract the 3-panel gunport lid (6 triangles = 18 indices) right after each recoil group
    for (const g of groups) {
      const m = /^gun\.(lower|middle|upper)\.(port|starboard)\.(\d+)$/.exec(g.id);
      if (!m) continue;
      const [, deck, sideName, idxStr] = m;
      const portIdx = Number(idxStr);
      const gunId = (sideName === 'port' ? 0 : 44) + portIdx;
      const recoilGroup = groups.find((x) => x.id === `gunnery.recoil.${gunId}`);
      if (!recoilGroup) continue;
      const lidStart = recoilGroup.firstVertex + recoilGroup.vertexCount;
      const lidCount = 18;
      if (lidStart + lidCount <= g.firstVertex + g.vertexCount) {
        expanded.push({
          id: `gun.lid.${deck}.${sideName}.${portIdx}`,
          nodeId: 'hull',
          firstVertex: lidStart,
          vertexCount: lidCount,
        });
      }
    }

    // 2. Partition `rig.running` by sail mast and tier using `VICTORY_RUNNING_LINES`
    const runGroup = groups.find((g) => g.id === 'rig.running');
    if (runGroup && vertices instanceof Float32Array && indices instanceof Uint32Array) {
      const sailById = new Map(VICTORY_SAILS.map((s) => [s.id, s]));
      let curKey = null;
      let segStart = runGroup.firstVertex;
      for (let i = runGroup.firstVertex; i < runGroup.firstVertex + runGroup.vertexCount; i += 3) {
        const v0 = indices[i] * 9;
        const u = vertices[v0 + 7];
        const lineIdx = Math.max(0, Math.round(u - 100));
        const line = VICTORY_RUNNING_LINES[lineIdx];
        const sail = line ? sailById.get(line.sail) : null;
        const mastId = sail ? (MAST_INDEX_TO_ID[sail.mast] ?? 'main') : 'main';
        const tier = sail ? inferSailTierFromName(sail.name) : 1;
        const key = `${mastId}.t${tier}.${lineIdx}`;
        if (key !== curKey) {
          if (curKey !== null && i > segStart) {
            expanded.push({
              id: `rig.running.${curKey}`,
              nodeId: 'hull',
              firstVertex: segStart,
              vertexCount: i - segStart,
            });
          }
          curKey = key;
          segStart = i;
        }
      }
      if (curKey !== null && runGroup.firstVertex + runGroup.vertexCount > segStart) {
        expanded.push({
          id: `rig.running.${curKey}`,
          nodeId: 'hull',
          firstVertex: segStart,
          vertexCount: runGroup.firstVertex + runGroup.vertexCount - segStart,
        });
      }
    }
    return expanded;
  }

  if (modelId === 'pinta' || modelId === 'santa-maria' || modelId === 'flying-cloud' || modelId === 'gipsy-moth-iv') {
    const ctx =
      modelId === 'pinta' || modelId === 'santa-maria'
        ? additionalRigContext(modelId)
        : laterSailRigContext(modelId);
    const surfById = new Map(ctx.surfaces.map((s) => [s.id, s]));
    const mastIdOfLine = (line) => {
      const surf = surfById.get(line.surface ?? line.a?.surface ?? line.b?.surface);
      const mIdx = line.mast ?? surf?.mast ?? 0;
      const mastObj = ctx.masts[mIdx];
      return mastObj?.id ?? MAST_INDEX_TO_ID[mIdx] ?? 'main';
    };
    const tierOfLine = (line) => {
      const surf = surfById.get(line.surface ?? line.a?.surface ?? line.b?.surface);
      return surf ? inferSailTierFromName(surf.name) : 1;
    };

    // 1. Partition `rig.standing`: each static line emits 24 indices
    const standGroup = groups.find((g) => g.id === 'rig.standing');
    const staticLines = ctx.lines.filter((l) => l.static);
    if (standGroup && staticLines.length * 24 === standGroup.vertexCount) {
      let curMast = null;
      let segStart = standGroup.firstVertex;
      let runIdx = 0;
      for (let l = 0; l < staticLines.length; l++) {
        const mastId = mastIdOfLine(staticLines[l]);
        const vAt = standGroup.firstVertex + l * 24;
        if (mastId !== curMast) {
          if (curMast !== null && vAt > segStart) {
            expanded.push({
              id: `rig.standing.${curMast}.${runIdx++}`,
              nodeId: 'hull',
              firstVertex: segStart,
              vertexCount: vAt - segStart,
            });
          }
          curMast = mastId;
          segStart = vAt;
        }
      }
      if (curMast !== null && standGroup.firstVertex + standGroup.vertexCount > segStart) {
        expanded.push({
          id: `rig.standing.${curMast}.${runIdx++}`,
          nodeId: 'hull',
          firstVertex: segStart,
          vertexCount: standGroup.firstVertex + standGroup.vertexCount - segStart,
        });
      }
    }

    // 2. Partition `rig.running` via `uv.x = 100 + lineIndex`
    const runGroup = groups.find((g) => g.id === 'rig.running');
    if (runGroup && vertices instanceof Float32Array && indices instanceof Uint32Array) {
      let curKey = null;
      let segStart = runGroup.firstVertex;
      let chunk = 0;
      for (let i = runGroup.firstVertex; i < runGroup.firstVertex + runGroup.vertexCount; i += 3) {
        const v0 = indices[i] * 9;
        const lineIdx = Math.max(0, Math.round(vertices[v0 + 7] - 100));
        const line = ctx.lines[lineIdx];
        const mastId = line ? mastIdOfLine(line) : 'main';
        const tier = line ? tierOfLine(line) : 1;
        const key = `${mastId}.t${tier}`;
        if (key !== curKey) {
          if (curKey !== null && i > segStart) {
            expanded.push({
              id: `rig.running.${curKey}.${chunk++}`,
              nodeId: 'hull',
              firstVertex: segStart,
              vertexCount: i - segStart,
            });
          }
          curKey = key;
          segStart = i;
        }
      }
      if (curKey !== null && runGroup.firstVertex + runGroup.vertexCount > segStart) {
        expanded.push({
          id: `rig.running.${curKey}.${chunk++}`,
          nodeId: 'hull',
          firstVertex: segStart,
          vertexCount: runGroup.firstVertex + runGroup.vertexCount - segStart,
        });
      }
    }
  }

  return expanded;
}

/**
 * Classify a mesh group or structural node into the Universal Boat Part Taxonomy.
 */
export function classifyShipPartTaxonomy(modelId, groupOrPart) {
  const id = String(groupOrPart?.id ?? '');
  const nodeId = String(groupOrPart?.nodeId ?? '');
  const low = id.toLowerCase();

  let taxonomyKey = 'hull.planking';
  let batteryDeck = null;
  let gunId = null;
  let portSlotKey = null;
  let isPortLid = false;
  let portSideSign = 0;
  let oarStationIndex = null;

  // 1. Gunport lids (Victory modular port sealing)
  const lidMatch = /^gun\.lid\.(lower|middle|upper)\.(port|starboard)\.(\d+)$/.exec(id);
  if (lidMatch) {
    taxonomyKey = 'hull.port-lid';
    batteryDeck = lidMatch[1];
    const sideName = lidMatch[2];
    const portIdx = Number(lidMatch[3]);
    portSideSign = sideName === 'port' ? -1 : 1;
    gunId = (sideName === 'port' ? 0 : 44) + portIdx;
    portSlotKey = `${batteryDeck}:${portIdx}`;
    isPortLid = true;
  } else if (low.startsWith('gunnery.recoil.')) {
    taxonomyKey = 'ordnance.recoil';
    gunId = Number(id.slice('gunnery.recoil.'.length));
    if (modelId === 'victory') {
      if (gunId < 88) {
        const portIdx = gunId % 44;
        batteryDeck = portIdx < 15 ? 'lower' : portIdx < 29 ? 'middle' : 'upper';
        portSlotKey = `${batteryDeck}:${portIdx}`;
      } else if (gunId < 100) {
        batteryDeck = 'quarter';
        portSlotKey = `quarter:${(gunId - 88) % 6}`;
      } else {
        batteryDeck = 'forecastle';
        portSlotKey = `forecastle:${(gunId - 100) % 2}`;
      }
    } else {
      batteryDeck = 'weather';
      portSlotKey = `weather:${gunId % 2}`;
    }
  } else if (low.startsWith('gun.') || low.startsWith('gun:')) {
    taxonomyKey = 'ordnance.gunport';
    const vicMatch = /^gun\.(lower|middle|upper|quarter|forecastle)\.(port|starboard)\.(\d+)$/.exec(id);
    if (vicMatch) {
      batteryDeck = vicMatch[1];
      const sideName = vicMatch[2];
      const idx = Number(vicMatch[3]);
      portSideSign = sideName === 'port' ? -1 : 1;
      portSlotKey = `${batteryDeck}:${idx}`;
      if (batteryDeck === 'lower' || batteryDeck === 'middle' || batteryDeck === 'upper') {
        gunId = (sideName === 'port' ? 0 : 44) + idx;
      } else if (batteryDeck === 'quarter') {
        gunId = 88 + (sideName === 'port' ? 0 : 6) + idx;
      } else {
        gunId = 100 + (sideName === 'port' ? 0 : 2) + idx;
      }
    } else if (/^gun\.(\d+)$/.test(id)) {
      gunId = Number(id.slice(4));
      batteryDeck = 'weather';
      portSlotKey = `weather:${gunId % 2}`;
    } else if (id.startsWith('gun:')) {
      // Nina: gun:-1:3.25, gun:-1:4.9, gun:1:3.25, gun:1:4.9
      const parts = id.split(':');
      const side = Number(parts[1]);
      const z = Number(parts[2]);
      const slot = z > 4.0 ? 1 : 0;
      gunId = (side < 0 ? 0 : 2) + slot;
      batteryDeck = 'weather';
      portSlotKey = `weather:${slot}`;
    }
  } else if (low.startsWith('rowing.propulsor.') || low.startsWith('rowing.station.') || low.startsWith('rowing.port.')) {
    taxonomyKey = 'propulsion.oar';
    const m = /\.(\d+)$/.exec(id);
    if (m) oarStationIndex = Number(m[1]) - 1;
  } else if (low.startsWith('rowing.benches')) {
    taxonomyKey = 'propulsion.bench';
  } else if (low.includes('keel')) {
    taxonomyKey = 'hull.keel';
  } else if (low.startsWith('bow.bowsprit')) {
    taxonomyKey = 'rig.bowsprit';
  } else if (low.startsWith('bow.')) {
    taxonomyKey = 'hull.stem';
  } else if (low.includes('sternpost') || low === 'transom') {
    taxonomyKey = 'hull.sternpost';
  } else if (low.includes('frames') || low.startsWith('frames.')) {
    taxonomyKey = 'hull.frames';
  } else if (low.includes('wale') && !low.startsWith('chainwale')) {
    taxonomyKey = 'hull.wales';
  } else if (low.includes('gunwales') || low.includes('copper') || low.includes('clinker')) {
    taxonomyKey = 'hull.wales';
  } else if (low.startsWith('hull')) {
    taxonomyKey = 'hull.planking';
  } else if (low.includes('orlop') || low.includes('internal')) {
    taxonomyKey = 'deck.internal';
  } else if (low.includes('magazine')) {
    taxonomyKey = 'interior.magazine';
  } else if (low.includes('bulkhead')) {
    taxonomyKey = 'deck.bulkhead';
  } else if (low.includes('stair')) {
    taxonomyKey = 'deck.stair';
  } else if (low.includes('hatch.coaming') || low.includes('hatch.frame')) {
    taxonomyKey = 'deck.hatch-coaming';
  } else if (low.startsWith('hatch.')) {
    taxonomyKey = 'deck.hatch-cover';
  } else if (low === 'deck.fittings' || low === 'deck.stores' || low === 'deck.fore.bitts') {
    taxonomyKey = 'deck.fittings';
  } else if (low.startsWith('deck.')) {
    taxonomyKey = 'deck.weather';
  } else if (low === 'cabin' || low.startsWith('structure.')) {
    taxonomyKey = 'superstructure.cabin';
  } else if (low.startsWith('stern.')) {
    taxonomyKey = 'superstructure.gallery';
  } else if (low.startsWith('bulwark') || low.startsWith('rail.')) {
    taxonomyKey = 'superstructure.bulwark';
  } else if (low === 'helm.rudder') {
    taxonomyKey = 'helm.rudder';
  } else if (low === 'helm.wheel' || low === 'helm.pedestal') {
    taxonomyKey = 'helm.wheel';
  } else if (low.startsWith('helm.')) {
    taxonomyKey = 'helm.tiller';
  } else if (low.startsWith('anchor')) {
    taxonomyKey = 'ground-tackle.anchor';
  } else if (low.startsWith('boat.waist')) {
    taxonomyKey = 'fitting.boat';
  } else if (low.startsWith('lookout.')) {
    taxonomyKey = 'rig.lookout';
  } else if (low.startsWith('mast.')) {
    taxonomyKey = 'rig.mast';
  } else if (low.startsWith('chainwale.')) {
    taxonomyKey = 'rig.chainwale';
  } else if (low.startsWith('yard.') || low.startsWith('spar.')) {
    taxonomyKey = 'rig.yard';
  } else if (low.startsWith('sail.')) {
    taxonomyKey = 'rig.sail';
  } else if (low.startsWith('flag.')) {
    taxonomyKey = 'rig.flag';
  } else if (
    low.startsWith('rig.standing') ||
    low.startsWith('fitting.') ||
    low === 'rig.stay-attachments' ||
    (low.startsWith('rope.') && (low.includes('shroud') || low.includes('runner') || low.includes('stay')))
  ) {
    taxonomyKey = 'rig.standing';
  } else if (low.startsWith('rig.') || low.startsWith('tackle.') || low.startsWith('rope.')) {
    taxonomyKey = 'rig.running';
  }

  const entry = UNIVERSAL_PART_TAXONOMY[taxonomyKey] ?? UNIVERSAL_PART_TAXONOMY['hull.planking'];
  const mastGroup =
    entry.category === 'rig' && taxonomyKey !== 'rig.bowsprit' && taxonomyKey !== 'rig.flag'
      ? inferMastGroupFromName(modelId, id, nodeId)
      : null;

  let sailTier = null;
  if (taxonomyKey === 'rig.sail' || taxonomyKey === 'rig.yard' || taxonomyKey === 'rig.running') {
    const tierMatch = /\.t(\d+)(?:\.|$)/.exec(id);
    sailTier = tierMatch ? Number(tierMatch[1]) : inferSailTierFromName(id);
  }

  const isDiscreteModular =
    entry.scalingMode === 'discrete-modular' ||
    mastGroup !== null ||
    gunId !== null ||
    oarStationIndex !== null;

  return Object.freeze({
    taxonomyId: entry.id,
    category: entry.category,
    scalingMode: entry.scalingMode,
    scalingModeCode: entry.scalingModeCode,
    isDiscreteModular,
    mastGroup,
    sailTier,
    batteryDeck,
    gunId,
    portSlotKey,
    isPortLid,
    portSideSign,
    oarStationIndex,
  });
}

export const ARCHETYPE_SCALE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'compact',
    label: 'Compact / Sloop Rate (0.52×)',
    lengthFactor: 0.52,
    beamFactor: 0.58,
  }),
  Object.freeze({
    id: 'brig',
    label: 'Brig / Corvette Rate (0.68×)',
    lengthFactor: 0.68,
    beamFactor: 0.74,
  }),
  Object.freeze({
    id: 'frigate',
    label: 'Frigate / Medium Rate (0.82×)',
    lengthFactor: 0.82,
    beamFactor: 0.86,
  }),
  Object.freeze({
    id: 'standard',
    label: 'Standard Archetype (1.00×)',
    lengthFactor: 1.0,
    beamFactor: 1.0,
  }),
  Object.freeze({
    id: 'grand',
    label: 'Grand Rate / Heavy (1.18×)',
    lengthFactor: 1.18,
    beamFactor: 1.12,
  }),
]);

const MODEL_DEFAULT_MASTS = Object.freeze({
  nina: Object.freeze(['fore', 'main', 'mizzen']),
  pinta: Object.freeze(['fore', 'main', 'mizzen']),
  'santa-maria': Object.freeze(['fore', 'main', 'mizzen']),
  'flying-cloud': Object.freeze(['fore', 'main', 'mizzen']),
  victory: Object.freeze(['fore', 'main', 'mizzen']),
  'gipsy-moth-iv': Object.freeze(['main', 'mizzen']),
  oseberg: Object.freeze(['main']),
  lusoria: Object.freeze(['main']),
  'taino-canoe': Object.freeze([]),
});

const MODEL_DECK_REF_Y = Object.freeze({
  nina: 0.82,
  pinta: 0.55,
  'santa-maria': 0.62,
  'flying-cloud': 0.55,
  victory: 1.58,
  'gipsy-moth-iv': 0.55,
  oseberg: 0.25,
  lusoria: 0.22,
  'taino-canoe': 0.15,
});

const MODEL_DEFAULT_OAR_PAIRS = Object.freeze({
  oseberg: 15,
  lusoria: 12,
  'taino-canoe': 12,
});

function selectEvenlySpacedIndices(totalCount, keepCount) {
  if (keepCount <= 0) return [];
  if (keepCount >= totalCount) return Array.from({ length: totalCount }, (_, i) => i);
  if (keepCount === 1) return [Math.floor((totalCount - 1) / 2)];
  const chosen = new Set();
  for (let k = 0; k < keepCount; k++) {
    const idx = Math.round((k * (totalCount - 1)) / (keepCount - 1));
    chosen.add(idx);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Compute non-rubberband scaling rules for a given ship archetype and target
 * dimensions `{ modelId, length, beam }`.
 */
export function computeArchetypeScaleSpec(boatOrSpec = {}) {
  const modelId = boatOrSpec?.modelId ?? 'nina';
  const model = SHIP_MODELS[modelId] ?? SHIP_MODELS.nina;
  const defaultLength = model.runtime?.length ?? 20;
  const defaultBeam = model.runtime?.beam ?? 6;
  const length = Number.isFinite(boatOrSpec?.length) && boatOrSpec.length > 0 ? Number(boatOrSpec.length) : defaultLength;
  const beam = Number.isFinite(boatOrSpec?.beam) && boatOrSpec.beam > 0 ? Number(boatOrSpec.beam) : defaultBeam;

  const lengthScale = length / defaultLength;
  const beamScale = beam / defaultBeam;
  const isDefaultScale = Math.abs(lengthScale - 1.0) < 1e-4 && Math.abs(beamScale - 1.0) < 1e-4;

  // Midships waist absorbs more of the length change than the bow/stern ends
  const waistWarpK = isDefaultScale
    ? 0.0
    : Math.max(-0.12, Math.min(0.14, (lengthScale - 1.0) * 0.18));

  // Rig height above weather deck scales smoothly with hull scale so a short
  // hull does not carry an impossibly tall full-rate rig
  const rigHeightScale = isDefaultScale
    ? 1.0
    : Math.max(0.48, Math.min(1.42, Math.pow(Math.min(lengthScale, beamScale * 1.15), 0.72)));

  const deckRefY = MODEL_DECK_REF_Y[modelId] ?? 0.65;
  const defaultMasts = MODEL_DEFAULT_MASTS[modelId] ?? MODEL_DEFAULT_MASTS.nina;

  // 1. Discrete Mast Pruning
  let activeMasts;
  if (defaultMasts.length === 3) {
    if (lengthScale < 0.56) {
      activeMasts = ['main'];
    } else if (lengthScale < 0.78) {
      activeMasts = ['fore', 'main'];
    } else {
      activeMasts = ['fore', 'main', 'mizzen'];
    }
  } else if (defaultMasts.length === 2) {
    activeMasts = lengthScale < 0.72 ? ['main'] : ['main', 'mizzen'];
  } else {
    activeMasts = [...defaultMasts];
  }
  const activeMastSet = new Set(activeMasts);

  // 2. Discrete Sail Tier Pruning
  let maxSailTier = 5;
  if (lengthScale < 0.58) maxSailTier = 2;
  else if (lengthScale < 0.74) maxSailTier = 3;
  else if (lengthScale < 0.88) maxSailTier = 4;

  // 3. Discrete Gunport & Battery Deck Quantization
  const activeBatteryDecks = [];
  const activePortSlotKeys = new Set();
  const activeGunIds = new Set();
  let defaultGunCount = 0;

  if (modelId === 'victory') {
    defaultGunCount = 104;
    // Battery deck retention by hull scale / rate
    if (lengthScale >= 0.70) activeBatteryDecks.push('lower');
    if (lengthScale >= 0.85) activeBatteryDecks.push('middle');
    activeBatteryDecks.push('upper');
    if (lengthScale >= 0.58) activeBatteryDecks.push('quarter');
    if (lengthScale >= 0.64) activeBatteryDecks.push('forecastle');

    const activeDeckSet = new Set(activeBatteryDecks);
    const deckConfigs = [
      { id: 'lower', perSide: 15, baseOffset: 0 },
      { id: 'middle', perSide: 14, baseOffset: 15 },
      { id: 'upper', perSide: 15, baseOffset: 29 },
      { id: 'quarter', perSide: 6, baseOffset: 0 },
      { id: 'forecastle', perSide: 2, baseOffset: 0 },
    ];
    for (const cfg of deckConfigs) {
      if (!activeDeckSet.has(cfg.id)) continue;
      const minPerSide = cfg.id === 'forecastle' ? 1 : cfg.id === 'quarter' ? 2 : 4;
      const keepCount = isDefaultScale
        ? cfg.perSide
        : Math.max(minPerSide, Math.min(cfg.perSide, Math.round(cfg.perSide * lengthScale)));
      const localIndices = selectEvenlySpacedIndices(cfg.perSide, keepCount);
      for (const localIdx of localIndices) {
        if (cfg.id === 'lower' || cfg.id === 'middle' || cfg.id === 'upper') {
          const portIdx = cfg.baseOffset + localIdx;
          activePortSlotKeys.add(`${cfg.id}:${portIdx}`);
          activeGunIds.add(portIdx);
          activeGunIds.add(44 + portIdx);
        } else if (cfg.id === 'quarter') {
          activePortSlotKeys.add(`quarter:${localIdx}`);
          activeGunIds.add(88 + localIdx);
          activeGunIds.add(88 + 6 + localIdx);
        } else if (cfg.id === 'forecastle') {
          activePortSlotKeys.add(`forecastle:${localIdx}`);
          activeGunIds.add(100 + localIdx);
          activeGunIds.add(100 + 2 + localIdx);
        }
      }
    }
  } else if (modelId === 'nina' || modelId === 'pinta' || modelId === 'santa-maria') {
    defaultGunCount = 4;
    activeBatteryDecks.push('weather');
    const keepPerSide = lengthScale < 0.65 ? 1 : 2;
    const slots = keepPerSide === 1 ? [0] : [0, 1];
    for (const s of slots) {
      activePortSlotKeys.add(`weather:${s}`);
      activeGunIds.add(s);
      activeGunIds.add(2 + s);
    }
  }

  // 4. Discrete Oar / Paddle Station Quantization
  const defaultOarPairs = MODEL_DEFAULT_OAR_PAIRS[modelId] ?? 0;
  const activeOarPairs =
    defaultOarPairs > 0
      ? isDefaultScale
        ? defaultOarPairs
        : Math.max(3, Math.min(defaultOarPairs, Math.round(defaultOarPairs * lengthScale)))
      : 0;
  const activeOarIndices = new Set(selectEvenlySpacedIndices(defaultOarPairs, activeOarPairs));

  // 5. Effective Sail Area & Propulsion Scaling Factor
  const mastRatio = defaultMasts.length > 0 ? activeMasts.length / defaultMasts.length : 1;
  const tierRatio = maxSailTier >= 4 ? 1.0 : maxSailTier === 3 ? 0.88 : 0.74;
  const sailAreaFactor = isDefaultScale
    ? 1.0
    : Math.max(0.22, Math.min(1.65, mastRatio * tierRatio * rigHeightScale * Math.pow(lengthScale, 0.65)));

  // 6. Rate / Variant Classification Label
  const activeGunCount = activeGunIds.size;
  let variantClass = model.name;
  if (modelId === 'victory') {
    if (activeMasts.length === 1) variantClass = `Sloop-of-War (${activeGunCount} guns)`;
    else if (activeMasts.length === 2) variantClass = `Brig-Corvette (${activeGunCount} guns)`;
    else if (activeBatteryDecks.length <= 3 && !activeBatteryDecks.includes('lower')) {
      variantClass = `Fifth-Rate Frigate (${activeGunCount} guns)`;
    } else if (!activeBatteryDecks.includes('middle')) {
      variantClass = `Third-Rate Two-Decker (${activeGunCount} guns)`;
    } else if (lengthScale > 1.08) {
      variantClass = `Grand First-Rate (${activeGunCount} guns)`;
    } else {
      variantClass = `First-Rate (${activeGunCount} guns)`;
    }
  } else if (defaultMasts.length >= 2) {
    if (activeMasts.length === 1) variantClass = `${model.name} Cutter/Sloop (1 mast)`;
    else if (activeMasts.length === 2 && defaultMasts.length === 3) variantClass = `${model.name} Brigantine (2 masts)`;
    else variantClass = `${model.name} (${activeMasts.length} masts)`;
  } else if (defaultOarPairs > 0) {
    variantClass = `${model.name} (${activeOarPairs * 2} oars)`;
  }

  const mastSummary = defaultMasts.length > 0 ? `${activeMasts.length}/${defaultMasts.length} masts` : 'unmasted';
  const gunSummary = defaultGunCount > 0 ? `${activeGunCount}/${defaultGunCount} guns` : null;
  const oarSummary = defaultOarPairs > 0 ? `${activeOarPairs * 2}/${defaultOarPairs * 2} oars` : null;
  const summaryLabel = [variantClass, mastSummary, gunSummary, oarSummary].filter(Boolean).join(' · ');

  return Object.freeze({
    modelId,
    defaultLength,
    defaultBeam,
    length,
    beam,
    lengthScale,
    beamScale,
    isDefaultScale,
    waistWarpK,
    rigHeightScale,
    deckRefY,
    defaultMasts,
    activeMasts: Object.freeze(activeMasts),
    activeMastSet,
    maxSailTier,
    activeBatteryDecks: Object.freeze(activeBatteryDecks),
    activePortSlotKeys,
    activeGunIds,
    activeGunCount,
    defaultGunCount,
    defaultOarPairs,
    activeOarPairs,
    activeOarIndices,
    sailAreaFactor,
    variantClass,
    summaryLabel,
  });
}

/**
 * Determine whether a taxonomy-classified part is active or sealed under a
 * given `scaleSpec`.
 * Returns `{ active: boolean, sealPortLid: boolean }`.
 */
export function evaluatePartScaleActivity(partTaxonomy, scaleSpec) {
  if (!partTaxonomy || !scaleSpec || scaleSpec.isDefaultScale) {
    return { active: true, sealPortLid: false };
  }
  if (partTaxonomy.mastGroup && !scaleSpec.activeMastSet.has(partTaxonomy.mastGroup)) {
    return { active: false, sealPortLid: false };
  }
  if (partTaxonomy.sailTier !== null && partTaxonomy.sailTier > scaleSpec.maxSailTier) {
    return { active: false, sealPortLid: false };
  }
  if (partTaxonomy.isPortLid) {
    const portActive = partTaxonomy.portSlotKey
      ? scaleSpec.activePortSlotKeys.has(partTaxonomy.portSlotKey)
      : true;
    return { active: true, sealPortLid: !portActive };
  }
  if (partTaxonomy.portSlotKey !== null) {
    const portActive = scaleSpec.activePortSlotKeys.has(partTaxonomy.portSlotKey);
    return { active: portActive, sealPortLid: false };
  }
  if (partTaxonomy.gunId !== null && scaleSpec.defaultGunCount > 0) {
    return { active: scaleSpec.activeGunIds.has(partTaxonomy.gunId), sealPortLid: false };
  }
  if (partTaxonomy.oarStationIndex !== null && scaleSpec.defaultOarPairs > 0) {
    return { active: scaleSpec.activeOarIndices.has(partTaxonomy.oarStationIndex), sealPortLid: false };
  }
  return { active: true, sealPortLid: false };
}
