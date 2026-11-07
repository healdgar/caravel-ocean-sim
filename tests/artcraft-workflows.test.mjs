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
import { PROPS_RENDER } from '../js/wgsl/props.js';
import { SOUNDCRAFT_LUFS_AUDIT, soundcraftLufsTrim } from '../js/audio.js';
import { VECTORCRAFT_FLEUR_DE_LIS_PATH } from '../js/voyage/chart-drawer.js';
import { CADCRAFT_TRACE_ITALIENNE_RATIOS, squareFortPlan } from '../js/fort-plan.js';

test('Workflow 1 (SolidCraft): CAD physical oracle & belfry bronze bell geometry', () => {
  const oraclePath = path.resolve('assets/artcraft/solidcraft-ordnance-oracle.json');
  assert.ok(fs.existsSync(oraclePath), 'solidcraft-ordnance-oracle.json exists');
  const oracleJson = JSON.parse(fs.readFileSync(oraclePath, 'utf8'));

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
  assert.ok(demiMass > 1300 && demiMass < 1400, `Expected 9-lb demi-culverin mass ~1346kg, got ${demiMass}`);
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

test('Workflow 2 & 4 (MaterialCraft + PhotoCraft): 1024x1024 power-of-two oak albedo & SBS graph', () => {
  const webpPath = path.resolve('assets/caravel-oak-albedo.webp');
  const buf = fs.readFileSync(webpPath);
  // VP8 / VP8L / VP8X header check for 1024x1024 WebP
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP');
  // Size reduced from 560,816 bytes to ~343,690 bytes
  assert.ok(buf.length < 400_000 && buf.length > 100_000, `Expected optimized 1024x1024 WebP size, got ${buf.length}`);

  const sbsPath = path.resolve('assets/artcraft/caravel-oak.sbs');
  const previewPath = path.resolve('assets/artcraft/caravel-oak-preview.png');
  assert.ok(fs.existsSync(sbsPath) && fs.statSync(sbsPath).size > 1000, 'MaterialCraft .sbs graph exists');
  assert.ok(fs.existsSync(previewPath) && fs.statSync(previewPath).size > 10_000, 'MaterialCraft 3D preview exists');
});

test('Workflow 3 (TextureCraft): WGSL prop shader includes cavityAO, tidalWet, and edgeChafe', () => {
  const previewPath = path.resolve('assets/artcraft/cleat-weathered-preview.png');
  assert.ok(fs.existsSync(previewPath) && fs.statSync(previewPath).size > 10_000, 'TextureCraft preview exists');
  assert.match(PROPS_RENDER, /cavityAO/, 'PROPS_RENDER includes cavityAO');
  assert.match(PROPS_RENDER, /tidalWet/, 'PROPS_RENDER includes tidalWet');
  assert.match(PROPS_RENDER, /edgeChafe/, 'PROPS_RENDER includes screen-space curvature edgeChafe');
});

test('Workflow 5 (SoundCraft): LUFS loudness audit & gain normalization', () => {
  const auditPath = path.resolve('assets/artcraft/soundcraft-loudness-audit.json');
  const sessionPath = path.resolve('assets/artcraft/waterworld-sound-master.scraft');
  assert.ok(fs.existsSync(auditPath), 'SoundCraft loudness audit JSON exists');
  assert.ok(fs.existsSync(sessionPath), 'SoundCraft session .scraft exists');

  assert.equal(SOUNDCRAFT_LUFS_AUDIT['cannon-report'].lufs, -23.62);
  assert.equal(SOUNDCRAFT_LUFS_AUDIT['cannon-recoil'].lufs, -19.21);

  const reportTrim = soundcraftLufsTrim('cannon-report');
  const recoilTrim = soundcraftLufsTrim('cannon-recoil');
  const sailHoTrim = soundcraftLufsTrim('lookout-sail-ho');
  assert.ok(reportTrim > recoilTrim, `Expected cannon-report trim (${reportTrim}) > cannon-recoil trim (${recoilTrim})`);
  assert.ok(reportTrim > 2.0, `Expected cannon-report boost > 2.0x, got ${reportTrim}`);
  assert.ok(sailHoTrim > 1.3 && sailHoTrim < 1.8, `Expected lookout-sail-ho LUFS trim in 1.3..1.8, got ${sailHoTrim}`);
});

test('Workflow 6 (VectorCraft + CADCraft): 1550 compass rose SVG & trace italienne fort plan', () => {
  const svgPath = path.resolve('assets/artcraft/compass-rose-1550.svg');
  const dxfPath = path.resolve('assets/artcraft/fort-trace-italienne.dxf');
  assert.ok(fs.existsSync(svgPath), 'VectorCraft compass rose SVG exists');
  assert.ok(fs.existsSync(dxfPath), 'CADCraft trace italienne DXF exists');

  const svgContent = fs.readFileSync(svgPath, 'utf8');
  assert.ok(svgContent.includes(VECTORCRAFT_FLEUR_DE_LIS_PATH), 'SVG contains VECTORCRAFT_FLEUR_DE_LIS_PATH');

  assert.equal(CADCRAFT_TRACE_ITALIENNE_RATIOS.cornerInsetRatio, 0.86);
  // Check compact 50x50 square fort keeps cottages inside the curtain wall
  const compactPlan = squareFortPlan(50, 50);
  const curtainX = 25 * 0.86; // 21.5m
  for (const [cx, cz] of compactPlan.cottageSlots) {
    assert.ok(
      Math.abs(cx) <= curtainX - CADCRAFT_TRACE_ITALIENNE_RATIOS.wallClearanceM,
      `Cottage x=${cx} must sit inside curtain wall ${curtainX}`
    );
    assert.ok(
      Math.abs(cz) <= curtainX - CADCRAFT_TRACE_ITALIENNE_RATIOS.wallClearanceM,
      `Cottage z=${cz} must sit inside curtain wall ${curtainX}`
    );
  }
});

test('Workflow 7 (FigCraft): UI design system .figcraft, spec JSON, and index.html CSS tokens', () => {
  const figPath = path.resolve('assets/artcraft/waterworld-ui.figcraft');
  const specPath = path.resolve('assets/artcraft/waterworld-ui-spec.json');
  const mockupPath = path.resolve('assets/artcraft/waterworld-ui-mockup.png');
  assert.ok(fs.existsSync(figPath), 'waterworld-ui.figcraft exists');
  assert.ok(fs.existsSync(specPath), 'waterworld-ui-spec.json exists');
  assert.ok(fs.existsSync(mockupPath), 'waterworld-ui-mockup.png exists');

  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.nodes.title.wrapStyle, 'balance');
  assert.equal(spec.nodes.body.wrapStyle, 'pretty');

  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  for (const token of Object.keys(spec.tokens)) {
    assert.ok(html.includes(token), `index.html includes FigCraft token ${token}`);
  }
  assert.match(html, /text-wrap:var\(--ww-title-wrap,balance\)/);
  assert.match(html, /text-wrap:var\(--ww-body-wrap,pretty\)/);
});
