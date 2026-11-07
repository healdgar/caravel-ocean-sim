import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
} from '../js/audio.js';
import { applyCrewCasualtiesAndMorale } from '../js/gunnery-control.js';
import { garrisonSoldierFalls } from '../js/crew.js';
import { crewThrowFromMast } from '../js/crew-aloft.js';
import { createTownShots } from '../js/town-shots.js';

const audioPoint = { x: 0, y: 2, z: 0 };

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

function installMockAudioContext(t) {
  const originalAudio = globalThis.AudioContext;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.AudioContext = originalAudio;
    globalThis.fetch = originalFetch;
  });
  const starts = [];
  const params = [];
  const parameter = () => ({
    value: 0,
    setValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; params.push(v); },
    linearRampToValueAtTime(v) { this.value = v; },
    exponentialRampToValueAtTime(v) { this.value = v; },
  });
  const node = () => ({ connect(target) { return target; }, disconnect() {} });
  class MockAudioContext {
    state = 'suspended';
    currentTime = 0;
    destination = node();
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
      return {
        ...node(),
        loop: false,
        playbackRate: parameter(),
        connect(target) { this.level = target.gain; return target; },
        start() {
          starts.push({ loop: this.loop, url: this.buffer?.url ?? '', level: this.level });
          if (!this.loop) this.onended?.();
        },
        stop() { this.onended?.(); },
      };
    }
    async decodeAudioData(bytes) {
      return { duration: 1, url: new TextDecoder().decode(bytes) };
    }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    async close() { this.state = 'closed'; }
  }
  globalThis.AudioContext = MockAudioContext;
  globalThis.fetch = async url => new Response(String(url));
  return { starts, params };
}

test('promoted world audio SFX and voice assets match provenance and valid MP3 payloads', async () => {
  const provenance = JSON.parse(
    await fs.readFile(new URL('../assets/audio/world/provenance.json', import.meta.url), 'utf8'),
  );
  assert.equal(provenance.length, 27);
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

test('6 & 9. shoreline surf crashing/lapping and shorebirds activate near coast and pan toward land', async t => {
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

  // Verify sceneAudio.update starts shore-surf lazily and triggers shore-birds
  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  assert.equal(starts.filter(s => s.loop).length, 7, 'lazy loops do not start in open ocean');

  const boat = { x: 0, z: 0, length: 24, showProw: true, enabled: true, surgeVelocity: 0, revision: 0 };
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 18, swellHs: 3.5, seabirds: 0.9, sunElev: 25 };
  const weather = { intensity: 0, type: 'off' };
  for (let i = 0; i < 40; i++) {
    engine.update(0.25, p, boat, frame, weather, [], { terrain: coastalTerrain, sunElev: 25 });
  }
  assert.ok(starts.some(s => s.loop && s.url.endsWith('/shore-surf.mp3')), 'shore-surf loop started lazily near coast');
  assert.ok(starts.some(s => s.url.endsWith('/shore-birds.mp3')), 'shore-birds triggered near coast during day');
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
  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const boat = { x: 0, z: 0, length: 24, showProw: true, enabled: true };
  engine.event({ type: 'boarding-round', position: { x: 8, y: 2, z: 0 } }, boat);
  const frame = new Float32Array(32);
  frame[20] = 1;
  engine.update(0.2, { soundVolume: 0.8, windSpeed: 0, seabirds: 0 }, boat, frame, { intensity: 0, type: 'off' });
  assert.ok(starts.some(s => s.url.endsWith('/enemy-boarding-cry.mp3')), 'boarding-round plays enemy-boarding-cry');
});

test('8. Native American languages resolve authentic clips per polity/culture and play near Indigenous settlements or canoes', async t => {
  assert.equal(indigenousVoiceClipForCulture('taino_boriken'), 'indigenous-taino');
  assert.equal(indigenousVoiceClipForCulture('arawak'), 'indigenous-taino');
  assert.equal(indigenousVoiceClipForCulture('kalinago_dominica'), 'indigenous-kalinago');
  assert.equal(indigenousVoiceClipForCulture('powhatan_tsenacommacah'), 'indigenous-algonquian');
  assert.equal(indigenousVoiceClipForCulture('abenaki_wabanaki'), 'indigenous-algonquian');
  assert.equal(indigenousVoiceClipForCulture('tupinamba_guanabara'), 'indigenous-tupinamba');
  assert.equal(indigenousVoiceClipForCulture('maya_pole'), 'indigenous-maya');

  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const boat = { x: 0, z: 0, length: 12, showProw: true, enabled: true };
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 2, seabirds: 0, sunElev: 20 };
  const weather = { intensity: 0, type: 'off' };

  // Explicit diplomatic/trade action voice event
  engine.event({ type: 'indigenous-voice', cultureId: 'maya_pole', position: { x: 15, y: 2, z: 0 } }, boat);
  assert.ok(starts.some(s => s.url.endsWith('/indigenous-maya.mp3')), 'indigenous-voice event plays Yucatec Maya greeting');

  // Ambient settlement voice when moored/approaching an Indigenous polity
  const tainoPort = {
    x: 30,
    z: 0,
    indigenousSettlement: { isSovereignPolity: true, cultureId: 'taino', polityId: 'taino_boriken' },
    instances: [{ x: 30, z: 0 }],
  };
  for (let i = 0; i < 40; i++) {
    engine.update(0.5, p, boat, frame, weather, [], { ports: [tainoPort], sunElev: 20 });
  }
  assert.ok(starts.some(s => s.url.endsWith('/indigenous-taino.mp3')), 'approaching Taíno settlement plays Taíno greeting');
});

test('10. busy towns ambience scales by population and time of day, and switches to panic + alarm bell under bombardment', async t => {
  const port = {
    x: 40,
    z: 0,
    instances: Array.from({ length: 14 }, (_, i) => ({ x: 40 + i * 2, z: 0 })),
    streets: {
      people: Array.from({ length: 10 }, (_, i) => ({ x: 40 + i, z: 2, visible: true })),
      underFireCount: 0,
    },
  };
  const listener = { x: 0, y: 2, z: 0, rightX: 1, rightZ: 0 };

  const dayState = computeTownAmbienceState([port], listener, 25);
  assert.ok(dayState.nearTown, 'nearTown true within 380m');
  assert.ok(dayState.crowdGain > 0.1, 'busy daytime town has strong crowdGain');
  assert.equal(dayState.underFire, false);
  assert.ok(dayState.pan > 0.4, 'town ambience pans toward port');

  const nightState = computeTownAmbienceState([port], listener, -20);
  assert.ok(nightState.crowdGain < dayState.crowdGain * 0.5, 'town is quieter at night');

  // Bombardment via createTownShots.note marks town under fire
  port.streets.window = { x: 40, z: 0, span: 120 };
  const shotResponse = createTownShots(port.streets);
  shotResponse.note([40, 6, 0], [42, 2, 0], { fraction: 1 }, { mass: 8, velocity: [150, -10, 0] });
  assert.ok(port.streets.underFireCount > 0, 'town shot response records underFireCount');

  const bombardedState = computeTownAmbienceState([port], listener, 25);
  assert.equal(bombardedState.underFire, true, 'computeTownAmbienceState detects town under fire');

  // Verify sceneAudio.update starts town-ambience lazily and plays crowd-panic when under fire
  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const boat = { x: 0, z: 0, length: 24, showProw: true, enabled: true };
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 2, seabirds: 0, sunElev: 25 };
  const weather = { intensity: 0, type: 'off' };

  engine.update(0.25, p, boat, frame, weather, [], { ports: [port], sunElev: 25 });
  assert.ok(starts.some(s => s.loop && s.url.endsWith('/town-ambience.mp3')), 'town-ambience loop started lazily near port');
  assert.ok(starts.some(s => s.url.endsWith('/crowd-panic.mp3')), 'bombarded town triggers crowd-panic');
});

test('11. footsteps sync to walker stride steps on ship decks and on shore ground', async t => {
  const memory = new WeakMap();
  const boat = {
    x: 0,
    z: 0,
    heave: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    enabled: true,
    viewStation: 'deck',
    deckWalkSpeed: 2.0,
  };
  const sailor = {
    visible: true,
    casualtyState: 'able',
    walk: 0.8,
    walkTime: 0.1,
    position: [1.5, 0, -2.0],
  };
  const soldier = {
    visible: true,
    casualtyState: 'able',
    walk: 0.7,
    walkTime: 0.1,
    x: 6,
    y: 1,
    z: 0,
  };
  const citizen = {
    visible: true,
    walk: 0.6,
    walkTime: 0.1,
    x: -5,
    y: 1,
    z: 2,
  };
  const listener = { x: 0, y: 2, z: 0 };

  // First sample initializes stride indices
  const first = collectFootstepEvents({
    boat,
    crew: [sailor],
    fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } },
    ports: [{ streets: { people: [citizen] } }],
    listener,
    memory,
    dt: 0.05,
  });
  assert.equal(first.length, 0);

  // Advance walkTime past half-stride boundary (Math.PI)
  sailor.walkTime = 3.5;
  soldier.walkTime = 3.5;
  citizen.walkTime = 3.5;
  const second = collectFootstepEvents({
    boat,
    crew: [sailor],
    fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } },
    ports: [{ streets: { people: [citizen] } }],
    listener,
    memory,
    dt: 0.5,
  });
  assert.ok(second.some(e => e.surface === 'deck'), 'deck footstep emitted on stride boundary');
  assert.ok(second.some(e => e.surface === 'ground'), 'ground footstep emitted on stride boundary');

  // Verify sceneAudio.update plays footstep-deck and footstep-ground
  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 0, seabirds: 0 };
  const weather = { intensity: 0, type: 'off' };
  sailor.walkTime = 0.2;
  soldier.walkTime = 0.2;
  engine.update(0.05, p, boat, frame, weather, [], {
    crew: [sailor],
    fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } },
  });
  sailor.walkTime = 3.6;
  soldier.walkTime = 3.6;
  engine.update(0.2, p, boat, frame, weather, [], {
    crew: [sailor],
    fortSoldiers: { state: { garrisons: [{ soldiers: [soldier] }] } },
  });
  assert.ok(starts.some(s => s.url.endsWith('/footstep-deck.mp3')), 'footstep-deck played');
  assert.ok(starts.some(s => s.url.endsWith('/footstep-ground.mp3')), 'footstep-ground played');
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

  const { starts } = installMockAudioContext(t);
  const engine = createSceneAudio();
  await engine.toggle();
  const frame = new Float32Array(32);
  frame[20] = 1;
  const p = { soundVolume: 0.8, windSpeed: 10, seabirds: 0 };
  const weather = { intensity: 0, type: 'off' };

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

  engine.update(0.2, p, boat, frame, weather, [], {
    rowingEvents: [{ x: 2, z: -1, closingSpeed: 2.2 }],
  });
  assert.ok(starts.some(s => s.url.endsWith('/oar-stroke.mp3')), 'rowing event plays oar-stroke');
  assert.ok(starts.some(s => s.url.endsWith('/sail-luff.mp3')), 'pinching into wind plays sail-luff');
  assert.ok(starts.some(s => s.url.endsWith('/lookout-sail-ho.mp3')), 'ship sighting plays lookout-sail-ho');

  // Whale sighting call
  engine.event({ type: 'lookout-sighting', kind: 'whale' }, boat);
  assert.ok(starts.some(s => s.url.endsWith('/lookout-whale-ho.mp3')), 'whale sighting plays lookout-whale-ho');

  // Land ho sighting call (after advancing past lookout cooldown)
  for (let i = 0; i < 30; i++) engine.update(0.5, p, boat, frame, weather, []);
  engine.event({ type: 'lookout-sighting', kind: 'land' }, boat);
  assert.ok(starts.some(s => s.url.endsWith('/lookout-land-ho.mp3')), 'landfall sighting plays lookout-land-ho');
});
