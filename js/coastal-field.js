// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How the coast shapes the sea around the ship, baked to the GPU. Shelter from land and the
// slope of the seabed take dozens of height lookups a point but change only with the swell's
// direction, so the ocean reads them from here instead of working them out for every pixel.
// The texture wraps around and follows the camera: moving on rebakes only tiles coming into range.
import { COASTAL_FIELD_BAKE, COASTAL_FIELD_SIZE, COASTAL_FIELD_SPAN_M, COASTAL_FIELD_TILE_TEXELS } from './wgsl/terrain.js';

const TILES_PER_SIDE = COASTAL_FIELD_SIZE / COASTAL_FIELD_TILE_TEXELS;
const TILE_COUNT = TILES_PER_SIDE * TILES_PER_SIDE;
const TILE_METRES = COASTAL_FIELD_SPAN_M / TILES_PER_SIDE;
const TILE_WORKGROUPS = COASTAL_FIELD_TILE_TEXELS / 8;
const TILES_PER_FRAME = 8;
const SWELL_TOLERANCE_RADIANS = 3 * Math.PI / 180;

const fieldMod = (value, size) => ((value % size) + size) % size;

// Which tiles need baking for this camera, nearest first. A tile keeps its slot wherever it wraps to.
export function coastalFieldStaleTiles(state, cameraX, cameraZ) {
  const firstX = Math.floor(cameraX / TILE_METRES) - TILES_PER_SIDE / 2, firstZ = Math.floor(cameraZ / TILE_METRES) - TILES_PER_SIDE / 2;
  const stale = [];
  for (let row = 0; row < TILES_PER_SIDE; row++) for (let column = 0; column < TILES_PER_SIDE; column++) {
    const x = firstX + column, z = firstZ + row;
    const slot = fieldMod(x, TILES_PER_SIDE) + TILES_PER_SIDE * fieldMod(z, TILES_PER_SIDE);
    if (state.ownerX[slot] === x && state.ownerZ[slot] === z && state.bakedGeneration[slot] === state.generation) continue;
    stale.push({ slot, x, z, distance: Math.hypot((x + 0.5) * TILE_METRES - cameraX, (z + 0.5) * TILE_METRES - cameraZ) });
  }
  stale.sort((a, b) => a.distance - b.distance);
  return { stale, centreX: (firstX + TILES_PER_SIDE / 2) * TILE_METRES, centreZ: (firstZ + TILES_PER_SIDE / 2) * TILE_METRES };
}
export function createCoastalFieldState() {
  return { generation: 0, ownerX: new Int32Array(TILE_COUNT), ownerZ: new Int32Array(TILE_COUNT), bakedGeneration: new Int32Array(TILE_COUNT).fill(-1) };
}

export async function createCoastalField({ device, computePipe, frameUBO, land, elevationView, nearDomain, nearElevation }) {
  const pipeline = await computePipe(COASTAL_FIELD_BAKE, 'coastal field');
  const texture = (label) => device.createTexture({ label, size: [COASTAL_FIELD_SIZE, COASTAL_FIELD_SIZE], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
  const shelter = texture('coastal field shelter and bed'), slope = texture('coastal field seabed slope');
  const sampler = device.createSampler({ label: 'coastal field', magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  const tileData = new Float32Array(TILE_COUNT * 4);
  const tiles = device.createBuffer({ label: 'coastal field tiles', size: tileData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const windowData = new Float32Array([0, 0, COASTAL_FIELD_SPAN_M / 2, 0]);
  const windowUniform = device.createBuffer({ label: 'coastal field window', size: windowData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'coastal field bake', layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: frameUBO } }, { binding: 1, resource: { buffer: land } }, { binding: 2, resource: elevationView },
    { binding: 3, resource: { buffer: nearDomain } }, { binding: 4, resource: { buffer: nearElevation } }, { binding: 5, resource: { buffer: tiles } },
    { binding: 6, resource: shelter.createView() }, { binding: 7, resource: slope.createView() },
  ] });
  const state = createCoastalFieldState();
  let swellX = 0, swellZ = 0, windowX = NaN, windowZ = NaN;
  return {
    state,
    // The ground changed: everything baked from it is stale.
    invalidate() { state.generation++; },
    // How clear this coast's shallows run, which the water's colour reads alongside the window.
    setClarity(clarity) { windowData[3] = clarity; device.queue.writeBuffer(windowUniform, 0, windowData); },
    encode(pass, frame) {
      // Frame words: camera position 16-18, wind direction 56-57, swell direction 59.
      const swellAngle = frame[59], nextX = Math.abs(swellAngle) > 0.1 ? Math.cos(swellAngle) : frame[56], nextZ = Math.abs(swellAngle) > 0.1 ? Math.sin(swellAngle) : frame[57];
      if (nextX * swellX + nextZ * swellZ < Math.cos(SWELL_TOLERANCE_RADIANS)) { swellX = nextX; swellZ = nextZ; state.generation++; }
      const { stale, centreX, centreZ } = coastalFieldStaleTiles(state, frame[16], frame[18]);
      if (centreX !== windowX || centreZ !== windowZ) {
        windowX = centreX; windowZ = centreZ;
        windowData[0] = centreX; windowData[1] = centreZ;
        device.queue.writeBuffer(windowUniform, 0, windowData);
      }
      if (!stale.length) return;
      // Arriving somewhere new is rebaked at once. Sailing on spreads the work over frames.
      const count = stale.length > TILE_COUNT / 4 ? stale.length : Math.min(stale.length, TILES_PER_FRAME);
      for (let i = 0; i < count; i++) {
        const { slot, x, z } = stale[i], at = i * 4;
        state.ownerX[slot] = x; state.ownerZ[slot] = z; state.bakedGeneration[slot] = state.generation;
        tileData[at] = x * TILE_METRES; tileData[at + 1] = z * TILE_METRES;
        tileData[at + 2] = (slot % TILES_PER_SIDE) * COASTAL_FIELD_TILE_TEXELS; tileData[at + 3] = Math.floor(slot / TILES_PER_SIDE) * COASTAL_FIELD_TILE_TEXELS;
      }
      device.queue.writeBuffer(tiles, 0, tileData, 0, count * 4);
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(TILE_WORKGROUPS, TILE_WORKGROUPS, count);
    },
    waterGroup: (pipe) => device.createBindGroup({ label: 'coastal water', layout: pipe.getBindGroupLayout(2), entries: [
      { binding: 0, resource: shelter.createView() }, { binding: 1, resource: slope.createView() }, { binding: 2, resource: sampler }, { binding: 3, resource: { buffer: windowUniform } },
    ] }),
    destroy() { shelter.destroy(); slope.destroy(); tiles.destroy(); windowUniform.destroy(); },
  };
}
