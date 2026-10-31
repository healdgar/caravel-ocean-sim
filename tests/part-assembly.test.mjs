import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHIP_SUB_ASSEMBLIES,
  BUILDING_SUB_ASSEMBLIES,
  PART_CUTAWAY_MODES,
  createPartAssemblyCatalog,
  createPartAssemblyState,
  createPartAssemblyGPU,
  locatePartAtLocalPoint,
  bakeVesselImpactDeformations,
  bakeBuildingImpactDeformations,
} from '../js/part-assembly.js';
import {
  PART_ASSEMBLY_WGSL,
  PART_ASSEMBLY_POSE_UPDATE,
} from '../js/wgsl/part-assembly.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { getShipParts, SHIP_PART_CAPABILITIES } from '../js/ship-parts.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import {
  PORT_PREFABS,
  getBuildingParts,
  resolveGlobalCoastalRegion,
  synthesizeCoastalTerrain,
  placeCoastalPort,
  buildPortPrefabGeometry,
} from '../js/coastal-world.js';
import {
  sweepShipSegment,
  applyShipImpactDamage,
  stepVesselDamage,
  createVesselMagazineState,
  consumeMagazineOrdnance,
  sweepBuildingSegment,
  applyBuildingImpactDamage,
  classifyBuildingMaterial,
  createBuildingMagazineState,
  detonateBuildingMagazine,
  stepBuildingDamage,
  createBuildingGunDefinitions,
  createBuildingGunnery,
  createPortGunnery,
  createShipGunnery,
} from '../js/gunnery-control.js';

if (!globalThis.GPUBufferUsage) {
  globalThis.GPUBufferUsage = {
    STORAGE: 0x80,
    UNIFORM: 0x40,
    COPY_DST: 0x08,
  };
}

function createMockPartGPUDevice() {
  const createdBuffers = [];
  const writes = [];
  const dispatches = [];
  return {
    createdBuffers,
    writes,
    dispatches,
    createBuffer(desc) {
      const buf = {
        label: desc.label,
        size: desc.size,
        usage: desc.usage,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      createdBuffers.push(buf);
      return buf;
    },
    createBindGroup(desc) {
      return { layout: desc.layout, entries: desc.entries };
    },
    queue: {
      writeBuffer(buffer, offset, data, dataOffset = 0, size = data.byteLength) {
        writes.push({ buffer, offset, byteLength: size });
      },
    },
  };
}

test('all 9 playable ship models expose hierarchical part-assembly catalogs and node manifests', () => {
  const modelIds = Object.keys(SHIP_MODELS);
  assert.equal(modelIds.length, 9);
  assert.equal(SHIP_SUB_ASSEMBLIES.length, 6);
  assert.ok(SHIP_PART_CAPABILITIES.assembly);

  const assetCache = createShipAssetCache();

  for (const modelId of modelIds) {
    const parts = getShipParts(modelId);
    assert.ok(parts.assembly, `${modelId} should expose parts.assembly node manifest`);
    assert.ok(parts.assembly.partCount > 3, `${modelId} manifest should have multiple nodes`);

    const asset = assetCache.get(modelId);
    assert.ok(asset.partAssembly, `${modelId} mesh asset should expose partAssembly catalog`);

    const catalog = asset.partAssembly;
    assert.equal(catalog.domain, 'ship');
    assert.equal(catalog.modelId, modelId);
    assert.ok(catalog.partCount >= 4, `${modelId} should have multiple semantic mesh parts, got ${catalog.partCount}`);
    assert.equal(catalog.vertexPartBuffer.length, catalog.vertexCount * 8);
    assert.equal(catalog.partDescriptors.length, catalog.partCount * 8);

    // Every part must have valid monotonically ordered assembly timing and a finite exploded offset
    for (let i = 0; i < catalog.partCount; i++) {
      const part = catalog.parts[i];
      assert.equal(part.partNumber, i);
      assert.ok(part.layer >= 0 && part.layer <= 5, `invalid layer ${part.layer} on ${modelId}:${part.id}`);
      assert.ok(part.assemblyWindow[0] >= 0 && part.assemblyWindow[1] <= 1.0001);
      assert.ok(part.assemblyWindow[1] > part.assemblyWindow[0]);
      const [ox, oy, oz] = part.explodedOffset;
      assert.ok(Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz));
      assert.ok(Math.hypot(ox, oy, oz) > 0.25, `${modelId}:${part.id} should have non-zero exploded offset`);
    }

    // Lookup by local point near hull center should resolve a valid part
    const hit = locatePartAtLocalPoint(catalog, [0, 0, 0]);
    assert.ok(hit, `${modelId} should resolve a part near local origin`);
    assert.ok(hit.partNumber >= 0 && hit.partNumber < catalog.partCount);
  }
});

test('all 31 colonial and Native American port building prefabs expose hierarchical part-assembly catalogs across structural layers', () => {
  const prefabIds = Object.keys(PORT_PREFABS);
  assert.equal(prefabIds.length, 31);
  assert.equal(BUILDING_SUB_ASSEMBLIES.length, 6);

  const observedSubAssemblies = new Set();

  for (const prefabId of prefabIds) {
    const bparts = getBuildingParts(prefabId);
    assert.equal(bparts.prefabId, prefabId);
    assert.ok(bparts.groups.length >= 2, `${prefabId} should record multiple semantic part groups`);

    const catalog = bparts.partAssembly;
    assert.equal(catalog.domain, 'building');
    assert.equal(catalog.modelId, prefabId);
    assert.equal(catalog.partCount, bparts.groups.length);
    assert.equal(catalog.vertexPartBuffer.length, catalog.vertexCount * 8);
    assert.equal(catalog.partDescriptors.length, catalog.partCount * 8);

    for (const part of catalog.parts) {
      observedSubAssemblies.add(part.subAssembly);
      assert.ok(part.layer >= 0 && part.layer <= 5);
      assert.ok(part.totalTriangleCount > 0, `${prefabId}:${part.id} should span triangles`);
      if (part.isLeaf) {
        assert.ok(part.triangleCount > 0, `leaf part ${prefabId}:${part.id} should own leaf triangles`);
        assert.ok(part.vertexCount > 0, `leaf part ${prefabId}:${part.id} should own vertices`);
      }
    }

    // Verify locatePartAtLocalPoint resolves a building component
    const samplePart = catalog.parts.find((p) => p.isLeaf) ?? catalog.parts[0];
    const located = bparts.locatePartAtLocalPoint(samplePart.centroid);
    assert.ok(located, `${prefabId} should locate a part near centroid`);
  }

  // Across the 20 port prefabs, all 6 building structural layers should be represented
  for (const sub of BUILDING_SUB_ASSEMBLIES) {
    assert.ok(observedSubAssemblies.has(sub.id), `Expected building sub-assembly ${sub.id} across PORT_PREFABS`);
  }
});

test('part-by-part assembly, exploded view, cutaway modes, and per-part damage transform vertices deterministically', () => {
  const assetCache = createShipAssetCache();
  const victoryAsset = assetCache.get('victory');
  const catalog = victoryAsset.partAssembly;
  const state = catalog.createState({
    assemblyProgress: 0.0,
    explodeFactor: 0.0,
  });

  assert.equal(state.partState.length, catalog.partCount * 4);
  assert.equal(state.uniform.length, 8);

  // At assemblyProgress = 0, no parts have landed yet
  for (let i = 0; i < catalog.partCount; i++) {
    assert.equal(state.evaluatePartPose(i).appear, 0);
  }

  // At assemblyProgress = 0.5, inner structural layers (keel/frame/decks) have higher appear progress than outer rigging
  state.setAssemblyProgress(0.5);
  let innerSum = 0;
  let innerCount = 0;
  let outerSum = 0;
  let outerCount = 0;
  for (const part of catalog.parts) {
    const pPose = state.evaluatePartPose(part.id);
    if (part.layer <= 1) {
      innerSum += pPose.appear;
      innerCount++;
    } else if (part.layer >= 5) {
      outerSum += pPose.appear;
      outerCount++;
    }
  }
  assert.ok(innerCount > 0 && outerCount > 0);
  assert.ok(innerSum / innerCount > outerSum / outerCount, 'Inner layers should assemble earlier than outer rigging');

  // At assemblyProgress = 1.0, all parts are 100% assembled
  state.setAssemblyProgress(1.0);
  for (let i = 0; i < catalog.partCount; i++) {
    assert.ok(Math.abs(state.evaluatePartPose(i).appear - 1.0) < 1e-5);
  }

  // Exploded view displaces vertices outward along their part's explodedOffset
  state.setExplodeFactor(1.0);
  assert.equal(state.uniform[1], 1.0);

  // Layer cutaway hides outer layers above maxLayer while keeping inner structure visible
  state.setExplodeFactor(0.0);
  state.setCutaway({ mode: 'layer', maxLayer: 2 });
  for (const part of catalog.parts) {
    const pPose = state.evaluatePartPose(part.id);
    if (part.layer > 2) {
      assert.equal(pPose.cutawayVisibility, 0, `Layer ${part.layer} part ${part.id} should be cut away`);
    } else {
      assert.equal(pPose.cutawayVisibility, 1, `Layer ${part.layer} part ${part.id} should remain visible`);
    }
  }

  // Building roof cutaway hides roof-and-canopy (layer 5) while exposing interior walls/foundations
  const chapel = getBuildingParts('mission_chapel');
  const bState = chapel.createAssemblyState();
  bState.setCutaway({ mode: 'layer', maxLayer: 4 });
  for (const part of chapel.partAssembly.parts) {
    const ps = bState.evaluatePartPose(part.id);
    if (part.layer >= 5) {
      assert.equal(ps.cutawayVisibility, 0);
    } else {
      assert.equal(ps.cutawayVisibility, 1);
    }
  }

  // CPU applyToVertices matches assembled vs exploded displacement
  bState.reset();
  const assembledVerts = bState.applyToVertices(chapel.vertices);
  assert.deepEqual(Array.from(assembledVerts.slice(0, 64)), Array.from(chapel.vertices.slice(0, 64)));

  bState.setExplodeFactor(1.0);
  const explodedVerts = bState.applyToVertices(chapel.vertices);
  let movedVertices = 0;
  const stride = chapel.partAssembly.vertexStride;
  for (let v = 0; v < chapel.partAssembly.vertexCount; v++) {
    const baseOff = v * stride;
    const dx = explodedVerts[baseOff] - chapel.vertices[baseOff];
    const dy = explodedVerts[baseOff + 1] - chapel.vertices[baseOff + 1];
    const dz = explodedVerts[baseOff + 2] - chapel.vertices[baseOff + 2];
    if (Math.hypot(dx, dy, dz) > 0.1) movedVertices++;
  }
  assert.equal(movedVertices, chapel.partAssembly.vertexCount, 'Every vertex should displace in exploded view');
});

test('createPartAssemblyGPU shares static model buffers across instances and gates uploads by revision', async () => {
  const device = createMockPartGPUDevice();
  const fakeComputePipe = async () => ({
    getBindGroupLayout(index) {
      return { index };
    },
  });
  const ninaCatalog = createShipAssetCache().get('nina').partAssembly;
  const posedA = device.createBuffer({ size: ninaCatalog.vertexCount * 48, usage: 0x80 });
  const posedB = device.createBuffer({ size: ninaCatalog.vertexCount * 48, usage: 0x80 });

  const gpuA = await createPartAssemblyGPU({
    device,
    computePipe: fakeComputePipe,
    posedBuffer: posedA,
    catalog: ninaCatalog,
  });
  const gpuB = await createPartAssemblyGPU({
    device,
    computePipe: fakeComputePipe,
    posedBuffer: posedB,
    catalog: ninaCatalog,
    shared: gpuA.assets,
  });

  // Both instances share the static vertexAttrsBuffer and descriptorsBuffer
  assert.equal(gpuA.assets.vertexAttrsBuffer, gpuB.assets.vertexAttrsBuffer);
  assert.equal(gpuA.assets.descriptorsBuffer, gpuB.assets.descriptorsBuffer);

  // First update uploads initial revision 0
  assert.equal(gpuA.update(), true);
  const writesAfterInit = device.writes.length;

  // Calling update() again without state changes performs zero redundant buffer writes
  assert.equal(gpuA.update(), false);
  assert.equal(device.writes.length, writesAfterInit);

  // Mutating state increments revision and triggers 2 buffer writes (partState + uniform)
  gpuA.state.setExplodeFactor(0.75);
  assert.equal(gpuA.update(), true);
  assert.equal(device.writes.length, writesAfterInit + 2);

  // Encoding compute pass dispatches ceil(vertexCount / 64) workgroups when active
  const pass = {
    setPipeline(p) {
      this.pipeline = p;
    },
    setBindGroup(i, g) {
      this.group = g;
    },
    dispatchWorkgroups(count) {
      device.dispatches.push(count);
    },
  };
  assert.equal(gpuA.encode(pass, true), true);
  assert.equal(device.dispatches.length, 1);
  assert.equal(device.dispatches[0], Math.ceil(ninaCatalog.vertexCount / 64));

  // Destroying first instance retains shared static buffers until last instance is destroyed
  gpuA.destroy();
  assert.equal(gpuA.assets.vertexAttrsBuffer.destroyed, false);

  gpuB.destroy();
  assert.equal(gpuA.assets.vertexAttrsBuffer.destroyed, true);
  assert.equal(gpuA.assets.descriptorsBuffer.destroyed, true);
});

test('WGSL part-assembly shaders contain required structs and entry points', () => {
  assert.ok(PART_ASSEMBLY_WGSL.includes('struct PartAssemblyUniform'));
  assert.ok(PART_ASSEMBLY_WGSL.includes('fn evaluatePartAssemblyVertex('));
  assert.ok(PART_ASSEMBLY_WGSL.includes('fn applyPartSurfaceState('));
  assert.ok(PART_ASSEMBLY_POSE_UPDATE.includes('@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u)'));
});

test('cannonball impacts on ships and 1550 port buildings resolve hitPartId, hitSubAssembly, and per-part damage', () => {
  const source = { id: 'player', modelId: 'victory', x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0 };
  const targetShip = {
    id: 'enemy-nina',
    modelId: 'nina',
    length: 20,
    beam: 6,
    x: -35,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
  };

  const hullHit = sweepShipSegment([-10, 0.4, 0], [-50, 0.4, 0], 0.08, targetShip, source);
  assert.ok(hullHit, 'swept segment should hit targetShip');
  assert.equal(hullHit.kind, 'ship');
  assert.ok(hullHit.hitPartId, 'ship sweep should identify specific hitPartId');
  assert.ok(hullHit.hitSubAssembly, 'ship sweep should identify specific hitSubAssembly');
  assert.ok(Number.isInteger(hullHit.hitLayer));

  const shipRep = applyShipImpactDamage(targetShip, {
    ...hullHit,
    position: [-32, 0.4, 0],
    surfacePosition: [-32, 0.4, 0],
    velocity: [-320, -4, 0],
    mass: 5.4,
    energy: 0.5 * 5.4 * 320 * 320,
  });
  assert.equal(shipRep.hitPartId, hullHit.hitPartId);
  assert.equal(shipRep.hitSubAssembly, hullHit.hitSubAssembly);
  assert.ok(shipRep.partDamage > 0);
  assert.ok(targetShip.damage.partDamage[hullHit.hitPartId] > 0);

  const region = resolveGlobalCoastalRegion({
    id: 'cartagena',
    name: 'Cartagena',
    latitude: 10.423,
    longitude: -75.548,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
  });
  const heights = synthesizeCoastalTerrain(region);
  const port = placeCoastalPort(region, heights);
  const bastion = port.instances.find((i) => i.prefabId === 'stone_sea_bastion');
  assert.ok(bastion);

  const bFrom = [bastion.x, bastion.baseY + bastion.height * 0.5, bastion.z + 40];
  const bTo = [bastion.x, bastion.baseY + bastion.height * 0.5, bastion.z - 40];
  const bHit = sweepBuildingSegment(bFrom, bTo, 0.08, port);
  assert.ok(bHit, 'cannonball should intersect port building');
  assert.equal(bHit.kind, 'building');
  assert.ok(bHit.hitPartId, 'building sweep should identify specific hitPartId');
  assert.ok(bHit.hitSubAssembly, 'building sweep should identify specific hitSubAssembly');
  assert.ok(Number.isInteger(bHit.hitLayer));

  const bRep = applyBuildingImpactDamage(bastion, {
    ...bHit,
    velocity: [0, 0, -420],
    mass: 14.5,
    energy: 0.5 * 14.5 * 420 * 420,
  });
  assert.equal(bRep.hitPartId, bHit.hitPartId);
  assert.equal(bRep.hitSubAssembly, bHit.hitSubAssembly);
  assert.ok(bRep.partDamage > 0);
  assert.ok(bastion.damageState.partDamage[bHit.hitPartId] > 0);
});

test('syncVesselDamage maps cannonball impact sites and modular part damage into live GPU state', () => {
  const victoryCatalog = createShipAssetCache().get('victory').partAssembly;
  const state = createPartAssemblyState(victoryCatalog);
  assert.equal(state.isDefaultIntact(), true);

  const stanchionPart = victoryCatalog.parts.find(
    (p) => p.id.includes('.stanchion.') && p.triangleCount > 0 && p.triangleCount <= 450 && p.layer >= 2
  );
  assert.ok(stanchionPart, 'Victory should have a breakable bulwark modular part');

  const changed = state.syncVesselDamage({
    partDamage: {
      'hull.planking': 0.85,
      [stanchionPart.id]: 0.9,
    },
    impactSites: [[1.65, 1.4, -0.5, 0.75]],
  });
  assert.equal(changed, true);
  assert.equal(state.isDefaultIntact(), false);

  const plankingPose = state.evaluatePartPose('hull.planking');
  assert.equal(plankingPose.visible, true, 'Continuous hull planking remains visible');
  assert.equal(plankingPose.explode, 0, 'Continuous hull planking does not translate as a rigid block');

  const stanchionPose = state.evaluatePartPose(stanchionPart.id);
  assert.equal(stanchionPose.visible, false, 'Shattered modular bulwark part breaks away when heavily damaged');
  assert.ok(Math.abs(state.impactSites[3] - 0.75) < 1e-5, 'Impact site severity is recorded for localized GPU crater/scorch');
});

test('overlapping cannonball hits cumulatively erode hull collision envelope and bake deeper 3D vertex craters', () => {
  const victoryAsset = createShipAssetCache().get('victory');
  const mesh = new Float32Array(victoryAsset.vertices);
  const origMesh = new Float32Array(victoryAsset.vertices);

  const source = { id: 'player', modelId: 'victory', x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0 };
  const targetShip = {
    id: 'enemy-victory',
    modelId: 'victory',
    length: 69,
    beam: 15.8,
    x: -75,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
  };

  // Fire three overlapping 32-pdr cannonballs into the same upper-hull spot on targetShip's starboard side
  const hitPositionsX = [];
  const maxInwardDisplacements = [];

  for (let i = 0; i < 3; i++) {
    const hit = sweepShipSegment([-20, 4.8, 2.0], [-90, 4.8, 2.0], 0.08, targetShip, source);
    assert.ok(hit, `Shot ${i + 1} should hit targetShip`);
    hitPositionsX.push(hit.localPosition[0]);

    applyShipImpactDamage(targetShip, {
      ...hit,
      velocity: [-400, -4, 0],
      mass: 14.5,
      energy: 0.5 * 14.5 * 400 * 400,
    });

    const bakeRange = bakeVesselImpactDeformations(mesh, targetShip.damage.pendingBakes.splice(0), 9);
    assert.ok(bakeRange, `Shot ${i + 1} should bake vertex deformations`);

    let maxInward = 0;
    for (let v = bakeRange.minVertex; v <= bakeRange.maxVertex; v++) {
      const off = v * 9;
      if (origMesh[off] > 0.5) {
        const inward = origMesh[off] - mesh[off];
        if (inward > maxInward) maxInward = inward;
      }
    }
    maxInwardDisplacements.push(maxInward);
  }

  assert.equal(targetShip.damage.craters.length, 1, 'Overlapping hits merge into a cumulative crater');
  assert.equal(targetShip.damage.craters[0].hits, 3, 'Crater records 3 cumulative hits');
  assert.ok(
    hitPositionsX[1] < hitPositionsX[0] && hitPositionsX[2] < hitPositionsX[1],
    `Subsequent overlapping shots penetrate progressively deeper into the hull (${hitPositionsX.map((x) => x.toFixed(3)).join(' -> ')})`
  );
  assert.ok(
    maxInwardDisplacements[1] > maxInwardDisplacements[0] && maxInwardDisplacements[2] > maxInwardDisplacements[1],
    `Baked 3D vertex crater deepens cumulatively across overlapping hits (${maxInwardDisplacements.map((d) => d.toFixed(3)).join(' -> ')})`
  );
});

test('point-blank hits penetrate outer hull, damage internal decks/beams, dismount struck cannons, and collapse masts', () => {
  const victoryAsset = createShipAssetCache().get('victory');
  const mesh = new Float32Array(victoryAsset.vertices);
  const origMesh = new Float32Array(victoryAsset.vertices);

  const source = { id: 'player', modelId: 'victory', x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0 };
  const targetShip = {
    id: 'enemy-victory-pen',
    modelId: 'victory',
    length: 69,
    beam: 15.8,
    x: -55,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    sailMain: 1.0,
  };

  // 1. Point-blank direct hit on a lower-deck starboard cannon (z ≈ 0.0, y ≈ 0.35 in model units -> world y ≈ 2.24, z ≈ 0.0)
  const gunHit = sweepShipSegment([-20, 2.24, 0.0], [-75, 2.24, 0.0], 0.08, targetShip, source);
  assert.ok(gunHit, 'Point-blank shot should hit targetShip lower gun deck');
  const rep1 = applyShipImpactDamage(targetShip, {
    ...gunHit,
    velocity: [-435, -6, 0],
    mass: 14.5,
    energy: 0.5 * 14.5 * 435 * 435, // ~1.37 MJ point-blank 32-pdr
  });
  assert.equal(rep1.penetratedOuter, true, 'First point-blank 32-pdr shot penetrates the outer hull immediately');
  assert.ok(targetShip.damage.throughBreaches >= 1, 'Through-breach count increments on first point-blank shot');
  assert.ok(targetShip.damage.craters[0].depth >= 0.24, 'First point-blank shot records through-breach depth >= 0.24');
  assert.ok(targetShip.damage.dismountedGuns >= 1, 'Direct point-blank hit near gunport dismounts the cannon');
  assert.ok(
    (targetShip.damage.partDamage['deck.lower.internal'] || 0) > 0 ||
      (targetShip.damage.partDamage['deck.middle.internal'] || 0) > 0 ||
      (targetShip.damage.partDamage['deck.orlop.internal'] || 0) > 0,
    'Penetrating shot damages internal gun-deck structure'
  );

  const bake1 = bakeVesselImpactDeformations(mesh, targetShip.damage.pendingBakes.splice(0), 9);
  assert.ok(bake1, 'Point-blank penetrating hit and cannon dismount bake 3D deformations');

  // Verify cannon vertices near the struck gunport (x > 0.72, |y - 0.45| < 0.35, |z| < 0.28) were knocked inward and dropped
  let movedCannonVerts = 0;
  for (let v = 0, n = mesh.length / 9; v < n; v++) {
    const off = v * 9;
    const mat = Math.floor(origMesh[off + 6]);
    if ((mat === 3 || mat === 4 || mat === 24) && origMesh[off] > 0.72 && Math.abs(origMesh[off + 1] - 0.45) < 0.35 && Math.abs(origMesh[off + 2]) < 0.28) {
      if (mesh[off] < origMesh[off] - 0.02 && mesh[off + 1] < origMesh[off + 1] - 0.005) {
        movedCannonVerts++;
      }
    }
  }
  assert.ok(movedCannonVerts > 10, `Struck cannon barrel/carriage vertices should be knocked inward and dropped (${movedCannonVerts} moved)`);

  // 2. Repeated hits on the mainmast progressively snap topmast (stage: 'topmast') and then collapse full mainmast (stage: 'full')
  for (let i = 0; i < 6; i++) {
    applyShipImpactDamage(targetShip, {
      hitZone: 'rigging',
      mastGroup: 'main',
      hitPartId: 'masts.spars',
      hitSubAssembly: 'masts-and-spars',
      hitLayer: 4,
      localPosition: [0.0, 2.5, -0.10],
      localNormal: [1, 0, 0],
      position: [-55, 16.0, -0.64],
      surfacePosition: [-55, 16.0, -0.64],
      velocity: [-410, 0, 0],
      mass: 14.5,
      energy: 0.5 * 14.5 * 410 * 410,
    });
  }
  assert.equal(targetShip.damage.mastState.main, 2, 'Mainmast reaches full collapse state after heavy cannonade');
  assert.equal(targetShip.sailMain, 0, 'Mainmast collapse drops sailMain power to 0');

  const mastBakes = targetShip.damage.pendingBakes.splice(0);
  assert.ok(mastBakes.some((b) => b.kind === 'mast-break' && b.stage === 'topmast'), 'Queues topmast fracture stage');
  assert.ok(mastBakes.some((b) => b.kind === 'mast-break' && b.stage === 'full'), 'Queues full mast collapse stage');

  bakeVesselImpactDeformations(mesh, mastBakes, 9);

  // Verify upper mainmast vertices (origY > 5.0, |origZ + 0.10| < 0.4) have toppled downward and to the side
  let toppledMastVerts = 0;
  for (let v = 0, n = mesh.length / 9; v < n; v++) {
    const off = v * 9;
    if (origMesh[off + 1] > 5.0 && Math.abs(origMesh[off + 2] + 0.10) < 0.45) {
      const dy = mesh[off + 1] - origMesh[off + 1];
      const dx = Math.abs(mesh[off] - origMesh[off]);
      if (dy < -0.5 && dx > 0.5) toppledMastVerts++;
    }
  }
  assert.ok(toppledMastVerts > 50, `Collapsed mainmast, yards, sails, and rigging vertices should topple downward and sideways (${toppledMastVerts} toppled)`);
});

test('shots through stern/quarter-gallery windows shatter glass, damage internal bulkheads/decks, and strike the back wall of the hull', () => {
  const victoryAsset = createShipAssetCache().get('victory');
  const mesh = new Float32Array(victoryAsset.vertices);
  const origMesh = new Float32Array(victoryAsset.vertices);

  const targetShip = {
    id: 'enemy-victory-window',
    modelId: 'victory',
    length: 69,
    beam: 15.8,
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
  };

  // 1. Shot entering through the stern gallery windows (designPt ≈ [0.22, 1.95, 6.15] -> local [0.96, 12.46, 35.36])
  const sternWinRep = applyShipImpactDamage(targetShip, {
    hitZone: 'hull',
    hitPartId: 'stern.gallery.1.windows',
    hitSubAssembly: 'hull-and-bulwarks',
    localPosition: [0.96, 12.46, 35.36],
    position: [0.96, 12.46, 35.36],
    surfacePosition: [0.96, 12.46, 35.36],
    velocity: [-65, -4, -395],
    mass: 14.5,
    energy: 0.5 * 14.5 * 400 * 400,
  });

  assert.equal(sternWinRep.enteredThroughWindow, true, 'Shot through stern gallery window is flagged as enteredThroughWindow');
  assert.equal(sternWinRep.penetratedOuter, true, 'Glass window offers minimal entry resistance (12 kJ)');
  assert.equal(sternWinRep.hitBackWall, true, 'Raking shot through stern window strikes the cabin back wall / internal bulkheads');
  assert.ok(targetShip.damage.windowHits >= 1, 'Records window hit count');
  assert.ok(targetShip.damage.backWallHits >= 1, 'Records back wall hit count');
  assert.ok(
    (targetShip.damage.partDamage['stern.gallery.1.windows'] || 0) > 0.4,
    'Shatters stern gallery window part'
  );
  assert.ok(
    (targetShip.damage.partDamage['hull.closure.stern'] || 0) > 0 ||
      (targetShip.damage.partDamage['deck.bulkhead.4.35'] || 0) > 0 ||
      (targetShip.damage.partDamage['stern.gallery.1.rear'] || 0) > 0,
    'Damages cabin back wall and internal bulkheads along interior trajectory'
  );

  // 2. Athwartships shot entering through an open gunport / quarter-gallery window and striking the opposite back wall of the hull
  const portToStarboardRep = applyShipImpactDamage(targetShip, {
    hitZone: 'hull',
    hitPartId: 'gun.0.7.port',
    hitSubAssembly: 'ordnance-and-helm',
    localPosition: [5.4, 2.2, 0.0],
    position: [5.4, 2.2, 0.0],
    surfacePosition: [5.4, 2.2, 0.0],
    velocity: [-430, -2, 0],
    mass: 14.5,
    energy: 0.5 * 14.5 * 430 * 430,
  });
  assert.equal(portToStarboardRep.enteredThroughWindow, true, 'Open gunport entry is recognized');
  assert.equal(portToStarboardRep.hitBackWall, true, 'Shot crosses gun deck and strikes opposite back wall of the hull');
  assert.ok(targetShip.damage.backWallHits >= 2, 'Increments backWallHits on opposite hull wall strike');

  const bakes = targetShip.damage.pendingBakes.splice(0);
  assert.ok(bakes.some((b) => b.kind === 'window-shatter'), 'Queues window-shatter vertex bake');
  assert.ok(bakes.some((b) => b.kind === 'back-wall'), 'Queues back-wall vertex bake on opposite hull wall');
  const baked = bakeVesselImpactDeformations(mesh, bakes, 9);
  assert.ok(baked, 'Window shatter and back-wall bakes deform 3D mesh');

  // Verify stern window glass (mat === 11) vertices were shattered inward and marked with high fracture damage
  let shatteredGlassVerts = 0;
  for (let v = 0, n = mesh.length / 9; v < n; v++) {
    const off = v * 9;
    const mat = Math.floor(origMesh[off + 6]);
    if (mat === 11 && origMesh[off + 2] > 5.0) {
      const nLen = Math.hypot(mesh[off + 3], mesh[off + 4], mesh[off + 5]);
      if (mesh[off + 2] < origMesh[off + 2] - 0.01 && nLen > 1.8) {
        shatteredGlassVerts++;
      }
    }
  }
  assert.ok(shatteredGlassVerts > 4, `Stern gallery glass vertices should shatter inward (${shatteredGlassVerts} shattered)`);
});

test('hot shot ignites shipboard fires, chain/grape shot shred sails & rigging, and uncontained waterline breaches sink the ship', async () => {
  const { boatHydrodynamics } = await import('../js/boat.js');
  const targetShip = {
    id: 'enemy-frigate',
    modelId: 'nina',
    length: 20,
    beam: 6,
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
    cargoTonnes: 0,
  };
  targetShip.hydrodynamics = boatHydrodynamics(20, 6);

  // 1. Chain shot vs Round shot against rigging & sails
  const roundRig = applyShipImpactDamage(targetShip, {
    ammo: 'round',
    hitZone: 'rigging',
    mastGroup: 'fore',
    localPosition: [0, 8, -4],
    position: [0, 8, -4],
    velocity: [-280, 0, 0],
    mass: 5.4,
    energy: 80000,
  });
  const foreLossRound = 1 - targetShip.damage.mastIntegrity.fore;

  const chainRig = applyShipImpactDamage(targetShip, {
    ammo: 'chain',
    hitZone: 'rigging',
    mastGroup: 'main',
    localPosition: [0, 8, 0],
    position: [0, 8, 0],
    velocity: [-280, 0, 0],
    mass: 5.4,
    energy: 80000,
  });
  const mainLossChain = 1 - targetShip.damage.mastIntegrity.main;
  assert.equal(chainRig.ammo, 'chain');
  assert.ok(mainLossChain > foreLossRound * 2.5, 'Chain shot inflicts >2.5x more sail and rigging damage than solid roundshot');
  assert.ok(targetShip.sailMain < targetShip.sailFore, 'Chain shot rips deployed main sail canvas');

  // 2. Hot shot ignites shipboard fires and emits world-space fire/smoke plumes
  const hotRep = applyShipImpactDamage(targetShip, {
    ammo: 'hot',
    hitZone: 'hull',
    localPosition: [2.2, 1.4, 1.0],
    position: [2.2, 1.4, 1.0],
    velocity: [-340, -5, 0],
    mass: 10.8,
    energy: 0.5 * 10.8 * 340 * 340,
  });
  assert.equal(hotRep.ammo, 'hot');
  assert.ok(hotRep.fires >= 1 && hotRep.fireIntensity > 0.5, 'Glowing hot shot starts a shipboard fire');
  const preBurnHull = targetShip.damage.hullIntegrity;
  stepVesselDamage(targetShip, 1.0);
  assert.ok(targetShip.damage.worldFires.length >= 1, 'stepVesselDamage populates world-space fire/smoke plume emitters');
  assert.ok(targetShip.damage.hullIntegrity < preBurnHull, 'Active shipboard fire progressively burns hull timbers');

  // 3. Large/repeated waterline breaches continuously take on water, list the ship, and eventually sink it
  for (let i = 0; i < 6; i++) {
    applyShipImpactDamage(targetShip, {
      ammo: 'round',
      hitZone: 'hull',
      waterline: true,
      localPosition: [2.6, 0.1, 0.5],
      position: [2.6, 0.1, 0.5],
      velocity: [-410, -8, 0],
      mass: 14.5,
      radius: 0.11,
      energy: 0.5 * 14.5 * 410 * 410,
    });
  }
  const initialFlood = targetShip.damage.floodingTonnes;
  for (let t = 0; t < 120; t++) {
    stepVesselDamage(targetShip, 0.25);
  }
  assert.ok(targetShip.damage.floodingTonnes > initialFlood + 10, 'Waterline breaches continuously admit seawater over time');
  assert.ok(targetShip.damage.floodingSinkage > 0.8, 'Continuous flooding deepens vessel sinkage');
  assert.ok(targetShip.damage.floodingRoll > 0.05, 'Starboard waterline breaches cause the ship to list to starboard');
  assert.equal(targetShip.damage.sunk, true, 'Uncontained heavy waterline breaches eventually founder and sink the ship');
});

test('powder magazine tracks ordnance inventory, depletes on firing, and causes a catastrophic explosion or fire scaled by remaining powder', async () => {
  const { boatHydrodynamics } = await import('../js/boat.js');
  const victoryAsset = createShipAssetCache().get('victory');
  const partIds = new Set(victoryAsset.partAssembly.parts.map((p) => p.id));
  assert.ok(partIds.has('magazine.grand'), 'HMS Victory 3D assembly contains the forward Grand Magazine');
  assert.ok(partIds.has('magazine.aft'), 'HMS Victory 3D assembly contains the Aft Magazine');
  assert.ok(partIds.has('magazine.shot_locker'), 'HMS Victory 3D assembly contains the midships Shot Locker');

  const makeVictory = (id) => {
    const ship = {
      id,
      modelId: 'victory',
      length: 69,
      beam: 15.8,
      x: 0,
      z: 0,
      heave: 0,
      heading: 0,
      roll: 0,
      pitch: 0,
      sailFore: 1,
      sailMain: 1,
      sailMizzen: 1,
      cargoTonnes: 0,
    };
    ship.hydrodynamics = boatHydrodynamics(69, 15.8, 30, 0, 'victory');
    createVesselMagazineState(ship);
    return ship;
  };

  // 1. Historical powder & shot inventory and depletion per gun fired
  const shipFull = makeVictory('victory-full-mag');
  assert.equal(shipFull.magazine.barrelsTotal, 350, '1st-rate Victory stows 350 copper-hooped 90-lb powder barrels');
  assert.equal(shipFull.magazine.initialPowderKg, 14280, 'Initial black powder inventory is 14,280 kg');
  assert.equal(shipFull.magazine.rounds.round, 6200, 'Shot locker carries 6,200 round shot');
  assert.equal(shipFull.magazine.rounds.hot, 240, 'Shot locker carries 240 furnace-heated hot shot');
  assert.equal(shipFull.magazine.rounds.chain, 620, 'Shot locker carries 620 chain shot');
  assert.equal(shipFull.magazine.rounds.grape, 840, 'Shot locker carries 840 grape shot');

  consumeMagazineOrdnance(shipFull, { mass: 14.5, ammo: 'round' });
  assert.ok(shipFull.magazine.powderKg < shipFull.magazine.initialPowderKg, 'Firing a 32-pdr deducts ~4.83 kg of black powder');
  assert.equal(shipFull.magazine.rounds.round, 6199, 'Firing deducts 1 round shot from the locker');

  // 2. Penetrating hit into the Grand Magazine with ~100% powder remaining -> Catastrophic Explosion
  const fullMesh = new Float32Array(victoryAsset.vertices);
  const origMesh = new Float32Array(victoryAsset.vertices);
  const fullRep = applyShipImpactDamage(shipFull, {
    ammo: 'round',
    hitZone: 'hull',
    hitPartId: 'magazine.grand',
    hitSubAssembly: 'decks-and-interior',
    localPosition: [4.2, -2.5, -18.5],
    position: [4.2, -2.5, -18.5],
    surfacePosition: [4.2, -2.5, -18.5],
    velocity: [-420, -25, 0],
    mass: 14.5,
    energy: 0.5 * 14.5 * 420 * 420,
  });

  assert.equal(fullRep.magazineHit, true, 'Direct/penetrating strike on Grand Magazine registers magazineHit');
  assert.equal(fullRep.magazineExploded, true, 'Full magazine triggers a catastrophic explosion');
  assert.ok(fullRep.magazineExplosionYieldMj > 40000, 'Full magazine detonation releases >40,000 MJ of black powder energy');
  assert.equal(shipFull.magazine.powderKg, 0, 'Detonation consumes all remaining black powder');
  assert.equal(shipFull.damage.sunk, true, 'Catastrophic magazine explosion ruptures the hull below the waterline and sinks the ship');
  assert.equal(shipFull.damage.mastIntegrity.fore, 0, 'Upward blast unsteps and collapses the foremast');
  assert.equal(shipFull.damage.mastIntegrity.main, 0, 'Full magazine explosion also collapses the mainmast');
  assert.ok(shipFull.damage.fires.length >= 4, 'Magazine explosion ignites a raging multi-deck conflagration');

  const fullBakes = shipFull.damage.pendingBakes.splice(0);
  assert.ok(fullBakes.some((b) => b.kind === 'magazine-explosion'), 'Queues 3D magazine-explosion mesh deformation');
  bakeVesselImpactDeformations(fullMesh, fullBakes, 9);

  let heavedDeckVerts = 0;
  for (let v = 0, n = fullMesh.length / 9; v < n; v++) {
    const off = v * 9;
    if (Math.abs(origMesh[off + 2] + 3.3) < 1.5 && origMesh[off + 1] > -0.6 && origMesh[off + 1] < 1.6) {
      if (fullMesh[off + 1] > origMesh[off + 1] + 0.12 || Math.abs(fullMesh[off]) > Math.abs(origMesh[off]) + 0.12) {
        heavedDeckVerts++;
      }
    }
  }
  assert.ok(heavedDeckVerts > 50, `Magazine explosion bakes upward deck heave and outward hull blowout (${heavedDeckVerts} vertices displaced)`);

  // 3. Strike on a nearly depleted magazine (10% powder left) -> Violent internal deflagration & fire, NOT full hull detonation
  const shipLow = makeVictory('victory-low-mag');
  shipLow.magazine.powderKg = shipLow.magazine.initialPowderKg * 0.10;
  shipLow.magazine.powderFraction = 0.10;
  const lowRep = applyShipImpactDamage(shipLow, {
    ammo: 'hot',
    hitZone: 'hull',
    hitPartId: 'magazine.grand',
    hitSubAssembly: 'decks-and-interior',
    localPosition: [4.2, -2.5, -18.5],
    position: [4.2, -2.5, -18.5],
    surfacePosition: [4.2, -2.5, -18.5],
    velocity: [-400, -20, 0],
    mass: 14.5,
    energy: 0.5 * 14.5 * 400 * 400,
  });
  assert.equal(lowRep.magazineHit, true, 'Strike on low magazine registers magazineHit');
  assert.equal(lowRep.magazineExploded, false, '10% remaining powder does not blow the ship apart immediately');
  assert.equal(lowRep.magazineDeflagrated, true, '10% remaining powder causes a violent internal deflagration and major fire');
  assert.ok(lowRep.magazineExplosionYieldMj > 3000 && lowRep.magazineExplosionYieldMj < fullRep.magazineExplosionYieldMj * 0.15, 'Deflagration yield scales proportionally with remaining powder');
  assert.ok(shipLow.damage.fires.length >= 2 && shipLow.damage.fireIntensity > 1.5, 'Deflagration ignites severe internal shipboard fires');
  assert.ok(shipLow.damage.hullIntegrity > shipFull.damage.hullIntegrity, 'Low-powder deflagration leaves more hull integrity than a full-magazine detonation');

  // 4. Strike on an empty magazine (0% powder left) -> Only timber impact damage, no powder fire/explosion
  const shipEmpty = makeVictory('victory-empty-mag');
  shipEmpty.magazine.powderKg = 0;
  shipEmpty.magazine.powderFraction = 0;
  const emptyRep = applyShipImpactDamage(shipEmpty, {
    ammo: 'round',
    hitZone: 'hull',
    hitPartId: 'magazine.grand',
    hitSubAssembly: 'decks-and-interior',
    localPosition: [4.2, -2.5, -18.5],
    position: [4.2, -2.5, -18.5],
    surfacePosition: [4.2, -2.5, -18.5],
    velocity: [-400, -20, 0],
    mass: 14.5,
    energy: 0.5 * 14.5 * 400 * 400,
  });
  assert.equal(emptyRep.magazineHit, true);
  assert.equal(emptyRep.magazineExploded, false, 'Empty magazine cannot explode');
  assert.equal(emptyRep.magazineDeflagrated, false, 'Empty magazine cannot deflagrate');
  assert.equal(emptyRep.magazineExplosionYieldMj, 0, 'Empty magazine releases 0 MJ of chemical energy');
});

test('a foundering ship decelerates to a halt, heels/plunges asymmetrically, and sinks completely beneath the surface', async () => {
  const { boatHydrodynamics, boatForwardSpeed } = await import('../js/boat.js');
  const { stepVessel, createVesselProbeState } = await import('../js/vessels.js');

  const ship = {
    id: 'sinking-victory',
    modelId: 'victory',
    length: 69,
    beam: 15.8,
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    rudder: 0,
    rudderTarget: 0,
    yawRate: 0,
    propulsion: 'sail',
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
    crewSailRate: new Float64Array([0, 0, 0]), // Crew at gun stations, not hauling halyards
    provisionDays: 30,
    cargoTonnes: 0,
    speed: 6,
    revision: 0,
    target: { heave: 0, pitch: 0, roll: 0 },
    waveSlopeX: 0,
    waveSlopeZ: 0,
    waveSampleTime: -1,
    waveRevision: -1,
  };
  ship.hydrodynamics = boatHydrodynamics(69, 15.8, 30, 0, 'victory');
  ship.heave = -ship.hydrodynamics.sinkage;
  const probe = createVesselProbeState();

  // Sail for 10 seconds in 12 m/s broad-reach wind to establish steady forward headway
  for (let i = 0; i < 40; i++) {
    stepVessel(ship, probe, 0.25, i * 0.25, 12, -Math.PI / 3, 0);
  }
  const underwaySpeed = boatForwardSpeed(ship);
  assert.ok(underwaySpeed > 1.5, `Ship should establish forward headway before sinking (got ${underwaySpeed.toFixed(2)} m/s)`);

  // Inflict heavy waterline breaches on the forward starboard compartment (foreStarboard), forward of the grand magazine
  for (let hit = 0; hit < 18; hit++) {
    applyShipImpactDamage(ship, {
      ammo: 'round',
      hitZone: 'hull',
      waterline: true,
      localPosition: [5.5, 0.2, -23.0],
      position: [5.5, 0.2, -23.0],
      surfacePosition: [5.5, 0.2, -23.0],
      velocity: [-420, -6, 0],
      mass: 14.5,
      radius: 0.12,
      energy: 0.5 * 14.5 * 420 * 420,
    });
  }
  assert.equal(ship.damage.sunk, false, 'Warship must not sink instantaneously upon impact before water pours into the hull');
  assert.ok(ship.damage.compartments.foreStarboard.breachArea > 0.5, 'Forward starboard compartment records waterline breach area');

  // Step progressive compartment flooding until the forward compartment drags the bow down,
  // raises the stern up, cracks the hull under longitudinal strain, and founders the vessel
  let stepsToFounder = 0;
  while (!ship.damage.sunk && stepsToFounder < 600) {
    stepVesselDamage(ship, 0.25);
    stepVessel(ship, probe, 0.25, 10 + stepsToFounder * 0.25, 12, -Math.PI / 3, 0);
    stepsToFounder++;
  }
  assert.ok(stepsToFounder >= 8, `Flooding should take real time to founder the ship (took ${(stepsToFounder * 0.25).toFixed(1)} s)`);
  assert.ok(
    ship.damage.compartments.foreStarboard.waterTonnes > ship.damage.compartments.aftPort.waterTonnes * 3,
    'Breached forward starboard compartment floods first before aft compartments'
  );
  assert.equal(ship.damage.hullCracked, true, 'Uneven compartment flooding and bow-down/stern-up cantilever strain cracks the hull');

  // Step the foundering vessel for another 45 seconds so it settles deep below the waves
  for (let i = 0; i < 180; i++) {
    stepVesselDamage(ship, 0.25);
    stepVessel(ship, probe, 0.25, 30 + i * 0.25, 12, -Math.PI / 3, 0);
  }

  const sunkSpeed = Math.abs(boatForwardSpeed(ship));
  assert.ok(
    sunkSpeed < underwaySpeed * 0.12,
    `Foundering ship must lose forward headway instead of sailing on at speed (${underwaySpeed.toFixed(2)} -> ${sunkSpeed.toFixed(2)} m/s)`
  );
  assert.ok(
    Math.abs(ship.roll) > 0.35,
    `Foundering ship must heel heavily onto its beam-ends instead of sinking vertically (roll = ${(ship.roll * 180 / Math.PI).toFixed(1)} deg)`
  );
  assert.ok(
    Math.abs(ship.pitch) > 0.18,
    `Foundering ship must plunge by the bow or stern instead of sinking flat (pitch = ${(ship.pitch * 180 / Math.PI).toFixed(1)} deg)`
  );
  assert.ok(
    ship.heave < -60,
    `Foundering 69 m Victory must sink deep enough to submerge its entire hull and masts (heave = ${ship.heave.toFixed(1)} m)`
  );
  assert.equal(ship.damage.settledWreck, true, 'Sunken ship transitions to settledWreck after resting on the bottom');
  const settledPose = { x: ship.x, z: ship.z, heave: ship.heave, roll: ship.roll, pitch: ship.pitch };
  ship.target = { heave: 4.5, pitch: 0.3, roll: -0.3 };
  stepVesselDamage(ship, 0.5);
  stepVessel(ship, probe, 0.5, 90, 20, 0, 1);
  assert.deepEqual(
    { x: ship.x, z: ship.z, heave: ship.heave, roll: ship.roll, pitch: ship.pitch },
    settledPose,
    'Settled wreck on the seabed freezes all motion and stops integrating surface waves or wind'
  );
});

test('sail-rip and hull-crack bakes physically deform 3D sail cloth ribbons, rigging lines, and cracked hull strakes', async () => {
  const { boatHydrodynamics } = await import('../js/boat.js');
  const victoryAsset = createShipAssetCache().get('victory');
  const baseMesh = victoryAsset.vertices;
  const workingMesh = new Float32Array(baseMesh);
  const stride = 9;
  const vertexCount = workingMesh.length / stride;

  const ship = {
    id: 'victory-rip-crack',
    modelId: 'victory',
    length: 69,
    beam: 15.8,
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
    cargoTonnes: 0,
  };
  ship.hydrodynamics = boatHydrodynamics(69, 15.8, 30, 0, 'victory');

  // 1. Chain shot and grape shot hitting mainmast sails queue 'sail-rip' bakes
  const ripReport = applyShipImpactDamage(ship, {
    ammo: 'chain',
    hitZone: 'rigging',
    mastGroup: 'main',
    localPosition: [0.5, 22.0, 0.2],
    position: [0.5, 22.0, 0.2],
    surfacePosition: [0.5, 22.0, 0.2],
    velocity: [-320, 0, 0],
    mass: 5.4,
    energy: 140000,
  });
  assert.ok(ripReport.sailRips >= 1, 'Rigging hit records sail rip count');
  assert.ok(ship.damage.pendingBakes.some((b) => b.kind === 'sail-rip'), 'Rigging hit queues a 3D sail-rip mesh deformation bake');

  // Also queue a hull-crack bake from extreme longitudinal bending strain
  ship.damage.pendingBakes.push({
    kind: 'hull-crack',
    z: -1.05,
    severity: 1.2,
  });

  const range = bakeVesselImpactDeformations(workingMesh, ship.damage.pendingBakes, stride);
  assert.ok(range, 'bakeVesselImpactDeformations returns dirty vertex range for sail-rip and hull-crack');

  let rippedSailVerts = 0;
  let frayedRiggingVerts = 0;
  let crackedHullVerts = 0;
  for (let v = 0; v < vertexCount; v++) {
    const at = v * stride;
    const mat = Math.floor(workingMesh[at + 6]);
    const dx = workingMesh[at] - baseMesh[at];
    const dy = workingMesh[at + 1] - baseMesh[at + 1];
    const dz = workingMesh[at + 2] - baseMesh[at + 2];
    const disp = Math.hypot(dx, dy, dz);
    const nLen = Math.hypot(workingMesh[at + 3], workingMesh[at + 4], workingMesh[at + 5]);
    const dmg = nLen > 1.002 ? nLen - 1.0 : 0;
    if ((mat === 9 || mat === 13) && disp > 0.10 && dmg > 0.35) {
      rippedSailVerts++;
    } else if ((mat === 2 || mat === 12 || mat === 19) && disp > 0.05 && dmg > 0.25) {
      frayedRiggingVerts++;
    } else if (mat === 0 && Math.abs(baseMesh[at + 2] - (-1.05)) < 0.85 && disp > 0.05 && dmg > 0.5) {
      crackedHullVerts++;
    }
  }
  assert.ok(
    rippedSailVerts > 20,
    `Sail cloth vertices must deform >0.10 design units and encode tear damage for shader holes (got ${rippedSailVerts})`
  );
  assert.ok(
    frayedRiggingVerts > 5,
    `Rigging lines near sail impact must slacken and fray (got ${frayedRiggingVerts})`
  );
  assert.ok(
    crackedHullVerts > 20,
    `Hull planking across the fracture plane must split open under bending strain (got ${crackedHullVerts})`
  );
});

test('all 9 playable ship models engage in naval battles, fire broadsides, deform 3D meshes, and sink realistically', async () => {
  const { boatHydrodynamics } = await import('../js/boat.js');
  const cache = createShipAssetCache();
  const allModelIds = [
    'victory',
    'nina',
    'pinta',
    'santa-maria',
    'oseberg',
    'lusoria',
    'taino-canoe',
    'flying-cloud',
    'gipsy-moth-iv',
  ];

  for (const modelId of allModelIds) {
    const asset = cache.get(modelId);
    assert.ok(asset?.vertices?.length > 0, `${modelId} has valid 3D mesh vertices`);
    const rt = asset.model.runtime;
    const ship = {
      id: `battle-${modelId}`,
      modelId,
      model: asset.model,
      length: rt.length,
      beam: rt.beam,
      x: 0,
      z: 0,
      heave: 0,
      heading: 0,
      roll: 0,
      pitch: 0,
      sailFore: 1,
      sailMain: 1,
      sailMizzen: 1,
      cargoTonnes: 0,
    };
    ship.hydrodynamics = boatHydrodynamics(rt.length, rt.beam, 30, 0, modelId);

    // 1. Every vessel model initializes naval battle gunnery and can fire a starboard broadside
    const shotsFired = [];
    const gunnery = createShipGunnery(ship, {
      onEvent: (ev) => {
        if (ev.type === 'shot') shotsFired.push(ev);
      },
    });
    assert.ok(gunnery.state.guns.length >= 2, `${modelId} mounts port and starboard broadside guns`);
    for (const g of gunnery.state.guns) {
      if (g.visibleCrew) {
        ship.gunneryAttendance ??= new Set();
        ship.gunneryAttendance.add(g.id);
      }
    }
    gunnery.readyAtQuarters('starboard');
    assert.equal(gunnery.fire('starboard'), true, `${modelId} accepts fire('starboard') order`);
    for (let step = 0; step < 30; step++) {
      gunnery.update(0.2, [0, 0, 0]);
    }
    assert.ok(shotsFired.length >= 1, `${modelId} fires broadside projectiles (${shotsFired.length} fired)`);

    // 2. Sweep & apply hull impact damage + 3D vertex deformation on this model
    const sweepHit = sweepShipSegment([rt.beam * 2, 0.25, 0], [-rt.beam * 2, 0.25, 0], 0.08, ship);
    assert.ok(sweepHit && sweepHit.hitZone === 'hull', `sweepShipSegment intersects ${modelId} hull`);

    const hullRep = applyShipImpactDamage(ship, {
      ...sweepHit,
      ammo: 'round',
      waterline: true,
      position: sweepHit.localPosition,
      surfacePosition: sweepHit.localPosition,
      velocity: [-410, -5, 0],
      mass: 10.8,
      radius: 0.10,
      energy: 0.5 * 10.8 * 410 * 410,
    });
    assert.equal(hullRep.penetratedOuter, true, `Heavy roundshot penetrates ${modelId} outer hull planking`);
    assert.ok(hullRep.breaches >= 1, `${modelId} records waterline breach`);

    if ((asset.model.rig?.sails?.length ?? 0) > 0) {
      const rigRep = applyShipImpactDamage(ship, {
        ammo: 'chain',
        hitZone: 'rigging',
        mastGroup: 'main',
        localPosition: [0, rt.length * 0.45, 0],
        position: [0, rt.length * 0.45, 0],
        velocity: [-310, 0, 0],
        mass: 5.4,
        energy: 110000,
      });
      assert.ok(rigRep.sailRips >= 1, `${modelId} records sail rip under chain shot`);
    }

    const workMesh = new Float32Array(asset.vertices);
    const dirty = bakeVesselImpactDeformations(workMesh, ship.damage.pendingBakes.splice(0), 9);
    assert.ok(dirty && dirty.byteLength > 0, `bakeVesselImpactDeformations deforms ${modelId} 3D mesh`);
  }
});

test('cannon shot extrapolates to stone, masonry, and wooden land structures with material-specific penetration, hot-shot fires, Polvorín magazine detonation, 3D mesh craters, and shore battery return fire', async () => {
  const { boatHydrodynamics } = await import('../js/boat.js');
  const region = resolveGlobalCoastalRegion({
    id: 'cartagena',
    name: 'Cartagena',
    latitude: 10.423,
    longitude: -75.548,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
  });
  const heights = synthesizeCoastalTerrain(region);
  const port = placeCoastalPort(region, heights);
  assert.ok(port && port.instances.length >= 6, 'Coastal port places stone, masonry, and wooden structures');
  const portGeom = buildPortPrefabGeometry(port);
  assert.ok(portGeom.vertices.length > 0, 'buildPortPrefabGeometry generates 3D port building vertices');

  const bastion = port.instances.find((i) => i.prefabId === 'stone_sea_bastion');
  const fortress = port.instances.find((i) => i.prefabId === 'bastion_trace_fortress');
  const pier = port.instances.find((i) => i.prefabId === 'timber_mole_pier');
  const warehouse = port.instances.find((i) => i.prefabId === 'casa_de_contratacion' || i.prefabId === 'royal_warehouse');
  assert.ok(bastion && fortress && pier && warehouse, 'Port contains stone bastion, trace fortress, timber mole pier, and masonry building');

  // 1. Material classification & penetration resistance (fortified stone vs masonry vs timber)
  assert.equal(classifyBuildingMaterial(bastion), 'fortified-stone');
  assert.equal(classifyBuildingMaterial(fortress), 'fortified-stone');
  assert.equal(classifyBuildingMaterial(pier), 'timber');
  assert.equal(classifyBuildingMaterial(warehouse), 'masonry');

  // Medium 120 kJ shot penetrates timber pier, does NOT penetrate fortified stone bastion wall
  const medPierRep = applyBuildingImpactDamage(pier, {
    ammo: 'round',
    localPosition: [0, 1.0, 0],
    position: [pier.x, (pier.baseY ?? 0) + 1.0, pier.z],
    normal: [0, 0, 1],
    velocity: [0, 0, -210],
    mass: 5.4,
    energy: 120000,
  });
  const medBastionRep = applyBuildingImpactDamage(bastion, {
    ammo: 'round',
    localPosition: [2.0, 2.0, -bastion.depth * 0.5],
    position: [bastion.x + 2.0, (bastion.baseY ?? 0) + 2.0, bastion.z - bastion.depth * 0.5],
    normal: [0, 0, -1],
    velocity: [0, 0, 210],
    mass: 5.4,
    energy: 120000,
  });
  assert.equal(medPierRep.penetratedOuter, true, '120 kJ roundshot penetrates timber mole pier');
  assert.equal(medBastionRep.penetratedOuter, false, '120 kJ roundshot does not breach thick fortified stone bastion wall');

  // Heavy 32-pdr point-blank roundshot (1.25 MJ) breaches fortified stone bastion
  const heavyBastionRep = applyBuildingImpactDamage(bastion, {
    ammo: 'round',
    localPosition: [1.5, 2.2, -bastion.depth * 0.5],
    position: [bastion.x + 1.5, (bastion.baseY ?? 0) + 2.2, bastion.z - bastion.depth * 0.5],
    normal: [0, 0, -1],
    velocity: [0, 0, 415],
    mass: 14.5,
    energy: 1250000,
  });
  assert.equal(heavyBastionRep.penetratedOuter, true, 'Heavy 32-pdr roundshot breaches fortified stone bastion');

  // 2. Hot shot ignites wooden structures with high intensity and burns them over time
  const hotPierRep = applyBuildingImpactDamage(pier, {
    ammo: 'hot',
    localPosition: [0, 1.2, 1.0],
    position: [pier.x, (pier.baseY ?? 0) + 1.2, pier.z + 1.0],
    normal: [0, 0, 1],
    velocity: [0, 0, -320],
    mass: 10.8,
    energy: 550000,
  });
  assert.ok(hotPierRep.fires >= 1 && hotPierRep.fireIntensity > 0.8, 'Hot shot ignites timber mole pier with high fire intensity');
  const pierIntegrityBeforeBurn = pier.damageState.integrity;
  stepBuildingDamage(pier, 2.0);
  assert.ok(pier.damageState.integrity < pierIntegrityBeforeBurn, 'Active timber fire progressively burns down wooden structure');
  assert.ok(pier.damageState.worldFires.length >= 1, 'Burning building emits world-space fire/smoke plumes');

  // 3. Polvorín (fort powder magazine) detonation when struck by penetrating round/hot shot
  createBuildingMagazineState(fortress);
  assert.ok(fortress.magazine.initialPowderKg > 10000, 'Bastion trace fortress Polvorín stores >10,000 kg of black powder');
  const polvorinRep = applyBuildingImpactDamage(fortress, {
    ammo: 'hot',
    hitPartId: 'bastion_trace_fortress:polvorin_magazine',
    hitSubAssembly: 'roofs-and-superstructure',
    localPosition: [0, fortress.height + 0.5, fortress.depth * 0.16],
    position: [fortress.x, (fortress.baseY ?? 0) + fortress.height + 0.5, fortress.z + fortress.depth * 0.16],
    normal: [0, 1, 0],
    velocity: [0, -280, 220],
    mass: 14.5,
    energy: 920000,
  });
  assert.equal(polvorinRep.magazineHit, true, 'Strike on fortress Polvorín registers magazineHit');
  assert.equal(polvorinRep.magazineExploded, true, 'Penetrating hot shot detonates the fortress Polvorín magazine');
  assert.ok(polvorinRep.magazineExplosionYieldMj > 30000, 'Polvorín explosion releases >30,000 MJ of blast energy');
  assert.ok(fortress.damageState.dismountedGuns >= 4, 'Polvorín explosion dismounts fortress embrasure cannons');

  // 4. 3D vertex deformation on stone and wooden port structures
  const portVertsCopy = new Float32Array(portGeom.vertices);
  const allBuildingBakes = [
    ...bastion.damageState.pendingBakes.splice(0),
    ...pier.damageState.pendingBakes.splice(0),
    ...fortress.damageState.pendingBakes.splice(0),
  ];
  assert.ok(allBuildingBakes.some((b) => b.kind === 'stone-crater'), 'Queues stone-crater 3D bake');
  assert.ok(allBuildingBakes.some((b) => b.kind === 'timber-splinter'), 'Queues timber-splinter 3D bake');
  assert.ok(allBuildingBakes.some((b) => b.kind === 'building-explosion'), 'Queues building-explosion 3D bake');
  const dirtyBuildingRange = bakeBuildingImpactDeformations(portVertsCopy, allBuildingBakes, 8);
  assert.ok(dirtyBuildingRange && dirtyBuildingRange.byteLength > 0, 'bakeBuildingImpactDeformations deforms 3D port building vertices');

  // 5. Shore battery gunnery & return fire against an offshore warship
  const freshBastion = {
    ...bastion,
    id: 'test-shore-bastion',
    x: 0,
    z: 0,
    baseY: 2.0,
    yaw: 0,
    width: 16,
    depth: 14,
    height: 6.5,
    damageState: null,
    magazine: null,
  };
  const attackingShip = {
    id: 'invading-frigate',
    modelId: 'victory',
    length: 56,
    beam: 15,
    x: 0,
    z: -110,
    heave: 0,
    heading: 90,
    roll: 0,
    pitch: 0,
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
    cargoTonnes: 0,
  };
  attackingShip.hydrodynamics = boatHydrodynamics(56, 15, 30, 0, 'victory');

  const shoreHitsOnShip = [];
  const shoreBattery = createBuildingGunnery(freshBastion, {
    getVessels: () => [attackingShip],
    onEvent: (ev) => {
      if (ev.type === 'impact' && ev.kind === 'ship') shoreHitsOnShip.push(ev);
    },
  });
  assert.equal(shoreBattery.state.guns.length, 5, 'Stone sea bastion mounts 5 heavy 24-pdr embrasure cannons');

  const queuedReturnShots = shoreBattery.fireAtTarget(attackingShip, { ammo: 'hot' });
  assert.ok(queuedReturnShots >= 3, 'Shore battery aims and queues seaward embrasure guns at attacking ship');
  for (let step = 0; step < 40; step++) {
    shoreBattery.update(0.05, [0, 0, 0]);
  }
  assert.ok(shoreHitsOnShip.length >= 1, 'Shore battery return fire strikes the offshore warship');
  assert.ok((attackingShip.damage?.hits ?? 0) >= 1, 'Offshore warship receives hull/rig impact damage from shore battery');
  assert.ok((attackingShip.damage?.fires?.length ?? 0) >= 1, 'Shore battery hot shot ignites fire aboard the attacking ship');
});

test('all 9 ship models have complete part attribution, superstructure classification, and model-accurate superstructure/mast damage', () => {
  const assetCache = createShipAssetCache();
  for (const modelId of Object.keys(SHIP_MODELS)) {
    const asset = assetCache.get(modelId);
    const catalog = asset.partAssembly;
    const partMap = new Map(catalog.parts.map((p) => [p.id, p]));
    assert.equal(partMap.has('hull.structure'), false, `${modelId} should have zero unattributed fallback triangles`);

    for (const p of catalog.parts) {
      if (p.id.startsWith('spar.')) {
        assert.equal(p.subAssembly, 'masts-and-spars', `${modelId}:${p.id} should be masts-and-spars`);
        assert.equal(p.isMoving, true, `${modelId}:${p.id} should be marked moving`);
      }
      if (p.id.startsWith('fitting.')) {
        assert.equal(p.subAssembly, 'rigging-and-sails', `${modelId}:${p.id} should be rigging-and-sails`);
      }
      if (p.id.startsWith('rowing.propulsor.')) {
        assert.equal(p.subAssembly, 'ordnance-and-helm', `${modelId}:${p.id} should be ordnance-and-helm`);
        assert.equal(p.isMoving, true, `${modelId}:${p.id} should be marked moving`);
      }
      if (p.id === 'rowing.benches') {
        assert.equal(p.subAssembly, 'decks-and-interior', `${modelId}:${p.id} should be decks-and-interior`);
      }
      if (p.id === 'cabin' || p.id.startsWith('structure.') || p.id === 'stern.windows' || p.id.startsWith('stern.gallery')) {
        assert.equal(p.superstructure, true, `${modelId}:${p.id} should be flagged as superstructure`);
      }
    }
  }

  // Verify newly attributed parts on Victory, Flying Cloud, and Gipsy Moth IV
  const victoryParts = new Map(assetCache.get('victory').partAssembly.parts.map((p) => [p.id, p]));
  assert.ok(victoryParts.has('bow.bowsprit'), 'Victory should have attributed bow.bowsprit part');
  assert.ok(victoryParts.has('anchor.cathead.port') && victoryParts.has('anchor.cathead.starboard'), 'Victory should have attributed cathead parts');

  const cloudParts = new Map(assetCache.get('flying-cloud').partAssembly.parts.map((p) => [p.id, p]));
  assert.ok(cloudParts.has('helm.pedestal'), 'Flying Cloud should have attributed helm.pedestal part');
  assert.equal(cloudParts.get('helm.pedestal').isMoving, false, 'helm.pedestal must remain stationary when wheel turns');
  assert.equal(cloudParts.get('structure.deckhouse').superstructure, true, 'Flying Cloud deckhouse is superstructure');

  // Verify superstructure parts do NOT vanish into thin air under syncVesselDamage
  const cloudState = createPartAssemblyState(assetCache.get('flying-cloud').partAssembly);
  cloudState.syncVesselDamage({
    partDamage: {
      'structure.deckhouse': 0.95,
      'hull.closure.stern': 0.95,
    },
  });
  assert.equal(cloudState.evaluatePartPose('structure.deckhouse').visible, true, 'Damaged deckhouse superstructure must not vanish');
  assert.equal(cloudState.evaluatePartPose('hull.closure.stern').visible, true, 'Damaged stern closure must not vanish');

  // Verify Santa Maria mast-break only rotates the broken mast's sails, not other masts' sails
  const smAsset = assetCache.get('santa-maria');
  const smOrig = smAsset.vertices;
  const smMesh = new Float32Array(smOrig);
  bakeVesselImpactDeformations(
    smMesh,
    [{ kind: 'mast-break', modelId: 'santa-maria', mastGroup: 'fore', stage: 'full', side: 1, pivotY: 1.65, pivotZ: -3.55 }],
    9
  );
  let foreMoved = 0;
  let mainCourseMoved = 0;
  for (let v = 0, n = smMesh.length / 9; v < n; v++) {
    const off = v * 9;
    const rawMat = smOrig[off + 6];
    const mat = Math.floor(rawMat);
    const sailId = Math.round((rawMat - mat) * 64);
    const moved = Math.hypot(smMesh[off] - smOrig[off], smMesh[off + 1] - smOrig[off + 1], smMesh[off + 2] - smOrig[off + 2]) > 0.05;
    if (mat === 9 && sailId === 1 && moved) foreMoved++;
    if (mat === 9 && sailId === 2 && moved) mainCourseMoved++;
  }
  assert.ok(foreMoved > 20, 'Breaking Santa Maria foremast topples fore-course sail');
  assert.equal(mainCourseMoved, 0, 'Breaking Santa Maria foremast must not detach main-course sail');

  // Verify non-Victory stern window shatter & centerline deckhouse superstructure impact
  const smShip = {
    id: 'test-santa-maria',
    modelId: 'santa-maria',
    length: 28.3,
    beam: 8.9,
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    roll: 0,
    pitch: 0,
  };
  const smWinRep = applyShipImpactDamage(smShip, {
    hitZone: 'hull',
    hitPartId: 'stern.windows',
    hitSubAssembly: 'hull-and-bulwarks',
    localPosition: [0.2, 3.6, 13.8],
    position: [0.2, 3.6, 13.8],
    surfacePosition: [0.2, 3.6, 13.8],
    velocity: [0, 0, -360],
    mass: 8.0,
    energy: 0.5 * 8.0 * 360 * 360,
  });
  assert.equal(smWinRep.enteredThroughWindow, true, 'Santa Maria stern window hit registers enteredThroughWindow');
  assert.equal(smWinRep.isSuperstructure, true, 'Santa Maria stern window hit is classified as superstructure');
  assert.ok(smWinRep.superstructureIntegrity < 1, 'Superstructure integrity decreases on superstructure hit');
  assert.ok(smShip.damage.pendingBakes.some((b) => b.kind === 'window-shatter'), 'Non-Victory window hit queues window-shatter bake');

  // Centerline deckhouse hit on Flying Cloud deforms vertices even when |x| < 0.22
  const cloudMesh = new Float32Array(assetCache.get('flying-cloud').vertices);
  const cloudOrig = assetCache.get('flying-cloud').vertices;
  const centerBake = bakeVesselImpactDeformations(
    cloudMesh,
    [{ kind: 'superstructure', modelId: 'flying-cloud', x: 0.05, y: 0.85, z: -1.35, side: 1, radius: 0.35, stepDepth: 0.25, severity: 0.9, hits: 1 }],
    9
  );
  assert.ok(centerBake && centerBake.byteLength > 0, 'Centerline deckhouse superstructure hit deforms mesh vertices');
  let deformedCenterVerts = 0;
  for (let v = centerBake.minVertex; v <= centerBake.maxVertex; v++) {
    const off = v * 9;
    if (Math.abs(cloudOrig[off]) < 0.22 && Math.hypot(cloudMesh[off] - cloudOrig[off], cloudMesh[off + 1] - cloudOrig[off + 1], cloudMesh[off + 2] - cloudOrig[off + 2]) > 0.01) {
      deformedCenterVerts++;
    }
  }
  assert.ok(deformedCenterVerts > 0, 'Centerline superstructure vertices (|x| < 0.22) deform on impact');
});





