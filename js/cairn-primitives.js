// Cairn Declarative JSON Primitive & Voxel Language for Waterworld
// Ported from contextflow/src/lib/cairn (types.ts, brushes.ts, damage.ts, primitives-renderer.ts).
// Compiles declarative Cairn JSON scenes (shapes dictionary, groups, stacks, walls with openings,
// arches, domes, roofs, stairs, cylinders, voxel runs, and CSG/voxel damage impactors) directly
// into Waterworld's 8-float unshared-face port vertex buffer for 3D Voronoi block-cell detachment.

export function isFraction(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (!match) return false;
  return parseFloat(match[2]) !== 0;
}

export function parseFraction(fraction) {
  if (typeof fraction !== 'string') return NaN;
  const match = fraction.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (!match) return NaN;
  const num = parseFloat(match[1]);
  const den = parseFloat(match[2]);
  return den === 0 ? NaN : num / den;
}

export function resolveNumeric(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    if (isFraction(value)) return parseFraction(value);
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function resolvePosition(pos, fallback = [0, 0, 0]) {
  if (!Array.isArray(pos) || pos.length < 3) return [...fallback];
  return [
    resolveNumeric(pos[0], fallback[0]),
    resolveNumeric(pos[1], fallback[1]),
    resolveNumeric(pos[2], fallback[2]),
  ];
}

export function toFraction(value, maxDenominator = 1000) {
  const common = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16];
  const tol = 1e-9;
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  for (const d of common) {
    const n = Math.round(value * d);
    if (Math.abs(n / d - value) < tol) {
      const div = gcd(Math.abs(n), d);
      return `${n / div}/${d / div}`;
    }
  }
  for (let d = 2; d <= maxDenominator; d++) {
    const n = Math.round(value * d);
    if (Math.abs(n / d - value) < tol) {
      const div = gcd(Math.abs(n), d);
      return `${n / div}/${d / div}`;
    }
  }
  return undefined;
}

// Map Cairn material names (or numeric kind IDs) to Waterworld [kind, shade] pairs
export const CAIRN_MATERIAL_TO_KIND = Object.freeze({
  timber: { kind: 10, shade: 0.78 },
  wood: { kind: 10, shade: 0.80 },
  oak: { kind: 10, shade: 0.74 },
  dark_wood: { kind: 10, shade: 0.62 },
  beam: { kind: 10, shade: 0.70 },
  stone: { kind: 11, shade: 0.86 },
  ashlar: { kind: 11, shade: 0.90 },
  limestone: { kind: 11, shade: 0.92 },
  gray_stone: { kind: 11, shade: 0.82 },
  light_gray_stone: { kind: 11, shade: 0.91 },
  dark_stone: { kind: 11, shade: 0.72 },
  quoin: { kind: 11, shade: 0.85 },
  stucco: { kind: 12, shade: 0.92 },
  whitewash: { kind: 12, shade: 0.96 },
  plaster: { kind: 12, shade: 0.90 },
  cream_stucco: { kind: 12, shade: 0.94 },
  ochre_stucco: { kind: 12, shade: 0.86 },
  white_plastic: { kind: 12, shade: 0.95 },
  terracotta: { kind: 13, shade: 0.90 },
  tile: { kind: 13, shade: 0.92 },
  roof_tile: { kind: 13, shade: 0.91 },
  brick: { kind: 13, shade: 0.82 },
  red_brick: { kind: 13, shade: 0.80 },
  recess: { kind: 14, shade: 0.55 },
  opening: { kind: 14, shade: 0.50 },
  iron: { kind: 14, shade: 0.62 },
  bronze: { kind: 10, shade: 0.58 },
  thatch: { kind: 15, shade: 0.88 },
  reed: { kind: 15, shade: 0.90 },
  palm_thatch: { kind: 15, shade: 0.88 },
  cobble: { kind: 16, shade: 0.84 },
  pavement: { kind: 16, shade: 0.86 },
  earth: { kind: 16, shade: 0.78 },
  bark: { kind: 17, shade: 0.86 },
  birchbark: { kind: 17, shade: 0.90 },
});
const CAIRN_MATERIAL_MAP = CAIRN_MATERIAL_TO_KIND;

export function resolveCairnMaterial(material, fallbackKind = 11, fallbackShade = 0.88) {
  if (typeof material === 'number' && Number.isFinite(material)) {
    return { kind: material, shade: fallbackShade };
  }
  if (typeof material === 'string') {
    const key = material.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (CAIRN_MATERIAL_MAP[key]) {
      return { ...CAIRN_MATERIAL_MAP[key] };
    }
  }
  if (material && typeof material === 'object' && Number.isFinite(material.kind)) {
    return {
      kind: material.kind,
      shade: Number.isFinite(material.shade) ? material.shade : fallbackShade,
    };
  }
  return { kind: fallbackKind, shade: fallbackShade };
}

export function isShapeReference(prim) {
  return Boolean(prim && typeof prim === 'object' && typeof prim.shape === 'string' && !prim.primitive);
}

function clonePrimitive(prim) {
  return JSON.parse(JSON.stringify(prim));
}

function applyMaterialToChildren(prim, material) {
  if (!prim || typeof prim !== 'object') return;
  if (!prim.material) prim.material = material;
  if (Array.isArray(prim.children)) {
    for (const child of prim.children) applyMaterialToChildren(child, material);
  }
}

export function resolveShapeReference(ref, shapes = {}, grid = null) {
  if (!ref || !shapes || !shapes[ref.shape]) return null;
  const resolved = clonePrimitive(shapes[ref.shape]);
  if (ref.name) resolved.name = ref.name;
  if (ref.partGroup) resolved.partGroup = ref.partGroup;
  const mat = ref.material ?? resolved.material;
  if (mat) applyMaterialToChildren(resolved, mat);

  let offset = [0, 0, 0];
  if (ref.position !== undefined) {
    offset = resolvePosition(ref.position);
  } else if (Array.isArray(ref.cell)) {
    const cellSize = resolveNumeric(grid?.cellSize, 1);
    const origin = resolvePosition(grid?.origin, [0, 0, 0]);
    const c = resolvePosition(ref.cell);
    offset = [origin[0] + c[0] * cellSize, origin[1] + c[1] * cellSize, origin[2] + c[2] * cellSize];
  }

  const pType = resolved.primitive ?? resolved.brush ?? resolved.type;
  if (pType === 'group' || pType === 'stack') {
    const basePos = resolvePosition(resolved.position, [0, 0, 0]);
    resolved.position = [basePos[0] + offset[0], basePos[1] + offset[1], basePos[2] + offset[2]];
  } else if (pType === 'cylinder' || pType === 'cone' || pType === 'dome' || pType === 'voxel-column') {
    const base = resolvePosition(resolved.base ?? resolved.position, [0, 0, 0]);
    resolved.base = [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]];
  } else if (pType === 'sphere') {
    const center = resolvePosition(resolved.center ?? resolved.position, [0, 0, 0]);
    resolved.center = [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]];
  } else if (resolved.from !== undefined && resolved.to !== undefined) {
    const f = resolvePosition(resolved.from);
    const t = resolvePosition(resolved.to);
    resolved.from = [f[0] + offset[0], f[1] + offset[1], f[2] + offset[2]];
    resolved.to = [t[0] + offset[0], t[1] + offset[1], t[2] + offset[2]];
  } else if (resolved.pos !== undefined) {
    const p = resolvePosition(resolved.pos);
    resolved.pos = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
  } else {
    const p = resolvePosition(resolved.position, [0, 0, 0]);
    resolved.position = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
  }

  if (ref.rotation !== undefined) resolved.rotation = ref.rotation;
  if (ref.scale !== undefined) resolved.scale = ref.scale;
  return resolved;
}

// Test whether a 3D point [x, y, z] lies inside a Cairn CSG / Impactor brush
function pointInsideImpactor(pt, impactor) {
  if (!impactor || typeof impactor !== 'object') return false;
  const [x, y, z] = pt;
  const type = impactor.type ?? impactor.shape ?? 'sphere';
  if (type === 'sphere') {
    const c = resolvePosition(impactor.center ?? impactor.position, [0, 0, 0]);
    const r = resolveNumeric(impactor.radius, 1);
    const vel = impactor.velocity ? resolvePosition(impactor.velocity, [0, 0, 0]) : null;
    if (vel && Math.hypot(vel[0], vel[1], vel[2]) > 1e-4) {
      // Swept sphere (capsule wound channel)
      const vx = vel[0], vy = vel[1], vz = vel[2];
      const vLen2 = vx * vx + vy * vy + vz * vz;
      const t = Math.max(-0.5, Math.min(1.0, ((x - c[0]) * vx + (y - c[1]) * vy + (z - c[2]) * vz) / vLen2));
      const px = c[0] + vx * t, py = c[1] + vy * t, pz = c[2] + vz * t;
      return (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2 <= r * r;
    }
    return (x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 <= r * r;
  }
  if (type === 'box') {
    const mn = resolvePosition(impactor.min ?? impactor.from, [-1, -1, -1]);
    const mx = resolvePosition(impactor.max ?? impactor.to, [1, 1, 1]);
    return (
      x >= Math.min(mn[0], mx[0]) && x <= Math.max(mn[0], mx[0]) &&
      y >= Math.min(mn[1], mx[1]) && y <= Math.max(mn[1], mx[1]) &&
      z >= Math.min(mn[2], mx[2]) && z <= Math.max(mn[2], mx[2])
    );
  }
  if (type === 'cylinder') {
    const base = resolvePosition(impactor.base ?? [0, 0, 0]);
    const r = resolveNumeric(impactor.radius, 1);
    const h = resolveNumeric(impactor.height, 2);
    return y >= base[1] && y <= base[1] + h && (x - base[0]) ** 2 + (z - base[2]) ** 2 <= r * r;
  }
  return false;
}

// Expand a Cairn voxel primitive (block, blocks, box, wall, stairs, arch, dome, frame, voxel-column, voxel-line)
// into an array of { pos: [x, y, z], size: [sx, sy, sz], material } blocks.
export function expandCairnVoxelPrimitive(prim) {
  if (!prim || typeof prim !== 'object') return [];
  const pType = prim.primitive ?? prim.brush ?? prim.type;
  const mat = prim.material ?? 'stone';
  const blocks = [];

  if (pType === 'block') {
    blocks.push({ pos: resolvePosition(prim.pos ?? prim.position), material: mat });
    return blocks;
  }

  if (pType === 'blocks' || pType === 'box') {
    if (Array.isArray(prim.runs)) {
      for (const run of prim.runs) {
        const rx = Array.isArray(run.x) ? [resolveNumeric(run.x[0], 0), resolveNumeric(run.x[1], 0)] : [resolveNumeric(run.x, 0), resolveNumeric(run.x, 0)];
        const ry = Array.isArray(run.y) ? [resolveNumeric(run.y[0], 0), resolveNumeric(run.y[1], 0)] : [resolveNumeric(run.y, 0), resolveNumeric(run.y, 0)];
        const rz = Array.isArray(run.z) ? [resolveNumeric(run.z[0], 0), resolveNumeric(run.z[1], 0)] : [resolveNumeric(run.z, 0), resolveNumeric(run.z, 0)];
        const x0 = Math.floor(Math.min(rx[0], rx[1])), x1 = Math.floor(Math.max(rx[0], rx[1]));
        const y0 = Math.floor(Math.min(ry[0], ry[1])), y1 = Math.floor(Math.max(ry[0], ry[1]));
        const z0 = Math.floor(Math.min(rz[0], rz[1])), z1 = Math.floor(Math.max(rz[0], rz[1]));
        const rMat = run.material ?? mat;
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z++) {
              blocks.push({ pos: [x, y, z], material: rMat });
            }
          }
        }
      }
      return blocks;
    }
    const f = resolvePosition(prim.from);
    const t = resolvePosition(prim.to);
    const x0 = Math.floor(Math.min(f[0], t[0])), x1 = Math.ceil(Math.max(f[0], t[0]));
    const y0 = Math.floor(Math.min(f[1], t[1])), y1 = Math.ceil(Math.max(f[1], t[1]));
    const z0 = Math.floor(Math.min(f[2], t[2])), z1 = Math.ceil(Math.max(f[2], t[2]));
    const hollow = Boolean(prim.hollow);
    const thick = Math.max(1, Math.round(resolveNumeric(prim.thickness, 1)));
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) {
          if (
            hollow &&
            x >= x0 + thick && x < x1 - thick &&
            y >= y0 + thick && y < y1 - thick &&
            z >= z0 + thick && z < z1 - thick
          ) {
            continue;
          }
          blocks.push({ pos: [x, y, z], material: mat });
        }
      }
    }
    return blocks;
  }

  if (pType === 'voxel-line' || pType === 'line') {
    const f = resolvePosition(prim.from);
    const t = resolvePosition(prim.to);
    const steps = Math.max(1, Math.round(Math.max(Math.abs(t[0] - f[0]), Math.abs(t[1] - f[1]), Math.abs(t[2] - f[2]))));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      blocks.push({
        pos: [Math.round(f[0] + (t[0] - f[0]) * u), Math.round(f[1] + (t[1] - f[1]) * u), Math.round(f[2] + (t[2] - f[2]) * u)],
        material: mat,
      });
    }
    return blocks;
  }

  if (pType === 'voxel-column' || pType === 'column') {
    const base = resolvePosition(prim.base ?? prim.from, [0, 0, 0]);
    const h = Math.max(1, Math.round(resolveNumeric(prim.height, 4)));
    for (let dy = 0; dy < h; dy++) {
      blocks.push({ pos: [Math.round(base[0]), Math.round(base[1]) + dy, Math.round(base[2])], material: mat });
    }
    return blocks;
  }

  return blocks;
}

// Render a set of voxel blocks with interior hidden-face culling (SurfaceVoxel bitmask from Cairn damage.ts)
// while emitting every exposed face as an unshared 4-vertex Voronoi-detachable quad.
export function emitCairnVoxelGrid(blocks, { toWorld, pushQuad, damageRegions = [] }) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const grid = new Map();
  const keyOf = (x, y, z) => `${x},${y},${z}`;

  for (const b of blocks) {
    if (!b?.pos) continue;
    const x = Math.round(b.pos[0]);
    const y = Math.round(b.pos[1]);
    const z = Math.round(b.pos[2]);
    let carved = false;
    if (Array.isArray(damageRegions) && damageRegions.length > 0) {
      const center = [x + 0.5, y + 0.5, z + 0.5];
      for (const reg of damageRegions) {
        if (pointInsideImpactor(center, reg?.impactor ?? reg?.brush ?? reg)) {
          carved = true;
          break;
        }
      }
    }
    if (!carved) {
      grid.set(keyOf(x, y, z), { x, y, z, material: b.material });
    }
  }

  let emittedFaces = 0;
  for (const vox of grid.values()) {
    const { x, y, z, material } = vox;
    const { kind, shade } = resolveCairnMaterial(material);
    const x0 = x, x1 = x + 1;
    const y0 = y, y1 = y + 1;
    const z0 = z, z1 = z + 1;
    // -Z face
    if (!grid.has(keyOf(x, y, z - 1))) {
      pushQuad(toWorld(x0, y0, z0), toWorld(x1, y0, z0), toWorld(x1, y1, z0), toWorld(x0, y1, z0), kind, shade * 0.94);
      emittedFaces++;
    }
    // +Z face
    if (!grid.has(keyOf(x, y, z + 1))) {
      pushQuad(toWorld(x1, y0, z1), toWorld(x0, y0, z1), toWorld(x0, y1, z1), toWorld(x1, y1, z1), kind, shade * 0.96);
      emittedFaces++;
    }
    // -X face
    if (!grid.has(keyOf(x - 1, y, z))) {
      pushQuad(toWorld(x0, y0, z1), toWorld(x0, y0, z0), toWorld(x0, y1, z0), toWorld(x0, y1, z1), kind, shade * 0.88);
      emittedFaces++;
    }
    // +X face
    if (!grid.has(keyOf(x + 1, y, z))) {
      pushQuad(toWorld(x1, y0, z0), toWorld(x1, y0, z1), toWorld(x1, y1, z1), toWorld(x1, y1, z0), kind, shade);
      emittedFaces++;
    }
    // +Y top face
    if (!grid.has(keyOf(x, y + 1, z))) {
      pushQuad(toWorld(x0, y1, z0), toWorld(x1, y1, z0), toWorld(x1, y1, z1), toWorld(x0, y1, z1), kind, Math.min(1, shade * 1.06));
      emittedFaces++;
    }
  }
  return emittedFaces;
}

// Compute the vertical span of a Cairn primitive (used by `stack` primitive)
function computePrimitiveHeight(prim, shapes = {}) {
  if (!prim) return 0;
  if (isShapeReference(prim)) {
    const resolved = resolveShapeReference(prim, shapes);
    return computePrimitiveHeight(resolved, shapes);
  }
  if (prim.height !== undefined) return resolveNumeric(prim.height, 0);
  if (prim.from && prim.to) {
    const f = resolvePosition(prim.from);
    const t = resolvePosition(prim.to);
    return Math.abs(t[1] - f[1]);
  }
  if (prim.primitive === 'dome' || prim.primitive === 'sphere') {
    return resolveNumeric(prim.height ?? prim.radius, 2);
  }
  if (prim.primitive === 'group' && Array.isArray(prim.children)) {
    let maxH = 0;
    for (const c of prim.children) maxH = Math.max(maxH, computePrimitiveHeight(c, shapes));
    return maxH;
  }
  return 0;
}

// Compile & emit a Cairn JSON primitive list into Waterworld's port geometry builder
export function emitCairnScene(sceneSpec, helpers) {
  if (!sceneSpec || !helpers) return;
  const {
    toWorld: rootToWorld,
    emitBox,
    emitCylinder,
    emitRoof,
    pushQuad,
    pushTri,
    withPartGroup = (_name, fn) => fn(),
  } = helpers;

  const shapes = sceneSpec.shapes ?? sceneSpec.world?.shapes ?? {};
  const grid = sceneSpec.grid ?? sceneSpec.world?.grid ?? null;
  const primitives = sceneSpec.primitives ?? sceneSpec.items ?? sceneSpec.world?.primitives ?? [];
  const damageRegions = sceneSpec.damageRegions ?? sceneSpec.damage ?? sceneSpec.impactors ?? [];

  const composeToWorld = (parentToWorld, pos = [0, 0, 0], rotDeg = [0, 0, 0], scale = [1, 1, 1]) => {
    const [tx, ty, tz] = resolvePosition(pos, [0, 0, 0]);
    const ry = ((Array.isArray(rotDeg) ? resolveNumeric(rotDeg[1], 0) : resolveNumeric(rotDeg, 0)) * Math.PI) / 180;
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const sx = Array.isArray(scale) ? resolveNumeric(scale[0], 1) : resolveNumeric(scale, 1);
    const syScale = Array.isArray(scale) ? resolveNumeric(scale[1], 1) : resolveNumeric(scale, 1);
    const sz = Array.isArray(scale) ? resolveNumeric(scale[2], 1) : resolveNumeric(scale, 1);
    return (lx, ly, lz) => {
      const x1 = lx * sx;
      const y1 = ly * syScale;
      const z1 = lz * sz;
      const rx = x1 * cy + z1 * sy + tx;
      const ryWorld = y1 + ty;
      const rz = -x1 * sy + z1 * cy + tz;
      return parentToWorld(rx, ryWorld, rz);
    };
  };

  const emitSinglePrimitive = (rawPrim, localToWorld) => {
    if (!rawPrim) return;
    const prim = isShapeReference(rawPrim) ? resolveShapeReference(rawPrim, shapes, grid) : rawPrim;
    if (!prim) return;

    const groupName = prim.partGroup ?? prim.name ? String(prim.partGroup ?? prim.name) : null;
    const run = () => {
      const pType = prim.primitive ?? prim.brush ?? prim.type;
      const { kind, shade } = resolveCairnMaterial(prim.material, 11, 0.88);
      const primToWorld = (prim.rotation || prim.scale)
        ? composeToWorld(localToWorld, [0, 0, 0], prim.rotation ?? [0, 0, 0], prim.scale ?? [1, 1, 1])
        : localToWorld;

      if (pType === 'group') {
        const gToWorld = composeToWorld(localToWorld, prim.position ?? [0, 0, 0], prim.rotation ?? [0, 0, 0], prim.scale ?? [1, 1, 1]);
        for (const child of prim.children ?? prim.items ?? []) {
          emitSinglePrimitive(child, gToWorld);
        }
        return;
      }

      if (pType === 'stack') {
        const basePos = resolvePosition(prim.position, [0, 0, 0]);
        let curY = basePos[1];
        for (const level of prim.children ?? prim.levels ?? prim.items ?? []) {
          const levelToWorld = composeToWorld(localToWorld, [basePos[0], curY, basePos[2]], prim.rotation ?? [0, 0, 0], prim.scale ?? [1, 1, 1]);
          emitSinglePrimitive(level, levelToWorld);
          curY += computePrimitiveHeight(level, shapes) + resolveNumeric(prim.gap, 0);
        }
        return;
      }

      if (pType === 'block' || pType === 'blocks' || pType === 'voxel-line' || pType === 'voxel-column') {
        const vox = expandCairnVoxelPrimitive(prim);
        emitCairnVoxelGrid(vox, { toWorld: primToWorld, pushQuad, damageRegions: prim.damage ?? damageRegions });
        return;
      }

      if (pType === 'box') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const x0 = Math.min(f[0], t[0]), x1 = Math.max(f[0], t[0]);
        const y0 = Math.min(f[1], t[1]), y1 = Math.max(f[1], t[1]);
        const z0 = Math.min(f[2], t[2]), z1 = Math.max(f[2], t[2]);
        const topInset = resolveNumeric(prim.topInset, 0);
        if (prim.hollow) {
          const th = Math.max(0.25, resolveNumeric(prim.thickness, 0.6));
          emitBox(primToWorld, x0, x1, y0, y1, z0, z0 + th, kind, shade);
          emitBox(primToWorld, x0, x1, y0, y1, z1 - th, z1, kind, shade);
          emitBox(primToWorld, x0, x0 + th, y0, y1, z0 + th, z1 - th, kind, shade * 0.94);
          emitBox(primToWorld, x1 - th, x1, y0, y1, z0 + th, z1 - th, kind, shade * 0.94);
        } else {
          emitBox(primToWorld, x0, x1, y0, y1, z0, z1, kind, shade, Boolean(prim.includeBottom), topInset);
        }
        return;
      }

      if (pType === 'wall') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const h = Math.max(0.5, resolveNumeric(prim.height, Math.max(2.5, Math.abs(t[1] - f[1]))));
        const th = Math.max(0.25, resolveNumeric(prim.thickness, 0.65));
        const y0 = Math.min(f[1], t[1]);
        const y1 = y0 + h;
        const dx = t[0] - f[0], dz = t[2] - f[2];
        const len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len;
        const nx = -uz, nz = ux;
        const wallToWorld = (sAlong, yLocal, nAcross) =>
          primToWorld(f[0] + ux * sAlong + nx * nAcross, yLocal, f[2] + uz * sAlong + nz * nAcross);

        const openings = Array.isArray(prim.openings) ? [...prim.openings] : [];
        openings.sort((a, b) => resolveNumeric(a.offset ?? a.at, 0) - resolveNumeric(b.offset ?? b.at, 0));

        let curS = 0;
        for (const op of openings) {
          const opCenter = resolveNumeric(op.offset ?? op.at, len * 0.5);
          const opW = Math.max(0.5, resolveNumeric(op.width, 1.4));
          const opH = Math.max(0.6, resolveNumeric(op.height, 2.2));
          const sill = Math.max(0, resolveNumeric(op.sillHeight ?? op.sill, 0));
          const s0 = Math.max(curS, opCenter - opW * 0.5);
          const s1 = Math.min(len, opCenter + opW * 0.5);
          if (s0 > curS + 0.08) {
            emitBox(wallToWorld, curS, s0, y0, y1, -th * 0.5, th * 0.5, kind, shade);
          }
          if (s1 > s0 + 0.1) {
            if (sill > 0.08) {
              emitBox(wallToWorld, s0, s1, y0, y0 + sill, -th * 0.5, th * 0.5, kind, shade * 0.95);
            }
            const topOpenY = Math.min(y1 - 0.15, y0 + sill + opH);
            if (y1 > topOpenY + 0.08) {
              emitBox(wallToWorld, s0, s1, topOpenY, y1, -th * 0.5, th * 0.5, kind, shade * 0.96);
            }
            // Dark recessed interior opening & stone surround jambs
            emitBox(wallToWorld, s0 + 0.06, s1 - 0.06, y0 + sill, topOpenY, -th * 0.36, th * 0.36, 14, 0.52);
            emitBox(wallToWorld, s0 - 0.12, s0 + 0.08, y0 + sill, topOpenY, -th * 0.56, th * 0.56, 11, 0.88);
            emitBox(wallToWorld, s1 - 0.08, s1 + 0.12, y0 + sill, topOpenY, -th * 0.56, th * 0.56, 11, 0.88);
            emitBox(wallToWorld, s0 - 0.16, s1 + 0.16, topOpenY - 0.05, topOpenY + 0.22, -th * 0.58, th * 0.58, 11, 0.90);
          }
          curS = Math.max(curS, s1);
        }
        if (curS < len - 0.05) {
          emitBox(wallToWorld, curS, len, y0, y1, -th * 0.5, th * 0.5, kind, shade);
        }

        if (prim.crenellated) {
          const merlonW = resolveNumeric(prim.merlonWidth, 1.15);
          const merlonGap = resolveNumeric(prim.merlonGap, 0.85);
          const merlonH = resolveNumeric(prim.merlonHeight, 0.78);
          const step = merlonW + merlonGap;
          for (let s = 0; s + merlonW <= len + 0.05; s += step) {
            emitBox(wallToWorld, s, Math.min(len, s + merlonW), y1, y1 + merlonH, -th * 0.52, th * 0.52, 11, shade * 0.96, false, 0.04);
          }
        }
        return;
      }

      if (pType === 'arch') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const h = Math.max(1.8, resolveNumeric(prim.height, 3.6));
        const th = Math.max(0.35, resolveNumeric(prim.thickness, 0.75));
        const y0 = Math.min(f[1], t[1]);
        const dx = t[0] - f[0], dz = t[2] - f[2];
        const span = Math.hypot(dx, dz) || 3.0;
        const ux = dx / span, uz = dz / span;
        const nx = -uz, nz = ux;
        const archToWorld = (sAlong, yLocal, nAcross) =>
          primToWorld(f[0] + ux * sAlong + nx * nAcross, yLocal, f[2] + uz * sAlong + nz * nAcross);

        const pierW = Math.max(0.45, resolveNumeric(prim.pierWidth, span * 0.18));
        const radius = Math.max(0.4, (span - pierW * 2) * 0.5);
        const ySpring = Math.max(y0 + 0.8, y0 + h - radius - 0.35);
        // Side piers
        emitBox(archToWorld, 0, pierW, y0, y0 + h, -th * 0.5, th * 0.5, kind, shade);
        emitBox(archToWorld, span - pierW, span, y0, y0 + h, -th * 0.5, th * 0.5, kind, shade);
        // Spandrel lintel above arch crown
        emitBox(archToWorld, pierW, span - pierW, ySpring + radius * 0.82, y0 + h, -th * 0.5, th * 0.5, kind, shade * 0.95);
        // Radial stone voussoirs
        const segs = Math.max(5, Math.round(resolveNumeric(prim.voussoirs, 7)));
        const sMid = span * 0.5;
        const rOuter = radius + 0.32;
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI;
          const a1 = ((i + 1) / segs) * Math.PI;
          const xIn0 = sMid - Math.cos(a0) * radius, yIn0 = ySpring + Math.sin(a0) * radius;
          const xIn1 = sMid - Math.cos(a1) * radius, yIn1 = ySpring + Math.sin(a1) * radius;
          const xOut0 = sMid - Math.cos(a0) * rOuter, yOut0 = ySpring + Math.sin(a0) * rOuter;
          const xOut1 = sMid - Math.cos(a1) * rOuter, yOut1 = ySpring + Math.sin(a1) * rOuter;
          const vShade = i === Math.floor(segs / 2) ? Math.min(1, shade * 1.05) : shade * (i % 2 === 0 ? 0.94 : 0.88);
          // Front & back voussoir faces + intrados soffit
          pushQuad(
            archToWorld(xIn0, yIn0, -th * 0.54),
            archToWorld(xIn1, yIn1, -th * 0.54),
            archToWorld(xOut1, yOut1, -th * 0.54),
            archToWorld(xOut0, yOut0, -th * 0.54),
            11,
            vShade
          );
          pushQuad(
            archToWorld(xIn1, yIn1, th * 0.54),
            archToWorld(xIn0, yIn0, th * 0.54),
            archToWorld(xOut0, yOut0, th * 0.54),
            archToWorld(xOut1, yOut1, th * 0.54),
            11,
            vShade
          );
          pushQuad(
            archToWorld(xIn0, yIn0, th * 0.54),
            archToWorld(xIn1, yIn1, th * 0.54),
            archToWorld(xIn1, yIn1, -th * 0.54),
            archToWorld(xIn0, yIn0, -th * 0.54),
            11,
            vShade * 0.78
          );
        }
        return;
      }

      if (pType === 'roof') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const x0 = Math.min(f[0], t[0]), x1 = Math.max(f[0], t[0]);
        const z0 = Math.min(f[2], t[2]), z1 = Math.max(f[2], t[2]);
        const yEave = Math.min(f[1], t[1]);
        const h = Math.max(0.6, resolveNumeric(prim.height, Math.max(1.6, Math.abs(t[1] - f[1]))));
        const overhang = resolveNumeric(prim.overhang, 0.38);
        const hipRatio = prim.style === 'gable' ? 0 : resolveNumeric(prim.hipRatio, 0.25);
        const wallKind = resolveCairnMaterial(prim.wallMaterial ?? 'stucco', 12, 0.90).kind;
        emitRoof(primToWorld, x0, x1, yEave, yEave + h, z0, z1, overhang, hipRatio, kind, wallKind);
        return;
      }

      if (pType === 'dome') {
        const base = resolvePosition(prim.base ?? prim.position ?? prim.center, [0, 0, 0]);
        const r = Math.max(0.8, resolveNumeric(prim.radius, 3.0));
        const h = Math.max(0.8, resolveNumeric(prim.height, r * 0.95));
        const rings = Math.max(3, Math.min(8, Math.round(resolveNumeric(prim.rings, 4))));
        const segs = Math.max(6, Math.min(16, Math.round(resolveNumeric(prim.segments, 10))));
        // Octagonal / cylindrical drum plinth if drumHeight > 0
        const drumH = resolveNumeric(prim.drumHeight, 0);
        let yStart = base[1];
        if (drumH > 0.1) {
          emitCylinder(primToWorld, base[0], base[2], yStart, yStart + drumH, r * 1.02, r, segs, 11, 0.88, true);
          yStart += drumH;
        }
        for (let ring = 0; ring < rings; ring++) {
          const t0 = (ring / rings) * (Math.PI * 0.5);
          const t1 = ((ring + 1) / rings) * (Math.PI * 0.5);
          const r0 = Math.cos(t0) * r;
          const r1 = Math.max(0.08, Math.cos(t1) * r);
          const y0 = yStart + Math.sin(t0) * h;
          const y1 = yStart + Math.sin(t1) * h;
          emitCylinder(primToWorld, base[0], base[2], y0, y1, r0, r1, segs, kind, shade * (0.94 + 0.06 * (ring / rings)), ring === rings - 1);
        }
        if (prim.lantern) {
          const lR = r * 0.24;
          const lH = h * 0.38;
          emitCylinder(primToWorld, base[0], base[2], yStart + h - 0.1, yStart + h + lH, lR, lR * 0.92, 8, 11, 0.92, true);
          emitCylinder(primToWorld, base[0], base[2], yStart + h + lH, yStart + h + lH * 1.55, lR * 1.05, 0.06, 8, 13, 0.94, true);
        }
        return;
      }

      if (pType === 'cylinder' || pType === 'cone') {
        const base = resolvePosition(prim.base ?? prim.position ?? prim.center, [0, 0, 0]);
        const h = Math.max(0.2, resolveNumeric(prim.height, 3.0));
        const rBottom = Math.max(0.08, resolveNumeric(prim.radiusBottom ?? prim.radius, 1.0));
        const rTop = pType === 'cone' ? Math.max(0.04, resolveNumeric(prim.radiusTop, 0.05)) : Math.max(0.04, resolveNumeric(prim.radiusTop ?? prim.radius, rBottom));
        const segs = Math.max(5, Math.min(16, Math.round(resolveNumeric(prim.radialSegments ?? prim.segments, 8))));
        emitCylinder(primToWorld, base[0], base[2], base[1], base[1] + h, rBottom, rTop, segs, kind, shade, prim.openEnded !== true);
        return;
      }

      if (pType === 'stairs' || pType === 'ramp') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const w = Math.max(0.8, resolveNumeric(prim.width, 2.4));
        const y0 = Math.min(f[1], t[1]);
        const y1 = Math.max(f[1], t[1]);
        const dx = t[0] - f[0], dz = t[2] - f[2];
        const runLen = Math.hypot(dx, dz) || 2.0;
        const ux = dx / runLen, uz = dz / runLen;
        const nx = -uz, nz = ux;
        const stairToWorld = (sAlong, yLocal, nAcross) =>
          primToWorld(f[0] + ux * sAlong + nx * nAcross, yLocal, f[2] + uz * sAlong + nz * nAcross);
        const nSteps = Math.max(3, Math.min(18, Math.round((y1 - y0) / 0.28)));
        for (let s = 0; s < nSteps; s++) {
          const s0 = (s / nSteps) * runLen;
          const s1 = ((s + 1) / nSteps) * runLen;
          const sy = y0 + ((s + 1) / nSteps) * (y1 - y0);
          emitBox(stairToWorld, s0, s1, y0, sy, -w * 0.5, w * 0.5, kind, shade * (s % 2 === 0 ? 0.94 : 0.88));
        }
        if (prim.parapet !== false) {
          emitBox(stairToWorld, 0, runLen, y0, y1 + 0.55, -w * 0.5 - 0.24, -w * 0.5, 11, 0.88);
          emitBox(stairToWorld, 0, runLen, y0, y1 + 0.55, w * 0.5, w * 0.5 + 0.24, 11, 0.88);
        }
        return;
      }

      if (pType === 'frame') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const x0 = Math.min(f[0], t[0]), x1 = Math.max(f[0], t[0]);
        const y0 = Math.min(f[1], t[1]), y1 = Math.max(f[1], t[1]);
        const z0 = Math.min(f[2], t[2]), z1 = Math.max(f[2], t[2]);
        const th = Math.max(0.18, resolveNumeric(prim.thickness, 0.32));
        // 4 corner posts + 4 top ring beams
        emitBox(primToWorld, x0, x0 + th, y0, y1, z0, z0 + th, kind, shade);
        emitBox(primToWorld, x1 - th, x1, y0, y1, z0, z0 + th, kind, shade);
        emitBox(primToWorld, x0, x0 + th, y0, y1, z1 - th, z1, kind, shade);
        emitBox(primToWorld, x1 - th, x1, y0, y1, z1 - th, z1, kind, shade);
        emitBox(primToWorld, x0, x1, y1 - th, y1, z0, z0 + th, kind, shade * 0.95);
        emitBox(primToWorld, x0, x1, y1 - th, y1, z1 - th, z1, kind, shade * 0.95);
        emitBox(primToWorld, x0, x0 + th, y1 - th, y1, z0 + th, z1 - th, kind, shade * 0.92);
        emitBox(primToWorld, x1 - th, x1, y1 - th, y1, z0 + th, z1 - th, kind, shade * 0.92);
      }
    };

    if (groupName) {
      withPartGroup(groupName, run);
    } else {
      run();
    }
  };

  for (const prim of primitives) {
    emitSinglePrimitive(prim, rootToWorld);
  }
}

// Declarative Cairn JSON architectural templates for colonial & fortified port landmarks.
// Demonstrates how complex multi-tower cathedrals, arched loggias, and stepped plazas
// are authored in compact Cairn JSON (`shapes` + `primitives`) rather than hundreds of lines of imperative code.
export const CAIRN_ARCHITECTURAL_TEMPLATES = {
  catedral_basilica: {
    schemaVersion: '0.4',
    shapes: {
      bell_tower_tier: {
        primitive: 'group',
        children: [
          {
            primitive: 'box',
            from: [-2.4, 0, -2.4],
            to: [2.4, 5.2, 2.4],
            material: 'ashlar',
            topInset: 0.08,
          },
          {
            primitive: 'box',
            from: [-2.65, 4.85, -2.65],
            to: [2.65, 5.35, 2.65],
            material: 'limestone',
          },
        ],
      },
      belfry_stage: {
        primitive: 'group',
        children: [
          {
            primitive: 'wall',
            from: [-2.1, 0, -2.1],
            to: [2.1, 0, -2.1],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [
              { offset: '4/3', width: 0.95, height: 2.6, sillHeight: 0.65 },
              { offset: '8/3', width: 0.95, height: 2.6, sillHeight: 0.65 },
            ],
          },
          {
            primitive: 'wall',
            from: [-2.1, 0, 2.1],
            to: [2.1, 0, 2.1],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [
              { offset: '4/3', width: 0.95, height: 2.6, sillHeight: 0.65 },
              { offset: '8/3', width: 0.95, height: 2.6, sillHeight: 0.65 },
            ],
          },
          {
            primitive: 'wall',
            from: [-2.1, 0, -2.1],
            to: [-2.1, 0, 2.1],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [{ offset: 2.1, width: 1.1, height: 2.6, sillHeight: 0.65 }],
          },
          {
            primitive: 'wall',
            from: [2.1, 0, -2.1],
            to: [2.1, 0, 2.1],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [{ offset: 2.1, width: 1.1, height: 2.6, sillHeight: 0.65 }],
          },
          {
            primitive: 'dome',
            base: [0, 4.2, 0],
            radius: 2.15,
            height: 2.4,
            segments: 8,
            material: 'terracotta',
            lantern: true,
          },
        ],
      },
      nave_buttress: {
        primitive: 'box',
        from: [-0.45, 0, -0.55],
        to: [0.45, 8.8, 0.55],
        topInset: 0.12,
        material: 'ashlar',
      },
    },
    primitives: [
      // Stepped stone atrium parvis platform
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-11.5, -3.5, -15.5],
        to: [11.5, 0.65, 15.5],
        material: 'ashlar',
      },
      {
        primitive: 'stairs',
        partGroup: 'atrium_steps',
        from: [0, 0.0, -17.8],
        to: [0, 0.65, -15.2],
        width: 8.5,
        material: 'limestone',
      },
      // Three-aisle basilica body & clerestory nave
      {
        primitive: 'box',
        partGroup: 'side_aisles',
        from: [-10.2, 0.65, -12.5],
        to: [10.2, 7.2, 11.5],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'central_nave',
        from: [-5.6, 0.65, -13.2],
        to: [5.6, 11.2, 12.2],
        material: 'whitewash',
      },
      // Transept arms
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [-12.4, 0.65, 1.2],
        to: [12.4, 9.6, 7.6],
        material: 'cream_stucco',
      },
      // Grand west facade portal with triple arches
      {
        primitive: 'arch',
        partGroup: 'west_portal_arch',
        from: [-3.2, 0.65, -13.55],
        to: [3.2, 0.65, -13.55],
        height: 5.8,
        thickness: 0.95,
        voussoirs: 9,
        material: 'ashlar',
      },
      // Nave & aisle pitched terracotta roofs
      {
        primitive: 'roof',
        partGroup: 'nave_roof',
        from: [-5.8, 11.2, -13.2],
        to: [5.8, 14.4, 12.2],
        height: 3.2,
        style: 'gable',
        material: 'terracotta',
        wallMaterial: 'whitewash',
      },
      {
        primitive: 'roof',
        partGroup: 'transept_roof',
        from: [-12.4, 9.6, 1.2],
        to: [12.4, 12.2, 7.6],
        height: 2.6,
        hipRatio: 0.25,
        material: 'terracotta',
      },
      // Crossing drum, ribbed cupola dome & lantern
      {
        primitive: 'dome',
        partGroup: 'crossing_cupola_dome',
        base: [0, 11.2, 4.4],
        drumHeight: 3.2,
        radius: 4.8,
        height: 4.6,
        segments: 12,
        rings: 5,
        lantern: true,
        material: 'terracotta',
      },
      // Twin west facade bell towers using Cairn `stack` + `shapes` references
      {
        primitive: 'stack',
        partGroup: 'north_bell_tower',
        position: [-8.2, 0.65, -12.8],
        children: [
          { shape: 'bell_tower_tier' },
          { shape: 'bell_tower_tier', scale: [0.92, 0.95, 0.92] },
          { shape: 'belfry_stage' },
        ],
      },
      {
        primitive: 'stack',
        partGroup: 'south_bell_tower',
        position: [8.2, 0.65, -12.8],
        children: [
          { shape: 'bell_tower_tier' },
          { shape: 'bell_tower_tier', scale: [0.92, 0.95, 0.92] },
          { shape: 'belfry_stage' },
        ],
      },
      // Side ashlar buttresses along the nave
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [-10.4, 0.65, -8.0] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [-10.4, 0.65, -3.0] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [10.4, 0.65, -8.0] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [10.4, 0.65, -3.0] },
    ],
  },
};
