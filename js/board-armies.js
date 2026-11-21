// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Live 3D GPU-driven field armies, standing royal/noble household hosts, siege lines, and marching columns
// from Castle & Commons (`W.armies`, exposed via `boardLife.armies()`). Every rendered commander and soldier
// is drawn through the One Continuum (`soldier` & `captain` bodies + 3D clothing + strand hair) on the GPU
// with zero fake scenery units: only hosts actually living in `W.armies` exist here, wearing their house's
// heraldic livery (`sigilHue`) and carrying real named Castle & Commons souls clickable in `folkCard`.
import { CREW_ACTOR_FLOATS } from './crew.js';
import { CREW_JOINT_COUNT } from './crew-skeleton.js';
import { createCrewClipPipeline, createCrewClipBatch } from './crew-clip-pose.js';
import { packCrewFaceW } from './crew-components.js';
import { DRESS_MASK_SCALE } from './indigenous-dress.js';
import {
  CREW_CONTINUUM_ORDER_IMPORTANT, createCrewContinuumBatch, loadCrewContinuumBodies, requestCrewContinuumPipelines,
} from './crew-continuum-draw.js';
import { CREW_CONTINUUM_IDENTITY_SHIFT, CREW_CONTINUUM_AGE_SHIFT } from './wgsl/crew-continuum.js';

const MAX_ARMY_SOLDIERS = 256;
const MAX_ARMY_COMMANDERS = 24;
const MAX_SOLDIERS_PER_HOST = 36;
const ARMY_SIGHT_M = 2800;

const BOARD_ARMY_SKIN_TONES = Object.freeze([
  [0.76, 0.45, 0.29], [0.68, 0.38, 0.22], [0.58, 0.30, 0.16], [0.42, 0.19, 0.10], [0.72, 0.41, 0.25],
]);
const BOARD_ARMY_HAIR_TONES = Object.freeze([
  [0.048, 0.025, 0.015], [0.015, 0.012, 0.010], [0.095, 0.048, 0.020], [0.16, 0.085, 0.032], [0.024, 0.018, 0.014],
]);
const BOARD_ARMY_FALLBACK_LIVERY = Object.freeze([
  [0.44, 0.11, 0.09], // Crown crimson
  [0.12, 0.20, 0.36], // Royal blue
  [0.16, 0.28, 0.14], // Forest green
  [0.48, 0.36, 0.11], // Gold ochre
  [0.28, 0.14, 0.32], // Plum purple
  [0.36, 0.22, 0.12], // Russet umber
]);

function boardArmyHashU32(a, b = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

function boardArmyHexToLinearRGB(hex) {
  if (typeof hex !== 'number' || !Number.isFinite(hex)) return null;
  const r = ((hex >>> 16) & 255) / 255;
  const g = ((hex >>> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return [
    Math.max(0.03, Math.min(0.65, toLin(r))),
    Math.max(0.03, Math.min(0.65, toLin(g))),
    Math.max(0.03, Math.min(0.65, toLin(b))),
  ];
}

function boardArmyLiveryForHost(host) {
  const hues = Array.isArray(host.sigilHue) ? host.sigilHue : null;
  const primary = boardArmyHexToLinearRGB(hues?.[0]) ?? BOARD_ARMY_FALLBACK_LIVERY[Math.abs(host.house | 0) % BOARD_ARMY_FALLBACK_LIVERY.length];
  const secondary = boardArmyHexToLinearRGB(hues?.[1]) ?? [primary[0] * 0.45, primary[1] * 0.45, primary[2] * 0.45];
  return { shirt: primary, trousers: secondary };
}

function boardArmyWriteTransform(out, offset, x, y, z, yaw, scale = 1) {
  const c = Math.cos(yaw) * scale, s = Math.sin(yaw) * scale;
  out[offset] = c; out[offset + 1] = 0; out[offset + 2] = -s; out[offset + 3] = 0;
  out[offset + 4] = 0; out[offset + 5] = scale; out[offset + 6] = 0; out[offset + 7] = 0;
  out[offset + 8] = s; out[offset + 9] = 0; out[offset + 10] = c; out[offset + 11] = 0;
  out[offset + 12] = x; out[offset + 13] = y; out[offset + 14] = z; out[offset + 15] = 1;
}

function boardArmyPlaceholderCaptainTex(device) {
  const tex = device.createTexture({
    label: 'board armies placeholder captain tex',
    size: [1, 1],
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, new Uint8Array([128, 128, 128, 255]), { bytesPerRow: 4 }, [1, 1]);
  return tex;
}

export async function createBoardArmies({
  device,
  frameUBO,
  transView,
  skyView,
  sampClamp,
  envCubeView,
  sunVisBuf,
  shadows,
  shader,
  format = 'rgba16float',
  samples = 4,
  shared = null,
  waterOptics = null,
}) {
  const B = GPUBufferUsage;
  const mkBuf = (label, data, usage) => {
    const b = device.createBuffer({ label, size: Math.max(16, data.byteLength), usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };

  const [bodies, pipelines] = await Promise.all([
    loadCrewContinuumBodies(device, ['soldier', 'captain']),
    requestCrewContinuumPipelines({ device, shader, format, samples, waterOptics }),
  ]);
  const [soldierBody, captainBody] = bodies;
  const captainTexture = shared?.captainTexture ?? boardArmyPlaceholderCaptainTex(device);
  const captainTexView = shared?.captainTexView ?? captainTexture.createView();
  const captainSampler = shared?.captainSampler ?? device.createSampler({
    label: 'board armies captain sampler',
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
  });

  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0);
  hullData.set([0, 1, 0, 0], 4);
  hullData.set([0, 0, -1, 0], 8);
  hullData.set([3.6, 12, 1, 1], 12);
  const hullUBO = mkBuf('board armies world hull', hullData, B.UNIFORM);
  const dryMoisture = mkBuf('board armies dry moisture', new Float32Array(16), B.STORAGE);
  const clipPipeline = shared?.clipPipeline ?? await createCrewClipPipeline(device, shader);

  const makeBatch = (label, body, capacity) => {
    const poses = new Float32Array(capacity * CREW_JOINT_COUNT * 16);
    const actors = new Float32Array(capacity * CREW_ACTOR_FLOATS);
    const bones = mkBuf(`${label} joints`, poses, B.STORAGE);
    const actor = mkBuf(`${label} actors`, actors, B.STORAGE);
    const main = [
      { buffer: frameUBO }, { buffer: hullUBO }, { buffer: bones }, { buffer: actor },
      transView, sampClamp, envCubeView, { buffer: sunVisBuf }, { buffer: dryMoisture }, skyView,
      { binding: 13, resource: captainTexView }, { binding: 14, resource: captainSampler },
    ];
    const clip = createCrewClipBatch(device, clipPipeline, body.standIn, bones, capacity, true);
    const cut = createCrewContinuumBatch({
      device, pipelines, body, capacity, samples, frame: frameUBO, hull: hullUBO, bones, actor, main, shadows, ground: true,
    });
    return { body, capacity, actors, bones, actor, clip, cut, people: [], dirty: false };
  };

  const soldierBatch = makeBatch('board armies soldiers', soldierBody, MAX_ARMY_SOLDIERS);
  const captainBatch = makeBatch('board armies commanders', captainBody, MAX_ARMY_COMMANDERS);

  let hostRecords = [];
  let summary = { day: 0, war: false, armiesCount: 0, totalStrength: 0, hosts: [] };
  let simOrigin = { x: 0, z: 0 };
  let worldOffsetX = 0, worldOffsetZ = 0;
  let groundSampler = null;
  let drawEnabled = false;
  let destroyed = false;

  function sampleGround(wx, wz) {
    if (typeof groundSampler === 'function') {
      const y = groundSampler(wx, wz);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  function buildFormations(snapshot, { origin = null, groundAt = null, places = null, furniture = null, solids = null } = {}) {
    if (origin) simOrigin = { x: origin.x ?? 0, z: origin.z ?? 0 };
    if (typeof groundAt === 'function') groundSampler = groundAt;
    const obstacles = Array.isArray(furniture) ? furniture : [];
    const hitSolid = (x, z, pad = 1.2) => {
      if (!solids || typeof solids.near !== 'function') return false;
      const near = solids.near(x, z, pad + 6);
      for (let i = 0; i < near.length; i++) {
        const b = near[i];
        const dx = x - b.x, dz = z - b.z;
        const c = b.c ?? 1, s = b.s ?? 0;
        const lx = Math.abs(dx * c - dz * s);
        const lz = Math.abs(dx * s + dz * c);
        if (lx < b.hx + pad && lz < b.hz + pad) return true;
      }
      return false;
    };
    const clearOfObstacles = (x, z, pad = 2.0) => {
      for (let i = 0; i < obstacles.length; i++) {
        const o = obstacles[i];
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
        const r = Math.max(o.radius ?? 0, (o.w ?? 2.4) * 0.5, (o.d ?? 2.4) * 0.5) + pad;
        if (Math.hypot(x - o.x, z - o.z) < r) return false;
      }
      return !hitSolid(x, z, pad);
    };
    const pushClearOfObstacles = (x, z, pad = 2.2) => {
      let rx = x, rz = z;
      for (let pass = 0; pass < 3; pass++) {
        let hit = false;
        for (let i = 0; i < obstacles.length; i++) {
          const o = obstacles[i];
          if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue;
          const r = Math.max(o.radius ?? 0, (o.w ?? 2.4) * 0.5, (o.d ?? 2.4) * 0.5) + pad;
          const dx = rx - o.x, dz = rz - o.z;
          const d = Math.hypot(dx, dz);
          if (d < r) {
            const nx = d > 1e-3 ? dx / d : 1, nz = d > 1e-3 ? dz / d : 0;
            rx = o.x + nx * (r + 0.5);
            rz = o.z + nz * (r + 0.5);
            hit = true;
          }
        }
        if (solids && typeof solids.near === 'function') {
          const near = solids.near(rx, rz, pad + 6);
          for (let i = 0; i < near.length; i++) {
            const b = near[i];
            const dx = rx - b.x, dz = rz - b.z;
            const c = b.c ?? 1, s = b.s ?? 0;
            const lx = dx * c - dz * s, lz = dx * s + dz * c;
            const penX = (b.hx + pad) - Math.abs(lx), penZ = (b.hz + pad) - Math.abs(lz);
            if (penX > 0 && penZ > 0) {
              let nlx = lx, nlz = lz;
              if (penX < penZ) nlx = (lx >= 0 ? 1 : -1) * (b.hx + pad + 0.4);
              else nlz = (lz >= 0 ? 1 : -1) * (b.hz + pad + 0.4);
              rx = b.x + nlx * c + nlz * s;
              rz = b.z - nlx * s + nlz * c;
              hit = true;
            }
          }
        }
        if (!hit) break;
      }
      return [rx, rz];
    };
    const rawArmies = Array.isArray(snapshot?.armies) ? snapshot.armies : [];
    const ox = simOrigin.x, oz = simOrigin.z;

    const soldiers = [];
    const commanders = [];
    const hosts = [];
    let totalStrength = 0;

    // Sort strongest / active field hosts first so they get full rank allocation.
    const sorted = rawArmies
      .filter((a) => {
        if (!a || a.sea) return false;
        const ax = a.pos?.x ?? a.x, az = a.pos?.z ?? a.z;
        return Number.isFinite(ax) && Number.isFinite(az) && (a.strength > 0 || a.men?.length > 0);
      })
      .sort((a, b) => {
        const aField = a.state === 'march' || a.state === 'battle' || a.state === 'siege' ? 1 : 0;
        const bField = b.state === 'march' || b.state === 'battle' || b.state === 'siege' ? 1 : 0;
        return (bField - aField) || ((b.strength || 0) - (a.strength || 0)) || ((a.id || 0) - (b.id || 0));
      });

    for (let hi = 0; hi < sorted.length; hi++) {
      const a = sorted[hi];
      const ax = a.pos?.x ?? a.x, az = a.pos?.z ?? a.z;
      const strength = Math.max(1, Math.round(a.strength || a.men?.length || 0));
      totalStrength += strength;
      const livery = boardArmyLiveryForHost(a);
      const isMarching = a.state === 'march' || a.state === 'rout';
      const isCombat = a.state === 'battle' || a.state === 'siege';

      let cx = ox + ax;
      let cz = oz + az;
      // When a standing host is garrisoned at its home settlement (idle), muster cleanly on clear ground beside the
      // town gate/plaza rather than stacking inside the settlement's central building footprint.
      if (!isMarching && !isCombat && Array.isArray(places) && a.at != null && places[a.at]) {
        const pl = places[a.at];
        const px = ox + (pl.x ?? 0), pz = oz + (pl.z ?? 0);
        const dFromCenter = Math.hypot(cx - px, cz - pz);
        if (dFromCenter < Math.max(24, (pl.radius || 45) * 0.45) || !clearOfObstacles(cx, cz, 8.5)) {
          const ang = (boardArmyHashU32(a.id || hi, 19) % 360) * (Math.PI / 180);
          // Try a nearby clear plaza offset first (10..18 m beside monument, clear of buildings), then wider muster radius
          let foundClear = false;
          for (const rad of [11, 16, 22, Math.max(38, Math.min(95, (pl.radius || 55) * 0.75))]) {
            for (let tryK = 0; tryK < 12; tryK++) {
              const ta = ang + tryK * (Math.PI / 6);
              const tx = cx + Math.cos(ta) * rad;
              const tz = cz + Math.sin(ta) * rad;
              if (sampleGround(tx, tz) > 1.2 && clearOfObstacles(tx, tz, 6.0)) {
                cx = tx; cz = tz; foundClear = true; break;
              }
            }
            if (foundClear) break;
          }
        }
      }

      const rawTx = a.target?.tx ?? a.tx, rawTz = a.target?.tz ?? a.tz;
      const tx = Number.isFinite(rawTx) ? (ox + rawTx) : cx;
      const tz = Number.isFinite(rawTz) ? (oz + rawTz) : (cz + 10);
      const hdx = tx - cx, hdz = tz - cz;
      const yaw = Math.hypot(hdx, hdz) > 0.5
        ? Math.atan2(hdx, hdz)
        : ((boardArmyHashU32(a.id || hi, 7) % 360) * (Math.PI / 180));
      const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
      const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);

      // Visible formation count scales logarithmically/proportionally to real sim strength
      const roomLeft = MAX_ARMY_SOLDIERS - soldiers.length;
      const desiredCount = Math.min(MAX_SOLDIERS_PER_HOST, Math.max(4, Math.round(strength / 4)));
      const rankCount = Math.min(roomLeft, desiredCount);

      // Commander in front of the formation
      const [cmdX, cmdZ] = pushClearOfObstacles(cx + fwdX * 2.4, cz + fwdZ * 2.4, 1.4);
      const cmdY = sampleGround(cmdX, cmdZ);
      if (commanders.length < MAX_ARMY_COMMANDERS && cmdY > 0.35) {
        const cSeed = boardArmyHashU32(a.commander?.id ?? (a.id * 97 + 1), 31);
        const cmdSoul = a.commander ? {
          id: a.commander.id,
          name: a.commander.name,
          age: a.commander.age ?? 36,
          sex: 'm',
          role: a.commander.role || 'commander',
          host: a.name,
          houseName: a.houseName || '',
          state: a.state,
        } : null;
        commanders.push({
          hostId: a.id,
          hostName: a.name,
          houseName: a.houseName || '',
          state: a.state,
          x: cmdX, y: cmdY, z: cmdZ, yaw,
          baseX: cmdX, baseZ: cmdZ,
          isMarching,
          walk: isMarching ? 1.0 : 0.0,
          walkSpeed: isMarching ? 1.38 : 0.0,
          time: (cSeed % 1000) * 0.01,
          walkTime: (cSeed % 1000) * 0.005,
          identity: (a.commander?.id ?? (a.id * 97 + 1)) & 0x3fff,
          age: Math.max(20, Math.min(65, Math.round(a.commander?.age ?? 38))),
          shirt: livery.shirt,
          trousers: livery.trousers,
          skin: BOARD_ARMY_SKIN_TONES[cSeed % BOARD_ARMY_SKIN_TONES.length],
          hair: BOARD_ARMY_HAIR_TONES[(cSeed >>> 4) % BOARD_ARMY_HAIR_TONES.length],
          face: [1.0, 1.0, 0.002, 1.0],
          scale: 1.03,
          soul: cmdSoul,
          position: [cmdX, cmdY, cmdZ],
          visible: true,
          name: cmdSoul?.name || `Commander of ${a.name}`,
          sex: 'm',
        });
      }

      // Rank-and-file soldiers in formation
      const cols = isMarching ? 4 : isCombat ? Math.min(12, Math.max(6, Math.ceil(rankCount / 2))) : Math.min(8, Math.max(4, Math.ceil(Math.sqrt(rankCount * 1.4))));
      const colSpacing = isMarching ? 1.35 : 1.45;
      const rowSpacing = isMarching ? 1.55 : 1.70;
      const namedMen = Array.isArray(a.men) ? a.men : [];

      for (let si = 0; si < rankCount; si++) {
        const col = si % cols;
        const row = Math.floor(si / cols);
        const lateral = (col - (cols - 1) * 0.5) * colSpacing;
        const back = -row * rowSpacing;
        const sSeed = boardArmyHashU32(a.id * 1009 + si, 53);
        const jitterX = (((sSeed & 255) / 255) - 0.5) * 0.24;
        const jitterZ = ((((sSeed >>> 8) & 255) / 255) - 0.5) * 0.24;
        const rawSx = cx + rightX * (lateral + jitterX) + fwdX * (back + jitterZ);
        const rawSz = cz + rightZ * (lateral + jitterX) + fwdZ * (back + jitterZ);
        const [sx, sz] = pushClearOfObstacles(rawSx, rawSz, 2.0);
        const sy = sampleGround(sx, sz);
        if (sy <= 0.35) continue;

        const mRec = namedMen[si] || null;
        const personId = mRec?.id ?? ((a.id || 1) * 1000 + si + 1);
        const age = Math.max(17, Math.min(55, Math.round(mRec?.age ?? (21 + (sSeed % 22)))));
        const soul = mRec ? {
          id: mRec.id,
          name: mRec.name,
          age,
          sex: 'm',
          role: mRec.merc ? 'mercenary' : (mRec.role || 'soldier'),
          host: a.name,
          houseName: a.houseName || '',
          state: a.state,
        } : null;

        soldiers.push({
          hostId: a.id,
          hostName: a.name,
          houseName: a.houseName || '',
          state: a.state,
          x: sx, y: sy, z: sz, yaw,
          baseX: sx, baseZ: sz,
          isMarching,
          walk: isMarching ? 1.0 : 0.0,
          walkSpeed: isMarching ? 1.38 : 0.0,
          time: (sSeed % 1000) * 0.01,
          walkTime: ((row * 0.14) + ((sSeed >>> 16) % 100) * 0.002),
          identity: personId & 0x3fff,
          age,
          shirt: livery.shirt,
          trousers: livery.trousers,
          skin: BOARD_ARMY_SKIN_TONES[(sSeed >>> 3) % BOARD_ARMY_SKIN_TONES.length],
          hair: BOARD_ARMY_HAIR_TONES[(sSeed >>> 7) % BOARD_ARMY_HAIR_TONES.length],
          face: [0.98 + ((sSeed & 15) / 15) * 0.06, 0.98 + (((sSeed >>> 4) & 15) / 15) * 0.06, 0.001, 0.98],
          scale: 0.96 + (((sSeed >>> 12) & 31) / 31) * 0.08,
          soul,
          position: [sx, sy, sz],
          visible: true,
          name: soul?.name || `Soldier of ${a.name}`,
          sex: 'm',
        });
      }

      hosts.push({
        id: a.id,
        name: a.name,
        house: a.house,
        houseName: a.houseName || '',
        state: a.state,
        standing: Boolean(a.standing),
        strength,
        horses: a.horses || 0,
        supply: a.supply || 0,
        x: cx, y: sampleGround(cx, cz), z: cz,
        yaw,
        drawnMen: rankCount,
        commander: a.commander?.name || null,
      });
    }

    soldierBatch.people = soldiers;
    captainBatch.people = commanders;
    soldierBatch.dirty = true;
    captainBatch.dirty = true;
    hostRecords = hosts;
    summary = {
      day: snapshot?.day ?? 0,
      war: Boolean(snapshot?.war),
      feuds: Array.isArray(snapshot?.feuds) ? snapshot.feuds.length : 0,
      armiesCount: hosts.length,
      totalStrength,
      drawnSoldiers: soldiers.length,
      drawnCommanders: commanders.length,
      hosts,
    };
  }

  function uploadActors(batch) {
    const n = batch.people.length;
    for (let i = 0; i < n; i++) {
      const p = batch.people[i];
      const off = i * CREW_ACTOR_FLOATS;
      boardArmyWriteTransform(batch.actors, off, p.x, p.y, p.z, p.yaw, p.scale);
      batch.actors[off + 16] = p.shirt[0];
      batch.actors[off + 17] = p.shirt[1];
      batch.actors[off + 18] = p.shirt[2];
      batch.actors[off + 19] = 0; // visible, unwounded
      batch.actors[off + 20] = p.trousers[0];
      batch.actors[off + 21] = p.trousers[1];
      batch.actors[off + 22] = p.trousers[2];
      batch.actors[off + 23] = 1;
      batch.actors[off + 24] = p.skin[0];
      batch.actors[off + 25] = p.skin[1];
      batch.actors[off + 26] = p.skin[2];
      batch.actors[off + 27] = 0; // male body
      batch.actors[off + 28] = p.hair[0];
      batch.actors[off + 29] = p.hair[1];
      batch.actors[off + 30] = p.hair[2];
      batch.actors[off + 31] = 0 / DRESS_MASK_SCALE;
      batch.actors[off + 32] = p.face[0];
      batch.actors[off + 33] = p.face[1];
      batch.actors[off + 34] = p.face[2];
      batch.actors[off + 35] = packCrewFaceW(p.face[3], 0, false);
    }
    if (n > 0) {
      device.queue.writeBuffer(batch.actor, 0, batch.actors, 0, n * CREW_ACTOR_FLOATS);
    }
    batch.dirty = false;
  }

  function stepBatch(batch, dt, camera) {
    const n = batch.people.length;
    if (!n) {
      batch.cut.update(0, () => 0, false);
      return false;
    }
    let anyInRange = false;
    let moved = false;
    for (let i = 0; i < n; i++) {
      const p = batch.people[i];
      p.time += dt;
      if (p.isMarching) {
        p.walkTime += dt;
        // Gentle local march-in-column stride oscillation between sim day updates
        const stepOff = Math.sin(p.time * 0.15) * 1.5;
        p.x = p.baseX + Math.sin(p.yaw) * stepOff;
        p.z = p.baseZ + Math.cos(p.yaw) * stepOff;
        p.y = sampleGround(p.x, p.z);
        p.position[0] = p.x; p.position[1] = p.y; p.position[2] = p.z;
        moved = true;
      }
      if (camera && Number.isFinite(camera.x)) {
        const d = Math.hypot(p.x + worldOffsetX - camera.x, p.z + worldOffsetZ - camera.z);
        if (d <= ARMY_SIGHT_M) anyInRange = true;
      } else {
        anyInRange = true;
      }
    }
    if (!anyInRange) {
      batch.cut.update(0, () => 0, false);
      return false;
    }
    if (batch.dirty || moved) uploadActors(batch);

    batch.clip.begin(n);
    for (let i = 0; i < n; i++) {
      const p = batch.people[i];
      batch.clip.set(i, p.time, p.walkTime, p.walk);
    }
    batch.clip.upload();

    batch.cut.update(
      batch.people,
      (p) => (((p.identity + 1) << CREW_CONTINUUM_IDENTITY_SHIFT) | ((p.age & 127) << CREW_CONTINUUM_AGE_SHIFT) | (p.hostId === 0 ? CREW_CONTINUUM_ORDER_IMPORTANT : 0)) >>> 0,
      true,
    );
    return true;
  }

  return {
    get state() { return summary; },
    get hosts() { return hostRecords; },
    setArmies(snapshot, opts = {}) {
      if (destroyed) return;
      buildFormations(snapshot, opts);
    },
    update(dt, camera = null, worldOffset = null) {
      if (destroyed) return;
      if (worldOffset) {
        const nx = worldOffset.x ?? 0, nz = worldOffset.z ?? 0;
        if (nx !== worldOffsetX || nz !== worldOffsetZ) {
          worldOffsetX = nx; worldOffsetZ = nz;
          hullData[16] = nx; hullData[17] = 0; hullData[18] = nz;
          device.queue.writeBuffer(hullUBO, 0, hullData);
        }
      }
      const a = stepBatch(soldierBatch, dt, camera);
      const b = stepBatch(captainBatch, dt, camera);
      drawEnabled = a || b;
    },
    encodePose(pass) {
      if (destroyed || !drawEnabled) return;
      if (soldierBatch.people.length) soldierBatch.clip.encode(pass);
      if (captainBatch.people.length) captainBatch.clip.encode(pass);
      soldierBatch.cut.encodeSelect(pass);
      captainBatch.cut.encodeSelect(pass);
    },
    draw(pass) {
      if (destroyed || !drawEnabled) return;
      soldierBatch.cut.drawOpaque(pass);
      captainBatch.cut.drawOpaque(pass);
    },
    drawShadow(pass) {
      if (destroyed || !drawEnabled) return;
      soldierBatch.cut.drawShadow(pass);
      captainBatch.cut.drawShadow(pass);
    },
    drawSubmerged(pass, above = false) {
      if (destroyed || !drawEnabled) return;
      soldierBatch.cut.drawSubmerged(pass, above);
      captainBatch.cut.drawSubmerged(pass, above);
    },
    continuumDraws() {
      if (destroyed || !drawEnabled) return [];
      return [...soldierBatch.cut.continuumDraws(), ...captainBatch.cut.continuumDraws()];
    },
    locate() {
      return [...captainBatch.people, ...soldierBatch.people];
    },
    destroy() {
      destroyed = true;
      drawEnabled = false;
      hullUBO.destroy();
      dryMoisture.destroy();
      if (!shared?.captainTexture) captainTexture.destroy();
      for (const b of [soldierBatch, captainBatch]) {
        b.clip.destroy();
        b.cut.destroy();
        b.bones.destroy();
        b.actor.destroy();
      }
    },
  };
}
