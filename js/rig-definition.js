// Declarative rig contracts are independent of meshes, physics and GPU state.
// A planned rig describes attachment requirements; it cannot enable a backend.
export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function validateRigDefinition(rig, nodes, { planned = false } = {}) {
  const errors = [], record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const name = value => typeof value === 'string' && value.trim().length > 0;
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  if (!record(rig)) return ['rig: expected an object'];
  if (!record(nodes)) return ['nodes: expected a node map'];
  const reference = (value, path) => {
    if (!name(value)) fail(path, 'expected a node ID');
    else if (!Object.hasOwn(nodes, value)) fail(path, `unknown node ${value}`);
  };
  const list = (value, path) => {
    if (!Array.isArray(value)) { fail(path, 'expected an array'); return []; }
    return value;
  };
  const uniqueIDs = (items, path) => {
    const ids = new Set();
    items.forEach((item, i) => {
      if (!record(item)) { fail(`${path}[${i}]`, 'expected an object'); return; }
      if (!name(item.id)) fail(`${path}[${i}].id`, 'expected an ID');
      else if (ids.has(item.id)) fail(`${path}[${i}].id`, `duplicate ID ${item.id}`);
      else ids.add(item.id);
    });
    return ids;
  };

  if (!name(rig.id)) fail('rig.id', 'expected an ID');
  if (!name(rig.backend)) fail('rig.backend', 'expected a backend ID');
  else if (!planned && !['lateen3','square1805','surfaces-v1'].includes(rig.backend)) fail('rig.backend', `${rig.backend} is not a ready runtime backend`);

  const nodeIDs = new Set();
  for (const [key, node] of Object.entries(nodes)) {
    const path = `nodes.${key}`;
    if (!name(key)) fail(path, 'expected a node ID');
    if (!record(node)) { fail(path, 'expected an object'); continue; }
    if (node.id !== key) fail(`${path}.id`, 'must match the map key');
    if (name(node.id)) {
      if (nodeIDs.has(node.id)) fail(`${path}.id`, `duplicate ID ${node.id}`);
      nodeIDs.add(node.id);
    }
    if (!['frame', 'attachment', 'station', 'part'].includes(node.kind)) fail(`${path}.kind`, 'unknown node kind');
    if (node.parent !== null) reference(node.parent, `${path}.parent`);
    if (!(planned && node.position === null) && !(Array.isArray(node.position) && node.position.length === 3 && node.position.every(Number.isFinite))) {
      fail(`${path}.position`, planned ? 'expected a finite XYZ position or null' : 'expected a resolved finite XYZ position');
    }
    if (node.motion !== undefined && (!record(node.motion) || !name(node.motion.type))) fail(`${path}.motion`, 'expected a motion object with a type');
  }
  // Parent chains are structural transforms, so even a planned graph must be a DAG.
  const visited = new Set();
  for (const start of Object.keys(nodes)) {
    const chain = new Set();
    let id = start;
    while (id !== null && Object.hasOwn(nodes, id) && record(nodes[id]) && !visited.has(id)) {
      if (chain.has(id)) { fail(`nodes.${id}.parent`, 'parent cycle'); break; }
      chain.add(id); id = nodes[id].parent;
    }
    for (const id of chain) visited.add(id);
  }

  const masts = list(rig.masts, 'rig.masts'), sails = list(rig.sails, 'rig.sails');
  const fittings = list(rig.fittings, 'rig.fittings');
  const mastIDs = uniqueIDs(masts, 'rig.masts');
  uniqueIDs(sails, 'rig.sails'); uniqueIDs(fittings, 'rig.fittings');
  if (!masts.length && (rig.backend!=='surfaces-v1'||sails.length)) fail('rig.masts', 'requires at least one mast');
  if (!sails.length && rig.backend!=='surfaces-v1') fail('rig.sails', 'requires at least one sail');
  masts.forEach((mast, i) => {
    if (!record(mast)) return;
    for (const key of ['node', 'headNode', 'climbNode']) reference(mast[key], `rig.masts[${i}].${key}`);
  });
  sails.forEach((sail, i) => {
    if (!record(sail)) return;
    const path = `rig.sails[${i}]`;
    if (!mastIDs.has(sail.mast)) fail(`${path}.mast`, `unknown mast ${sail.mast}`);
    if (!['lateen', 'square','headsail','gaff'].includes(sail.kind)) fail(`${path}.kind`, 'unknown sail kind');
    if (!name(sail.controlGroup)) fail(`${path}.controlGroup`, 'expected a control group ID');
    if (rig.backend==='surfaces-v1' && !['fore','main','mizzen'].includes(sail.controlGroup)) fail(`${path}.controlGroup`, 'surfaces-v1 requires a supported canvas control group');
    if (rig.backend==='surfaces-v1' && (!Number.isInteger(sail.surfaceId)||sail.surfaceId<1)) fail(`${path}.surfaceId`, 'requires a positive authored surface ID');
    reference(sail.yardNode, `${path}.yardNode`);
    const clews = list(sail.clewNodes, `${path}.clewNodes`);
    const expected = ['lateen','headsail','gaff'].includes(sail.kind) ? 1 : sail.kind === 'square' ? 2 : 0;
    if (expected && clews.length !== expected) fail(`${path}.clewNodes`, `${sail.kind} requires ${expected} free clew node${expected === 1 ? '' : 's'}`);
    if (new Set(clews).size !== clews.length) fail(`${path}.clewNodes`, 'duplicate clew nodes');
    clews.forEach((id, j) => reference(id, `${path}.clewNodes[${j}]`));
  });
  if(rig.backend==='surfaces-v1' && new Set(sails.map(s=>s?.surfaceId)).size!==sails.length)fail('rig.sails','duplicate authored surface IDs');
  fittings.forEach((fitting, i) => {
    if (!record(fitting)) return;
    if (!name(fitting.kind)) fail(`rig.fittings[${i}].kind`, 'expected a fitting kind');
    reference(fitting.node, `rig.fittings[${i}].node`);
    if (fitting.mast !== undefined && !mastIDs.has(fitting.mast)) fail(`rig.fittings[${i}].mast`, `unknown mast ${fitting.mast}`);
    if (fitting.kind === 'crows-nest' && !mastIDs.has(fitting.mast)) fail(`rig.fittings[${i}].mast`, 'a crows nest requires a mast');
  });

  if (!planned && rig.backend === 'lateen3') {
    if (masts.length !== 3) fail('rig.masts', 'lateen3 requires exactly three masts');
    if (sails.length !== 3) fail('rig.sails', 'lateen3 requires exactly three sails');
    if (sails.some(sail => sail?.kind !== 'lateen')) fail('rig.sails', 'lateen3 supports only lateen sails');
    for (const id of ['fore', 'main', 'mizzen']) {
      if (!mastIDs.has(id)) fail('rig.masts', `lateen3 requires the ${id} mast`);
      if (sails.filter(sail => sail?.controlGroup === id).length !== 1) fail('rig.sails', `lateen3 requires exactly one ${id} control group`);
      if (sails.filter(sail => sail?.mast === id).length !== 1) fail('rig.sails', `lateen3 requires exactly one sail on the ${id} mast`);
    }
    for (const sail of sails) if (record(sail) && sail.controlGroup !== sail.mast) fail('rig.sails', 'lateen3 control groups must match their mast IDs');
  }
  return errors;
}

// Freeze the rig only; its node map belongs to the containing model definition.
export function defineRig(rig, nodes, options) {
  const errors = validateRigDefinition(rig, nodes, options);
  if (errors.length) throw new Error(`Invalid rig definition:\n${errors.join('\n')}`);
  return deepFreeze(rig);
}
