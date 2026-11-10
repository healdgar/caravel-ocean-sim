import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  SOLIDCRAFT_ORDNANCE_ORACLE,
  solidcraftBarrelMassKg,
  createGunneryState,
} from '../js/gunnery-state.js';
import { CAIRN_ARCHITECTURAL_TEMPLATES } from '../js/cairn-primitives.js';
import { SOUNDCRAFT_LUFS_AUDIT, soundcraftLufsTrim } from '../js/audio.js';
import { SOUND_ASSETS } from '../js/audio-assets.js';
import { VOICE_ASSETS } from '../js/voice-assets.js';
import { GUNNERY_AUDIO_ASSETS } from '../js/gunnery-audio-assets.js';
import { WORLD_AUDIO_ASSETS } from '../js/world-audio-assets.js';
import { VECTORCRAFT_FLEUR_DE_LIS_PATH } from '../js/voyage/chart-drawer.js';
import { CADCRAFT_TRACE_ITALIENNE_RATIOS, squareFortPlan } from '../js/fort-plan.js';

// Each authoring tool leaves a record beside its source file. These tests hold the game's own numbers to those
// records: a mass, a loudness, a wall, a colour. A record that only exists proves nothing, so none is tested for
// existing except where another record names it.
const readJson = file => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

test('Workflow 1 (SolidCraft): CAD physical oracle & belfry bronze bell geometry', () => {
  const oracleJson = readJson('assets/artcraft/solidcraft-ordnance-oracle.json');

  const barrelBody = oracleJson.bodies.find((b) => b.name === 'DemiCulverinBarrel');
  const bellBody = oracleJson.bodies.find((b) => b.name === 'ShipsWatchBell');
  assert.ok(
    Math.abs(barrelBody.mass_g / 1000 - SOLIDCRAFT_ORDNANCE_ORACLE.demiCulverin9lb.massKg) < 0.05,
    'Demi-culverin CAD mass matches gunnery-state oracle (~1346.39 kg)'
  );
  assert.ok(
    Math.abs(bellBody.mass_g / 1000 - SOLIDCRAFT_ORDNANCE_ORACLE.shipsWatchBell.massKg) < 0.05,
    'Ships watch bell CAD mass matches oracle (~32.86 kg)'
  );

  const demiMass = solidcraftBarrelMassKg(9, 'cannon');
  const swivelMass = solidcraftBarrelMassKg(1, 'swivel');
  assert.ok(Math.abs(demiMass - barrelBody.mass_g / 1000) < 60, `A 9-lb gun weighs what the CAD barrel weighs (${demiMass} kg against ${barrelBody.mass_g / 1000})`);
  assert.ok(swivelMass >= 55 && swivelMass <= 180, `Expected swivel mass <180kg, got ${swivelMass}`);

  const gunnery = createGunneryState([{ id: 'port-1', side: 'port', calibre: 9, kind: 'cannon' }]);
  assert.ok(gunnery.guns.length > 0, 'Caravel has guns');
  for (const gun of gunnery.guns) {
    assert.ok(Number.isFinite(gun.breechMass) && gun.breechMass > 1300);
    assert.equal(gun.trunnionBalanceRatio, SOLIDCRAFT_ORDNANCE_ORACLE.demiCulverin9lb.trunnionBalanceRatio);
  }

  // Verify belfry_stage includes the SolidCraft-proportioned bronze church bell
  const belfryChildren = CAIRN_ARCHITECTURAL_TEMPLATES.catedral_basilica.shapes.belfry_stage.children;
  const bellCylinders = belfryChildren.filter((c) => c.primitive === 'cylinder' && c.material === 'iron');
  assert.equal(bellCylinders.length, 2, 'Expected 2 tapered iron/bronze bell frustums in belfry_stage');
});

// The canvas size a WebP file declares, whichever of its three encodings it uses.
function webpSize(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === 'VP8L') { const bits = buf.readUInt32LE(21); return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]; }
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  throw new Error('Not a WebP image: ' + kind);
}

test('Workflow 2 & 4 (MaterialCraft + PhotoCraft): the oak albedo the hull loads is a 1024 power-of-two square', () => {
  const buf = fs.readFileSync(path.resolve('assets/caravel-oak-albedo.webp'));
  const [width, height] = webpSize(buf);
  assert.deepEqual([width, height], [1024, 1024], 'mipmaps and wrapping need a power-of-two square');
  assert.ok(buf.length < 400_000, `the optimised file stays small (${buf.length} bytes)`);
  assert.ok(fs.readFileSync(path.resolve('js/main.js'), 'utf8').includes('assets/caravel-oak-albedo.webp'), 'and it is the file the game fetches');
});

test('Workflow 5 (SoundCraft): the loudness trims the engine applies are the ones that were measured', () => {
  const audit = readJson('assets/artcraft/soundcraft-loudness-audit.json');
  const playable = { ...SOUND_ASSETS, ...VOICE_ASSETS, ...GUNNERY_AUDIO_ASSETS, ...WORLD_AUDIO_ASSETS };

  // The table in js/audio.js is a copy of the audit. Neither may say what the other does not.
  const measured = Object.fromEntries(Object.entries(audit.clips).map(([id, clip]) => [id, {
    lufs: clip.lufs, peakDb: clip.peakDb, truePeakDb: clip.truePeakDb, targetLufs: clip.targetLufs, trimGain: clip.trimGain,
  }]));
  assert.deepEqual(JSON.parse(JSON.stringify(SOUNDCRAFT_LUFS_AUDIT)), measured);

  const TRUE_PEAK_CEILING_DB = -1;
  for (const [id, clip] of Object.entries(audit.clips)) {
    // What was measured is a clip the game plays, at the length the game believes it has.
    assert.ok(playable[id], `${id} is a clip the engine can play`);
    assert.equal(clip.file, playable[id].url, `${id} was measured from the file that is played`);
    assert.equal(clip.seconds, playable[id].seconds);
    assert.ok(fs.statSync(path.resolve(clip.file)).size > 0);
    // A trim raises a clip to its target loudness, but never so far that its true peak passes the ceiling.
    const trimDb = 20 * Math.log10(clip.trimGain);
    const wanted = Math.min(clip.targetLufs - clip.lufs, TRUE_PEAK_CEILING_DB - clip.truePeakDb);
    assert.ok(Math.abs(trimDb - wanted) < 0.01, `${id}: trim of ${trimDb.toFixed(3)} dB against ${wanted.toFixed(3)} dB by the rule`);
    assert.ok(Math.abs(trimDb - clip.appliedTrimDb) < 0.01, `${id}: gain and decibels agree`);
    assert.ok(clip.truePeakDb + trimDb <= TRUE_PEAK_CEILING_DB + 0.01, `${id} cannot clip at full gain`);
    assert.equal(soundcraftLufsTrim(id), clip.trimGain);
  }
  assert.equal(soundcraftLufsTrim('wind-steady'), 1, 'a clip that was not measured is left as it is');
  assert.equal(soundcraftLufsTrim('no-such-clip'), 1);
  // The quiet report is brought up furthest: more than doubled, and by more than the recoil that follows it.
  assert.ok(soundcraftLufsTrim('cannon-report') > 2 && soundcraftLufsTrim('cannon-report') > soundcraftLufsTrim('cannon-recoil'));
});

test('Workflow 6 (VectorCraft + CADCraft): 1550 compass rose SVG & trace italienne fort plan', () => {
  const svgContent = fs.readFileSync(path.resolve('assets/artcraft/compass-rose-1550.svg'), 'utf8');
  assert.ok(svgContent.includes(VECTORCRAFT_FLEUR_DE_LIS_PATH), 'the chart draws the fleur-de-lis that was drawn for it');

  // The CAD drawing is of a fort fifty metres square. The plan the game lays for that size is the same fort.
  const drawing = readJson('assets/artcraft/fort-trace-italienne-inspect.json');
  const drawn = (layer, type) => drawing.entities.filter(e => e.layer === layer && e.type === type).map(e => e.geometry);
  const plan = squareFortPlan(50, 50);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const samePoint = (p, [x, z]) => near(p.x, x) && near(p.y, z);
  const circles = drawn('BASTION', 'Circle');
  assert.equal(circles.length, plan.bastions.length);
  for (const bastion of plan.bastions) {
    const circle = circles.find(c => samePoint(c.center, bastion));
    assert.ok(circle, `the drawing has a bastion at ${bastion}`);
    assert.ok(near(circle.radius, plan.bastionRadius), `of radius ${plan.bastionRadius}`);
  }
  const walls = drawn('CURTAIN', 'Line');
  // Every span of wall, the gate curtain broken where the gate stands.
  for (const [from, to] of plan.wallSpans) {
    assert.ok(walls.some(l => (samePoint(l.a, from) && samePoint(l.b, to)) || (samePoint(l.a, to) && samePoint(l.b, from))), `the drawing has the wall ${from} to ${to}`);
  }
  for (const post of drawn('GATE', 'Line')) assert.ok(near(Math.abs(post.a.x), plan.gateHalfWidth), 'the gate is as wide as the gap left for it');
  const apron = drawn('GATE', 'Polyline')[0].vertices.map(v => v.p);
  assert.equal(apron.length, plan.gateApron.length);
  for (const corner of plan.gateApron) assert.ok(apron.some(p => samePoint(p, corner)), `the drawing has the gate apron corner ${corner}`);
  const corner = 25 * CADCRAFT_TRACE_ITALIENNE_RATIOS.cornerInsetRatio;
  assert.ok(plan.bastions.every(([x, z]) => near(Math.abs(x), corner) && near(Math.abs(z), corner)), 'bastions stand at the inset corners');

  // A compact fort keeps its cottages inside the curtain wall.
  for (const [cx, cz] of plan.cottageSlots) {
    assert.ok(
      Math.abs(cx) <= corner - CADCRAFT_TRACE_ITALIENNE_RATIOS.wallClearanceM,
      `Cottage x=${cx} must sit inside curtain wall ${corner}`
    );
    assert.ok(
      Math.abs(cz) <= corner - CADCRAFT_TRACE_ITALIENNE_RATIOS.wallClearanceM,
      `Cottage z=${cz} must sit inside curtain wall ${corner}`
    );
  }
});

test('Workflow 7 (FigCraft): the page declares each design token with the value the design gives it', () => {
  const spec = readJson('assets/artcraft/waterworld-ui-spec.json');
  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  // rgba(22, 17, 12, 0.92) in the design is rgba(22,17,12,.92) in minified CSS.
  const plain = value => value.replace(/\s+/g, '').toLowerCase().replace(/(^|[^0-9])0\./g, '$1.');
  const declared = new Map([...html.matchAll(/(--ww-[a-z-]+):([^;}]+)[;}]/g)].map(m => [m[1], plain(m[2])]));
  for (const [token, value] of Object.entries(spec.tokens)) {
    assert.equal(declared.get(token), plain(value), `${token} in index.html`);
  }
  // The design's own nodes use those tokens, and so does the page.
  assert.equal(spec.nodes.title.wrapStyle, spec.tokens['--ww-title-wrap']);
  assert.equal(spec.nodes.body.wrapStyle, spec.tokens['--ww-body-wrap']);
  assert.equal(spec.nodes.modal.cornerRadius + 'px', spec.tokens['--ww-hud-radius']);
  for (const token of ['--ww-title-wrap', '--ww-body-wrap']) {
    assert.ok(html.includes(`text-wrap:var(${token},${spec.tokens[token]})`), `text is wrapped by ${token}`);
  }
  // The design file and mock-up the record names are the ones kept beside it.
  for (const file of [spec.file, spec.mockup]) assert.ok(fs.statSync(path.resolve(file)).size > 1000, file);
});
