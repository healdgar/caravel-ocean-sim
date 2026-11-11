// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The frame block carries two fire lights in eight spare floats. In the game a compute pass chooses them
// from the fire records the GPU keeps (js/gunnery-effects.js, encodeLights); packFrameFireLights is the
// same choice in JavaScript, kept as the measure of it and for callers with no such pass.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const { FRAME_FIRE_SLOTS, FRAME_FIRE_PATCH_FIRST, FRAME_FIRE_PATCH_FLOATS, FRAME_WGSL, packFrameFireLights } = await import('../js/wgsl/common.js');
const { SKY_RENDER_FUNCS } = await import('../js/wgsl/sky.js');

const FRAME_FLOATS = 132;
function frameAt({ sunY = 0.5, exposure = 1 } = {}) {
  const frame = new Float32Array(FRAME_FLOATS);
  for (let i = 0; i < FRAME_FLOATS; i++) frame[i] = 1000 + i;   // anything the packer must leave alone
  for (const slot of FRAME_FIRE_SLOTS) frame[slot] = 0;
  frame[33] = sunY; frame[68] = exposure;
  return frame;
}

// The packer this replaced, kept as the measure of what the lights should be.
function packedTheOldWay(frame, fires, eye) {
  const f = Float32Array.from(frame);
  f[23] = 0; f[27] = 0; f[31] = 0; f[54] = 0; f[55] = 0; f[61] = 0; f[62] = 0; f[87] = 0;
  if (!fires.length) return f;
  const nightFactor = 1 - Math.max(0, Math.min(1, (f[33] + 0.06) / 0.24));
  const fireExposure = Math.min(1.0, 1.35 / Math.max(f[68] || 1, 1e-3)) * (1.0 + 2.8 * nightFactor);
  const clusters = [];
  for (const wf of fires) {
    const pos = wf?.position, rawInt = wf?.intensity ?? 0;
    if (!pos || rawInt <= 0.01) continue;
    let merged = false;
    for (const c of clusters) {
      if ((c.x - pos[0]) ** 2 + (c.y - pos[1]) ** 2 + (c.z - pos[2]) ** 2 < 144) {
        const nextW = c.w + rawInt;
        c.x = (c.x * c.w + pos[0] * rawInt) / nextW; c.y = (c.y * c.w + pos[1] * rawInt) / nextW; c.z = (c.z * c.w + pos[2] * rawInt) / nextW;
        c.w = Math.min(3.6, nextW);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ x: pos[0], y: pos[1], z: pos[2], w: Math.min(3.2, rawInt) });
  }
  if (!clusters.length) return f;
  clusters.sort((a, b) => (b.w / (1 + Math.hypot(b.x - eye[0], b.y - eye[1], b.z - eye[2]) * 0.02)) - (a.w / (1 + Math.hypot(a.x - eye[0], a.y - eye[1], a.z - eye[2]) * 0.02)));
  const c0 = clusters[0];
  f[23] = c0.x; f[27] = c0.y; f[31] = c0.z; f[54] = c0.w * fireExposure;
  if (clusters.length > 1) { const c1 = clusters[1]; f[55] = c1.x; f[61] = c1.y; f[62] = c1.z; f[87] = c1.w * fireExposure; }
  return f;
}

// A small repeatable source of fires.
function scatter(seed, count) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  return Array.from({ length: count }, () => ({ position: [next() * 300 - 150, next() * 20, next() * 300 - 150], intensity: next() * 2.4 }));
}

test('the fire slots are the spare floats the shaders read, and one patch spans them', () => {
  assert.deepEqual([...FRAME_FIRE_SLOTS], [23, 27, 31, 54, 55, 61, 62, 87]);
  assert.equal(FRAME_FIRE_PATCH_FIRST, Math.min(...FRAME_FIRE_SLOTS));
  assert.equal(FRAME_FIRE_PATCH_FIRST + FRAME_FIRE_PATCH_FLOATS - 1, Math.max(...FRAME_FIRE_SLOTS));
  // Float n of the block is component n & 3 of the vec4 at n >> 2: these are the members the fire shader names.
  assert.match(SKY_RENDER_FUNCS, /let f0=vec4f\(F\.camRight\.w,F\.camUp\.w,F\.camFwd\.w,F\.cascInvL\[1\]\.z\);/);
  assert.match(SKY_RENDER_FUNCS, /let f1=vec4f\(F\.cascInvL\[1\]\.w,F\.windP\[1\]\.y,F\.windP\[1\]\.z,F\.foamP\.w\);/);
  // And the struct's own notes say so, instead of promising hull length, beam and lace sharpness there.
  assert.match(FRAME_WGSL, /camRight: vec4f,[^\n]*fire light 0 x/);
  assert.match(FRAME_WGSL, /windP: [^\n]*fire light 1 y, fire light 1 z/);
  assert.match(FRAME_WGSL, /foamP: [^\n]*fire light 1 intensity/);
  assert.doesNotMatch(FRAME_WGSL, /hull heading, length, beam|lace sharpness/);
});

test('no fire leaves the slots dark and reports nothing to send', () => {
  const frame = frameAt(), before = Float32Array.from(frame);
  assert.equal(packFrameFireLights(frame, [], 0, 0, 0), false);
  assert.equal(packFrameFireLights(frame, null, 0, 0, 0), false);
  assert.equal(packFrameFireLights(frame, [{ position: [1, 2, 3], intensity: 0.005 }, { intensity: 2 }, null], 0, 0, 0), false, 'an ember or a fire with no place lights nothing');
  assert.deepEqual(frame, before);
});

test('the lights are those the old packer chose, and nothing else in the frame is touched', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const fires = scatter(seed, seed % 23), eye = [seed * 3 - 90, 4 + (seed % 5), 40 - seed * 2];
    const frame = frameAt({ sunY: (seed % 9) / 10 - 0.3, exposure: 0.4 + (seed % 7) * 0.5 });
    const expected = packedTheOldWay(frame, fires, eye);
    packFrameFireLights(frame, fires, eye[0], eye[1], eye[2]);
    assert.deepEqual(frame, expected, `seed ${seed}: ${fires.length} fires`);
  }
});

test('fires close together burn as one light, and the two that matter most from the eye win', () => {
  const frame = frameAt();
  const fires = [
    { position: [100, 5, 0], intensity: 1 }, { position: [104, 5, 0], intensity: 1 },   // one blaze, 100 m off
    { position: [-400, 5, 0], intensity: 3 },                                            // a great fire far away
    { position: [0, 5, 10], intensity: 0.6 },                                            // a small one at hand
  ];
  assert.equal(packFrameFireLights(frame, fires, 0, 5, 0), true);
  assert.deepEqual([frame[23], frame[27], frame[31]], [102, 5, 0], 'the merged blaze is the first light, at its centre');
  assert.ok(Math.abs(frame[54] - 2) < 1e-6, 'with the strength of both');
  assert.deepEqual([frame[55], frame[61], frame[62]], [0, 5, 10], 'the small fire at hand is the second: the great one is too far off');
});

test('an unchanged fire needs no upload, and a changed one does', () => {
  const frame = frameAt({ sunY: -0.2 });
  const fires = [{ position: [10, 2, -30], intensity: 1.5 }];
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), true, 'a fire lit');
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), false, 'the same fire the next frame');
  assert.equal(packFrameFireLights(frame, fires, 5, 3, 0), false, 'the eye moving past a single fire changes nothing sent');
  fires[0].intensity = 1.6;
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), true, 'the fire flaring');
  frame[68] = 3;
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), true, 'the exposure changing');
  fires.length = 0;
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), true, 'the fire going out');
  assert.ok(FRAME_FIRE_SLOTS.every((slot) => frame[slot] === 0));
  assert.equal(packFrameFireLights(frame, fires, 0, 3, 0), false);
});

test('more fires than the packer has met before are still packed', () => {
  const frame = frameAt(), fires = Array.from({ length: 200 }, (_, i) => ({ position: [i * 40, 0, 0], intensity: 1 + i * 0.001 }));
  packFrameFireLights(frame, fires, 0, 0, 0);
  assert.deepEqual(frame, packedTheOldWay(frameAt(), fires, [0, 0, 0]));
});

test('in the game the GPU chooses the fire lights: JavaScript uploads the block whole once, its lights dark, and packs nothing', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /packFrameFireLights\(/, 'the packer stays the measure of the lights, not work the frame loop does');
  assert.equal(main.match(/writeBuffer\(frameUBO, ?0, ?f(rameF)?\)/g)?.length, 1, 'one whole upload a frame');
  assert.doesNotMatch(main, /writeBuffer\(frameUBO,\s*FRAME_FIRE_PATCH_FIRST/, 'and no second upload for the lights');
  // writeFrame gives the fire slots no value of its own: it sends them dark, as the last thing before the upload.
  const writeFrame = main.slice(main.indexOf('function writeFrame(time)'), main.indexOf('device.queue.writeBuffer(frameUBO, 0, f);'));
  for (const slot of FRAME_FIRE_SLOTS) assert.doesNotMatch(writeFrame, new RegExp(`f\\[${slot}\\]\\s*=`), `writeFrame leaves float ${slot} to the GPU`);
  assert.match(writeFrame, /clearFireLights\(f\);\s*$/);
  assert.match(main, /function clearFireLights\(f\)\{for\(const slot of FRAME_FIRE_SLOTS\)f\[slot\]=0;\}/);
  // The fires are gathered, their records kept on the GPU, and a compute pass there writes the lights into the block.
  const gathered = main.indexOf('activeFires.length=activeFireHulls.length=0;'), kept = main.indexOf('gunEffects.update(dt,{wind:windVec,time:simTime,fires:activeFires,fireHulls:activeFireHulls});');
  const chosen = main.indexOf('gunEffects.encodeLights(enc,{frame:frameUBO,hull:vesselHullUBO});');
  assert.ok(gathered > 0 && kept > gathered && chosen > kept, 'gathered, then kept, then chosen');
  const effects = readFileSync(new URL('../js/gunnery-effects.js', import.meta.url), 'utf8');
  const lights = effects.slice(effects.indexOf('    encodeLights(encoder,'), effects.indexOf('    encode(encoder){'));
  assert.match(lights, /if\(!fires\.count\)return false;/, 'with nothing burning there is no pass at all');
  assert.match(lights, /for\(const \[from,to,bytes\] of FRAME_FIRE_LIGHT_SPANS\)encoder\.copyBufferToBuffer\(lightBuffer,from,frame,to,bytes\);/);
  assert.doesNotMatch(lights, /writeBuffer/, 'and nothing is sent from JavaScript for them');
  assert.match(effects, /const FRAME_FIRE_LIGHT_SPANS=FRAME_FIRE_SLOTS\.reduce\(/, 'into these same slots');
});
