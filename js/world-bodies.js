// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared GPU physical-space body registry (AGENTS.md Rules 1-3): one per GPUDevice.
// Every physical actor on land — the ashore captain, static town-square monuments & stalls,
// grazing & travelling livestock, street mounts, road vehicles, and townsfolk pedestrians —
// occupies a real 2D cylinder/capsule volume in this single 128 KB GPU buffer so both
// `HERDS_STEP_WGSL` and `TOWNSFOLK_WALK` resolve cross-family steering, yielding, hard
// non-penetration, body-turning, and 1:1 horse-rider saddle locking entirely on the GPU.

export const WORLD_BODY_FLOATS = 8; // 2 x vec4f = 32 bytes
export const WORLD_BODY_BYTES = WORLD_BODY_FLOATS * 4;
export const WORLD_BODY_SLOTS = 4096; // 128 KB total VRAM

export const BODY_HEADER_SLOT = 0;
export const BODY_CAPTAIN_SLOT = 1;
export const BODY_STATIC_BASE = 2;
export const MAX_STATIC_BODIES = 510;
export const BODY_HERD_BASE = 512;
export const MAX_HERD_BODIES = 1536;
export const BODY_WALKER_BASE = 2048;
export const MAX_WALKER_BODIES = 1024;
export const BODY_MOUNT_POSE_BASE = 3072;
export const MAX_MOUNT_POSES = 1024;

export const BODY_FLAG_ACTIVE = 1;
export const BODY_FLAG_STATIC = 2;
export const BODY_FLAG_CAPTAIN = 4;
export const BODY_FLAG_HUMAN = 8;
export const BODY_FLAG_ANIMAL = 16;
export const BODY_FLAG_MOUNT = 32;
export const BODY_FLAG_VEHICLE = 64;
export const BODY_FLAG_STOPPED = 128;

export const WORLD_BODY_CAPTAIN_RADIUS = 0.44;

const REGISTRY_BY_DEVICE = new WeakMap();

export function worldBodiesForDevice(device) {
  let reg = REGISTRY_BY_DEVICE.get(device);
  if (reg) return reg;

  const B = globalThis.GPUBufferUsage;
  const buffer = device.createBuffer({
    label: 'world physical bodies',
    size: WORLD_BODY_SLOTS * WORLD_BODY_BYTES,
    usage: B.STORAGE | B.COPY_DST,
  });

  const headerData = new Float32Array(WORLD_BODY_FLOATS);
  const captainData = new Float32Array(WORLD_BODY_FLOATS);
  let captainWasActive = false;
  let lastStaticKey = '';

  const writeHeader = () => {
    device.queue.writeBuffer(buffer, BODY_HEADER_SLOT * WORLD_BODY_BYTES, headerData);
  };

  const zeroSlice = (baseSlot, count) => {
    if (count <= 0) return;
    device.queue.writeBuffer(buffer, baseSlot * WORLD_BODY_BYTES, new Float32Array(count * WORLD_BODY_FLOATS));
  };

  reg = {
    buffer,
    setCaptain(active, x = 0, y = 0, z = 0, yaw = 0, speed = 0) {
      if (!active) {
        if (!captainWasActive) return;
        captainWasActive = false;
        captainData.fill(0);
        device.queue.writeBuffer(buffer, BODY_CAPTAIN_SLOT * WORLD_BODY_BYTES, captainData);
        return;
      }
      captainWasActive = true;
      captainData[0] = x;
      captainData[1] = y;
      captainData[2] = z;
      captainData[3] = WORLD_BODY_CAPTAIN_RADIUS;
      captainData[4] = yaw;
      captainData[5] = 0;
      captainData[6] = speed;
      captainData[7] = BODY_FLAG_ACTIVE | BODY_FLAG_CAPTAIN | (speed < 0.08 ? BODY_FLAG_STOPPED : 0);
      device.queue.writeBuffer(buffer, BODY_CAPTAIN_SLOT * WORLD_BODY_BYTES, captainData);
    },
    setStaticObstacles(furniture, worldOffset = { x: 0, z: 0 }) {
      const list = Array.isArray(furniture) ? furniture : [];
      const ox = worldOffset?.x ?? 0;
      const oz = worldOffset?.z ?? 0;
      const count = Math.min(MAX_STATIC_BODIES, list.length);
      const first = list[0];
      const key = `${count}:${ox.toFixed(1)}:${oz.toFixed(1)}:${first ? `${first.x?.toFixed(1)},${first.z?.toFixed(1)}` : ''}`;
      if (key === lastStaticKey) return;
      lastStaticKey = key;

      const prevCount = Math.round(headerData[0]);
      if (count > 0) {
        const data = new Float32Array(count * WORLD_BODY_FLOATS);
        for (let i = 0; i < count; i++) {
          const f = list[i];
          const o = i * WORLD_BODY_FLOATS;
          const r = f.radius ?? Math.max(1.2, Math.min(f.width ?? 3, f.length ?? 3) * 0.5);
          const hl = f.halfLen ?? Math.max(0, Math.abs((f.length ?? 0) - (f.width ?? 0)) * 0.5);
          data[o] = (f.x ?? 0) + ox;
          data[o + 1] = f.y ?? 0;
          data[o + 2] = (f.z ?? 0) + oz;
          data[o + 3] = r;
          data[o + 4] = f.yaw ?? 0;
          data[o + 5] = hl;
          data[o + 6] = 0;
          data[o + 7] = BODY_FLAG_ACTIVE | BODY_FLAG_STATIC | BODY_FLAG_STOPPED;
        }
        device.queue.writeBuffer(buffer, BODY_STATIC_BASE * WORLD_BODY_BYTES, data);
      }
      if (prevCount > count) zeroSlice(BODY_STATIC_BASE + count, prevCount - count);
      headerData[0] = count;
      writeHeader();
    },
    setHerdCount(count) {
      const n = Math.max(0, Math.min(MAX_HERD_BODIES, count | 0));
      const prev = Math.round(headerData[1]);
      if (prev > n) zeroSlice(BODY_HERD_BASE + n, prev - n);
      zeroSlice(BODY_MOUNT_POSE_BASE, MAX_MOUNT_POSES);
      headerData[1] = n;
      writeHeader();
    },
    setWalkerCount(count) {
      const n = Math.max(0, Math.min(MAX_WALKER_BODIES, count | 0));
      const prev = Math.round(headerData[2]);
      if (prev > n) zeroSlice(BODY_WALKER_BASE + n, prev - n);
      headerData[2] = n;
      writeHeader();
    },
    destroy() {
      REGISTRY_BY_DEVICE.delete(device);
      buffer.destroy();
    },
  };

  REGISTRY_BY_DEVICE.set(device, reg);
  return reg;
}

export function worldBodiesWGSL(group, binding, access = 'read_write') {
  return /* wgsl */ `
struct WorldBody {
  pos: vec4f, // (x, y, z, radius); radius <= 0 => inactive
  dir: vec4f, // (yaw, halfLen, speed, flags)
};
@group(${group}) @binding(${binding}) var<storage, ${access}> worldBodies: array<WorldBody>;

const WB_HEADER_SLOT: u32 = ${BODY_HEADER_SLOT}u;
const WB_CAPTAIN_SLOT: u32 = ${BODY_CAPTAIN_SLOT}u;
const WB_STATIC_BASE: u32 = ${BODY_STATIC_BASE}u;
const WB_STATIC_MAX: u32 = ${MAX_STATIC_BODIES}u;
const WB_HERD_BASE: u32 = ${BODY_HERD_BASE}u;
const WB_HERD_MAX: u32 = ${MAX_HERD_BODIES}u;
const WB_WALKER_BASE: u32 = ${BODY_WALKER_BASE}u;
const WB_WALKER_MAX: u32 = ${MAX_WALKER_BODIES}u;
const WB_MOUNT_POSE_BASE: u32 = ${BODY_MOUNT_POSE_BASE}u;
const WB_MOUNT_POSE_MAX: u32 = ${MAX_MOUNT_POSES}u;

const WB_FLAG_ACTIVE: u32 = ${BODY_FLAG_ACTIVE}u;
const WB_FLAG_STATIC: u32 = ${BODY_FLAG_STATIC}u;
const WB_FLAG_CAPTAIN: u32 = ${BODY_FLAG_CAPTAIN}u;
const WB_FLAG_HUMAN: u32 = ${BODY_FLAG_HUMAN}u;
const WB_FLAG_ANIMAL: u32 = ${BODY_FLAG_ANIMAL}u;
const WB_FLAG_MOUNT: u32 = ${BODY_FLAG_MOUNT}u;
const WB_FLAG_VEHICLE: u32 = ${BODY_FLAG_VEHICLE}u;
const WB_FLAG_STOPPED: u32 = ${BODY_FLAG_STOPPED}u;

// 2D capsule-vs-capsule closest surface contact between body A (center pA, forward dirA, half-spine hlA, radius rA)
// and body B (center pB, forward dirB, half-spine hlB, radius rB).
// Returns vec4f(sepFromBtoA.x, sepFromBtoA.y, surfaceGap, penetrationDepth).
// When hlA == 0 && hlB == 0 this reduces to exact circle-vs-circle contact.
fn wbCapsuleContact(pA: vec2f, dirA: vec2f, hlA: f32, rA: f32, pB: vec2f, dirB: vec2f, hlB: f32, rB: f32) -> vec4f {
  let d0 = pA - pB;
  var sA = 0.0;
  var sB = 0.0;
  if (hlA > 1e-3 || hlB > 1e-3) {
    // Project center offset onto each spine, then refine once for crossed capsules.
    sB = clamp(dot(d0, dirB), -hlB, hlB);
    let qB0 = pB + dirB * sB;
    sA = clamp(dot(qB0 - pA, dirA), -hlA, hlA);
    let qA0 = pA + dirA * sA;
    sB = clamp(dot(qA0 - pB, dirB), -hlB, hlB);
    let qB1 = pB + dirB * sB;
    sA = clamp(dot(qB1 - pA, dirA), -hlA, hlA);
  }
  let diff = (pA + dirA * sA) - (pB + dirB * sB);
  let dist = length(diff);
  let rSum = rA + rB;
  let sep = select(vec2f(1.0, 0.0), diff / dist, dist > 1e-4);
  return vec4f(sep.x, sep.y, dist - rSum, max(0.0, rSum - dist));
}
`;
}
