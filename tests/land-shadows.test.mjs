import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitLandShadow, landShadowRadiusStep, landShadowRelief, LAND_SHADOW_RADII, LAND_SHADOW_RESOLUTION } from '../js/shadows.js';
import { SHADOW_SAMPLE } from '../js/wgsl/shadows.js';
import { TERRAIN } from '../js/wgsl/terrain.js';
import { FOREST_CLUSTER_SELECT, FOREST_CLUSTER_SHADOW_WGSL } from '../js/forest-clusters.js';

const RESOLUTION = LAND_SHADOW_RESOLUTION;
const sunAt = (elevation, azimuth = 0.7) => {
  const e = elevation * Math.PI / 180;
  return [Math.cos(e) * Math.cos(azimuth), Math.sin(e), Math.cos(e) * Math.sin(azimuth)];
};
const camera = (x, z, yaw = 0.4) => ({ x, y: 8, z, forward: [Math.cos(yaw), 0, Math.sin(yaw)] });
// Where the fitted box puts a world point: x and y from -1 to 1 across the map, z from 0 to 1 in depth.
function project(frame, [x, y, z]) {
  const p = [x - frame[16], y - frame[17], z - frame[18]];
  return [0, 1, 2].map((row) => frame[row] * p[0] + frame[row + 4] * p[1] + frame[row + 8] * p[2] + frame[row + 12]);
}
const texelOf = (frame, point) => project(frame, point).slice(0, 2).map((v) => (v * 0.5 + 0.5) * RESOLUTION);

test('the land shadow map keeps its texels on the same ground as the camera moves and turns', () => {
  const sun = sunAt(37), point = [1012.3, 4.1, -5871.9];
  const phases = [];
  // The walk crosses several of the 64 m cells the uniform's origin snaps to, and the camera turns as it goes.
  for (let step = 0; step < 40; step++) {
    const frame = fitLandShadow(new Float32Array(28), camera(940 + step * 7.3, -5900 + step * 3.1, step * 0.21), 2, sun, RESOLUTION, 185);
    phases.push(texelOf(frame, point).map((v) => v - Math.floor(v)));
  }
  for (const phase of phases) for (const axis of [0, 1]) {
    const drift = Math.abs(phase[axis] - phases[0][axis]);
    assert.ok(Math.min(drift, 1 - drift) < 0.02, `a fixed point slid ${drift.toFixed(3)} of a texel across the map`);
  }
});

test('a low sun spends the map on ground, and a high sun still holds the whole disc', () => {
  for (const [elevation, least] of [[12, 0.5], [20, 0.6], [45, 0.75], [80, 0.75]]) {
    const cam = camera(300, -200), sun = sunAt(elevation), radius = 185;
    const frame = fitLandShadow(new Float32Array(28), cam, 0, sun, RESOLUTION, radius);
    const centre = [cam.x + cam.forward[0] * radius * 0.45, 0, cam.z + cam.forward[2] * radius * 0.45];
    let low = Infinity, high = -Infinity;
    for (let i = 0; i < 64; i++) {
      const angle = i * Math.PI / 32, at = project(frame, [centre[0] + Math.cos(angle) * radius, 0, centre[2] + Math.sin(angle) * radius]);
      assert.ok(Math.abs(at[0]) <= 1.001 && Math.abs(at[1]) <= 1.001 && at[2] >= 0 && at[2] <= 1, `the disc's rim leaves the box at ${elevation} degrees`);
      low = Math.min(low, at[1]); high = Math.max(high, at[1]);
    }
    assert.ok((high - low) / 2 >= least, `level ground fills only ${((high - low) / 2 * 100).toFixed(0)}% of the rows at ${elevation} degrees`);
  }
});

test('ground far above and below the camera stays inside the box when the relief is given', () => {
  const cam = camera(0, 0), radius = 260, sun = sunAt(28, 2.1);
  const frame = fitLandShadow(new Float32Array(28), cam, 140, sun, RESOLUTION, radius, true, 0, 420);
  const centre = [cam.x + cam.forward[0] * 115, cam.z + cam.forward[2] * 115];
  for (const height of [0, 140, 420, 460]) for (let i = 0; i < 16; i++) {
    const angle = i * Math.PI / 8, at = project(frame, [centre[0] + Math.cos(angle) * radius, height, centre[1] + Math.sin(angle) * radius]);
    assert.ok(Math.abs(at[0]) <= 1.001 && Math.abs(at[1]) <= 1.001 && at[2] >= 0 && at[2] <= 1, `height ${height} m falls outside the box`);
  }
  assert.equal(frame[26], 1, 'the frame marks itself as the land map');
  assert.ok(Math.abs(frame[23] * Math.hypot(frame[2], frame[6], frame[10]) - 1) < 1e-5, 'the stored depth is the box\'s depth in metres');
});

test('the relief is read across the whole disc ahead of the camera', () => {
  const cam = camera(100, 50, 0), radius = 185;
  const hill = (x, z) => Math.max(0, 90 - Math.hypot(x - (100 + radius * 0.45 + 150), z - 50));
  const [low, high] = landShadowRelief(hill, cam, radius);
  assert.equal(low, 0);
  assert.ok(high > 50, `a hill 150 m from the box's centre was read as ${high} m`);
  assert.deepEqual(landShadowRelief(() => NaN, cam, radius), [NaN, NaN]);
});

test('the box changes size at a few heights and does not flick between two', () => {
  assert.equal(landShadowRadiusStep(120), LAND_SHADOW_RADII[0]);
  assert.equal(landShadowRadiusStep(1000), LAND_SHADOW_RADII.at(-1));
  let held = 0, changes = 0;
  // A camera bobbing across the first step's edge.
  for (let i = 0; i < 200; i++) {
    const next = landShadowRadiusStep(185 + Math.sin(i) * 4, held);
    if (next !== held) changes++;
    held = next;
  }
  assert.ok(changes <= 2, `the radius changed ${changes} times`);
  assert.equal(landShadowRadiusStep(170, 220), 185, 'a camera that has come well down gets the finer box back');
});

test('a ship keeps its full shadow filter and the land map takes four taps', () => {
  const body = SHADOW_SAMPLE.slice(SHADOW_SAMPLE.indexOf('fn vesselShadow('), SHADOW_SAMPLE.indexOf('fn waterVesselShadow('));
  assert.match(body, /let isLand=SH\.texel\.z>0\.5;/);
  assert.match(body, /normal\*facing\*select\(0\.008,0\.005,isLand\)\+SH\.sun\.xyz\*select\(0\.006,0\.004,isLand\)/, 'a ship\'s receivers keep the offset they were tuned with');
  assert.match(body, /clamp\(distance\*0\.004675\/SH\.texel\.xy,vec2f\(1\.5\),vec2f\(6\.0\)\)/, 'a ship\'s penumbra is never narrower than the filter was designed for');
  assert.match(body, /corner<4u&&!isLand/, 'the land map skips the blocker search');
  assert.ok(body.indexOf('if(isLand){result+=vec3f(solid*weight);continue;}') < body.indexOf('textureSampleCompareLevel(canvasShadow'), 'the land map reads no cloth');
});

test('land is shaded by whichever light the map was drawn from, and trees cast where they stand', () => {
  const finish = TERRAIN.slice(TERRAIN.indexOf('fn landFinishShadowed('), TERRAIN.indexOf('fn landFinish('));
  assert.match(finish, /sunIlluminance\(\)\*sunlight\*solarShadowVisibility\(vec3f\(shadowVis\)\)\.x/);
  assert.match(finish, /lunarSurface\([^;]*lunarShadowVisibility\(vec3f\(shadowVis\)\)\);/);
  const shadow = TERRAIN.slice(TERRAIN.indexOf('@vertex fn treeShadowVS('));
  const colour = TERRAIN.slice(TERRAIN.indexOf('@vertex fn treeVS('), TERRAIN.indexOf('@vertex fn groundVS('));
  assert.match(shadow, /treeWorld\(position,root,shape\)/, 'the shadow pass places a tree as the colour pass does');
  assert.match(colour, /o\.world=treeWorld\(position,root,shape\)/);
  const canopy = TERRAIN.slice(TERRAIN.indexOf('let beyondShadowMap='), TERRAIN.indexOf('let diffuse=', TERRAIN.indexOf('let beyondShadowMap=')));
  assert.match(canopy, /1\.0-landShadowCoverage\(world\)/, 'the stand-in canopy shade applies only where the map does not reach');
  assert.match(canopy, /beyondShadowMap>0\.0\)\{[^}]*vegetationMask/, 'and its texture is read only there');
});

test('forest shadow casters are chosen from every tree against the light box, not from the camera\'s lists', () => {
  const select = FOREST_CLUSTER_SELECT('');
  const body = select.slice(select.indexOf('fn forestClusterShadowSelect('), select.indexOf('fn forestClusterReset('));
  assert.ok(body.length > 200);
  assert.ok(!/\bvisible\[|\bcommands\[|F\.viewProj/.test(body), 'the shadow cut must not depend on what the camera can see');
  assert.match(body, /shadowBox\.lightView/);
  assert.match(body, /bucket\.capacity\.y\+id\.x/, 'it walks every root of the species');
  assert.ok(!/dCam|24025/.test(FOREST_CLUSTER_SHADOW_WGSL), 'no caster is rejected one vertex at a time');
  assert.match(FOREST_CLUSTER_SHADOW_WGSL, /@fragment fn forestClusterLeafShadowFS[^}]*discard/, 'leaves cast through their outlines');
});

test('the land shadow map is 2048 square on every device: 16 MiB, not 64', () => {
  assert.equal(LAND_SHADOW_RESOLUTION, 2048);
  assert.equal(LAND_SHADOW_RESOLUTION ** 2 * 4 / 2 ** 20, 16);
  const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  assert.match(main, /createLandShadows\(device\)/, 'the game asks for the default size, with no larger map for desktops');
});
