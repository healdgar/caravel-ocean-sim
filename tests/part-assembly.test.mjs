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
} from '../js/coastal-world.js';
import {
  sweepShipSegment,
  applyShipImpactDamage,
  sweepBuildingSegment,
  applyBuildingImpactDamage,
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

test('all 20 1550 port building prefabs expose hierarchical part-assembly catalogs across structural layers', () => {
  const prefabIds = Object.keys(PORT_PREFABS);
  assert.equal(prefabIds.length, 20);
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
