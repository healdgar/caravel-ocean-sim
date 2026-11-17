import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {readGLB, createSkinAnimator} from '../js/gltf.js';
import {CREW_JOINT_NAMES, CREW_JOINT_COUNT, CREW_JOINT_PARENTS, CREW_SLOT, CREW_FACE_JOINT_NAMES, CREW_REST_MALE_PLACES, CREW_REST_FEMALE_PLACES} from '../js/crew-skeleton.js';

const crewFile = (name) => new URL(`../assets/crew/${name}`, import.meta.url);
const skinned = readdirSync(new URL('../assets/crew/', import.meta.url)).filter((name) => name.endsWith('.glb') && name !== 'groom-pack.glb');

test('the runtime crew skeleton is the one the preparation scripts build: Unreal 5\'s 80 body joints and 13 face joints', () => {
  const python = JSON.parse(execFileSync('python3', ['-c', 'import json,sys; sys.path.insert(0,"scripts"); import crew_skeleton as s; print(json.dumps({"joints": s.JOINTS, "parents": [s.PARENT[n] for n in s.JOINTS], "face": s.FACE_JOINTS}))'], {cwd: new URL('..', import.meta.url)}).toString());
  assert.deepEqual([...CREW_JOINT_NAMES], python.joints);
  assert.deepEqual([...CREW_FACE_JOINT_NAMES], python.face);
  assert.deepEqual([...CREW_JOINT_PARENTS], python.parents.map((name) => (name ? CREW_SLOT[name] : -1)));
  assert.equal(CREW_JOINT_COUNT, 93);
  assert.equal(CREW_JOINT_NAMES.length - CREW_FACE_JOINT_NAMES.length, 80);
  for (const name of ['spine_05', 'neck_02', 'head', 'index_metacarpal_l', 'lowerarm_twist_01_r', 'calf_twist_02_l', 'FACIAL_C_Jaw', 'FACIAL_R_EyelidUpper']) assert.ok(name in CREW_SLOT, name);
  assert.ok(!CREW_JOINT_NAMES.some((name) => name === 'Head' || name.includes('_leaf')));
});

test('every joint follows its parent and is followed by all its descendants, as the GPU pose pass walks them', () => {
  const under = (slot, root) => { for (let at = CREW_JOINT_PARENTS[slot]; at >= 0; at = CREW_JOINT_PARENTS[at]) if (at === root) return true; return false; };
  for (let slot = 1; slot < CREW_JOINT_COUNT; slot++) {
    assert.ok(CREW_JOINT_PARENTS[slot] >= 0 && CREW_JOINT_PARENTS[slot] < slot, CREW_JOINT_NAMES[slot]);
    let end = slot + 1;
    while (end < CREW_JOINT_COUNT && under(end, slot)) end++;
    for (let other = end; other < CREW_JOINT_COUNT; other++) assert.ok(!under(other, slot), `${CREW_JOINT_NAMES[other]} is under ${CREW_JOINT_NAMES[slot]} but outside its run`);
  }
});

test('every skinned crew body is on the crew skeleton, joint for joint, and the rest tables are the base bodies\' own', () => {
  assert.ok(skinned.length >= 14, skinned.join(', '));
  for (const name of skinned) {
    const asset = readGLB(readFileSync(crewFile(name)).buffer.slice(0));
    const a = createSkinAnimator(asset);
    assert.deepEqual(a.joints.map((node) => a.names[node]), [...CREW_JOINT_NAMES], name);
    a.joints.forEach((node, slot) => { if (slot > 0) assert.equal(a.joints.indexOf(a.parent[node]), CREW_JOINT_PARENTS[slot], `${name} ${CREW_JOINT_NAMES[slot]}`); });
    if (name !== 'sailor.glb' && name !== 'sailor-female.glb') continue;
    a.sample(null, 0);
    const places = name === 'sailor.glb' ? CREW_REST_MALE_PLACES : CREW_REST_FEMALE_PLACES;
    a.joints.forEach((node, slot) => places[slot].forEach((v, k) => assert.ok(Math.abs(a.world[node][12 + k] - v) < 1e-3, `${name} ${CREW_JOINT_NAMES[slot]}`)));
  }
});
