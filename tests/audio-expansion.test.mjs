import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SOUND_ASSETS } from '../js/audio-assets.js';
import { VOICE_ASSETS } from '../js/voice-assets.js';
import { WORLD_AUDIO_ASSETS } from '../js/world-audio-assets.js';
import {GUNNERY_AUDIO_ASSETS} from '../js/gunnery-audio-assets.js';
import { createGunneryAudio } from '../js/gunnery-audio.js';
import {
  createSceneAudio,
  indigenousVoiceClipForCulture,
  probeShorelineSurf,
  computeTownAmbienceState,
  computeHullFloodingAudioState,
  collectFootstepEvents,
  createFootstepMemory,
  townWalkerStride,
  soundcraftLufsTrim,
} from '../js/audio.js';
import { applyCrewCasualtiesAndMorale } from '../js/gunnery-control.js';
import { garrisonSoldierFalls } from '../js/crew.js';
import { crewThrowFromMast } from '../js/crew-aloft.js';
import { crewAdvanceWalk, CREW_WALK_CYCLE_METRES } from '../js/crew-motion.js';
import { createTownShots } from '../js/town-shots.js';
import { generateProceduralCoastalPack } from '../js/coastal-world.js';
import { WALKER_WORDS } from '../js/town-streets.js';

const audioPoint = { x: 0, y: 2, z: 0 };
const EVERY_SOUND = { ...SOUND_ASSETS, ...VOICE_ASSETS, ...GUNNERY_AUDIO_ASSETS, ...WORLD_AUDIO_ASSETS };

function createGunneryFixture() {
  const played = [];
  let enabled = true;
  const allAssets = { ...GUNNERY_AUDIO_ASSETS, ...WORLD_AUDIO_ASSETS };
  const sound = createGunneryAudio({
    play: (...args) => {
      played.push(args);
      return allAssets[args[0]]?.seconds ?? 1;
    },
    available: () => enabled,
    listener: () => audioPoint,
  });
  return { played, sound, mute: () => { enabled = false; } };
}

// Ports as the game generates them, streets and settlement profile included: Lisbon and Cartagena are colonial
// towns, and a Borikén coast of 1500 carries a Taíno settlement.
const portPacks = new Map();
function generatedPort(spec) {
  const key = typeof spec === 'string' ? spec : spec.id;
  if (!portPacks.has(key)) {
    portPacks.set(key, generateProceduralCoastalPack(spec, { size: 257, biomeSize: 64, albedoSize: 64, vegetationCandidates: 400 }).port);
  }
  return portPacks.get(key);
}
const BORIKEN_1500 = { id: 'boriken-audio-test', name: 'Borikén', latitude: 18.4, longitude: -66.1, year: 1500 };

const clipOf = url => String(url).split('/').pop().replace(/\.mp3$/, '');
// Lets every fetch and decode that has been asked for finish.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
// The frame uniform as the engine reads it: the eye, the clock the GPU walks the townsfolk by, the camera's
// right-hand vector and the sun.
function frameAt({ x = 0, y = 0, z = 0, clock = 0, sunY = 1 } = {}) {
  const frame = new Float32Array(48);
  frame[16] = x; frame[17] = y; frame[18] = z; frame[19] = clock; frame[20] = 1; frame[33] = sunY;
  return frame;
}

// A Web Audio double. One-shot sources end the moment they start unless hold is set, in which case they sound
// until the engine stops them or the test finishes them, as a real clip sounds for its length.
function installMockAudioContext(t, { hold = false } = {}) {
  const originalAudio = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.AudioContext = originalAudio;
    globalThis.fetch = originalFetch;
  });
  const starts = [], stops = [], params = [], fetched = [], contexts = [], failing = new Set();
  const parameter = () => ({
    value: 0,
    // Scheduled ramps are not played out here, so value stays the level the engine set.
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime(v) { this.value = v; params.push(v); },
  });
  const node = () => ({
    outputs: [],
    connect(target) { this.outputs.push(target); return target; },
    disconnect() { this.outputs.length = 0; },
  });
  // The gain node a source plays through, past whatever filters come first.
  const levelOf = from => {
    for (let at = from, hops = 0; at && hops < 8; at = at.outputs?.[0], hops++) if (at.gain) return at.gain;
    return null;
  };
  class MockAudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = node();
    constructor() { contexts.push(this); }
    createGain() { return { ...node(), gain: parameter() }; }
    createStereoPanner() { return { ...node(), pan: parameter() }; }
    createBiquadFilter() { return { ...node(), type: 'lowpass', frequency: parameter(), Q: parameter() }; }
    createOscillator() {
      return {
        ...node(),
        type: 'sine',
        frequency: parameter(),
        start() {},
        stop() { this.onended?.(); },
      };
    }
    createDynamicsCompressor() {
      return {
        ...node(),
        ...Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map(k => [k, parameter()])),
      };
    }
    createBufferSource() {
      const context = this;
      return {
        ...node(),
        loop: false,
        ended: false,
        // A real source plays at its recorded rate until told otherwise.
        playbackRate: Object.assign(parameter(), { value: 1 }),
        start(when, offset, duration) {
          const level = levelOf(this);
          starts.push({
            id: clipOf(this.buffer?.url ?? ''), url: this.buffer?.url ?? '', loop: this.loop, source: this, level,
            gain: level?.value, rate: this.playbackRate.value, offset, duration, at: context.currentTime,
          });
          if (!this.loop && !hold) this.finish();
        },
        stop() { stops.push(this); this.finish(); },
        finish() {
          if (this.ended) return;
          this.ended = true;
          this.onended?.();
        },
      };
    }
    async decodeAudioData(bytes) {
      const url = new TextDecoder().decode(bytes);
      return { duration: EVERY_SOUND[clipOf(url)]?.seconds ?? 1, url };
    }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }
  globalThis.AudioContext = MockAudioContext;
  globalThis.fetch = async url => {
    const id = clipOf(url);
    fetched.push(id);
    return { ok: !failing.has(id), arrayBuffer: async () => new TextEncoder().encode(String(url)).buffer };
  };
  const sounding = id => starts.filter(s => !s.source.ended && (id === undefined || s.id === id));
  return { starts, stops, params, fetched, contexts, failing, sounding };
}

// An engine with sound enabled, as after the listener's first click.
async function enabledEngine(t, options) {
  const audio = installMockAudioContext(t, options);
  const statuses = [];
  const engine = createSceneAudio({ onStatus: state => statuses.push(state) });
  await engine.toggle();
  return { ...audio, engine, statuses };
}
const calmSea = { soundVolume: 0.8, windSpeed: 2, seabirds: 0, sunElev: 25 };
const fairWeather = { intensity: 0, type: 'off' };

test('promoted world audio SFX and voice assets match provenance and valid MP3 payloads', async () => {
  const provenance = JSON.parse(
    await fs.readFile(new URL('../assets/audio/world/provenance.json', import.meta.url), 'utf8'),
  );
  assert.equal(provenance.length, 28);
  for (const record of provenance) {
    const asset = WORLD_AUDIO_ASSETS[record.id];
    assert.ok(asset, `missing WORLD_AUDIO_ASSETS entry for ${record.id}`);
    assert.ok(asset.seconds > 0.25 && asset.seconds <= 12, `${record.id} duration out of bounds`);
    const bytes = await fs.readFile(new URL('../' + asset.url, import.meta.url));
    assert.equal(bytes.length, record.bytes, `${record.id} byte length mismatch`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, `${record.id} sha256 mismatch`);
    assert.ok(
      bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224),
      `${record.id} must be a valid MP3`,
    );
  }
});

test('world audio tooling finds its takes from any checkout and records unknown provenance as unknown', async () => {
  const { worldAudioRoot, worldProvenanceEntry } = await import('../scripts/world-audio.mjs');
  // The unversioned takes live beside the shared .git directory, wherever the repository sits.
  assert.equal(worldAudioRoot('/srv/game', '.git\n'), '/srv/game', 'the main checkout is its own root');
  assert.equal(worldAudioRoot('/srv/game/.claude/worktrees/a1', '/srv/game/.git\n'), '/srv/game', 'a worktree resolves to the main checkout');
  assert.equal(worldAudioRoot('/srv/export', ''), '/srv/export', 'outside git, the tree itself');
  assert.equal(worldAudioRoot('/srv/export', '/srv/bare.git'), '/srv/export', 'a bare repository has no checkout beside it');
  const source = await fs.readFile(new URL('../scripts/world-audio.mjs', import.meta.url), 'utf8');
  assert.ok(!/['"`]\/(Users|home)\//.test(source), 'no path on one person\'s machine is written into the script');

  const measured = { seconds: 2.25, sha256: 'bb', bytes: 3 };
  const generated = worldProvenanceEntry(
    { id: 'surf', category: 'nature', prompt: 'the recipe as it reads today' },
    { sha256: 'aa', request: { model_id: 'eleven_text_to_sound_v2', text: 'the prompt as it was sent' } },
    'surf-01.mp3',
    measured,
  );
  assert.deepEqual(
    [generated.provider, generated.model, generated.prompt, generated.sourceSha256, generated.sha256, generated.bytes, generated.seconds],
    ['ElevenLabs', 'eleven_text_to_sound_v2', 'the prompt as it was sent', 'aa', 'bb', 3, 2.25],
    'a generated take records what its own request says, not what the recipe says now',
  );
  const reuse = { id: 'shore-birds', category: 'nature', kind: 'pilot-reuse', sourceTake: 'tern-calls-01.mp3' };
  for (const record of [{ sha256: 'cc', provenance: 'unknown', reusedTake: 'tern-calls-01.mp3', request: null }, { sha256: 'cc' }, null]) {
    const entry = worldProvenanceEntry(reuse, record, 'shore-birds-01.mp3', measured);
    assert.deepEqual(
      [entry.provider, entry.model, entry.prompt, entry.text, entry.reusedTake],
      ['unknown', 'unknown', null, null, 'tern-calls-01.mp3'],
      'a reused take with no generation record claims no model and no prompt',
    );
  }
  const spoken = worldProvenanceEntry(
    { id: 'hail', category: 'voice', kind: 'voice', voiceId: 'v1', text: 'Sail ho' },
    { sha256: 'dd', request: { model_id: 'eleven_v3', text: 'Sail ho!' } },
    'hail-01.mp3',
    measured,
  );
  assert.deepEqual([spoken.model, spoken.text, spoken.prompt, spoken.voiceId], ['eleven_v3', 'Sail ho!', null, 'v1']);

  // The committed record obeys the same rule: a model is named only beside the words sent to it.
  const provenance = JSON.parse(await fs.readFile(new URL('../assets/audio/world/provenance.json', import.meta.url), 'utf8'));
  for (const entry of provenance) {
    if (entry.model === 'unknown') assert.equal(entry.provider, 'unknown', entry.id);
    else assert.ok(entry.prompt || entry.text, `${entry.id} names ${entry.model} and so records what was asked of it`);
  }
  assert.equal(provenance.find(entry => entry.id === 'shore-birds').reusedTake, 'tern-calls-01.mp3');
});

test('1. screaming and crying out people distinguish male, female, overboard, and crowd panic', () => {
  const { played, sound } = createGunneryFixture();

  // Direct male casualty scream
  assert.equal(sound.event({ type: 'casualty-scream', sex: 'male', position: { x: 10, y: 2, z: 0 } }), true);
  // Direct female casualty scream (after advancing past scream cooldown)
  sound.update(0.5);
  assert.equal(sound.event({ type: 'casualty-scream', sex: 'female', position: { x: 12, y: 2, z: 0 } }), true);
  sound.update(0.5);
  // Overboard scream
  assert.equal(sound.event({ type: 'casualty-scream', overboard: true, position: { x: 8, y: 0, z: 0 } }), true);
  sound.update(0.5);
  // Town crowd panic
  assert.equal(sound.event({ type: 'town-panic', position: { x: 40, y: 4, z: 0 } }), true);
  sound.update(0.5);

  const ids = played.map(p => p[0]);
  assert.ok(ids.includes('scream-male'), 'male casualty scream played');
  assert.ok(ids.includes('scream-female'), 'female casualty scream played');
  assert.ok(ids.includes('scream-overboard'), 'overboard scream played');
  assert.ok(ids.includes('crowd-panic'), 'town crowd panic played');

  // Simulation hook: applyCrewCasualtiesAndMorale emits casualty-scream with sailor sex
  const emitted = [];
  const boat = {
    x: 0,
    z: 0,
    heave: 0,
    crewEvents: ev => emitted.push(ev),
  };
  applyCrewCasualtiesAndMorale(
    boat,
    { ammo: 'round', energy: 90000, hitZone: 'hull', surfacePosition: [1, 2, 3] },
    { casualties: { killed: 0, wounded: 1 }, struck: { sailor: { sex: 'female' }, direction: [1, 0, 0] } },
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'casualty-scream');
  assert.equal(emitted[0].sex, 'female');

  // Simulation hook: fort garrison soldier falling queues casualty-scream on garrison.audioEvents
  const garrison = { soldiers: [] };
  const soldier = { sex: 'male', casualtyState: 'able', lx: 2, ly: 8, lz: -3 };
  garrisonSoldierFalls(null, soldier, { x: 50, z: -20, yaw: 0 }, false, garrison);
  assert.equal(garrison.audioEvents?.length, 1);
  assert.equal(garrison.audioEvents[0].type, 'casualty-scream');
  assert.equal(garrison.audioEvents[0].sex, 'male');

  // Simulation hook: crewThrowFromMast emits falling-from-aloft
  const aloftEvents = [];
  const aloftBoat = {
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    length: 24,
    beam: 6,
    crewEvents: ev => aloftEvents.push(ev),
  };
  const aloftSailor = {
    name: 'Beatriz',
    sex: 'female',
    job: { mast: 'main' },
    position: new Float32Array([0, 9, 0]),
  };
  crewThrowFromMast(aloftBoat, aloftSailor, 0, 'mast-fall');
  assert.ok(aloftEvents.some(e => e.type === 'falling-from-aloft' && e.sailor === aloftSailor));
});

test('2 & 3. crumbling timber, felled trees, crumbling stone, and masonry collapse trigger spatialized effects', () => {
  const { played, sound } = createGunneryFixture();

  // Scenery tree felled
  sound.event({
    type: 'impact',
    kind: 'scenery',
    mass: 8,
    position: { x: 35, y: 4, z: 0 },
    damageReport: { felled: true },
  });
  sound.update(0.6);
  assert.ok(played.some(p => p[0] === 'timber-crumble'), 'scenery impact plays timber-crumble');
  assert.ok(played.some(p => p[0] === 'timber-crumble' && p[3] < 0.9), 'felled tree plays deep-pitched timber crash');

  // Timber building collapse (e.g. palisade fort / pier)
  played.length = 0;
  sound.event({
    type: 'impact',
    kind: 'building',
    mass: 12,
    position: { x: 40, y: 5, z: 0 },
    damageReport: { timberClass: true, collapsed: true },
  });
  sound.update(0.6);
  assert.ok(played.some(p => p[0] === 'timber-crumble'), 'timber building plays timber-crumble');
  assert.ok(played.some(p => p[0] === 'timber-crumble' && p[3] < 0.9), 'collapsed timber structure plays heavy timber crash');

  // Stone fort / masonry building collapse with garrison casualty
  played.length = 0;
  sound.event({
    type: 'impact',
    kind: 'building',
    mass: 16,
    position: { x: 45, y: 6, z: 0 },
    damageReport: { timberClass: false, fortified: true, collapsed: true, casualties: 2 },
  });
  sound.update(0.8);
  assert.ok(played.some(p => p[0] === 'stone-crumble'), 'stone building impact plays stone-crumble');
  assert.ok(played.some(p => p[0] === 'stone-crumble' && p[3] < 0.9), 'collapsed stone bastion plays heavy masonry collapse');
  assert.ok(played.some(p => p[0] === 'scream-male'), 'fort casualty plays soldier scream');

  // Terrain crater impact
  played.length = 0;
  sound.event({
    type: 'impact',
    kind: 'terrain',
    mass: 12,
    position: { x: 30, y: 2, z: 0 },
  });
  sound.update(0.5);
  assert.ok(played.some(p => p[0] === 'stone-crumble'), 'terrain impact plays earth/stone crumble');
});

test('4. snapping masts and falling rigging trigger mast-snap and timber-creak', () => {
  const { played, sound } = createGunneryFixture();

  sound.event({
    type: 'impact',
    kind: 'rigging',
    mass: 10,
    position: { x: 15, y: 12, z: 0 },
    damageReport: { mastSnap: true, mastGroup: 'main' },
  });
  sound.update(0.4);
  assert.ok(played.some(p => p[0] === 'mast-snap'), 'rigging mastSnap plays mast-snap');
  assert.ok(played.some(p => p[0] === 'timber-creak'), 'rigging mastSnap plays rigging/spar strain');

  played.length = 0;
  sound.update(0.6);
  sound.event({
    type: 'mast-snap',
    stage: 'full',
    position: { x: 12, y: 10, z: 0 },
  });
  sound.update(0.3);
  assert.ok(played.some(p => p[0] === 'mast-snap'), 'explicit mast-snap event plays mast-snap');
});

test('5. bubbling and gurgling water scales with active hull shot-hole inflow and sinking vessels', async t => {
  const intactBoat = { x: 0, z: 0, heave: 0, damage: { holes: [], floodingTonnes: 0, sunk: false } };
  const intactState = computeHullFloodingAudioState(intactBoat, [{ boat: intactBoat }]);
  assert.equal(intactState.holeInflow, 0);
  assert.equal(intactState.sinkingIntensity, 0);

  const leakingBoat = {
    x: 5,
    z: -4,
    heave: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    damage: {
      holes: [
        { flow: 0.45, radius: 0.22, local: [2.5, -0.3, 1.0] },
        { flow: 0.35, radius: 0.18, local: [-2.5, -0.2, -1.5] },
      ],
      floodingTonnes: 22,
      sunk: false,
    },
  };
  const leakState = computeHullFloodingAudioState(leakingBoat, [{ boat: leakingBoat }]);
  assert.ok(leakState.holeInflow > 0.3, 'active waterline shot holes produce holeInflow');
  assert.ok(leakState.holePosition, 'holePosition resolved in world space');

  const sinkingBoat = {
    x: 18,
    z: 10,
    heave: -2.2,
    damage: {
      holes: [{ flow: 0.8, radius: 0.25, local: [1, -0.5, 0] }],
      floodingTonnes: 55,
      sinkingDepth: 2.8,
      sunk: true,
      settledWreck: false,
    },
  };
  const sinkState = computeHullFloodingAudioState(intactBoat, [{ boat: intactBoat }, { boat: sinkingBoat }]);
  assert.ok(sinkState.sinkingIntensity > 0.5, 'foundering vessel produces high sinkingIntensity');
  assert.deepEqual(sinkState.sinkingPosition, { x: 18, y: -2.2, z: 10 });

  // Verify sceneAudio.update plays water-bubble and sinking bulkhead groans
  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 4, seabirds: 0 };
  const weather = { intensity: 0, type: 'off' };
  for (let i = 0; i < 16; i++) {
    engine.update(0.25, p, leakingBoat, frame, weather, [], {
      vessels: [{ boat: leakingBoat }, { boat: sinkingBoat }],
    });
  }
  assert.ok(starts.some(s => s.url.endsWith('/water-bubble.mp3')), 'water-bubble played for leaking/sinking hull');
  assert.ok(starts.some(s => s.url.endsWith('/timber-creak.mp3')), 'timber-creak groans played for sinking ship');
});

test('6 & 9. surf and shorebirds sound where the sea meets the land, and rest once the coast is left', async t => {
  // Terrain with land to the east (+X)
  const coastalTerrain = {
    height(x) {
      return x > 35 ? 6.0 : -4.0;
    },
  };
  const listener = { x: 0, y: 2, z: 0, rightX: 1, rightZ: 0 };
  const calmSurf = probeShorelineSurf(coastalTerrain, listener, { windSpeed: 3, swellHs: 0.5 });
  assert.ok(calmSurf.nearShore, 'detects shoreline within 60m');
  assert.ok(calmSurf.shoreDistance <= 60, 'accurate shoreline distance');
  assert.ok(calmSurf.pan > 0.4, 'pans toward land on the right (+X)');
  assert.ok(calmSurf.lapGain > 0.05, 'lapping surf audible near shore');

  const stormSurf = probeShorelineSurf(coastalTerrain, listener, { windSpeed: 22, swellHs: 4.5 });
  assert.ok(stormSurf.breakerIntensity > calmSurf.breakerIntensity, 'heavy swell increases breakerIntensity');
  assert.ok(stormSurf.lapGain > calmSurf.lapGain, 'heavy swell increases surf gain');

  const openSeaTerrain = { height: () => -50 };
  const openSurf = probeShorelineSurf(openSeaTerrain, listener, { windSpeed: 10, swellHs: 2 });
  assert.equal(openSurf.nearShore, false);
  assert.equal(openSurf.lapGain, 0);

  // Low ground is a shore only where the waterline is crossed.
  const inlandPlain = { height: () => 2.2 };
  const plain = probeShorelineSurf(inlandPlain, listener, { windSpeed: 12, swellHs: 2 });
  assert.equal(plain.nearShore, false, 'level ground a little above the sea, with no sea in reach, has no surf');
  assert.equal(plain.lapGain, 0);
  const distantSea = { height: x => (x < -300 ? -3 : 1.5) };
  assert.equal(probeShorelineSurf(distantSea, listener, { windSpeed: 12, swellHs: 2 }).nearShore, false, 'nor has a marsh whose sea lies beyond earshot');
  const beach = { height: x => (x < -40 ? -2 : 3) };
  const ashore = probeShorelineSurf(beach, listener, { windSpeed: 12, swellHs: 2 });
  assert.ok(ashore.nearShore, 'standing ashore, the sea is found where the ground goes under it');
  assert.ok(ashore.shoreDistance > 36 && ashore.shoreDistance < 68, `the waterline lies between the probes either side of it (${ashore.shoreDistance})`);
  assert.ok(ashore.pan < -0.4, 'and it is heard on the side it lies');

  const { engine, starts, stops } = await enabledEngine(t);
  assert.equal(starts.filter(s => s.loop).length, 7, 'only the standing ambience loops start with sound');

  const boat = { x: 0, z: 0, length: 24, showProw: true, enabled: true, surgeVelocity: 0, revision: 0 };
  const frame = frameAt();
  const p = { soundVolume: 0.8, windSpeed: 18, swellHs: 3.5, seabirds: 0.9, sunElev: 25 };
  const sail = async (terrain, seconds) => {
    for (let s = 0; s < seconds; s += 0.25) {
      engine.update(0.25, p, boat, frame, fairWeather, [], { terrain, sunElev: 25 });
      await settle();
    }
  };
  await sail(inlandPlain, 3);
  assert.ok(!starts.some(s => s.id === 'shore-surf'), 'no surf plays over dry low ground');
  await sail(coastalTerrain, 10);
  const surf = starts.filter(s => s.loop && s.id === 'shore-surf');
  assert.equal(surf.length, 1, 'the surf loop starts near the coast');
  assert.ok(surf[0].level.value > 0.05, 'and is brought up');
  assert.ok(starts.some(s => s.id === 'shore-birds'), 'shore-birds triggered near coast during day');

  // A loop wanted only near a coast is not left running, silent, for the rest of the voyage.
  await sail(openSeaTerrain, 12);
  assert.ok(stops.includes(surf[0].source), 'the surf loop is stopped once it has rested in silence');
  assert.equal(stops.filter(source => source.loop).length, 1, 'wind, hull and weather loops keep running');
  await sail(coastalTerrain, 2);
  assert.equal(starts.filter(s => s.loop && s.id === 'shore-surf').length, 2, 'and it starts afresh when a coast returns');

  // Where the shore lies is looked for a few times a second, not on every frame.
  let lookups = 0;
  const counted = { height(x) { lookups++; return x > 35 ? 6.0 : -4.0; } };
  for (let i = 0; i < 60; i++) engine.update(1 / 60, p, boat, frame, fairWeather, [], { terrain: counted, sunElev: 25 });
  assert.ok(lookups > 0 && lookups <= 57 * 6, `${lookups} terrain heights were read in one second of frames`);
});

test('7. enemy captains, soldiers, and sailors voices propagate with distance delay on fire, boarding, and surrender', async t => {
  const { played, sound } = createGunneryFixture();
  const distance = 340.39; // 1 second speed-of-sound delay
  const enemyPos = { x: distance, y: 2, z: 0 };

  sound.event({ type: 'enemy-voice', action: 'fire', position: enemyPos });
  sound.update(0.5);
  assert.equal(played.length, 0, 'enemy fire order respects speed-of-sound delay');
  sound.update(0.6);
  assert.equal(played.length, 1);
  assert.equal(played[0][0], 'enemy-fire-order');

  sound.update(2.5);
  sound.event({ type: 'enemy-voice', action: 'boarding', position: { x: 15, y: 2, z: 0 } });
  sound.update(0.2);
  assert.equal(played.at(-1)[0], 'enemy-boarding-cry');

  sound.update(2.5);
  sound.event({ type: 'enemy-voice', action: 'surrender', position: { x: 20, y: 2, z: 0 } });
  sound.update(0.2);
  assert.equal(played.at(-1)[0], 'enemy-surrender-cry');

  // Verify boarding-round event in createSceneAudio triggers enemy-boarding-cry
  const { engine, starts } = await enabledEngine(t);
  const boat = { x: 0, z: 0, length: 24, showProw: true, enabled: true };
  engine.event({ type: 'boarding-round', position: { x: 8, y: 2, z: 0 } }, boat);
  engine.update(0.2, { soundVolume: 0.8, windSpeed: 0, seabirds: 0 }, boat, frameAt(), fairWeather);
  await settle();
  assert.ok(starts.some(s => s.id === 'enemy-boarding-cry'), 'boarding-round plays enemy-boarding-cry');
});

test('8. Native American speech is heard at Indigenous settlements and canoes, and nowhere else', async t => {
  assert.equal(indigenousVoiceClipForCulture('taino_boriken'), 'indigenous-taino');
  assert.equal(indigenousVoiceClipForCulture('arawak'), 'indigenous-taino');
  assert.equal(indigenousVoiceClipForCulture('kalinago_dominica'), 'indigenous-kalinago');
  assert.equal(indigenousVoiceClipForCulture('powhatan_tsenacommacah'), 'indigenous-algonquian');
  assert.equal(indigenousVoiceClipForCulture('abenaki_wabanaki'), 'indigenous-algonquian');
  assert.equal(indigenousVoiceClipForCulture('tupinamba_guanabara'), 'indigenous-tupinamba');
  assert.equal(indigenousVoiceClipForCulture('maya_pole'), 'indigenous-maya');

  // Every generated port carries a settlement profile naming the people of that coast. Only the profile's own
  // flag says whether any of them live there.
  const village = generatedPort(BORIKEN_1500), colony = generatedPort('havana');
  assert.equal(village.indigenousSettlement.hasIndigenousSettlement, true);
  assert.ok(colony.indigenousSettlement?.cultureId, 'a colonial port still names the culture of its coast');
  assert.equal(colony.indigenousSettlement.hasIndigenousSettlement, false);
  const earAt = port => ({ x: port.center.x, y: 2, z: port.center.z, rightX: 1, rightZ: 0 });
  const atVillage = computeTownAmbienceState([village], earAt(village), 25);
  assert.equal(atVillage.hasIndigenous, true);
  assert.equal(atVillage.cultureId, village.indigenousSettlement.cultureId);
  assert.equal(computeTownAmbienceState([colony], earAt(colony), 25).hasIndigenous, false, 'no Indigenous settlement stands at Havana');

  const { engine, starts, fetched } = await enabledEngine(t);
  const moor = async (port, seconds) => {
    const boat = { x: port.center.x, z: port.center.z, length: 12, showProw: true, enabled: true };
    const frame = frameAt({ x: port.center.x, y: 2, z: port.center.z });
    for (let s = 0; s < seconds; s += 0.5) {
      engine.update(0.5, calmSea, boat, frame, fairWeather, [], { ports: [port], sunElev: 20 });
      await settle();
    }
    return boat;
  };
  // Longer than the longest wait between two utterances.
  await moor(colony, 40);
  assert.deepEqual(starts.filter(s => s.id.startsWith('indigenous-')), [], 'none is spoken in a colonial port');
  assert.deepEqual(fetched.filter(id => id.startsWith('indigenous-')), [], 'nor is any fetched there');
  const boat = await moor(village, 20);
  assert.ok(starts.some(s => s.id === indigenousVoiceClipForCulture(village.indigenousSettlement.cultureId)), 'the people of a Taíno village are heard in their own language');

  // Explicit diplomatic/trade action voice event
  engine.event({ type: 'indigenous-voice', cultureId: 'maya_pole', position: { x: boat.x + 15, y: 2, z: boat.z } }, boat);
  await settle();
  assert.ok(starts.some(s => s.id === 'indigenous-maya'), 'indigenous-voice event plays Yucatec Maya greeting');
});

test('10. busy towns ambience scales by population and time of day, and switches to panic + alarm bell under bombardment', async t => {
  const port = generatedPort('cartagena');
  assert.equal(typeof port.streets.people, 'number', 'a town counts its people; it does not list them');
  const listener = { x: port.center.x, y: 2, z: port.center.z, rightX: 1, rightZ: 0 };

  const dayState = computeTownAmbienceState([port], listener, 25);
  assert.ok(dayState.nearTown, 'nearTown true in the middle of the town');
  assert.ok(dayState.crowdGain > 0.1, 'busy daytime town has strong crowdGain');
  assert.equal(dayState.livingPeople, port.streets.people);
  assert.ok(dayState.busyWalkGain > 0.006, 'and the bustle of people about');
  assert.equal(dayState.underFire, false);
  const outside = { ...listener, x: listener.x - 150 };
  const fromOutside = computeTownAmbienceState([port], outside, 25);
  assert.ok(fromOutside.pan * (fromOutside.position.x - outside.x) > 0, 'town ambience pans toward the town');
  assert.ok(fromOutside.crowdGain < dayState.crowdGain, 'and falls away with distance');

  const nightState = computeTownAmbienceState([port], listener, -20);
  assert.ok(nightState.crowdGain < dayState.crowdGain * 0.5, 'town is quieter at night');

  const { engine, starts, stops } = await enabledEngine(t);
  const boat = { x: listener.x, z: listener.z, length: 24, showProw: true, enabled: true };
  const frame = frameAt({ x: listener.x, y: 2, z: listener.z });
  const stay = async seconds => {
    for (let s = 0; s < seconds; s += 0.25) {
      engine.update(0.25, calmSea, boat, frame, fairWeather, [], { ports: [port], sunElev: 25 });
      await settle();
    }
  };
  await stay(1);
  const town = starts.find(s => s.loop && s.id === 'town-ambience');
  assert.ok(town, 'town-ambience loop started near port');
  const peaceful = town.level.value;
  assert.ok(peaceful > 0.1);
  const bustle = starts.find(s => s.loop && s.id === 'town-bustle');
  assert.ok(bustle, 'people about their day have their own loop');
  assert.ok(bustle.level.value > 0 && bustle.level.value < peaceful, 'under the hum of the town');
  assert.equal(bustle.source.playbackRate.value, 1, 'played as it was recorded');
  assert.ok(!starts.some(s => s.loop && s.id === 'crowd-panic'), 'and no panic is heard in a town at peace');

  // Bombardment via createTownShots.note marks town under fire
  const shotResponse = createTownShots(port.streets);
  const { x, z } = port.streets.window;
  shotResponse.note([x, 6, z], [x + 2, 2, z], { fraction: 1 }, { mass: 8, velocity: [150, -10, 0] });
  assert.ok(port.streets.underFireCount > 0, 'town shot response records underFireCount');
  assert.equal(computeTownAmbienceState([port], listener, 25).underFire, true, 'computeTownAmbienceState detects town under fire');
  await stay(1);
  const panic = starts.filter(s => s.loop && s.id === 'crowd-panic').at(-1);
  assert.ok(panic, 'bombarded town triggers crowd-panic');
  assert.equal(panic.source.playbackRate.value, 1, 'at its true pitch');
  assert.ok(panic.level.value > peaceful * 0.5, 'and loud');
  assert.ok(town.level.value < peaceful * 0.5, 'while the ordinary hum of the town drops away');
  assert.ok(bustle.level.value < 0.005, 'and the bustle stops');
  assert.ok(!stops.includes(town.source), 'the town loop keeps running while the town is in earshot');
});

test('11. footfalls are counted from the walk clip, two to a cycle, on deck, on the ramparts and in the streets', async t => {
  const boat = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, enabled: true, viewStation: 'deck' };
  const listener = { x: 0, y: 2, z: 0 };
  const walkerOnDeck = () => ({ visible: true, casualtyState: 'able', walk: 0.8, walkTime: 0, position: [1.5, 0, -2.0] });
  const walkerAshore = () => ({ visible: true, casualtyState: 'able', walk: 0.7, walkTime: 0, x: 6, y: 1, z: 0 });
  const FOOTFALL_METRES = CREW_WALK_CYCLE_METRES / 2;

  // The crew's walk clock is advanced by the ground they cover (crewAdvanceWalk), in seconds of the walk clip.
  for (const [surface, make, world] of [
    ['deck', walkerOnDeck, sailor => ({ boat, crew: [sailor] })],
    ['ground', walkerAshore, soldier => ({ boat, fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } } })],
  ]) {
    for (const clipSeconds of [undefined, 1.1]) {
      const walker = make(), memory = createFootstepMemory();
      if (clipSeconds) walker.walkClipDuration = clipSeconds;
      const speed = 1.2, dt = 1 / 60, distance = 13;
      let heard = 0;
      for (let time = 0, metres = 0; metres < distance; time += dt, metres += speed * dt) {
        crewAdvanceWalk(walker, speed * dt);
        const steps = collectFootstepEvents(memory, { ...world(walker), listener, time });
        assert.ok(steps.every(step => step.surface === surface && step.id === 'footstep-' + surface));
        heard += steps.length;
      }
      const due = distance / FOOTFALL_METRES;
      assert.ok(Math.abs(heard - due) <= 1, `${heard} footfalls on ${surface} over ${distance} m; a walk of that length has ${due}`);
    }
  }

  // What is remembered between frames holds no walker alive.
  const memory = createFootstepMemory();
  const passing = walkerOnDeck();
  collectFootstepEvents(memory, { boat, crew: [passing], listener, time: 0 });
  for (const kept of Object.values(memory)) {
    assert.ok(kept instanceof WeakMap || typeof kept === 'number', 'walkers are remembered weakly, and the last step time apart from them');
  }
  assert.deepEqual(collectFootstepEvents(new Map(), { boat, crew: [passing], listener, time: 1 }), [], 'a strong map is not accepted as memory');

  // The townsfolk exist as packed walkers and routes for the GPU, and nothing else. One of them, alone in the
  // street, puts a foot down for every half cycle of ground covered.
  const streets = generatedPort('lisbon').streets;
  assert.equal(typeof streets.people, 'number');
  assert.equal(streets.walkers.length, streets.people * WALKER_WORDS);
  const words = new Uint32Array(streets.walkers.buffer, streets.walkers.byteOffset, streets.walkers.length);
  // Someone who walks a fair way from noon on (clock 100) without stopping or turning, and who is home after dark.
  const strollFrom = index => {
    const stride = { position: { x: 0, y: 0, z: 0 }, walked: 0, stopped: false, cycle: 0 };
    let first = null, last = 0;
    for (let clock = 100; clock < 125; clock += 0.25) {
      const now = townWalkerStride(streets, index, clock, 1, stride, words);
      if (!now || now.stopped || now.walked < last) break;
      first ??= now.walked; last = now.walked;
    }
    return first === null ? 0 : last - first;
  };
  const one = Array.from({ length: streets.people }, (_, i) => i).find(i => streets.walkers[i * WALKER_WORDS + 9] > 0.1 && strollFrom(i) > 10);
  assert.ok(one !== undefined, 'someone is out walking at midday');
  const alone = { ...streets, people: 1, walkers: streets.walkers.slice(one * WALKER_WORDS, (one + 1) * WALKER_WORDS) };
  {
    const memory = createFootstepMemory(), ear = { x: 0, y: 0, z: 0 }, stride = townWalkerStride(alone, 0, 100, 1);
    let heard = 0, covered = 0, was = stride.walked, clock = 100;
    for (let i = 0; i < 60 * 40; i++) {
      clock += 1 / 60;
      const now = townWalkerStride(alone, 0, clock, 1, stride);
      if (!now || now.stopped) break;
      if (now.walked < was) break;
      covered += now.walked - was; was = now.walked;
      Object.assign(ear, now.position);
      const steps = collectFootstepEvents(memory, { ports: [{ streets: alone }], listener: ear, time: clock, clock, sunY: 1 });
      for (const step of steps) {
        assert.equal(step.id, 'footstep-ground');
        assert.ok(Math.hypot(step.position.x - now.position.x, step.position.z - now.position.z) < 1e-6, 'the step sounds where the walker stands');
      }
      heard += steps.length;
    }
    assert.ok(covered > 4, `the walker covered ${covered.toFixed(1)} m`);
    assert.ok(Math.abs(heard - covered / FOOTFALL_METRES) <= 1, `${heard} footfalls over ${covered.toFixed(2)} m of street; expected ${(covered / FOOTFALL_METRES).toFixed(1)}`);
  }

  // The whole town: steps are heard among the walkers by day, never more than two a frame, fewer once most have
  // gone home, and none while the guns have them running by a clock kept on the GPU.
  const crowdAt = (clock) => {
    const here = townWalkerStride(streets, one, clock, 1);
    return here.position;
  };
  const hear = (sunY, extra = {}) => {
    const memory = createFootstepMemory(), ear = { ...crowdAt(100) }, town = { ...streets, ...extra };
    let heard = 0;
    for (let i = 0, clock = 100; i < 60 * 20; i++, clock += 1 / 60) {
      const steps = collectFootstepEvents(memory, { ports: [{ streets: town }], listener: ear, time: clock, clock, sunY });
      assert.ok(steps.length <= 2);
      for (const step of steps) assert.ok(Math.hypot(step.position.x - ear.x, step.position.y - ear.y, step.position.z - ear.z) <= 18, 'only steps within earshot');
      heard += steps.length;
    }
    return heard;
  };
  const byDay = hear(1), byNight = hear(-0.3);
  assert.ok(byDay >= 10, `${byDay} footfalls in twenty seconds in a street at midday`);
  assert.ok(byNight < byDay, `${byNight} at night against ${byDay} by day`);
  assert.equal(hear(1, { underFireFrames: 30 }), 0);

  // The engine plays them: the crew's and the garrison's from their walk clocks, the town's from the frame clock.
  const { engine, starts } = await enabledEngine(t);
  const sailor = walkerOnDeck(), soldier = walkerAshore();
  const world = { crew: [sailor], fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } } };
  for (let i = 0; i < 90; i++) {
    crewAdvanceWalk(sailor, 1.2 / 60); crewAdvanceWalk(soldier, 1.2 / 60);
    engine.update(1 / 60, { soundVolume: 0.8, windSpeed: 0, seabirds: 0 }, boat, frameAt({ y: 2 }), fairWeather, [], world);
  }
  assert.ok(starts.some(s => s.id === 'footstep-deck'), 'footstep-deck played');
  assert.ok(starts.some(s => s.id === 'footstep-ground'), 'footstep-ground played');
  const before = starts.filter(s => s.id === 'footstep-ground').length;
  const street = crowdAt(100), awayBoat = { ...boat, x: street.x + 400, z: street.z };
  for (let i = 0, clock = 100; i < 60 * 5; i++, clock += 1 / 60) {
    engine.update(1 / 60, { soundVolume: 0.8, windSpeed: 0, seabirds: 0 }, awayBoat, frameAt({ ...street, clock, sunY: 1 }), fairWeather, [], { ports: [{ streets }] });
  }
  assert.ok(starts.filter(s => s.id === 'footstep-ground').length > before, 'the steps of the townsfolk are played');
});

test('12. bow release, rowing oar strokes, sail luffing, and lookout sighting calls trigger accurately', async t => {
  // Bow & arrow release in gunnery audio
  const { played, sound } = createGunneryFixture();
  sound.event({
    type: 'shot',
    shotId: 77,
    ammo: 'arrow',
    position: { x: 4, y: 2, z: 0 },
  });
  sound.update(0.1);
  assert.equal(played.at(-1)[0], 'bow-release', 'arrow shot plays bow-release clip');

  const { engine, starts } = await enabledEngine(t);
  const frame = frameAt();
  const p = { soundVolume: 0.8, windSpeed: 10, seabirds: 0 };

  const boat = {
    x: 0,
    z: 0,
    length: 20,
    showProw: true,
    enabled: true,
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 0,
    sailState: {
      squareFill: 0.08,
      lateenFill: 0.05,
      apparentSpeed: 9.5,
      maneuver: null,
    },
    rowingEffort: 0.8,
    rowingState: { phase: 0.1 },
    lookoutSighting: { kind: 'ship', x: 200, y: 3, z: -300 },
  };
  const calls = id => starts.filter(s => s.id === id).length;
  const watch = async seconds => {
    for (let s = 0; s < seconds; s += 0.5) { engine.update(0.5, p, boat, frame, fairWeather, []); await settle(); }
  };

  engine.update(0.2, p, boat, frame, fairWeather, [], {
    rowingEvents: [{ x: 2, z: -1, closingSpeed: 2.2 }],
  });
  assert.ok(starts.some(s => s.id === 'oar-stroke'), 'rowing event plays oar-stroke');
  assert.ok(starts.some(s => s.id === 'sail-luff'), 'pinching into wind plays sail-luff');
  await settle();
  assert.equal(calls('lookout-sail-ho'), 1, 'ship sighting plays lookout-sail-ho');
  assert.ok(Math.abs(starts.find(s => s.id === 'lookout-sail-ho').duration - 0.95) < 1e-9, 'only the hail itself, not the reading that follows it');

  // The masthead does not hail again within its cooldown because what it sees has changed.
  boat.lookoutSighting = { kind: 'whale', x: 150, y: 0, z: 90 };
  await watch(6);
  assert.equal(calls('lookout-whale-ho'), 0, 'a new sighting waits out the cooldown');
  await watch(10);
  assert.equal(calls('lookout-whale-ho'), 1, 'and is hailed once it has passed');
  await watch(20);
  assert.equal(calls('lookout-whale-ho'), 1, 'the same sighting is hailed once');

  // Land ho, reported by the voyage itself rather than seen from the frame
  engine.event({ type: 'lookout-sighting', kind: 'land' }, boat);
  await settle();
  assert.equal(calls('lookout-land-ho'), 1, 'landfall sighting plays lookout-land-ho');
});

test('spoken orders have voices of their own, and no one sound takes every voice', async t => {
  // Clips sound for their length here, as they do in a browser.
  const { engine, starts, stops, sounding } = await enabledEngine(t, { hold: true });
  const boat = { x: 0, z: 0, heave: 0, length: 24, showProw: true, enabled: true };
  const near = { x: 3, y: 2, z: 0 };
  engine.update(0.1, calmSea, boat, frameAt({ y: 2 }), fairWeather);
  const effects = () => sounding().filter(s => !s.loop && !/^(captain-|crew-|lookout-|enemy-|indigenous-)/.test(s.id) && s.id !== 'cannon-report');

  // A ship breaking up nearby: every kind of wreckage, asked for many times over.
  for (let i = 0; i < 5; i++) {
    engine.event({ type: 'timber-crumble', position: near }, boat);
    engine.event({ type: 'stone-crumble', position: near }, boat);
    engine.event({ type: 'water-bubble', position: near }, boat);
    engine.event({ type: 'sail-luff', rate: 1, position: near }, boat);
    await settle();
  }
  for (const id of ['timber-crumble', 'stone-crumble', 'water-bubble', 'sail-luff']) {
    assert.equal(sounding(id).length, 2, `${id} overlaps itself once and no more`);
  }
  assert.equal(effects().length, 8, 'the wreckage has taken every effect voice');
  engine.event({ type: 'oar-stroke', position: near }, boat);
  assert.equal(sounding('oar-stroke').length, 0, 'so one more effect finds none');

  // The captain's order is heard all the same.
  assert.equal(engine.gunneryOrder('prepare', boat), true);
  assert.equal(sounding('captain-guns-prepare').length, 1, 'an order is spoken while the effect voices are full');

  // Four voices of other people speaking fill the speech voices; an order takes the place of the oldest.
  for (const sound of sounding('captain-guns-prepare')) sound.source.finish();
  for (const cultureId of ['taino', 'kalinago', 'maya', 'tupinamba']) {
    engine.event({ type: 'indigenous-voice', cultureId, position: near }, boat);
  }
  await settle();
  const chatter = sounding().filter(s => s.id.startsWith('indigenous-'));
  assert.equal(chatter.length, 4);
  engine.event({ type: 'enemy-voice', action: 'fire', position: near }, boat);
  await settle();
  assert.equal(sounding('enemy-fire-order').length, 0, 'a fifth voice that is no order is not spoken');
  // The captain has finished his first order.
  for (let i = 0; i < 40; i++) engine.update(0.1, calmSea, boat, frameAt({ y: 2 }), fairWeather);
  assert.equal(engine.gunneryOrder('cease', boat), true);
  assert.equal(sounding('captain-guns-cease').length, 1, 'the order is spoken');
  assert.ok(stops.includes(chatter[0].source), 'in place of the oldest voice');
  assert.equal(sounding().filter(s => s.id.startsWith('indigenous-')).length, 3, 'and only that one');
  assert.ok(starts.length > 0);
});

test('a broadside landing does not queue a three-second tail of wreckage for every ball', () => {
  const { played, sound } = createGunneryFixture();
  const hull = { x: 6, y: 2, z: 0 };
  // Twenty balls strike a hull over one second.
  for (let i = 0; i < 20; i++) {
    sound.event({ type: 'impact', kind: 'vessel', hitZone: 'hull', position: hull });
    sound.update(0.05);
  }
  sound.update(0.2);
  const tails = played.filter(p => p[0] === 'timber-crumble');
  assert.ok(tails.length >= 1 && tails.length <= 3, `${tails.length} tails of falling timber in one second of hits`);
  for (const tail of tails) {
    assert.ok(tail[5].duration <= 1.5 && tail[5].release > 0, 'an ordinary hit gets the opening of the tail, faded out');
  }
  assert.ok(played.filter(p => p[0] === 'cannon-recoil').length >= 15, 'every ball is still heard to strike');

  // Shot into masonry and into the ground likewise.
  played.length = 0;
  sound.update(1);
  for (let i = 0; i < 10; i++) {
    sound.event({ type: 'impact', kind: i % 2 ? 'terrain' : 'building', position: hull });
    sound.update(0.05);
  }
  sound.update(0.2);
  const rubble = played.filter(p => p[0] === 'stone-crumble');
  assert.ok(rubble.length >= 1 && rubble.length <= 2, `${rubble.length} tails of falling stone in half a second of hits`);
  assert.ok(rubble.every(p => p[5].duration <= 1.5));

  // What comes down whole is heard whole, however soon after.
  played.length = 0;
  sound.event({ type: 'impact', kind: 'building', position: hull, damageReport: { collapsed: true } });
  sound.update(0.05);
  sound.event({ type: 'impact', kind: 'scenery', position: hull, damageReport: { felled: true } });
  sound.update(0.05);
  sound.event({ type: 'impact', kind: 'rigging', position: hull, damageReport: { mastSnap: true } });
  sound.update(0.2);
  for (const id of ['stone-crumble', 'timber-crumble', 'mast-snap']) {
    const whole = played.find(p => p[0] === id);
    assert.ok(whole, `${id} is played`);
    assert.equal(whole[5].duration, undefined, `${id} is not cut short`);
  }
});

test('only what is always wanted is decoded when sound is enabled; the rest when it is first wanted', async t => {
  const { engine, starts, fetched, contexts, failing, statuses } = await enabledEngine(t);
  const ofAPlaceOrOccasion = id => /^(indigenous-|lookout-|enemy-|captain-guns-lay-)/.test(id)
    || ['timber-crumble', 'stone-crumble', 'mast-snap', 'shore-surf', 'shore-birds', 'town-ambience', 'town-bustle', 'crowd-panic'].includes(id);
  const every = Object.keys(EVERY_SOUND);
  assert.deepEqual(fetched.filter(ofAPlaceOrOccasion), [], 'nothing of a particular place or occasion is fetched at the start');
  assert.deepEqual([...fetched].sort(), every.filter(id => !ofAPlaceOrOccasion(id)).sort(), 'everything else is, once each');
  const seconds = ids => ids.reduce((sum, id) => sum + EVERY_SOUND[id].seconds, 0);
  assert.ok(seconds(fetched) < seconds(every) * 0.7, `${seconds(fetched).toFixed(0)} s of ${seconds(every).toFixed(0)} s is decoded at the start`);
  assert.equal(statuses.at(-1).ready, true);
  assert.equal(statuses.at(-1).missing, 0, 'a clip not yet asked for is not a missing clip');

  const boat = { x: 0, z: 0, heave: 0, length: 24, showProw: true, enabled: true };
  const frame = frameAt({ y: 2 });
  engine.update(0.2, calmSea, boat, frame, fairWeather);

  // The first sighting fetches the hail and plays it as soon as it is decoded.
  engine.event({ type: 'lookout-sighting', kind: 'land' }, boat);
  assert.ok(fetched.includes('lookout-land-ho'));
  assert.equal(starts.filter(s => s.id === 'lookout-land-ho').length, 0);
  await settle();
  assert.equal(starts.filter(s => s.id === 'lookout-land-ho').length, 1);
  assert.equal(fetched.filter(id => id === 'lookout-land-ho').length, 1);

  // A clip that is ready only after its moment has passed is not played late, but is ready the next time.
  engine.event({ type: 'indigenous-voice', cultureId: 'maya_pole', position: { x: 5, y: 2, z: 0 } }, boat);
  contexts[0].currentTime += 3;
  await settle();
  assert.equal(starts.filter(s => s.id === 'indigenous-maya').length, 0);
  engine.event({ type: 'indigenous-voice', cultureId: 'maya_pole', position: { x: 5, y: 2, z: 0 } }, boat);
  assert.equal(starts.filter(s => s.id === 'indigenous-maya').length, 1, 'decoded, it starts at once');

  // The first order of a fight fetches what the fight will want, before it is wanted.
  assert.ok(!fetched.some(id => id.startsWith('captain-guns-lay-')));
  engine.gunneryOrder('prepare', boat);
  for (const id of every.filter(id => id.startsWith('captain-guns-lay-') || id.startsWith('enemy-') || ['timber-crumble', 'stone-crumble', 'mast-snap'].includes(id))) {
    assert.equal(fetched.filter(f => f === id).length, 1, `${id} is fetched with the first gunnery order`);
  }
  await settle();
  for (let i = 0; i < 40; i++) engine.update(0.1, calmSea, boat, frame, fairWeather);
  boat.gunneryElevation = 2;
  assert.equal(engine.gunneryOrder('fire-port', boat), true);
  assert.equal(starts.filter(s => s.id === 'captain-guns-lay-port-elev-2').length, 1, 'so the laying order is spoken the moment it is given');

  // A clip that cannot be had is reported as missing, and tried again when sound is next enabled.
  failing.add('shore-birds');
  const coast = { height: x => (x > 35 ? 6.0 : -4.0) };
  for (let i = 0; i < 4; i++) { engine.update(0.25, calmSea, boat, frame, fairWeather, [], { terrain: coast }); await settle(); }
  assert.equal(statuses.at(-1).missing, 1);
  failing.clear();
  await engine.toggle();
  await engine.toggle();
  assert.equal(statuses.at(-1).missing, 0);
  for (let i = 0; i < 4; i++) { engine.update(0.25, calmSea, boat, frame, fairWeather, [], { terrain: coast }); await settle(); }
  assert.equal(fetched.filter(id => id === 'shore-birds').length, 2);
  assert.equal(statuses.at(-1).missing, 0);
});

test('a loudness trim above one does not flatten a broadside to the level of a single gun', async t => {
  const { engine, starts } = await enabledEngine(t);
  const boat = { x: 0, z: 0, heave: 0, length: 24, showProw: true, enabled: true };
  const frame = frameAt({ y: 2 }), gun = { x: 0, y: 2, z: 0 };
  const fire = guns => {
    const from = starts.length;
    for (let i = 0; i < guns; i++) engine.gunneryEvent({ type: 'shot', shotId: 1000 * guns + i, position: gun });
    engine.update(0.05, calmSea, boat, frame, fairWeather);
    engine.update(1, calmSea, boat, frame, fairWeather);
    const reports = starts.slice(from).filter(s => s.id === 'cannon-report');
    assert.equal(reports.length, 1, 'guns fired together are one report');
    return reports[0].gain;
  };
  const one = fire(1), four = fire(4);
  assert.ok(soundcraftLufsTrim('cannon-report') > 2, 'the report is trimmed up by more than double');
  assert.ok(Math.abs(one - 0.43 * soundcraftLufsTrim('cannon-report')) < 1e-6, `one gun plays at its own gain times the trim (${one})`);
  assert.ok(Math.abs(four / one - 0.66 / 0.43) < 1e-6, `four guns together are louder than one, as the gunnery mix asks (${four} against ${one})`);
});

test('cries from the garrison are dropped while sound is off, not kept to play when it comes on', async t => {
  const audio = installMockAudioContext(t);
  const engine = createSceneAudio();
  const garrison = { soldiers: [] };
  const fort = { state: { garrisons: [garrison] } };
  const fall = () => garrisonSoldierFalls(null, { sex: 'male', casualtyState: 'able', lx: 2, ly: 8, lz: -3 }, { x: 5, z: 0, yaw: 0 }, false, garrison);
  const boat = { x: 0, z: 0, heave: 0, length: 24, showProw: true, enabled: true };
  const frame = frameAt({ y: 2 });
  const step = () => engine.update(0.1, calmSea, boat, frame, fairWeather, [], { fortSoldiers: fort });

  // Sound has never been enabled; men fall from the rampart for a minute.
  for (let i = 0; i < 60; i++) { fall(); step(); }
  assert.equal(garrison.audioEvents.length, 0, 'the queue is emptied each frame while nothing can be heard');

  await engine.toggle();
  for (let i = 0; i < 20; i++) step();
  assert.equal(audio.starts.filter(s => s.id.startsWith('scream-')).length, 0, 'no old scream plays when sound is enabled');

  fall();
  for (let i = 0; i < 20; i++) step();
  assert.equal(audio.starts.filter(s => s.id.startsWith('scream-')).length, 1, 'a man falling now is heard');
  assert.equal(garrison.audioEvents.length, 0);

  // Muted again by the listener: the same.
  await engine.toggle();
  for (let i = 0; i < 5; i++) { fall(); step(); }
  assert.equal(garrison.audioEvents.length, 0);
});
