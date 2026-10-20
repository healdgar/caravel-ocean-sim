import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { requirePlayableShipModel } from '../js/ship-models.js';
import { RIG_LINES } from '../js/lateen.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Recorded before introducing semantic groups. This refactor must not alter
// triangle order, signed zero, UV seams, normals, materials or geometry.
const NINA_MESH_BASELINE = {
  raw: '521800c648cb0591d572a633524af5b580ca68000cf0869bfd3a1244aeb5b483',
  indexed: 'a1638b17eb538d07fb77109b9bbe3f9c8df217987659bf565d341c4c25ef4166',
  indices: '9495a5d4937b34ce7a964c6bc9d3fbcc2caa5794f6dc165af6e389971a132516',
};

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
  assert.equal(sha(asset.vertices), NINA_MESH_BASELINE.indexed);
  assert.equal(sha(asset.indices), NINA_MESH_BASELINE.indices);
  assert.ok(Object.isFrozen(asset) && Object.isFrozen(asset.groups) && Object.isFrozen(asset.groups[0]));
  const raw = createCaravelMesh();
  for (const group of asset.groups) {
    // Indexing retains the original triangle stream, so a group's raw vertex
    // range is the exact drawIndexed range after deduplication.
    for (const i of [group.firstVertex, group.firstVertex + group.vertexCount - 1]) {
      const offset = asset.indices[i] * 9;
      assert.deepEqual(asset.vertices.subarray(offset, offset + 9), raw.subarray(i * 9, i * 9 + 9));
    }
  }
  assert.notEqual(createShipAssetCache().get(), asset, 'cache lifetime belongs to the renderer');
});

test('planned or unknown ships cannot silently receive the Niña geometry', () => {
  const cache = createShipAssetCache();
  for (const id of ['pinta', 'santa-maria', 'unknown-ship']) assert.throws(() => cache.get(id));
  assert.equal(cache.get().model.id, 'nina');
});
