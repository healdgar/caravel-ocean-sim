import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepFreeze, defineRig, validateRigDefinition } from '../js/rig-definition.js';

function rigFixture({ planned = false, square = false } = {}) {
  const nodes = { hull: { id: 'hull', parent: null, kind: 'frame', position: [0, 0, 0] } };
  const rig = { id: 'fixture', backend: square ? 'square-mixed-planned' : 'lateen3', masts: [], sails: [], fittings: [] };
  for (const id of ['fore', 'main', 'mizzen']) {
    const mast = `mast.${id}`, kind = square && id !== 'mizzen' ? 'square' : 'lateen';
    const add = (name, parent, type, motion) => {
      nodes[name] = { id: name, parent, kind: type, position: planned ? null : [0, 1, 0], ...(motion && { motion }) };
      return name;
    };
    rig.masts.push({ id, node: add(mast, 'hull', 'part'), headNode: add(`${mast}.head`, mast, 'attachment'), climbNode: add(`${mast}.runner`, mast, 'attachment') });
    rig.sails.push({ id: `${id}-course`, mast: id, kind, controlGroup: id,
      yardNode: add(`yard.${id}`, mast, 'part', { type: kind === 'lateen' ? 'lateen-yard' : 'square-yard' }),
      clewNodes: Array.from({ length: kind === 'square' ? 2 : 1 }, (_, i) => add(`sail.${id}.clew.${i}`, `yard.${id}`, 'attachment')) });
  }
  return { rig, nodes };
}

test('ready lateen rig validates and freezes definitions without owning mutable simulation state', () => {
  const { rig, nodes } = rigFixture();
  assert.deepEqual(validateRigDefinition(rig, nodes), []);
  assert.equal(defineRig(rig, nodes), rig);
  assert.ok(Object.isFrozen(rig) && Object.isFrozen(rig.sails) && Object.isFrozen(rig.sails[0].clewNodes));
  assert.throws(() => { rig.sails[0].mast = 'mizzen'; }, TypeError);
  assert.equal(Object.isFrozen(nodes), false, 'the model registry owns the node map');
  const cycle = {}; cycle.self = cycle;
  assert.equal(deepFreeze(cycle), cycle); assert.ok(Object.isFrozen(cycle));
});

test('planned square and optional mast fittings are declarative, never silently playable', () => {
  const { rig, nodes } = rigFixture({ planned: true, square: true });
  nodes['lookout.fore'] = { id: 'lookout.fore', parent: 'mast.fore', kind: 'station', position: null };
  rig.fittings.push({ id: 'lookout-top', kind: 'crows-nest', node: 'lookout.fore', mast: 'fore' });
  assert.deepEqual(validateRigDefinition(rig, nodes, { planned: true }), []);
  assert.equal(defineRig(rig, nodes, { planned: true }), rig);
  assert.ok(validateRigDefinition(rig, nodes).some(error => error.includes('not a ready runtime backend')));
  assert.ok(validateRigDefinition(rig, nodes).some(error => error.includes('resolved finite XYZ')));
});

test('rig validation catches missing attachments, cycles, duplicate IDs and invalid coordinates', () => {
  const { rig, nodes } = rigFixture();
  rig.masts[1].id = 'fore'; rig.sails[1].id = 'fore-course';
  rig.sails[0].yardNode = 'missing-yard'; rig.sails[0].mast = 'missing-mast';
  nodes.hull.parent = 'mast.fore'; nodes['mast.fore'].position[1] = NaN;
  nodes['mast.main'].id = 'mast.fore'; nodes['mast.mizzen'].motion = {};
  const errors = validateRigDefinition(rig, nodes);
  for (const fragment of ['duplicate ID fore', 'duplicate ID fore-course', 'unknown node missing-yard', 'unknown mast missing-mast', 'parent cycle', 'finite XYZ', 'must match the map key', 'motion object']) {
    assert.ok(errors.some(error => error.includes(fragment)), fragment);
  }
  assert.throws(() => defineRig(rig, nodes), /Invalid rig definition/);
});

test('backend guard rejects square cloth or extra sails on the lateen runtime layout', () => {
  const { rig, nodes } = rigFixture();
  rig.sails[0].kind = 'square';
  rig.sails[0].clewNodes.push('sail.main.clew.0');
  rig.sails.push({ ...rig.sails[1], id: 'main-topsail' });
  const errors = validateRigDefinition(rig, nodes);
  assert.ok(errors.some(error => error.includes('exactly three sails')));
  assert.ok(errors.some(error => error.includes('only lateen sails')));
  assert.ok(errors.some(error => error.includes('exactly one main control group')));
  assert.ok(errors.some(error => error.includes('exactly one sail on the main mast')));
  assert.deepEqual(validateRigDefinition(rig, nodes, { planned: true }), [], 'planned topology can contain multiple sails per mast');
});

test('malformed declarations return diagnostics rather than incidental type errors', () => {
  assert.deepEqual(validateRigDefinition(null, {}), ['rig: expected an object']);
  assert.deepEqual(validateRigDefinition({}, null), ['nodes: expected a node map']);
  const { rig, nodes } = rigFixture();
  rig.masts = [null]; rig.sails = [null]; rig.fittings = false;
  nodes.broken = { id: 'broken', kind: 'other', position: [0, Infinity, 0] };
  assert.doesNotThrow(() => validateRigDefinition(rig, nodes));
  assert.ok(validateRigDefinition(rig, nodes).some(error => error.includes('expected a node ID')));
});
