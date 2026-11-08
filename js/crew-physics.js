// Layered Animation Mixer, Pose-Space Spring Inertializer, Inverted-Pendulum "Sea Legs",
// 30-Joint Anatomical Finger Articulation, Autonomous Gaze Tracking, and 11-Body XPBD
// Articulated Ragdoll / Active-Ragdoll Physics for 65-joint crew & villager rigs.

import { gltfQuatMultiply, gltfSlerp } from './gltf.js';
import { vesselVerticalScale, modelDeckWidth } from './hull.js';
import { crewDeckHeight } from './crew-work.js';
import { crewNavigationObstacles } from './crew-navigation.js';

const crewPhysMixerMaskCache = new WeakMap();

const CREW_PHYS_FINGER_NAMES = ['index', 'middle', 'ring', 'pinky', 'thumb'];

const crewPhysClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const crewPhysSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crewPhysDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crewPhysCross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const crewPhysUnit = a => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const crewPhysMatPos = m => [m[12], m[13], m[14]];

function crewPhysMatRotQuat(m) {
  const scale = Math.hypot(m[0], m[1], m[2]) || 1;
  const r0 = m[0] / scale, r1 = m[4] / scale, r2 = m[8] / scale;
  const r3 = m[1] / scale, r4 = m[5] / scale, r5 = m[9] / scale;
  const r6 = m[2] / scale, r7 = m[6] / scale, r8 = m[10] / scale;
  const trace = r0 + r4 + r8;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r7 - r5) / s, (r2 - r6) / s, (r3 - r1) / s, s / 4];
  } else if (r0 > r4 && r0 > r8) {
    const s = Math.sqrt(1 + r0 - r4 - r8) * 2;
    q = [s / 4, (r1 + r3) / s, (r2 + r6) / s, (r7 - r5) / s];
  } else if (r4 > r8) {
    const s = Math.sqrt(1 + r4 - r0 - r8) * 2;
    q = [(r1 + r3) / s, s / 4, (r5 + r7) / s, (r2 - r6) / s];
  } else {
    const s = Math.sqrt(1 + r8 - r0 - r4) * 2;
    q = [(r2 + r6) / s, (r5 + r7) / s, s / 4, (r3 - r1) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

function crewPhysActorLocalPoint(p, s) {
  const dx = p[0] - s.position[0];
  const dy = p[1] - s.position[1];
  const dz = p[2] - s.position[2];
  const c = Math.cos(s.yaw ?? 0), sn = Math.sin(s.yaw ?? 0);
  const x = c * dx - sn * dz;
  const z = sn * dx + c * dz;
  const pitch = s.climbPitch ?? 0;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const sx = s.scale?.[0] || 1, sy = s.scale?.[1] || 1, sz = s.scale?.[2] || 1;
  return [x / sx, (cp * dy + sp * z) / sy, (-sp * dy + cp * z) / sz];
}

function crewPhysRotateBoneWorldDir(a, node, fromDir, toDir) {
  if (node < 0) return;
  const u = crewPhysUnit(fromDir), v = crewPhysUnit(toDir);
  const dot = crewPhysDot(u, v);
  let delta = dot < -0.9999
    ? [...crewPhysUnit(crewPhysCross(u, Math.abs(u[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0])), 0]
    : [...crewPhysCross(u, v), 1 + dot];
  const n = Math.hypot(delta[0], delta[1], delta[2], delta[3]) || 1;
  delta = [delta[0] / n, delta[1] / n, delta[2] / n, delta[3] / n];
  const parent = a.parent[node];
  const q = parent < 0 ? [0, 0, 0, 1] : crewPhysMatRotQuat(a.world[parent]);
  const inv = [-q[0], -q[1], -q[2], q[3]];
  const p = new Float32Array(4), local = new Float32Array(4);
  gltfQuatMultiply(p, inv, delta);
  gltfQuatMultiply(local, p, q);
  gltfQuatMultiply(p, local, a.pose[node].r);
  a.pose[node].r.set(p);
  if (a.updateBranch) a.updateBranch(node);
  else a.update();
}

function crewPhysMoveBoneLocalTarget(a, node, target) {
  if (node < 0) return;
  const at = crewPhysMatPos(a.world[node]);
  const delta = crewPhysSub(target, at);
  const parent = a.parent[node];
  if (parent < 0) {
    for (let k = 0; k < 3; k++) a.pose[node].t[k] += delta[k];
  } else {
    const matrix = a.world[parent];
    for (let k = 0; k < 3; k++) {
      const ax = [matrix[k * 4], matrix[k * 4 + 1], matrix[k * 4 + 2]];
      a.pose[node].t[k] += crewPhysDot(ax, delta) / Math.max(1e-12, crewPhysDot(ax, ax));
    }
  }
  if (a.updateBranch) a.updateBranch(node);
  else a.update();
}

function crewPhysSolveTwoBoneIK(a, upperNode, lowerNode, endNode, target, pole) {
  if (upperNode < 0 || lowerNode < 0 || endNode < 0) return;
  const A = crewPhysMatPos(a.world[upperNode]);
  const B = crewPhysMatPos(a.world[lowerNode]);
  const C = crewPhysMatPos(a.world[endNode]);
  const l1 = Math.hypot(...crewPhysSub(B, A));
  const l2 = Math.hypot(...crewPhysSub(C, B));
  const ray = crewPhysSub(target, A);
  const dir = crewPhysUnit(ray);
  const d = crewPhysClamp(Math.hypot(...ray), Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.001);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const p = crewPhysSub(pole, A);
  const pd = crewPhysDot(p, dir);
  const bend = crewPhysUnit([p[0] - dir[0] * pd, p[1] - dir[1] * pd, p[2] - dir[2] * pd]);
  const elbow = [
    A[0] + dir[0] * x + bend[0] * h,
    A[1] + dir[1] * x + bend[1] * h,
    A[2] + dir[2] * x + bend[2] * h,
  ];
  crewPhysRotateBoneWorldDir(a, upperNode, crewPhysSub(B, A), crewPhysSub(elbow, A));
  const b2 = crewPhysMatPos(a.world[lowerNode]);
  const c2 = crewPhysMatPos(a.world[endNode]);
  crewPhysRotateBoneWorldDir(a, lowerNode, crewPhysSub(c2, b2), crewPhysSub(target, b2));
}

export function getCrewMixerMasks(animator) {
  let masks = crewPhysMixerMaskCache.get(animator);
  if (masks) return masks;
  const idx = name => (animator.nodeIndex ? animator.nodeIndex(name) : animator.names.indexOf(name));
  const fingers = { l: [], r: [] };
  for (const side of ['l', 'r']) {
    for (const fname of CREW_PHYS_FINGER_NAMES) {
      const chain = [
        idx(`${fname}_01_${side}`),
        idx(`${fname}_02_${side}`),
        idx(`${fname}_03_${side}`),
      ].filter(n => n >= 0);
      fingers[side].push({ name: fname, nodes: chain });
    }
  }
  masks = Object.freeze({
    pelvis: idx('pelvis'),
    spine1: idx('spine_01'),
    spine2: idx('spine_02'),
    spine3: idx('spine_03'),
    neck: idx('neck_01'),
    head: idx('Head'),
    clavicleL: idx('clavicle_l'),
    clavicleR: idx('clavicle_r'),
    upperarmL: idx('upperarm_l'),
    lowerarmL: idx('lowerarm_l'),
    handL: idx('hand_l'),
    upperarmR: idx('upperarm_r'),
    lowerarmR: idx('lowerarm_r'),
    handR: idx('hand_r'),
    thighL: idx('thigh_l'),
    calfL: idx('calf_l'),
    footL: idx('foot_l'),
    thighR: idx('thigh_r'),
    calfR: idx('calf_r'),
    footR: idx('foot_r'),
    fingers,
    lowerBodySet: new Set(
      ['pelvis', 'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r']
        .map(idx)
        .filter(n => n >= 0),
    ),
    upperBodySet: new Set(
      ['spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r']
        .map(idx)
        .filter(n => n >= 0),
    ),
  });
  crewPhysMixerMaskCache.set(animator, masks);
  return masks;
}

function crewPhysResolveActionKey(s) {
  if (s.overboard?.inWater) return s.overboard.alive ? 'overboard:swim' : 'overboard:float';
  if (s.casualtyState === 'fallen') return 'ragdoll:fallen';
  if ((s.knockdownTimer ?? 0) > 0) return 'ragdoll:knockdown';
  if (s.seatedPose) return 'seated:rowing';
  const j = s.job;
  if (j) {
    if (j.kind === 'gunnery' && j.stage === 'working') {
      return `gunnery:${j.gunRole ?? 'crew'}:${j.gun?.stage ?? 'ready'}`;
    }
    if (j.kind === 'lookout' && j.lookoutAtStation) {
      return 'lookout:crows-nest';
    }
    if ((j.kind === 'rig' || j.kind === 'lookout') && ['ascending', 'descending', 'working'].includes(j.stage)) {
      return `climb:${j.kind}:${j.stage}`;
    }
    return `job:${j.kind}:${j.stage ?? 'active'}`;
  }
  if ((s.firePanic ?? 0) > 0.18) return 'panic:fire';
  if (s.casualtyState === 'wounded') return 'wounded:limp';
  if (s.role === 'Helmsman' || s.roles?.includes('helmsman')) return 'station:helm';
  if ((s.brace ?? 0) > 0.45) return 'stance:brace';
  if ((s.walk ?? 0) > 0.35) return 'locomotion:walk';
  return 'stance:idle';
}

// 11-Particle XPBD Articulated Ragdoll & Active-Ragdoll Stumble Solver
// 0: pelvis, 1: chest, 2: head, 3: elbowL, 4: handL, 5: elbowR, 6: handR,
// 7: kneeL, 8: footL, 9: kneeR, 10: footR
const CREW_PHYS_RAGDOLL_CONSTRAINTS = [
  [0, 1, 0.44], // pelvis - chest
  [1, 2, 0.28], // chest - head
  [1, 3, 0.27], // chest - elbowL
  [3, 4, 0.25], // elbowL - handL
  [1, 5, 0.27], // chest - elbowR
  [5, 6, 0.25], // elbowR - handR
  [0, 7, 0.41], // pelvis - kneeL
  [7, 8, 0.40], // kneeL - footL
  [0, 9, 0.41], // pelvis - kneeR
  [9, 10, 0.40], // kneeR - footR
  [0, 2, 0.68], // pelvis - head spine arc
  [7, 9, 0.24], // kneeL - kneeR separation
  [3, 5, 0.34], // elbowL - elbowR shoulder width
];

const CREW_PHYS_RAGDOLL_RADII = [0.13, 0.15, 0.11, 0.06, 0.05, 0.06, 0.05, 0.07, 0.06, 0.07, 0.06];

export function initArticulatedRagdoll(s, boat) {
  const px = s.position?.[0] ?? 0;
  const py = s.position?.[1] ?? 0;
  const pz = s.position?.[2] ?? 0;
  const yaw = s.collapseYaw ?? s.yaw ?? 0;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  const fallSign = s.fallDir ?? (((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1);
  const localToShip = (lx, ly, lz) => [
    px + c * lx + sn * lz,
    py + ly,
    pz - sn * lx + c * lz,
  ];
  const initialLocal = [
    [0.0, 0.88, 0.0],
    [0.0, 1.32, 0.02],
    [0.0, 1.60, 0.04],
    [0.24, 1.18, 0.08],
    [0.32, 0.96, 0.20],
    [-0.24, 1.18, 0.08],
    [-0.32, 0.96, 0.20],
    [0.11, 0.48, 0.04],
    [0.12, 0.08, 0.0],
    [-0.11, 0.48, -0.02],
    [-0.12, 0.08, -0.02],
  ];
  const vxBase = (s.knockbackVx ?? 0) * ((boat?.beam ?? 3.6) / 3.6);
  const vzBase = (s.knockbackVz ?? 0) * ((boat?.length ?? 12) / 12);
  const tumbleZ = fallSign * 2.4;
  const tumbleX = (((s.crewIndex ?? 0) % 3) - 1) * 0.95;

  const pos = new Float32Array(11 * 3);
  const prev = new Float32Array(11 * 3);
  const dt0 = 1 / 60;
  for (let i = 0; i < 11; i++) {
    const [lx, ly, lz] = initialLocal[i];
    const p = localToShip(lx, ly, lz);
    pos[i * 3 + 0] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    const heightFactor = crewPhysClamp(ly / 1.5, 0.15, 1.25);
    const vx = vxBase + (c * tumbleX + sn * tumbleZ) * heightFactor;
    const vy = (i <= 2 ? 0.65 : 0.25) * Math.min(1.5, Math.hypot(vxBase, vzBase) * 0.35);
    const vz = vzBase + (-sn * tumbleX + c * tumbleZ) * heightFactor;
    prev[i * 3 + 0] = p[0] - vx * dt0;
    prev[i * 3 + 1] = p[1] - vy * dt0;
    prev[i * 3 + 2] = p[2] - vz * dt0;
  }
  s.ragdoll = {
    active: true,
    age: 0,
    settled: false,
    anchorX: px,
    anchorY: py,
    anchorZ: pz,
    pos,
    prev,
  };
  return s.ragdoll;
}

export function stepArticulatedRagdoll(s, boat, dt) {
  const isDown = s.casualtyState === 'fallen' || (s.knockdownTimer ?? 0) > 0;
  if (!isDown) {
    if (s.ragdoll) s.ragdoll.active = false;
    return null;
  }
  const rag = (s.ragdoll && s.ragdoll.active) ? s.ragdoll : initArticulatedRagdoll(s, boat);
  const px = s.position?.[0] ?? 0;
  const py = s.position?.[1] ?? 0;
  const pz = s.position?.[2] ?? 0;
  const dRootX = px - rag.anchorX;
  const dRootY = py - rag.anchorY;
  const dRootZ = pz - rag.anchorZ;
  if (Math.hypot(dRootX, dRootY, dRootZ) > 1e-5) {
    for (let i = 0; i < 11; i++) {
      rag.pos[i * 3 + 0] += dRootX;
      rag.pos[i * 3 + 1] += dRootY;
      rag.pos[i * 3 + 2] += dRootZ;
      rag.prev[i * 3 + 0] += dRootX;
      rag.prev[i * 3 + 1] += dRootY;
      rag.prev[i * 3 + 2] += dRootZ;
    }
    rag.anchorX = px;
    rag.anchorY = py;
    rag.anchorZ = pz;
  }

  const stepDt = crewPhysClamp(dt, 0, 0.05);
  if (stepDt <= 1e-5) {
    if (rag.age === 0) {
      stepArticulatedRagdoll(s, boat, 0.032);
      stepArticulatedRagdoll(s, boat, 0.032);
      stepArticulatedRagdoll(s, boat, 0.032);
    }
    return rag;
  }

  rag.age += stepDt;
  const substeps = 3;
  const h = stepDt / substeps;
  const h2 = h * h;

  const roll = boat?.roll ?? 0;
  const pitch = boat?.pitch ?? 0;
  const rollRate = boat?.rollVelocity ?? 0;
  const pitchRate = boat?.pitchVelocity ?? 0;
  // Positive roll lifts starboard (+x) and positive pitch lifts the bow (-z), so bodies slide the other way.
  const gx = -Math.sin(roll) * 9.81 - crewPhysClamp(rollRate * 0.8, -2.5, 2.5);
  const gy = -Math.cos(roll) * Math.cos(pitch) * 9.81;
  const gz = Math.sin(pitch) * 9.81 - crewPhysClamp(pitchRate * 0.8, -2.5, 2.5);

  const sx = (boat?.beam ?? 3.6) / 3.6;
  const sz = (boat?.length ?? 12) / 12;
  const sy = boat ? vesselVerticalScale(boat) : 1;
  const baseFloorY = (s.navigationY ?? (boat ? crewDeckHeight(boat, s.z ?? (pz / sz), s.x ?? (px / sx)) : (s.ly ?? py))) * (boat ? sy : 1);
  const obstacles = boat ? crewNavigationObstacles(boat) : null;
  const inst = s.building ?? null;
  const instCosY = inst ? Math.cos(inst.yaw ?? 0) : 1;
  const instSinY = inst ? Math.sin(inst.yaw ?? 0) : 0;
  const instHW = inst ? (inst.width ?? 10) * 0.5 : 0;
  const instHL = inst ? (inst.length ?? 12) * 0.5 : 0;

  const recoverWeight = (s.casualtyState !== 'fallen' && (s.knockdownTimer ?? 0) > 0 && s.knockdownTimer < 0.55)
    ? crewPhysClamp(1 - s.knockdownTimer / 0.55, 0, 1)
    : 0;
  const yaw = s.yaw ?? 0;
  const cy = Math.cos(yaw), sny = Math.sin(yaw);

  for (let sub = 0; sub < substeps; sub++) {
    const damp = recoverWeight > 0 ? 0.90 : 0.965;
    for (let i = 0; i < 11; i++) {
      const idx = i * 3;
      const x = rag.pos[idx], y = rag.pos[idx + 1], z = rag.pos[idx + 2];
      const vx = (x - rag.prev[idx]) * damp;
      const vy = (y - rag.prev[idx + 1]) * damp;
      const vz = (z - rag.prev[idx + 2]) * damp;
      rag.prev[idx] = x;
      rag.prev[idx + 1] = y;
      rag.prev[idx + 2] = z;
      rag.pos[idx] = x + vx + gx * h2;
      rag.pos[idx + 1] = y + vy + gy * h2;
      rag.pos[idx + 2] = z + vz + gz * h2;
    }

    if (recoverWeight > 0) {
      const pull = recoverWeight * 0.22;
      const targetPelvis = [px, baseFloorY + 0.45 + 0.42 * recoverWeight, pz];
      const targetChest = [px + sny * 0.12 * (1 - recoverWeight), baseFloorY + 0.82 + 0.48 * recoverWeight, pz + cy * 0.12 * (1 - recoverWeight)];
      const targetHead = [targetChest[0], targetChest[1] + 0.27, targetChest[2]];
      for (const [nodeIdx, tgt] of [[0, targetPelvis], [1, targetChest], [2, targetHead]]) {
        const b = nodeIdx * 3;
        rag.pos[b] += (tgt[0] - rag.pos[b]) * pull;
        rag.pos[b + 1] += (tgt[1] - rag.pos[b + 1]) * pull;
        rag.pos[b + 2] += (tgt[2] - rag.pos[b + 2]) * pull;
      }
    }

    for (let iter = 0; iter < 2; iter++) {
      for (let cIdx = 0; cIdx < CREW_PHYS_RAGDOLL_CONSTRAINTS.length; cIdx++) {
        const [iA, iB, restLen] = CREW_PHYS_RAGDOLL_CONSTRAINTS[cIdx];
        const a3 = iA * 3, b3 = iB * 3;
        const dx = rag.pos[b3] - rag.pos[a3];
        const dy = rag.pos[b3 + 1] - rag.pos[a3 + 1];
        const dz = rag.pos[b3 + 2] - rag.pos[a3 + 2];
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const stiffness = cIdx < 10 ? 0.5 : 0.22;
        if (cIdx === 10 && dist >= 0.56 && dist <= 0.72) continue;
        if (cIdx === 11 && dist >= 0.16 && dist <= 0.38) continue;
        if (cIdx === 12 && dist >= 0.28 && dist <= 0.44) continue;
        const diff = (dist - restLen) / dist * stiffness;
        rag.pos[a3] += dx * diff;
        rag.pos[a3 + 1] += dy * diff;
        rag.pos[a3 + 2] += dz * diff;
        rag.pos[b3] -= dx * diff;
        rag.pos[b3 + 1] -= dy * diff;
        rag.pos[b3 + 2] -= dz * diff;
      }
      const dxP = rag.pos[0] - px;
      const dzP = rag.pos[2] - pz;
      const distP = Math.hypot(dxP, dzP);
      if (distP > 0.42) {
        const pullP = (distP - 0.42) / distP * 0.65;
        rag.pos[0] -= dxP * pullP;
        rag.pos[2] -= dzP * pullP;
      }
    }

    for (let i = 0; i < 11; i++) {
      const idx = i * 3;
      const r = CREW_PHYS_RAGDOLL_RADII[i];
      let floorY = baseFloorY;

      // Over the side there is no deck or rail to meet, only the sea at baseFloorY.
      if (boat && !s.overboard) {
        const xDesign = rag.pos[idx] / sx;
        const zDesign = rag.pos[idx + 2] / sz;
        const sampledDeckY = crewDeckHeight(boat, zDesign, xDesign) * sy;
        // If sampledDeckY is much higher than the particle's previous height, it hit a step riser wall (e.g. quarterdeck bulkhead)
        if (sampledDeckY > rag.prev[idx + 1] + 0.32 && sampledDeckY > baseFloorY + 0.25) {
          rag.pos[idx + 2] = rag.prev[idx + 2];
          floorY = baseFloorY;
        } else if (Number.isFinite(sampledDeckY)) {
          floorY = sampledDeckY;
        }
        const halfHullW = Math.max(0.38, modelDeckWidth(boat, zDesign) * sx - 0.14 - r);
        if (Math.abs(rag.pos[idx]) > halfHullW) {
          rag.pos[idx] = Math.sign(rag.pos[idx]) * halfHullW;
          rag.pos[idx + 2] -= (rag.pos[idx + 2] - rag.prev[idx + 2]) * 0.35;
        }
        // Collide against all 3D ship surface obstacles (cannons, hatches, masts, capstans, bitts, waist boats)
        if (obstacles) {
          const pxI = rag.pos[idx], pyI = rag.pos[idx + 1], pzI = rag.pos[idx + 2];
          for (let oIdx = 0; oIdx < obstacles.length; oIdx++) {
            const o = obstacles[oIdx];
            const minX = o.min[0] - r, maxX = o.max[0] + r;
            const minY = o.min[1] - r, maxY = o.max[1] + r;
            const minZ = o.min[2] - r, maxZ = o.max[2] + r;
            if (pxI > minX && pxI < maxX && pyI > minY && pyI < maxY && pzI > minZ && pzI < maxZ) {
              if (rag.prev[idx + 1] >= o.max[1] - 0.08 && pyI < maxY) {
                floorY = Math.max(floorY, o.max[1]);
              } else {
                const penL = pxI - minX, penR = maxX - pxI;
                const penF = pzI - minZ, penB = maxZ - pzI;
                const minHoriz = Math.min(penL, penR, penF, penB);
                if (minHoriz === penL) rag.pos[idx] = minX;
                else if (minHoriz === penR) rag.pos[idx] = maxX;
                else if (minHoriz === penF) rag.pos[idx + 2] = minZ;
                else rag.pos[idx + 2] = maxZ;
              }
            }
          }
        }
      } else if (inst) {
        // Building / fort / dock surface & parapet collision in local building coordinates
        const relX = rag.pos[idx] - (inst.x ?? 0);
        const relZ = rag.pos[idx + 2] - (inst.z ?? 0);
        let lx = relX * instCosY - relZ * instSinY;
        let lz = relX * instSinY + relZ * instCosY;
        floorY = (s.baseLy ?? inst.y ?? baseFloorY) + lx * (inst.slopeX ?? 0) + lz * (inst.slopeZ ?? 0);
        const impacts = inst.damageState?.impacts;
        if (impacts?.length) {
          for (let k = 0; k < impacts.length; k++) {
            const imp = impacts[k];
            const lp = imp.localPos;
            if (!lp) continue;
            const dImp = Math.hypot(lx - lp[0], lz - lp[2]);
            const rad = imp.radius ?? 1.8;
            if (dImp < rad) {
              floorY -= (1 - dImp / rad) * Math.min(0.45, (imp.strength ?? 0.5) * 0.35);
            }
          }
        }
        const maxLX = instHW + 1.8 - r;
        const maxLZ = instHL + 2.4 - r;
        const rootOnRoof = Math.abs(s.lx ?? 0) <= instHW + 1.2 && Math.abs(s.lz ?? 0) <= instHL + 1.2;
        if (rootOnRoof && (Math.abs(lx) > maxLX || Math.abs(lz) > maxLZ)) {
          lx = crewPhysClamp(lx, -maxLX, maxLX);
          lz = crewPhysClamp(lz, -maxLZ, maxLZ);
          rag.pos[idx] = (inst.x ?? 0) + lx * instCosY + lz * instSinY;
          rag.pos[idx + 2] = (inst.z ?? 0) - lx * instSinY + lz * instCosY;
        }
      }

      const minY = floorY + r;
      if (rag.pos[idx + 1] < minY) {
        const pen = minY - rag.pos[idx + 1];
        rag.pos[idx + 1] = minY;
        const fric = crewPhysClamp(0.28 + pen * 1.5, 0.28, 0.75);
        rag.pos[idx] -= (rag.pos[idx] - rag.prev[idx]) * fric;
        rag.pos[idx + 2] -= (rag.pos[idx + 2] - rag.prev[idx + 2]) * fric;
      }
    }
  }
  return rag;
}

export function applyArticulatedRagdollPose(a, s, boat) {
  const rag = s.ragdoll?.active ? s.ragdoll : stepArticulatedRagdoll(s, boat, 0.032);
  if (!rag) return false;
  const m = getCrewMixerMasks(a);
  if (m.pelvis < 0) return false;

  for (const node of [m.pelvis, m.spine1, m.spine2, m.spine3, m.neck, m.head]) {
    if (node < 0) continue;
    a.pose[node].t.set(a.rest[node].t);
    a.pose[node].r.set(a.rest[node].r);
    a.pose[node].s.set(a.rest[node].s);
  }
  a.update();

  const pPelvis = crewPhysActorLocalPoint([rag.pos[0], rag.pos[1], rag.pos[2]], s);
  const pChest = crewPhysActorLocalPoint([rag.pos[3], rag.pos[4], rag.pos[5]], s);
  const pHead = crewPhysActorLocalPoint([rag.pos[6], rag.pos[7], rag.pos[8]], s);
  const pElbowL = crewPhysActorLocalPoint([rag.pos[9], rag.pos[10], rag.pos[11]], s);
  const pHandL = crewPhysActorLocalPoint([rag.pos[12], rag.pos[13], rag.pos[14]], s);
  const pElbowR = crewPhysActorLocalPoint([rag.pos[15], rag.pos[16], rag.pos[17]], s);
  const pHandR = crewPhysActorLocalPoint([rag.pos[18], rag.pos[19], rag.pos[20]], s);
  const pKneeL = crewPhysActorLocalPoint([rag.pos[21], rag.pos[22], rag.pos[23]], s);
  const pFootL = crewPhysActorLocalPoint([rag.pos[24], rag.pos[25], rag.pos[26]], s);
  const pKneeR = crewPhysActorLocalPoint([rag.pos[27], rag.pos[28], rag.pos[29]], s);
  const pFootR = crewPhysActorLocalPoint([rag.pos[30], rag.pos[31], rag.pos[32]], s);

  crewPhysMoveBoneLocalTarget(a, m.pelvis, pPelvis);
  const curPelvis = crewPhysMatPos(a.world[m.pelvis]);
  const curChest = m.spine3 >= 0 ? crewPhysMatPos(a.world[m.spine3]) : [curPelvis[0], curPelvis[1] + 0.4, curPelvis[2]];
  crewPhysRotateBoneWorldDir(a, m.pelvis, crewPhysSub(curChest, curPelvis), crewPhysSub(pChest, curPelvis));

  if (m.head >= 0 && m.neck >= 0) {
    const neckPos = crewPhysMatPos(a.world[m.neck]);
    const headPos = crewPhysMatPos(a.world[m.head]);
    crewPhysRotateBoneWorldDir(a, m.neck, crewPhysSub(headPos, neckPos), crewPhysSub(pHead, neckPos));
  }

  crewPhysSolveTwoBoneIK(a, m.upperarmL, m.lowerarmL, m.handL, pHandL, pElbowL);
  crewPhysSolveTwoBoneIK(a, m.upperarmR, m.lowerarmR, m.handR, pHandR, pElbowR);
  crewPhysSolveTwoBoneIK(a, m.thighL, m.calfL, m.footL, pFootL, pKneeL);
  crewPhysSolveTwoBoneIK(a, m.thighR, m.calfR, m.footR, pFootR, pKneeR);

  poseCrewFingers(a, s, 0.35, 0.35);
  return true;
}

export function resolveLookoutTarget(s, boat) {
  const time = s?.time ?? 0;
  // 1. Deck fire hazard on own vessel
  if (boat?.damage?.fires?.length) {
    const f = boat.damage.fires[0];
    const dx = (f.localPosition?.[0] ?? 0) - (s.position?.[0] ?? 0);
    const dy = (f.localPosition?.[1] ?? 1) - ((s.position?.[1] ?? 8) + 1.1);
    const dz = (f.localPosition?.[2] ?? 0) - (s.position?.[2] ?? 0);
    const dist = Math.hypot(dx, dz) || 1;
    return {
      kind: 'danger',
      worldYaw: Math.atan2(dx, dz),
      pitch: crewPhysClamp(Math.atan2(dy, dist), -0.48, 0.35),
      useSpyglass: false,
    };
  }
  // 2. External sightings (whale/shark breach, enemy/friendly vessel, dolphin pod, or landfall)
  const sighting = boat?.lookoutSighting;
  if (sighting && Number.isFinite(sighting.x) && Number.isFinite(sighting.z)) {
    const bx = boat.x ?? 0, bz = boat.z ?? 0, by = (boat.heave ?? 0) + (s.position?.[1] ?? 8) + 1.2;
    const wx = sighting.x - bx;
    const wz = sighting.z - bz;
    const wy = (sighting.y ?? 0) - by;
    const dist = Math.hypot(wx, wz) || 1;
    const heading = ((boat.heading ?? 0) * Math.PI) / 180;
    const ch = Math.cos(heading), sh = Math.sin(heading);
    // Transform world delta into ship-local design frame (+X starboard, -Z bow)
    const localX = ch * wx - sh * wz;
    const localZ = -sh * wx - ch * wz;
    return {
      kind: sighting.kind ?? 'sighting',
      worldYaw: Math.atan2(localX, localZ),
      pitch: crewPhysClamp(Math.atan2(wy, dist), -0.45, 0.28),
      useSpyglass: sighting.kind !== 'dolphin' || dist > 35,
    };
  }
  // 3. Default crow's nest horizon watch: sweep across the forward bow sector (-Z => yaw = PI)
  const sweep = 0.42 * Math.sin(time * 0.46 + (s?.crewIndex ?? 0) * 0.7);
  const useSpyglass = Math.cos(time * 0.28) > -0.35;
  return {
    kind: 'horizon',
    worldYaw: Math.PI + sweep,
    pitch: -0.05 + 0.04 * Math.cos(time * 0.31),
    useSpyglass,
  };
}

export function stepCrewPhysicsState(s, boat, dt, company = null) {
  const safeDt = crewPhysClamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const phys = (s.phys ??= {
    comShiftX: 0,
    comVelX: 0,
    comShiftZ: 0,
    comVelZ: 0,
    comDropY: 0,
    comVelY: 0,
    spineLeanX: 0,
    spineVelX: 0,
    spineLeanZ: 0,
    spineVelZ: 0,
    armSpread: 0,
    prevRollRate: 0,
    prevPitchRate: 0,
    prevHeaveVel: 0,
    prevLeewayVel: 0,
    exertion: 0.18,
    breathPhase: ((s.crewIndex ?? 0) * 1.17) % (Math.PI * 2),
    gazeYaw: 0,
    gazePitch: 0,
    gazeTimer: ((s.crewIndex ?? 0) * 0.63) % 2.5,
    targetGazeYaw: 0,
    targetGazePitch: 0,
    lookoutKind: 'horizon',
    usingSpyglass: true,
  });

  if (s.overboard?.inWater) {
    if (s.ragdoll?.active) s.ragdoll.active = false;
    return phys;
  }
  if (s.casualtyState === 'fallen' || (s.knockdownTimer ?? 0) > 0) {
    stepArticulatedRagdoll(s, boat, safeDt);
    return phys;
  }
  if (s.ragdoll?.active) s.ragdoll.active = false;

  if (safeDt <= 1e-6) return phys;

  const invDt = 1 / Math.max(0.016, safeDt);
  const roll = boat?.roll ?? 0;
  const rollRate = boat?.rollVelocity ?? 0;
  const pitch = boat?.pitch ?? 0;
  const pitchRate = boat?.pitchVelocity ?? 0;
  const yawRate = boat?.yawRate ?? 0;
  const heaveVel = boat?.heaveVelocity ?? 0;
  const leewayVel = boat?.leewayVelocity ?? 0;
  const surgeAccel = crewPhysClamp(boat?.surgeAcceleration ?? 0, -6, 6);

  const rollAccel = crewPhysClamp((rollRate - phys.prevRollRate) * invDt, -14, 14);
  const pitchAccel = crewPhysClamp((pitchRate - phys.prevPitchRate) * invDt, -12, 12);
  const heaveAccel = crewPhysClamp((heaveVel - phys.prevHeaveVel) * invDt, -9, 9);
  const swayAccel = crewPhysClamp((leewayVel - phys.prevLeewayVel) * invDt, -6, 6);
  phys.prevRollRate = rollRate;
  phys.prevPitchRate = pitchRate;
  phys.prevHeaveVel = heaveVel;
  phys.prevLeewayVel = leewayVel;

  // Exact 3D station coordinates on the moving hull: rx (beam), ry (height above waterline), rz (fore-aft)
  const rx = s.position?.[0] ?? 0;
  const ry = s.position?.[1] ?? 1.5;
  const rz = s.position?.[2] ?? 0;

  // Non-inertial apparent acceleration (divided by g=9.81) at the sailor's actual 3D station (rx, ry, rz):
  // Includes gravity tilt + tangential whip (alpha x r) + centripetal (omega x (omega x r)) + linear hull surge/sway/heave
  const tangLat = -ry * rollAccel + rx * (rollRate * rollRate + yawRate * yawRate) - swayAccel;
  const tangFore = -ry * pitchAccel + rz * (pitchRate * pitchRate + yawRate * yawRate) + surgeAccel;
  const vertGLoad = heaveAccel + rz * pitchAccel - rx * rollAccel;

  const shipLatTilt = Math.sin(roll) + crewPhysClamp(tangLat / 9.81, -0.48, 0.48);
  const shipForeTilt = -Math.sin(pitch) + crewPhysClamp(tangFore / 9.81, -0.42, 0.42);

  const c = Math.cos(s.yaw ?? 0), sn = Math.sin(s.yaw ?? 0);
  const localRightTilt = c * shipLatTilt - sn * shipForeTilt;
  const localFwdTilt = sn * shipLatTilt + c * shipForeTilt;

  const climbing = s.job && (s.job.kind === 'rig' || s.job.kind === 'lookout') && (s.job.rung ?? 0) > 0 && !s.job.lookoutAtStation;
  const scaleFactor = climbing ? 0.22 : s.job?.lookoutAtStation ? 0.55 : s.seatedPose ? 0.45 : 1.0;
  const targetComX = crewPhysClamp(-localRightTilt * 0.12 * scaleFactor, -0.075, 0.075);
  const targetComZ = crewPhysClamp(-localFwdTilt * 0.10 * scaleFactor, -0.065, 0.065);
  const targetDropY = climbing || s.seatedPose
    ? 0
    : crewPhysClamp(Math.max(0, vertGLoad * 0.012) + (Math.abs(localRightTilt) + Math.abs(localFwdTilt)) * 0.045, 0, 0.085);
  const targetSpineX = crewPhysClamp(-localRightTilt * 0.62 * scaleFactor, -0.35, 0.35);
  const targetSpineZ = crewPhysClamp(-localFwdTilt * 0.52 * scaleFactor + (s.walk ?? 0) * 0.08, -0.30, 0.30);

  const omega = 14.0, omega2 = omega * omega, damp = 2 * 0.78 * omega;
  const invDenom = 1 / (1 + damp * safeDt + omega2 * safeDt * safeDt);
  phys.comVelX = (phys.comVelX + omega2 * (targetComX - phys.comShiftX) * safeDt) * invDenom;
  phys.comVelZ = (phys.comVelZ + omega2 * (targetComZ - phys.comShiftZ) * safeDt) * invDenom;
  phys.comVelY = (phys.comVelY + omega2 * (targetDropY - phys.comDropY) * safeDt) * invDenom;
  phys.comShiftX = crewPhysClamp(phys.comShiftX + phys.comVelX * safeDt, -0.085, 0.085);
  phys.comShiftZ = crewPhysClamp(phys.comShiftZ + phys.comVelZ * safeDt, -0.075, 0.075);
  phys.comDropY = crewPhysClamp(phys.comDropY + phys.comVelY * safeDt, 0, 0.095);

  phys.spineVelX = (phys.spineVelX + omega2 * (targetSpineX - phys.spineLeanX) * safeDt) * invDenom;
  phys.spineVelZ = (phys.spineVelZ + omega2 * (targetSpineZ - phys.spineLeanZ) * safeDt) * invDenom;
  phys.spineLeanX = crewPhysClamp(phys.spineLeanX + phys.spineVelX * safeDt, -0.38, 0.38);
  phys.spineLeanZ = crewPhysClamp(phys.spineLeanZ + phys.spineVelZ * safeDt, -0.34, 0.34);

  const lurch = crewPhysClamp(
    Math.abs(rollRate) * 0.65 + Math.abs(roll) * 0.35 + Math.abs(tangLat) * 0.08 + Math.abs(vertGLoad) * 0.05,
    0,
    1,
  );
  phys.armSpread += (lurch - phys.armSpread) * (1 - Math.exp(-safeDt * 9));

  let targetExertion = 0.16 + (s.walk ?? 0) * 0.32 + (s.brace ?? 0) * 0.25;
  if (s.job?.stage === 'working' || s.job?.stage === 'ascending') {
    targetExertion = s.job.kind === 'boarding' ? 0.95 : s.job.lookoutAtStation ? 0.38 : 0.78;
  } else if (s.seatedPose) {
    targetExertion = 0.68;
  }
  if ((s.firePanic ?? 0) > 0.15) targetExertion = Math.max(targetExertion, 0.92);
  phys.exertion += (targetExertion - phys.exertion) * (1 - Math.exp(-safeDt * 2.5));
  const breathFreq = 1.65 + phys.exertion * 2.85;
  phys.breathPhase = (phys.breathPhase + safeDt * breathFreq) % (Math.PI * 2);

  const j = s.job;
  if (j && j.kind === 'lookout' && (j.lookoutAtStation || j.stage === 'working')) {
    const tgt = resolveLookoutTarget(s, boat);
    phys.lookoutKind = tgt.kind;
    phys.usingSpyglass = tgt.useSpyglass;
    const relYaw = Math.atan2(Math.sin(tgt.worldYaw - (s.yaw ?? 0)), Math.cos(tgt.worldYaw - (s.yaw ?? 0)));
    phys.targetGazeYaw = crewPhysClamp(relYaw * 0.75, -0.88, 0.88);
    phys.targetGazePitch = crewPhysClamp(tgt.pitch, -0.45, 0.35);
    phys.gazeTimer = 0.25;
  } else {
    phys.gazeTimer -= safeDt;
    if (phys.gazeTimer <= 0) {
      phys.gazeTimer = 0.85 + (((s.crewIndex ?? 0) * 0.41 + (s.time ?? 0)) % 1.4);
      let gx = 0, gy = 0;
      if (j && (j.kind === 'rig' || j.kind === 'lookout') && ['ascending', 'working'].includes(j.stage)) {
        gx = 0.08 * Math.sin(s.time ?? 0);
        gy = 0.42;
      } else if (j && j.kind === 'haul' && j.stage === 'working') {
        gx = 0.05;
        gy = 0.34;
      } else if (j && j.kind === 'gunnery' && j.stage === 'working') {
        gx = j.gunRole === 'loader' ? -0.18 : 0.14;
        gy = -0.16;
      } else if ((s.firePanic ?? 0) > 0.18 && boat?.damage?.fires?.length) {
        const f = boat.damage.fires[0];
        const fx = (f.localPosition?.[0] ?? 0) - (s.position?.[0] ?? 0);
        const fz = (f.localPosition?.[2] ?? 0) - (s.position?.[2] ?? 0);
        const worldYaw = Math.atan2(fx, fz);
        const relYaw = Math.atan2(Math.sin(worldYaw - (s.yaw ?? 0)), Math.cos(worldYaw - (s.yaw ?? 0)));
        gx = crewPhysClamp(relYaw * 0.7, -0.85, 0.85);
        gy = -0.15;
      } else if (boat?.lookoutSighting && Math.abs(s.x ?? 0) > 0.35) {
        // Deckhands near the bulwark rail also glance out at sighted whales, dolphins, or ships
        const tgt = resolveLookoutTarget(s, boat);
        const relYaw = Math.atan2(Math.sin(tgt.worldYaw - (s.yaw ?? 0)), Math.cos(tgt.worldYaw - (s.yaw ?? 0)));
        if (Math.abs(relYaw) < 1.45) {
          gx = crewPhysClamp(relYaw * 0.72, -0.82, 0.82);
          gy = crewPhysClamp(tgt.pitch, -0.32, 0.25);
        }
      } else {
        const peers = company?.crew ?? company?.soldiers ?? null;
        let nearest = null, bestD = 2.8;
        if (peers && s.position) {
          for (let k = 0; k < peers.length; k++) {
            const other = peers[k];
            if (other === s || !other.visible || other.casualtyState === 'fallen' || !other.position) continue;
            const dy = Math.abs((other.position[1] ?? 0) - (s.position[1] ?? 0));
            if (dy > 1.2) continue;
            const d = Math.hypot((other.position[0] ?? 0) - s.position[0], (other.position[2] ?? 0) - s.position[2]);
            if (d > 0.4 && d < bestD) {
              bestD = d;
              nearest = other;
            }
          }
        }
        if (nearest) {
          const dx = nearest.position[0] - s.position[0];
          const dz = nearest.position[2] - s.position[2];
          const worldYaw = Math.atan2(dx, dz);
          const relYaw = Math.atan2(Math.sin(worldYaw - (s.yaw ?? 0)), Math.cos(worldYaw - (s.yaw ?? 0)));
          if (Math.abs(relYaw) < 1.35) {
            gx = crewPhysClamp(relYaw * 0.68, -0.78, 0.78);
            gy = crewPhysClamp(((nearest.scale?.[1] ?? 0.96) - (s.scale?.[1] ?? 0.96)) * 0.8, -0.12, 0.12);
          }
        } else {
          const scan = Math.sin((s.time ?? 0) * 0.55 + (s.crewIndex ?? 0) * 1.9);
          gx = scan * 0.28;
          gy = Math.cos((s.time ?? 0) * 0.37 + (s.crewIndex ?? 0)) * 0.06;
        }
      }
      phys.targetGazeYaw = gx;
      phys.targetGazePitch = gy;
    }
  }

  const gazeLerp = 1 - Math.exp(-safeDt * 6.5);
  phys.gazeYaw += (phys.targetGazeYaw - phys.gazeYaw) * gazeLerp;
  phys.gazePitch += (phys.targetGazePitch - phys.gazePitch) * gazeLerp;
  return phys;
}

export function poseCrewFingers(a, s, leftGrip = null, rightGrip = null) {
  const m = getCrewMixerMasks(a);
  if (!m.fingers.l.length && !m.fingers.r.length) return;

  if (leftGrip === null || rightGrip === null) {
    const j = s.job;
    if (s.seatedPose) {
      leftGrip = 0.84;
      rightGrip = 0.84;
    } else if (j && j.kind === 'lookout' && (j.lookoutAtStation || j.stage === 'working')) {
      // Left hand grips the crow's nest basket rim or shroud; right hand wraps around the brass spyglass
      leftGrip = 0.90;
      rightGrip = (s.phys?.usingSpyglass ?? true) ? 0.76 : 0.18;
    } else if (j && (j.kind === 'rig' || j.kind === 'lookout') && ['ascending', 'descending', 'working'].includes(j.stage)) {
      leftGrip = 0.88;
      rightGrip = 0.88;
    } else if (j && (j.kind === 'haul' || j.kind === 'hatch' || j.kind === 'mooring') && j.stage === 'working') {
      const pullPulse = 0.06 * Math.sin((s.time ?? 0) * 3.4);
      leftGrip = 0.82 + pullPulse;
      rightGrip = 0.82 - pullPulse;
    } else if (j && j.kind === 'gunnery' && j.stage === 'working') {
      leftGrip = 0.78;
      rightGrip = 0.82;
    } else if (j && j.kind === 'boarding' && j.stage === 'working') {
      leftGrip = 0.35;
      rightGrip = 0.94;
    } else if (s.role === 'Helmsman' || s.roles?.includes('helmsman')) {
      leftGrip = 1.05;
      rightGrip = 1.05;
    } else if ((s.firePanic ?? 0) > 0.18) {
      const tremor = 0.08 * Math.sin((s.time ?? 0) * 11 + (s.crewIndex ?? 0));
      leftGrip = -0.28 + tremor;
      rightGrip = -0.22 - tremor;
    } else if ((s.brace ?? 0) > 0.4) {
      leftGrip = 0.52;
      rightGrip = 0.52;
    } else {
      const idleWave = 0.04 * Math.sin((s.time ?? 0) * 1.7 + (s.crewIndex ?? 0));
      leftGrip = 0.26 + idleWave;
      rightGrip = 0.28 - idleWave;
    }
  }

  const grips = { l: crewPhysClamp(leftGrip, -0.45, 1.0), r: crewPhysClamp(rightGrip, -0.45, 1.0) };
  for (const side of ['l', 'r']) {
    const g = grips[side];
    const chains = m.fingers[side];
    for (let fIdx = 0; fIdx < chains.length; fIdx++) {
      const { name, nodes } = chains[fIdx];
      const cascade = name === 'thumb' ? 0.65 : (0.82 + fIdx * 0.09);
      for (let ph = 0; ph < nodes.length; ph++) {
        const node = nodes[ph];
        const restR = a.rest[node].r;
        const phWeight = ph === 0 ? 0.52 : ph === 1 ? 0.68 : 0.48;
        const angle = g * cascade * phWeight * 1.15;
        const half = angle * 0.5;
        const snh = Math.sin(half), csh = Math.cos(half);
        const dq = name === 'thumb'
          ? [snh * 0.55, side === 'l' ? snh * 0.45 : -snh * 0.45, snh * 0.70, csh]
          : [snh * 0.12, 0, snh * 0.99, csh];
        gltfQuatMultiply(a.pose[node].r, restR, dq);
      }
    }
    const handNode = side === 'l' ? m.handL : m.handR;
    if (handNode >= 0) {
      if (a.updateBranch) a.updateBranch(handNode);
      else a.update();
    }
  }
}

export function poseCrewGaze(a, s) {
  const phys = s.phys;
  if (!phys) return;
  const m = getCrewMixerMasks(a);
  if (m.neck < 0 || m.head < 0) return;

  const yaw = crewPhysClamp(phys.gazeYaw ?? 0, -0.95, 0.95);
  const pitch = crewPhysClamp(phys.gazePitch ?? 0, -0.52, 0.52);
  if (Math.abs(yaw) < 1e-3 && Math.abs(pitch) < 1e-3) return;

  for (const [node, wYaw, wPitch, wRoll] of [
    [m.neck, 0.35, 0.35, 0.05],
    [m.head, 0.65, 0.65, 0.12],
  ]) {
    const hy = (yaw * wYaw) * 0.5;
    const hp = (pitch * wPitch) * 0.5;
    const hr = (-yaw * wRoll) * 0.5;
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cp = Math.cos(hp), sp = Math.sin(hp);
    const cr = Math.cos(hr), sr = Math.sin(hr);
    const dq = [
      cy * sp * cr + sy * cp * sr,
      sy * cp * cr - cy * sp * sr,
      cy * cp * sr - sy * sp * cr,
      cy * cp * cr + sy * sp * sr,
    ];
    gltfQuatMultiply(a.pose[node].r, a.pose[node].r, dq);
  }
  if (a.updateBranch) a.updateBranch(m.neck);
  else a.update();
}

export function applySeaLegsAndBreathing(a, s, boat = null) {
  const phys = s.phys;
  if (!phys) return;
  const m = getCrewMixerMasks(a);

  // 1. Grounded Pelvis CoM Shift & Surface-Planted Two-Bone Leg/Knee IK for standing/bracing deckhands & sentries
  const hasExplicitFeet = Boolean(
    s.seatedPose ||
    s.walkContacts ||
    s.gunContacts ||
    s.grips?.foot_l ||
    s.grips?.foot_r ||
    (s.job?.rung ?? 0) > 0 ||
    s.job?.lookoutAtStation,
  );
  if (!hasExplicitFeet && m.pelvis >= 0 && m.footL >= 0 && m.footR >= 0 && (s.walk ?? 0) < 0.65) {
    const stanceWeight = crewPhysClamp(1 - (s.walk ?? 0) * 1.35, 0, 1);
    const footPosL = crewPhysMatPos(a.world[m.footL]);
    const footPosR = crewPhysMatPos(a.world[m.footR]);
    const rotFootL = crewPhysMatRotQuat(a.world[m.footL]);
    const rotFootR = crewPhysMatRotQuat(a.world[m.footR]);

    let dhL = 0, dhR = 0;
    const cYaw = Math.cos(s.yaw ?? 0), sYaw = Math.sin(s.yaw ?? 0);
    const scaleX = s.scale?.[0] || 1, scaleY = s.scale?.[1] || 1, scaleZ = s.scale?.[2] || 1;
    if (boat && s.position) {
      const sx = (boat.beam ?? 3.6) / 3.6;
      const sz = (boat.length ?? 12) / 12;
      const sy = vesselVerticalScale(boat);
      const rootFloor = crewDeckHeight(boat, s.position[2] / sz, s.position[0] / sx) * sy;
      if (Number.isFinite(rootFloor)) {
        const wxL = s.position[0] + cYaw * (footPosL[0] * scaleX) + sYaw * (footPosL[2] * scaleZ);
        const wzL = s.position[2] - sYaw * (footPosL[0] * scaleX) + cYaw * (footPosL[2] * scaleZ);
        const wxR = s.position[0] + cYaw * (footPosR[0] * scaleX) + sYaw * (footPosR[2] * scaleZ);
        const wzR = s.position[2] - sYaw * (footPosR[0] * scaleX) + cYaw * (footPosR[2] * scaleZ);
        const fL = crewDeckHeight(boat, wzL / sz, wxL / sx) * sy;
        const fR = crewDeckHeight(boat, wzR / sz, wxR / sx) * sy;
        if (Number.isFinite(fL) && Math.abs(fL - rootFloor) < 0.34) dhL = (fL - rootFloor) / scaleY;
        if (Number.isFinite(fR) && Math.abs(fR - rootFloor) < 0.34) dhR = (fR - rootFloor) / scaleY;
      }
    } else if (s.building) {
      const inst = s.building;
      const cB = Math.cos((s.yaw ?? 0) - (inst.yaw ?? 0));
      const sB = Math.sin((s.yaw ?? 0) - (inst.yaw ?? 0));
      const slX = inst.slopeX ?? 0, slZ = inst.slopeZ ?? 0;
      dhL = ((cB * footPosL[0] + sB * footPosL[2]) * slX + (-sB * footPosL[0] + cB * footPosL[2]) * slZ);
      dhR = ((cB * footPosR[0] + sB * footPosR[2]) * slX + (-sB * footPosR[0] + cB * footPosR[2]) * slZ);
    }

    const comX = (phys.comShiftX ?? 0) * stanceWeight;
    const comZ = (phys.comShiftZ ?? 0) * stanceWeight;
    const comDrop = ((phys.comDropY ?? 0) + Math.max(0, -Math.min(dhL, dhR))) * stanceWeight;
    if (Math.abs(comX) > 1e-3 || Math.abs(comZ) > 1e-3 || comDrop > 1e-3 || Math.abs(dhL) > 1e-3 || Math.abs(dhR) > 1e-3) {
      const pCur = crewPhysMatPos(a.world[m.pelvis]);
      crewPhysMoveBoneLocalTarget(a, m.pelvis, [pCur[0] + comX, pCur[1] - comDrop, pCur[2] + comZ]);
      const tgtL = [footPosL[0], footPosL[1] + dhL * stanceWeight, footPosL[2]];
      const tgtR = [footPosR[0], footPosR[1] + dhR * stanceWeight, footPosR[2]];
      crewPhysSolveTwoBoneIK(a, m.thighL, m.calfL, m.footL, tgtL, [0.22, 0.42, 0.82]);
      crewPhysSolveTwoBoneIK(a, m.thighR, m.calfR, m.footR, tgtR, [-0.22, 0.42, 0.82]);
      // Restore flat boot sole orientation after leg IK knee bend
      for (const [fNode, desiredQ] of [[m.footL, rotFootL], [m.footR, rotFootR]]) {
        const parent = a.parent[fNode];
        if (parent >= 0) {
          const pQ = crewPhysMatRotQuat(a.world[parent]);
          const invP = [-pQ[0], -pQ[1], -pQ[2], pQ[3]];
          gltfQuatMultiply(a.pose[fNode].r, invP, desiredQ);
          if (a.updateBranch) a.updateBranch(fNode);
        }
      }
    }
  }

  // 2. Spine Sea-Legs Counter-Lean & Exertion-Scaled Thoracic Breathing
  const breath = Math.sin(phys.breathPhase ?? 0);
  const breathAmp = 0.012 + (phys.exertion ?? 0.2) * 0.028;
  const leanX = phys.spineLeanX ?? 0;
  const leanZ = phys.spineLeanZ ?? 0;

  for (const [node, wLean, wBreath] of [
    [m.spine1, 0.38, 0.25],
    [m.spine2, 0.36, 0.45],
    [m.spine3, 0.26, 0.30],
  ]) {
    if (node < 0) continue;
    const rx = (leanZ * wLean - breath * breathAmp * wBreath) * 0.5;
    const rz = (-leanX * wLean) * 0.5;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    const dq = [sx * cz, sx * sz, cx * sz, cx * cz];
    gltfQuatMultiply(a.pose[node].r, a.pose[node].r, dq);
  }

  const hasConstrainedHands = Boolean(s.grips?.hand_l || s.grips?.hand_r || s.seatedPose);
  const spread = hasConstrainedHands ? 0 : (phys.armSpread ?? 0) * 0.18;
  const shrug = Math.max(0, breath) * breathAmp * 0.45;
  for (const [clav, arm, sign] of [
    [m.clavicleL, m.upperarmL, 1],
    [m.clavicleR, m.upperarmR, -1],
  ]) {
    if (clav >= 0 && (shrug > 1e-4 || spread > 1e-4)) {
      const half = (shrug + spread * 0.3) * 0.5 * sign;
      gltfQuatMultiply(a.pose[clav].r, a.pose[clav].r, [0, 0, Math.sin(half), Math.cos(half)]);
    }
    if (arm >= 0 && spread > 1e-3 && !hasConstrainedHands) {
      const half = spread * 0.5 * sign;
      gltfQuatMultiply(a.pose[arm].r, a.pose[arm].r, [0, 0, Math.sin(half), Math.cos(half)]);
    }
  }

  if (m.spine1 >= 0) {
    if (a.updateBranch) a.updateBranch(m.spine1);
    else a.update();
  }

  // 3. Closed-Chain Hand Re-Pinning: keep gripped hands locked to tillers, ropes, cannon tools, and basket rims while torso sways
  if (s.grips?.hand_l && m.upperarmL >= 0) {
    crewPhysSolveTwoBoneIK(a, m.upperarmL, m.lowerarmL, m.handL, s.grips.hand_l, [0.52, 0.92, 0.32]);
  }
  if (s.grips?.hand_r && m.upperarmR >= 0) {
    crewPhysSolveTwoBoneIK(a, m.upperarmR, m.lowerarmR, m.handR, s.grips.hand_r, [-0.52, 0.92, 0.32]);
  }
}

export function applyPoseInertializer(a, s, dt) {
  const nodeCount = a.pose.length;
  let mixer = s._mixer;
  const actionKey = crewPhysResolveActionKey(s);

  if (!mixer || mixer.nodeCount !== nodeCount) {
    const lastR = new Float32Array(nodeCount * 4);
    const fromR = new Float32Array(nodeCount * 4);
    for (let i = 0; i < nodeCount; i++) {
      lastR.set(a.pose[i].r, i * 4);
      fromR.set(a.pose[i].r, i * 4);
    }
    const m = getCrewMixerMasks(a);
    const pNode = m.pelvis >= 0 ? m.pelvis : 0;
    s._mixer = {
      nodeCount,
      actionKey,
      transitionAge: 10,
      transitionDuration: 0.24,
      lastR,
      fromR,
      lastPelvisT: a.pose[pNode].t.slice(),
      fromPelvisT: a.pose[pNode].t.slice(),
    };
    return;
  }

  const m = getCrewMixerMasks(a);
  const pNode = m.pelvis >= 0 ? m.pelvis : 0;

  if (mixer.actionKey !== actionKey) {
    mixer.fromR.set(mixer.lastR);
    mixer.fromPelvisT.set(mixer.lastPelvisT);
    mixer.actionKey = actionKey;
    mixer.transitionAge = 0;
    mixer.transitionDuration = actionKey.startsWith('ragdoll') ? 0.14 : 0.24;
  }

  const stepDt = crewPhysClamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
  mixer.transitionAge += stepDt;

  if (mixer.transitionAge < mixer.transitionDuration) {
    const u = crewPhysClamp(mixer.transitionAge / mixer.transitionDuration, 0, 1);
    const oneMinusU = 1 - u;
    const outWeight = (1 + 3 * u) * oneMinusU * oneMinusU * oneMinusU;
    if (outWeight > 1e-3) {
      const qFrom = new Float32Array(4);
      for (let i = 0; i < nodeCount; i++) {
        const off = i * 4;
        qFrom[0] = mixer.fromR[off];
        qFrom[1] = mixer.fromR[off + 1];
        qFrom[2] = mixer.fromR[off + 2];
        qFrom[3] = mixer.fromR[off + 3];
        gltfSlerp(a.pose[i].r, a.pose[i].r, qFrom, outWeight);
      }
      for (let k = 0; k < 3; k++) {
        a.pose[pNode].t[k] += (mixer.fromPelvisT[k] - a.pose[pNode].t[k]) * outWeight;
      }
      a.update();
    }
  }

  for (let i = 0; i < nodeCount; i++) {
    mixer.lastR.set(a.pose[i].r, i * 4);
  }
  mixer.lastPelvisT.set(a.pose[pNode].t);
}

export function applyCrewRealism(a, s, boat = null, dt = 1 / 60) {
  if (!a || !s) return;
  if (!s.phys) stepCrewPhysicsState(s, boat, dt);

  if (s.overboard?.inWater) {
    poseCrewFingers(a, s, 0.22, 0.22);
    applyPoseInertializer(a, s, dt);
    return;
  }
  const isDown = s.casualtyState === 'fallen' || (s.knockdownTimer ?? 0) > 0;
  if (isDown) {
    applyArticulatedRagdollPose(a, s, boat);
    applyPoseInertializer(a, s, dt);
    return;
  }

  applySeaLegsAndBreathing(a, s, boat);
  poseCrewGaze(a, s);
  poseCrewFingers(a, s);
  applyPoseInertializer(a, s, dt);
}
