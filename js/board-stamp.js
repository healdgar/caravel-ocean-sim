// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A board's country, stamped onto the ground's own colours. The ground is painted from its geography; what people
// have made of it (js/old-world-board.js) is laid over that by the GPU, in two passes into the ground's colour
// image: the furlongs, each tinted by its use and softened where it meets its neighbour, with the trodden ground of
// the towns; then every way and roof and watercourse as a line of its own width. JavaScript only sets the tables out
// once. When the model's life changes a field, the same tables are written again and the pass run again.
import { requestOnce } from './gpu-program-cache.js';

export const BOARD_STAMP_WGSL = /* wgsl */`
struct Stamp {
  origin: vec2f,   // the middle of the ground, world metres
  span: f32,       // its side
  cells: f32,      // furlong cells to a side
  image: vec2f,    // texels of the image stamped
  texel: f32,      // metres to a texel
  parcels: f32,
};
struct Parcel {
  tint: vec4f,     // its ground's colour, and how strongly it covers the geography under it
  lie: vec4f,      // cos and sin of the way its strips run, their width in metres, 1 where a hedge bounds it
};
@group(0) @binding(0) var<uniform> stamp: Stamp;
@group(0) @binding(1) var furlongs: texture_2d<u32>;
@group(0) @binding(2) var<storage, read> parcels: array<Parcel>;
@group(0) @binding(3) var town: texture_2d<f32>;
@group(0) @binding(4) var townSampler: sampler;

const TOWN_GROUND = vec3f(0.588, 0.525, 0.431);
const HEDGE = vec3f(0.227, 0.298, 0.173);
const BAULK = vec3f(0.56, 0.52, 0.42);

@vertex fn fieldVS(@builtin(vertex_index) k: u32) -> @builtin(position) vec4f {
  return vec4f(f32((k << 1u) & 2u) * 2.0 - 1.0, f32(k & 2u) * 2.0 - 1.0, 0.0, 1.0);
}

fn furlongAt(cell: vec2i) -> u32 {
  return textureLoad(furlongs, clamp(cell, vec2i(0), vec2i(i32(stamp.cells) - 1)), 0).r;
}

@fragment fn fieldFS(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / stamp.image;
  let world = stamp.origin + (uv - 0.5) * stamp.span;
  let at = uv * stamp.cells - 0.5;
  let base = vec2i(floor(at));
  let f = fract(at);
  let own = furlongAt(vec2i(round(at)));
  var colour = vec3f(0.0);
  var cover = 0.0;
  var weight = 0.0;
  var other = 0.0;
  // The furlongs of the cells round the point, each by how near it is: a bound between two is a soft band a
  // cell and a half wide, not a stair.
  for (var j = -1; j <= 2; j++) {
    for (var i = -1; i <= 2; i++) {
      let d = vec2f(f32(i), f32(j)) - f;
      let w = max(0.0, 1.0 - abs(d.x) / 1.5) * max(0.0, 1.0 - abs(d.y) / 1.5);
      if (w <= 0.0) { continue; }
      let id = furlongAt(base + vec2i(i, j));
      weight += w;
      if (id != own) { other += w; }
      if (id == 0u) { continue; }
      let parcel = parcels[id];
      var tint = parcel.tint.rgb;
      if (parcel.lie.z > 0.0) {
        // Ploughed and planted in strips, along the furlong's own lie.
        let across = dot(world, vec2f(-parcel.lie.y, parcel.lie.x));
        tint *= 1.0 + 0.07 * sin(across * 6.2832 / max(parcel.lie.z, 3.0 * stamp.texel));
      }
      colour += tint * parcel.tint.a * w;
      cover += parcel.tint.a * w;
    }
  }
  var out = vec4f(colour, cover) / max(weight, 1e-4);
  // The bound itself: a hedge where the furlong keeps one, else the pale line of a baulk.
  let mine = parcels[own];
  let bound = smoothstep(0.22, 0.5, other / max(weight, 1e-4)) * step(0.5, f32(own)) * step(0.01, mine.tint.a);
  let line = mix(vec4f(BAULK, 1.0) * 0.3, vec4f(HEDGE, 1.0) * 0.8, mine.lie.w);
  out = mix(out, line + out * (1.0 - line.a), bound);
  // The trodden ground of a town, over whatever its furlong was. The town is known at the ground's own lattice,
  // whose first and last points lie on the ground's edges.
  let lattice = vec2f(textureDimensions(town));
  let urban = smoothstep(0.15, 0.85, textureSampleLevel(town, townSampler, (uv * (lattice - 1.0) + 0.5) / lattice, 0.0).r);
  out = mix(out, vec4f(TOWN_GROUND, 1.0) * 0.82, urban);
  return out;
}

struct Way {
  @builtin(position) position: vec4f,
  @location(0) world: vec2f,
  @location(1) @interpolate(flat) ends: vec4f,
  @location(2) @interpolate(flat) half: f32,
  @location(3) @interpolate(flat) colour: vec4f,
};

// One line of ground: a road, a street, a roof's ridge, a stream. A box round it, a texel and a half to spare.
@vertex fn wayVS(@builtin(vertex_index) k: u32, @location(0) ends: vec4f, @location(1) shape: vec4f, @location(2) colour: vec4f) -> Way {
  let corner = vec2f(f32((0x1cu >> k) & 1u), f32((0x32u >> k) & 1u));
  let along = ends.zw - ends.xy;
  let dir = along / max(length(along), 1e-4);
  let side = vec2f(-dir.y, dir.x);
  let reach = shape.x + 1.5 * stamp.texel;
  let world = mix(ends.xy, ends.zw, corner.x) + dir * (corner.x * 2.0 - 1.0) * reach + side * (corner.y * 2.0 - 1.0) * reach;
  let uv = (world - stamp.origin) / stamp.span + 0.5;
  var out: Way;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.world = world;
  out.ends = ends;
  out.half = shape.x;
  out.colour = colour;
  return out;
}

@fragment fn wayFS(in: Way) -> @location(0) vec4f {
  let along = in.ends.zw - in.ends.xy;
  let t = clamp(dot(in.world - in.ends.xy, along) / max(dot(along, along), 1e-6), 0.0, 1.0);
  let d = distance(in.world, in.ends.xy + along * t);
  // Narrower than a texel, keep road and lane contrast visible across distant settlements.
  let reach = max(in.half, 0.5 * stamp.texel);
  let thin = clamp(in.half / (0.38 * stamp.texel), 0.38, 1.0);
  let alpha = in.colour.a * thin * clamp((reach + 0.5 * stamp.texel - d) / stamp.texel, 0.0, 1.0);
  return vec4f(in.colour.rgb * alpha, alpha);
}
`;

// The colour of each land use's ground (OLD_WORLD_LAND, 0 to 255) and how strongly it covers the geography. A wood
// is left to the forest's own colours, and ground no one holds to the country's.
const BOARD_USE_TINT = [
  [150, 134, 110, 0], // city: laid by the town's own ground
  [84, 104, 52, 0.85], // watered gardens
  [128, 122, 82, 0.8], // olives over dry grass
  [112, 122, 66, 0.8], // vines over pale earth
  [182, 158, 98, 0.88], // ripe corn and stubble
  [136, 104, 74, 0.85], // ploughed fallow
  [154, 142, 92, 0.6], // summer pasture
  [88, 94, 58, 0.5], // scrub
  [40, 70, 34, 0], // wood
];
const BOARD_STRIP_M = [0, 9, 0, 7, 14, 14, 0, 0, 0];
const BOARD_ROAD_TINT = [182, 166, 134, 0.94], BOARD_LANE_TINT = [162, 148, 122, 0.78], BOARD_STREET_TINT = [164, 152, 130, 0.95], BOARD_QUAY_TINT = [174, 164, 148, 0.96], BOARD_SQUARE_TINT = [174, 164, 142, 0.96], BOARD_BRIDGE_TINT = [178, 168, 150, 0.98];
const BOARD_WATER_TINT = [46, 54, 48, 0.82], BOARD_BANK_TINT = [70, 84, 58, 0.5], BOARD_ROOF_TINT = [158, 94, 66, 0.9], BOARD_THATCH_TINT = [164, 142, 92, 0.88];
export const BOARD_WAY_FLOATS = 12;

// The tables the passes read, set out once from what the adapter made (its `stamp`).
export function boardStampTables(board) {
  const parcels = new Float32Array((board.uses.length + 1) * 8);
  board.uses.forEach((use, k) => {
    const tint = BOARD_USE_TINT[use.kind], at = (k + 1) * 8, tone = (0.89 + 0.22 * use.shade) / 255;
    const cover = use.wild ? 0 : tint[3];
    parcels.set([tint[0] * tone, tint[1] * tone, tint[2] * tone, cover,
      Math.cos(use.heading || 0), Math.sin(use.heading || 0), cover > 0 ? BOARD_STRIP_M[use.kind] : 0, use.hedged ? 1 : 0], at);
  });
  const ways = [];
  const way = (ax, az, bx, bz, half, c) => ways.push(ax, az, bx, bz, half, 0, 0, 0, c[0] / 255, c[1] / 255, c[2] / 255, c[3]);
  const line = (points, half, c, stride = 1) => {
    for (let k = stride; k < points.length; k += stride) way(points[k - stride][0], points[k - stride][1], points[k][0], points[k][1], half, c);
    const rest = (points.length - 1) % stride;
    if (rest) { const a = points[points.length - 1 - rest], b = points[points.length - 1]; way(a[0], a[1], b[0], b[1], half, c); }
  };
  const { x: ox, z: oz } = board.origin;
  // Water first and its green banks, then the ways over it, then bridges, squares and roofs.
  for (const river of board.rivers) {
    for (const [colour, widen] of [[BOARD_BANK_TINT, 3.2], [BOARD_WATER_TINT, 1]]) {
      for (let k = 12; k < river.length; k += 12) {
        const a = k - 12, half = (river[a + 2] + river[k + 2]) / 2;
        way(ox + river[a], oz + river[a + 1], ox + river[k], oz + river[k + 1], half * widen + (widen > 1 ? 2 : 0), colour);
      }
    }
  }
  for (const road of board.roads) line(road, 3.4, BOARD_ROAD_TINT, 1);
  for (let k = 0; k < board.lanes.length; k += 4) way(ox + board.lanes[k], oz + board.lanes[k + 1], ox + board.lanes[k + 2], oz + board.lanes[k + 3], 1.6, BOARD_LANE_TINT);
  for (const street of board.streets) {
    const isRoad = street.kind === 'road', isQuay = street.kind === 'quay';
    const colour = isRoad ? BOARD_ROAD_TINT : isQuay ? BOARD_QUAY_TINT : BOARD_STREET_TINT;
    const half = isRoad ? Math.max(street.hw, 3.2) : isQuay ? Math.max(street.hw, 3.4) : street.hw;
    line(street.pts, half, colour);
  }
  for (const br of board.bridges ?? []) {
    const hl = Math.max(3, (br.length || 9) * 0.5);
    way(br.x - br.ux * hl, br.z - br.uz * hl, br.x + br.ux * hl, br.z + br.uz * hl, Math.max(br.halfWidth || 2.5, 2.5), BOARD_BRIDGE_TINT);
  }
  for (const square of board.squares) way(square.x - 0.5, square.z, square.x + 0.5, square.z, square.mean, BOARD_SQUARE_TINT);
  for (const lot of board.lots) {
    // A roof is a line along its ridge, as wide as the house is deep.
    const long = Math.max(lot.w, lot.d), short = Math.min(lot.w, lot.d), run = (long - short) / 2 + 0.01;
    const ux = lot.w >= lot.d ? lot.c : lot.s, uz = lot.w >= lot.d ? -lot.s : lot.c;
    const lit = 0.84 + 0.3 * ((Math.imul(Math.round(lot.x * 7) ^ 0x9e3779b9, Math.round(lot.z * 5) | 1) >>> 8) & 255) / 255;
    const roofTint = lot.thatch ? BOARD_THATCH_TINT : BOARD_ROOF_TINT;
    way(lot.x - ux * run, lot.z - uz * run, lot.x + ux * run, lot.z + uz * run, short / 2, [roofTint[0] * lit, roofTint[1] * lit, roofTint[2] * lit, roofTint[3]]);
  }
  return { parcels, ways: new Float32Array(ways), wayCount: ways.length / BOARD_WAY_FLOATS };
}

const BOARD_STAMP_BLEND = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };

// The two programs, asked for once a device (with the land's other programs, in the opening wave).
export function requestBoardStampPipelines({ device, shader }) {
  return requestOnce(device, 'board stamp', async () => {
    const module = await shader(BOARD_STAMP_WGSL, 'board stamp');
    const targets = [{ format: 'rgba8unorm', blend: BOARD_STAMP_BLEND }];
    return Promise.all([
      device.createRenderPipelineAsync({ label: 'board stamp: furlongs and town ground', layout: 'auto',
        vertex: { module, entryPoint: 'fieldVS' }, fragment: { module, entryPoint: 'fieldFS', targets }, primitive: { topology: 'triangle-list' } }),
      device.createRenderPipelineAsync({ label: 'board stamp: ways, roofs and water', layout: 'auto',
        vertex: { module, entryPoint: 'wayVS', buffers: [{ arrayStride: BOARD_WAY_FLOATS * 4, stepMode: 'instance', attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }, { shaderLocation: 2, offset: 32, format: 'float32x4' }] }] },
        fragment: { module, entryPoint: 'wayFS', targets }, primitive: { topology: 'triangle-list' } }),
    ]);
  });
}

/**
 * Holds one board's tables on the GPU and stamps them onto a ground colour image whenever it is written afresh.
 *   stamp(texture, size)   over mip 0 of an rgba8unorm image `size` texels square that covers the board's ground
 *   dispose()
 */
export async function createBoardStamp({ device, shader, board }) {
  const [fieldPipe, wayPipe] = await requestBoardStampPipelines({ device, shader });
  const tables = boardStampTables(board);
  const uniform = device.createBuffer({ label: 'board stamp', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const furlongs = device.createTexture({ label: 'board furlongs', size: [board.size, board.size], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: furlongs }, board.index, { bytesPerRow: board.size * 2 }, [board.size, board.size]);
  const parcels = device.createBuffer({ label: 'board parcels', size: tables.parcels.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(parcels, 0, tables.parcels);
  const lattice = Math.round(Math.sqrt(board.town.length)), townBytes = new Uint8Array(lattice * lattice);
  for (let k = 0; k < townBytes.length; k++) townBytes[k] = Math.round(255 * Math.max(0, Math.min(1, board.town[k])));
  const town = device.createTexture({ label: 'board town ground', size: [lattice, lattice], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: town }, townBytes, { bytesPerRow: lattice }, [lattice, lattice]);
  const ways = device.createBuffer({ label: 'board ways', size: Math.max(48, tables.ways.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ways, 0, tables.ways);
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const fieldGroup = device.createBindGroup({ layout: fieldPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: furlongs.createView() }, { binding: 2, resource: { buffer: parcels } },
    { binding: 3, resource: town.createView() }, { binding: 4, resource: sampler }] });
  const wayGroup = device.createBindGroup({ layout: wayPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
  return {
    ways: tables.wayCount, parcels: board.uses.length,
    stamp(texture, size) {
      device.queue.writeBuffer(uniform, 0, new Float32Array([board.origin.x, board.origin.z, board.span, board.size, size, size, board.span / size, board.uses.length]));
      const encoder = device.createCommandEncoder({ label: 'board stamp' });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }), loadOp: 'load', storeOp: 'store' }] });
      pass.setPipeline(fieldPipe); pass.setBindGroup(0, fieldGroup); pass.draw(3);
      if (tables.wayCount) { pass.setPipeline(wayPipe); pass.setBindGroup(0, wayGroup); pass.setVertexBuffer(0, ways); pass.draw(6, tables.wayCount); }
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    dispose() { uniform.destroy(); furlongs.destroy(); parcels.destroy(); town.destroy(); ways.destroy(); },
  };
}
