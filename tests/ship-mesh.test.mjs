import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { requirePlayableShipModel } from '../js/ship-models.js';
import { RIG_LINES } from '../js/lateen.js';
import {createVictoryMesh} from '../js/victory.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// A refactor must not alter triangle order, signed zero, UV seams, normals, materials or
// geometry. Refrozen once, for 86873b3, which moved the standing rigging to the hounds below
// the raised crow's nest: a group-by-group comparison with the mesh before it shows the three
// masts changed (hound band added, hoops respaced) and the 37 standing lines and the fore
// halyard moved to their new heads; the other 73 groups are byte-identical.
const NINA_MESH_BASELINE = {
  raw: 'eec22571f9375354b20183a99316e171b212ddaad6e8ffeb73f5b48682d2dbac',
  indexed: '9fccbfc6bb77ff55fc64e9bcc4894e3b78cbc2600e048b712656f91380bf43b5',
  indices: 'cdb2b3f8ade681ef5a444713a158a108adc5f5934fb7a1fba2974f2df2dca744',
};

test('shared construction primitives preserve Victory geometry, material seams and semantic ranges',()=>{
  const groups=[],raw=createVictoryMesh({groups}),{vertices,indices}=indexCaravelMesh(raw);
  // Refrozen for two deliberate changes, found by comparing groups with the mesh before each:
  // c4a11c2 gave the running lines four segments in place of two so their wave modes can bend
  // (rig.running, 2016 to 4032 vertices); and the mast trunks, topmasts, topgallant masts,
  // bowsprit and jibboom now carry the spar material 10 in place of general trim 1 (no vertex
  // moved), so the shader knows a spar by its material. Those are rig.running, the six mast
  // groups and bow.bowsprit with its parent bow.structure; the other 424 groups are byte-identical.
  assert.equal(sha(raw),'8a0b62210b807ea99253fbfc91bc5454403dd857f38dfa67e6c0c8e169bf1b7b');
  assert.equal(sha(vertices),'b0b1dd045e813c9e6ef7b74cd2f5a2ba26a130ea980b7357dbaeaf0c15e31c71');
  assert.equal(sha(indices),'cbf63a7f904b3edf95ce7e97736ae615245b9eb51fee05c78abb7512a7c6e5bb');
  assert.equal(groups.length,433);
  assert.equal(new Set(groups.map(g=>g.id)).size,groups.length);
  for(const g of groups){
    assert.ok(g.firstVertex>=0&&g.vertexCount>0&&g.firstVertex+g.vertexCount<=indices.length,g.id);
    assert.equal(g.firstVertex%3,0);assert.equal(g.vertexCount%3,0);
  }
});

test('semantic mesh groups preserve every pre-refactor vertex and legacy inspection part', () => {
  const groups = [], parts = new Map(), legacyParts = new Map();
  const raw = createCaravelMesh({ groups, parts }), legacy = createCaravelMesh({ parts: legacyParts });
  const indexed = indexCaravelMesh(raw);
  assert.equal(sha(raw), NINA_MESH_BASELINE.raw);
  assert.equal(sha(indexed.vertices), NINA_MESH_BASELINE.indexed);
  assert.equal(sha(indexed.indices), NINA_MESH_BASELINE.indices);
  assert.deepEqual(raw, legacy); assert.deepEqual(parts, legacyParts);
  assert.equal(parts.size, 25, 'legacy part tags remain unchanged');
});

test('semantic groups name real triangle ranges, structure points and rig components', () => {
  const groups = [], raw = createCaravelMesh({ groups }), model = requirePlayableShipModel('nina');
  assert.equal(new Set(groups.map(group => group.id)).size, groups.length, 'group IDs are unique');
  for (const group of groups) {
    assert.ok(model.nodes[group.nodeId], `known structural node for ${group.id}`);
    assert.ok(Number.isInteger(group.firstVertex) && group.firstVertex >= 0);
    assert.ok(Number.isInteger(group.vertexCount) && group.vertexCount > 0);
    assert.equal(group.firstVertex % 3, 0); assert.equal(group.vertexCount % 3, 0);
    assert.ok(group.firstVertex + group.vertexCount <= raw.length / 9);
  }
  const find = id => { const group = groups.find(group => group.id === id); assert.ok(group, id); return group; };
  for (const id of ['hull', 'deck.main.planks', 'deck.main.bed', 'helm.tiller', 'helm.rudder', 'transom', 'cabin', 'stairs', 'anchor:spare', 'anchor:cathead:-1', 'anchor:cathead:1']) find(id);
  assert.equal(find('helm.tiller').motion.type, 'tiller');
  for (const mast of ['fore', 'main', 'mizzen']) {
    assert.equal(find(`mast.${mast}`).nodeId, `mast.${mast}`);
    assert.equal(find(`sail.${mast}.canvas`).nodeId, `sail.${mast}`);
    assert.equal(find(`yard.${mast}`).motion.type, 'lateen-yard'); find(`sail.${mast}.edge`);
  }
  assert.equal(groups.filter(group => group.motion?.type === 'rig-rope').length, RIG_LINES.length);
  for (const [i, line] of RIG_LINES.entries()) assert.equal(find(`rope.${i}.${line.kind}`).motion.line, i);
  const cabin = find('cabin'), afterdeck = find('deck.quarter.planks');
  assert.ok(afterdeck.firstVertex >= cabin.firstVertex && afterdeck.firstVertex + afterdeck.vertexCount <= cabin.firstVertex + cabin.vertexCount,
    'inspection ranges intentionally nest; they are not an exclusive partition');
});

test('indexed model assets share one cached mesh with preserved group index ranges', () => {
  const cache = createShipAssetCache(), asset = cache.get();
  assert.equal(cache.get('nina'), asset); assert.equal(asset.model, requirePlayableShipModel('nina'));
  assert.ok(Object.isFrozen(asset) && Object.isFrozen(asset.groups) && Object.isFrozen(asset.groups[0]));
  const raw = createCaravelMesh();
  // Her indexed model is frozen. Fracture only appends to it: shard copies and the cuts in her masts.
  const indexed = indexCaravelMesh(raw);
  assert.equal(sha(indexed.vertices), NINA_MESH_BASELINE.indexed);
  assert.equal(sha(indexed.indices), NINA_MESH_BASELINE.indices);
  assert.equal(sha(asset.vertices.subarray(0, indexed.vertices.length)), NINA_MESH_BASELINE.indexed, 'every original vertex keeps its bytes');
  for (const group of asset.groups) {
    // Cut masts have new corners, and their cut pieces follow the original stream.
    if (group.id.startsWith('mast.')) continue;
    // Indexing retains the original triangle stream, so a group's raw vertex
    // range is the exact drawIndexed range after deduplication.
    for (const i of [group.firstVertex, group.firstVertex + group.vertexCount - 1]) {
      const offset = asset.indices[i] * 9;
      assert.deepEqual(asset.vertices.subarray(offset, offset + 9), raw.subarray(i * 9, i * 9 + 9));
    }
  }
  assert.notEqual(createShipAssetCache().get(), asset, 'cache lifetime belongs to the renderer');
});

test('additional ships receive independent geometry and mandatory GPU data; unknown ships fail', () => {
  const cache = createShipAssetCache();
  for (const id of ['pinta', 'santa-maria']){
    const asset=cache.get(id);assert.equal(asset.model.id,id);assert.equal(cache.get(id),asset);
    assert.notEqual(typeof asset.pose,'function');assert.equal(asset.gpuPose,true);
    assert.notEqual(sha(asset.vertices),NINA_MESH_BASELINE.indexed);
  }
  assert.throws(() => cache.get('unknown-ship'));
  assert.equal(cache.get().model.id, 'nina');
});

test('masts, mast trunks and bowsprits are built in the spar material, so the shader need not guess one from trim', () => {
  const cache = createShipAssetCache();
  const materialsOf = (asset, group) => {
    const found = new Set();
    for (let i = group.firstVertex; i < group.firstVertex + group.vertexCount; i++) found.add(Math.floor(asset.vertices[asset.indices[i] * 9 + 6]));
    return found;
  };
  for (const id of ['nina', 'victory', 'pinta', 'santa-maria', 'oseberg', 'lusoria']) {
    const asset = cache.get(id);
    const spars = asset.groups.filter(g => /^mast\.[a-z]+$/.test(g.id) || g.id.startsWith('mast.trunk.') || g.id === 'bow.bowsprit');
    assert.ok(spars.some(g => g.id.startsWith('mast.')), id + ' has masts');
    for (const group of spars) assert.ok(materialsOf(asset, group).has(10), `${id} ${group.id} carries the spar material`);
  }
  // Groups that are nothing but the timber itself hold no general trim at all.
  for (const [id, whole] of [['victory', ['mast.trunk.fore', 'mast.trunk.main', 'mast.trunk.mizzen']], ['oseberg', ['mast.main']], ['lusoria', ['mast.main']]]) {
    const asset = cache.get(id);
    for (const name of whole) assert.deepEqual([...materialsOf(asset, asset.groups.find(g => g.id === name))], [10], `${id} ${name}`);
  }
  // Victory's bowsprit and jibboom, and the caravels' bowsprits, are spars with painted or served bands.
  for (const id of ['victory', 'pinta', 'santa-maria']) {
    const asset = cache.get(id);
    assert.ok(!materialsOf(asset, asset.groups.find(g => g.id === 'bow.bowsprit')).has(1), id + ' bowsprit holds no general trim');
  }
});
