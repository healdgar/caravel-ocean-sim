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
  recess: { kind: 14, shade: 0.22 },
  opening: { kind: 14, shade: 0.20 },
  iron: { kind: 18, shade: 0.80 },
  cast_iron: { kind: 18, shade: 0.80 },
  ordnance: { kind: 18, shade: 0.80 },
  bronze: { kind: 18, shade: 0.76 },
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
        const step = Math.max(1, Math.round(resolveNumeric(run.step, 1)));
        const stepX = x1 > x0 ? step : 1;
        const stepZ = z1 > z0 ? step : 1;
        const rMat = run.material ?? mat;
        for (let x = x0; x <= x1; x += stepX) {
          for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z += stepZ) {
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
export function emitCairnVoxelGrid(blocks, { toWorld, pushQuad, damageRegions = [], gridSize = 1.0, origin = [0, 0, 0] }) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const grid = new Map();
  const keyOf = (x, y, z) => `${x},${y},${z}`;
  const cellSize = Math.max(0.1, resolveNumeric(gridSize, 1.0));
  const [ox, oy, oz] = resolvePosition(origin, [0, 0, 0]);

  for (const b of blocks) {
    if (!b?.pos) continue;
    const x = Math.round(b.pos[0]);
    const y = Math.round(b.pos[1]);
    const z = Math.round(b.pos[2]);
    let carved = false;
    if (Array.isArray(damageRegions) && damageRegions.length > 0) {
      const center = [ox + x * cellSize, oy + (y + 0.5) * cellSize, oz + z * cellSize];
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
    const x0 = ox + (x - 0.5) * cellSize, x1 = ox + (x + 0.5) * cellSize;
    const y0 = oy + y * cellSize, y1 = oy + (y + 1) * cellSize;
    const z0 = oz + (z - 0.5) * cellSize, z1 = oz + (z + 0.5) * cellSize;
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
    // -Y bottom face
    if (!grid.has(keyOf(x, y - 1, z))) {
      pushQuad(toWorld(x0, y0, z1), toWorld(x1, y0, z1), toWorld(x1, y0, z0), toWorld(x0, y0, z0), kind, shade * 0.72);
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
  const sy = Array.isArray(prim.scale) ? resolveNumeric(prim.scale[1], 1) : resolveNumeric(prim.scale, 1);
  if (prim.height !== undefined) return resolveNumeric(prim.height, 0) * sy;
  if (prim.from && prim.to) {
    const f = resolvePosition(prim.from);
    const t = resolvePosition(prim.to);
    return Math.max(Math.abs(t[1] - f[1]), Math.max(f[1], t[1])) * sy;
  }
  if (prim.primitive === 'dome' || prim.primitive === 'sphere') {
    return resolveNumeric(prim.height ?? prim.radius, 2) * sy;
  }
  if (prim.primitive === 'group' && Array.isArray(prim.children)) {
    let maxH = 0;
    for (const c of prim.children) maxH = Math.max(maxH, computePrimitiveHeight(c, shapes));
    return maxH * sy;
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
    emitFortCannon,
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

      if (pType === 'repeat') {
        const count = Math.max(1, Math.min(64, Math.round(resolveNumeric(prim.count, 1))));
        const step = resolvePosition(prim.step ?? [0, 0, 0], [0, 0, 0]);
        const itemSpec = prim.of ?? prim.template ?? prim.child ?? prim.item;
        if (itemSpec) {
          for (let i = 0; i < count; i++) {
            const stepToWorld = composeToWorld(primToWorld, [step[0] * i, step[1] * i, step[2] * i]);
            emitSinglePrimitive(itemSpec, stepToWorld);
          }
        }
        return;
      }

      if (pType === 'block' || pType === 'blocks' || pType === 'voxel-line' || pType === 'voxel-column') {
        const vox = expandCairnVoxelPrimitive(prim);
        emitCairnVoxelGrid(vox, {
          toWorld: primToWorld,
          pushQuad,
          damageRegions: prim.damage ?? damageRegions,
          gridSize: prim.gridSize ?? prim.voxelSize ?? grid?.cellSize ?? 1.0,
          origin: prim.origin ?? grid?.origin ?? [0, 0, 0],
        });
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
        const rOuter = Math.max(radius + 0.14, Math.min(radius + 0.34, (span - 0.16) * 0.5));
        const ySpring = Math.max(y0 + 0.65, Math.min(y0 + h - rOuter - 0.24, y0 + h - radius - 0.35));
        const sMid = span * 0.5;
        const yCrownTop = Math.max(ySpring + rOuter + 0.08, y0 + h - 0.18);
        const yArchTop = Math.max(yCrownTop + 0.18, y0 + h);
        const outerCheekW = Math.max(0.08, sMid - rOuter);
        // Side piers up to the arch springline
        emitBox(archToWorld, 0, pierW, y0, ySpring, -th * 0.5, th * 0.5, kind, shade);
        emitBox(archToWorld, span - pierW, span, y0, ySpring, -th * 0.5, th * 0.5, kind, shade);
        // Upper outer cheek piers outside the voussoir extrados (non-overlapping with spandrels)
        if (outerCheekW > 0.06) {
          emitBox(archToWorld, 0, outerCheekW, ySpring, yCrownTop, -th * 0.5, th * 0.5, kind, shade);
          emitBox(archToWorld, span - outerCheekW, span, ySpring, yCrownTop, -th * 0.5, th * 0.5, kind, shade);
        }
        // Top cornice lintel above the arch extrados
        emitBox(archToWorld, 0, span, yCrownTop, yArchTop, -th * 0.52, th * 0.52, kind, shade * 0.96);
        // Dark barrel-vaulted portal recess (kind 14) when arch is a doorway/window portal rather than an open-through arcade
        if (!prim.openThrough) {
          emitBox(
            archToWorld,
            pierW * 0.85,
            span - pierW * 0.85,
            y0,
            ySpring + radius * 0.92,
            -th * 0.38,
            th * 0.38,
            14,
            0.28
          );
        }
        // Solid stone spandrels + radial stone voussoirs
        const segs = Math.max(5, Math.round(resolveNumeric(prim.voussoirs, 7)));
        for (let i = 0; i < segs; i++) {
          const a0 = (i / segs) * Math.PI;
          const a1 = ((i + 1) / segs) * Math.PI;
          const xIn0 = sMid - Math.cos(a0) * radius, yIn0 = ySpring + Math.sin(a0) * radius;
          const xIn1 = sMid - Math.cos(a1) * radius, yIn1 = ySpring + Math.sin(a1) * radius;
          const xOut0 = sMid - Math.cos(a0) * rOuter, yOut0 = ySpring + Math.sin(a0) * rOuter;
          const xOut1 = sMid - Math.cos(a1) * rOuter, yOut1 = ySpring + Math.sin(a1) * rOuter;
          const vShade = i === Math.floor(segs / 2) ? Math.min(1, shade * 1.05) : shade * (i % 2 === 0 ? 0.94 : 0.88);
          // Solid spandrel quad between outer voussoir curve and top lintel (eliminates triangular holes above arch curve)
          pushQuad(
            archToWorld(xOut0, yOut0, -th * 0.5),
            archToWorld(xOut1, yOut1, -th * 0.5),
            archToWorld(xOut1, yCrownTop, -th * 0.5),
            archToWorld(xOut0, yCrownTop, -th * 0.5),
            kind,
            shade * 0.93
          );
          pushQuad(
            archToWorld(xOut1, yOut1, th * 0.5),
            archToWorld(xOut0, yOut0, th * 0.5),
            archToWorld(xOut0, yCrownTop, th * 0.5),
            archToWorld(xOut1, yCrownTop, th * 0.5),
            kind,
            shade * 0.93
          );
          // Front, back, soffit, and extrados voussoir faces
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
          pushQuad(
            archToWorld(xOut1, yOut1, th * 0.54),
            archToWorld(xOut0, yOut0, th * 0.54),
            archToWorld(xOut0, yOut0, -th * 0.54),
            archToWorld(xOut1, yOut1, -th * 0.54),
            11,
            vShade * 0.98
          );
        }
        return;
      }

      if (pType === 'roof' || pType === 'pyramid') {
        const f = resolvePosition(prim.from);
        const t = resolvePosition(prim.to);
        const x0 = Math.min(f[0], t[0]), x1 = Math.max(f[0], t[0]);
        const z0 = Math.min(f[2], t[2]), z1 = Math.max(f[2], t[2]);
        const yEave = Math.min(f[1], t[1]);
        const h = Math.max(0.6, resolveNumeric(prim.height, Math.max(1.6, Math.abs(t[1] - f[1]))));
        const overhang = resolveNumeric(prim.overhang, pType === 'pyramid' ? 0.18 : 0.38);
        const hipRatio = pType === 'pyramid' ? 0.49 : prim.style === 'gable' ? 0 : resolveNumeric(prim.hipRatio, 0.25);
        const wallKind = resolveCairnMaterial(prim.wallMaterial ?? 'stucco', 12, 0.90).kind;
        emitRoof(primToWorld, x0, x1, yEave, yEave + h, z0, z1, overhang, hipRatio, wallKind, kind);
        return;
      }

      if (pType === 'dome') {
        const base = resolvePosition(prim.base ?? prim.position ?? prim.center, [0, 0, 0]);
        const r = Math.max(0.8, resolveNumeric(prim.radius, 3.0));
        const h = Math.max(0.8, resolveNumeric(prim.height, r * 0.95));
        const rings = Math.max(4, Math.min(8, Math.round(resolveNumeric(prim.rings, 5))));
        const segs = Math.max(8, Math.min(18, Math.round(resolveNumeric(prim.segments, 12))));
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
          emitCylinder(primToWorld, base[0], base[2], yStart + h - 0.1, yStart + h + lH, lR, lR * 0.92, Math.max(8, Math.min(12, segs)), 11, 0.92, true);
          emitCylinder(primToWorld, base[0], base[2], yStart + h + lH, yStart + h + lH * 1.55, lR * 1.05, 0.06, Math.max(8, Math.min(12, segs)), 13, 0.94, true);
        }
        return;
      }

      if (pType === 'cylinder' || pType === 'cone') {
        const base = resolvePosition(prim.base ?? prim.position ?? prim.center, [0, 0, 0]);
        const h = Math.max(0.2, resolveNumeric(prim.height, 3.0));
        const rBottom = Math.max(0.08, resolveNumeric(prim.radiusBottom ?? prim.radius, 1.0));
        const rTop = pType === 'cone' ? Math.max(0.04, resolveNumeric(prim.radiusTop, 0.05)) : Math.max(0.04, resolveNumeric(prim.radiusTop ?? prim.radius, rBottom));
        const segs = Math.max(6, Math.min(18, Math.round(resolveNumeric(prim.radialSegments ?? prim.segments, 12))));
        emitCylinder(primToWorld, base[0], base[2], base[1], base[1] + h, rBottom, rTop, segs, kind, shade, prim.openEnded !== true);
        return;
      }

      if (pType === 'cannon') {
        const pos = resolvePosition(prim.position ?? prim.base ?? [0, 0, 0], [0, 0, 0]);
        const dir = Array.isArray(prim.direction) ? prim.direction : [0, -1];
        const dirX = resolveNumeric(dir[0], 0);
        const dirZ = resolveNumeric(dir.length >= 3 ? dir[2] : dir[1], -1);
        const cScale = Math.max(0.4, resolveNumeric(prim.cannonScale ?? prim.scale, 1.0));
        if (typeof emitFortCannon === 'function') {
          emitFortCannon(localToWorld, pos[0], pos[1], pos[2], dirX, dirZ, cScale);
        } else {
          emitBox(primToWorld, pos[0] - 0.35 * cScale, pos[0] + 0.35 * cScale, pos[1], pos[1] + 0.65 * cScale, pos[2] - 0.65 * cScale, pos[2] + 0.65 * cScale, 10, 0.72, true);
          emitCylinder(primToWorld, pos[0], pos[2], pos[1] + 0.55 * cScale, pos[1] + 0.95 * cScale, 0.22 * cScale, 0.18 * cScale, 8, 18, 0.80, true);
        }
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
        const stepH = (y1 - y0) / nSteps;
        for (let s = 0; s < nSteps; s++) {
          const s0 = (s / nSteps) * runLen;
          const s1 = ((s + 1) / nSteps) * runLen;
          const sy0 = s === 0 ? y0 : y0 + s * stepH - 0.04;
          const sy1 = y0 + (s + 1) * stepH;
          emitBox(stairToWorld, s0, s1, sy0, sy1, -w * 0.5 + 0.02, w * 0.5 - 0.02, kind, shade * (s % 2 === 0 ? 0.94 : 0.88));
        }
        if (prim.parapet !== false) {
          emitBox(stairToWorld, 0, runLen, y0, y1 + 0.55, -w * 0.5 - 0.26, -w * 0.5 - 0.02, 11, 0.88);
          emitBox(stairToWorld, 0, runLen, y0, y1 + 0.55, w * 0.5 + 0.02, w * 0.5 + 0.26, 11, 0.88);
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
    name: 'Catedral Basílica Metropolitana',
    width: 24,
    length: 34,
    height: 18,
    foundationDepth: 4.0,
    materialKind: 11,
    roofPitch: 3.5,
    waterfront: false,
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
            from: [-2.1, 0, -1.55],
            to: [-2.1, 0, 1.55],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [{ offset: 1.55, width: 1.0, height: 2.6, sillHeight: 0.65 }],
          },
          {
            primitive: 'wall',
            from: [2.1, 0, -1.55],
            to: [2.1, 0, 1.55],
            height: 4.2,
            thickness: 0.55,
            material: 'limestone',
            openings: [{ offset: 1.55, width: 1.0, height: 2.6, sillHeight: 0.65 }],
          },
          {
            primitive: 'box',
            from: [-1.55, 2.72, -0.18],
            to: [1.55, 3.04, 0.18],
            material: 'timber',
          },
          {
            primitive: 'cylinder',
            base: [0, 1.88, 0],
            height: 0.86,
            radius: 0.52,
            topRadius: 0.34,
            segments: 8,
            material: 'iron',
          },
          {
            primitive: 'cylinder',
            base: [0, 1.54, 0],
            height: 0.36,
            radius: 0.72,
            topRadius: 0.52,
            segments: 8,
            material: 'iron',
          },
          {
            primitive: 'box',
            from: [-2.4, 4.2, -2.4],
            to: [2.4, 4.55, 2.4],
            material: 'limestone',
          },
          {
            primitive: 'dome',
            base: [0, 4.55, 0],
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
        to: [0, 0.65, -15.5],
        width: 8.5,
        material: 'limestone',
      },
      // Three-aisle basilica body & clerestory nave (non-overlapping tiers)
      {
        primitive: 'box',
        partGroup: 'side_aisles',
        from: [-10.2, 0.65, -9.8],
        to: [10.2, 7.2, 11.5],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'central_nave',
        from: [-5.6, 0.65, -13.2],
        to: [5.6, 11.2, -9.8],
        material: 'whitewash',
      },
      {
        primitive: 'box',
        partGroup: 'central_nave',
        from: [-5.6, 7.2, -9.8],
        to: [5.6, 11.2, 12.2],
        material: 'whitewash',
      },
      // Transept projecting wings
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [-12.4, 0.65, 1.2],
        to: [-10.2, 9.6, 7.6],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [10.2, 0.65, 1.2],
        to: [12.4, 9.6, 7.6],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [-10.2, 7.2, 1.2],
        to: [10.2, 9.6, 7.6],
        material: 'cream_stucco',
      },
      // Grand west facade portal with triple arches
      {
        primitive: 'arch',
        partGroup: 'west_portal_arch',
        from: [-3.2, 0.65, -13.7],
        to: [3.2, 0.65, -13.7],
        height: 5.8,
        thickness: 0.95,
        voussoirs: 9,
        material: 'ashlar',
      },
      // Nave & aisle pitched terracotta roofs
      {
        primitive: 'roof',
        partGroup: 'nave_roof',
        from: [-5.6, 11.2, -13.0],
        to: [5.6, 14.2, 12.0],
        height: 3.0,
        style: 'gable',
        material: 'terracotta',
        wallMaterial: 'whitewash',
      },
      {
        primitive: 'roof',
        partGroup: 'transept_roof',
        from: [-12.4, 9.6, 1.2],
        to: [-5.6, 11.2, 7.6],
        height: 1.6,
        hipRatio: 0.25,
        material: 'terracotta',
      },
      {
        primitive: 'roof',
        partGroup: 'transept_roof',
        from: [5.6, 9.6, 1.2],
        to: [12.4, 11.2, 7.6],
        height: 1.6,
        hipRatio: 0.25,
        material: 'terracotta',
      },
      // Crossing drum, ribbed cupola dome & lantern
      {
        primitive: 'dome',
        partGroup: 'crossing_cupola_dome',
        base: [0, 12.6, 4.4],
        drumHeight: 2.6,
        radius: 4.6,
        height: 4.2,
        segments: 12,
        rings: 5,
        lantern: true,
        material: 'terracotta',
      },
      // Twin west facade bell towers flanking the west portal bay
      {
        primitive: 'stack',
        partGroup: 'north_bell_tower',
        position: [-8.2, 0.65, -12.4],
        children: [
          { shape: 'bell_tower_tier' },
          { shape: 'bell_tower_tier', scale: [0.92, 0.95, 0.92] },
          { shape: 'belfry_stage' },
        ],
      },
      {
        primitive: 'stack',
        partGroup: 'south_bell_tower',
        position: [8.2, 0.65, -12.4],
        children: [
          { shape: 'bell_tower_tier' },
          { shape: 'bell_tower_tier', scale: [0.92, 0.95, 0.92] },
          { shape: 'belfry_stage' },
        ],
      },
      // Side ashlar buttresses along the nave
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [-10.65, 0.65, -7.2] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [-10.65, 0.65, -2.6] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [10.65, 0.65, -7.2] },
      { shape: 'nave_buttress', partGroup: 'nave_buttresses', position: [10.65, 0.65, -2.6] },
    ],
  },

  // 1519 Lisboa · Torre de Belém (Baluarte de São Vicente a par de Belém)
  // Designed by Francisco de Arruda in pedra lioz limestone: polygonal seaward casemate bastion
  // with 6 cylindrical Manueline bartizan sentry turrets (garitas) topped by ribbed melon cupolas,
  // voxel-crenellated Order of Christ shield merlons, and a 4-story square Torre de Menagem keep
  // with south-facing 7-arch Renaissance loggia and overhanging machicolation gallery.
  torre_de_belem_manuelina: {
    schemaVersion: '0.4',
    name: 'Torre de Belém · Baluarte de São Vicente',
    width: 18,
    length: 28,
    height: 22.5,
    foundationDepth: 9.5,
    materialKind: 11,
    roofPitch: 2.2,
    waterfront: true,
    shapes: {
      manueline_garita: {
        primitive: 'group',
        children: [
          // Tapered corbel base
          {
            primitive: 'cone',
            base: [0, -1.35, 0],
            height: 1.35,
            radiusBottom: 0.22,
            radiusTop: 1.05,
            segments: 8,
            material: 'limestone',
          },
          // Cylindrical watch turret body
          {
            primitive: 'cylinder',
            base: [0, 0, 0],
            height: 2.45,
            radius: 0.98,
            segments: 8,
            material: 'limestone',
          },
          // Ribbed Moorish-Manueline melon cupola & finial
          {
            primitive: 'dome',
            base: [0, 2.45, 0],
            radius: 1.02,
            height: 1.45,
            segments: 8,
            rings: 4,
            lantern: true,
            material: 'limestone',
          },
        ],
      },
      keep_corner_turret: {
        primitive: 'group',
        children: [
          {
            primitive: 'cylinder',
            base: [0, 0, 0],
            height: 2.8,
            radius: 0.78,
            segments: 8,
            material: 'limestone',
          },
          {
            primitive: 'dome',
            base: [0, 2.8, 0],
            radius: 0.82,
            height: 1.25,
            segments: 8,
            rings: 4,
            lantern: true,
            material: 'limestone',
          },
        ],
      },
    },
    primitives: [
      // Submerged & intertidal pedra lioz cutwater plinth in the Tagus shallows
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-8.6, -8.5, -13.8],
        to: [8.6, 0.85, 12.2],
        topInset: 0.35,
        material: 'ashlar',
      },
      // Seaward polygonal casemate bastion (Baluarte) projecting into the Tagus
      {
        primitive: 'box',
        partGroup: 'bastion_casemate_walls',
        from: [-7.8, 0.85, -9.6],
        to: [7.8, 5.8, 2.0],
        topInset: 0.32,
        material: 'limestone',
      },
      // Beveled seaward prow of the polygonal bastion (flush against z = -9.6)
      {
        primitive: 'box',
        partGroup: 'bastion_seaward_prow',
        from: [-5.2, 0.85, -13.0],
        to: [5.2, 5.8, -9.6],
        topInset: 0.24,
        material: 'limestone',
      },
      // Bastion upper esplanade deck sitting flush on top of the casemate (y = 5.8..6.4)
      {
        primitive: 'box',
        partGroup: 'bastion_terreplein_deck',
        from: [-7.4, 5.8, -9.6],
        to: [7.4, 6.4, 2.0],
        material: 'cobble',
      },
      // Voxel-crenellated bastion parapet merlons (sitting flush at y = 6.4)
      {
        primitive: 'blocks',
        partGroup: 'bastion_parapet_merlons',
        gridSize: 1.0,
        origin: [0, 6.4, 0],
        material: 'limestone',
        runs: [
          { x: [-6, -2], y: 0, z: -9, step: 2 },
          { x: [2, 6], y: 0, z: -9, step: 2 },
          { x: [-4, 4], y: 0, z: -12, step: 2 },
          { x: -7, y: 0, z: [-7, 1], step: 2 },
          { x: 7, y: 0, z: [-7, 1], step: 2 },
        ],
      },
      // Lathe-turned cast-iron Manueline fortress culverins on stepped oak garrison carriages guarding the Tagus channel
      { primitive: 'cannon', partGroup: 'fort_cannon', position: [-3.0, 6.4, -7.9], direction: [0, -1], cannonScale: 0.92 },
      { primitive: 'cannon', partGroup: 'fort_cannon', position: [0.0, 6.4, -7.9], direction: [0, -1], cannonScale: 0.95 },
      { primitive: 'cannon', partGroup: 'fort_cannon', position: [3.0, 6.4, -7.9], direction: [0, -1], cannonScale: 0.92 },
      { primitive: 'cannon', partGroup: 'fort_cannon', position: [-5.9, 6.4, -4.0], direction: [-1, 0], cannonScale: 0.90 },
      { primitive: 'cannon', partGroup: 'fort_cannon', position: [5.9, 6.4, -4.0], direction: [1, 0], cannonScale: 0.90 },
      // Six iconic cylindrical Manueline bartizan sentry turrets (Garitas) on the bastion corners
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [-7.5, 5.4, -9.4] },
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [7.5, 5.4, -9.4] },
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [-4.9, 5.4, -12.7] },
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [4.9, 5.4, -12.7] },
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [-7.5, 5.4, 1.8] },
      { shape: 'manueline_garita', partGroup: 'bastion_garitas', position: [7.5, 5.4, 1.8] },
      // 4-story square Torre de Menagem keep rising on the north end of the bastion
      {
        primitive: 'box',
        partGroup: 'keep_lower_tiers',
        from: [-5.4, 0.85, 2.0],
        to: [5.4, 13.8, 11.4],
        topInset: 0.18,
        material: 'limestone',
      },
      {
        primitive: 'box',
        partGroup: 'keep_upper_tiers',
        from: [-5.1, 13.8, 2.3],
        to: [5.1, 19.8, 11.1],
        material: 'whitewash',
      },
      // Recessed Manueline royal windows & stone surrounds on the Keep upper stories
      {
        primitive: 'arch',
        partGroup: 'keep_upper_tiers',
        from: [-3.4, 14.8, 2.15],
        to: [-0.8, 14.8, 2.15],
        height: 3.2,
        thickness: 0.45,
        voussoirs: 7,
        material: 'limestone',
      },
      {
        primitive: 'arch',
        partGroup: 'keep_upper_tiers',
        from: [0.8, 14.8, 2.15],
        to: [3.4, 14.8, 2.15],
        height: 3.2,
        thickness: 0.45,
        voussoirs: 7,
        material: 'limestone',
      },
      // South-facing 2nd-story Manueline arched loggia (Varanda do Renascimento) overlooking the bastion
      {
        primitive: 'box',
        partGroup: 'manueline_loggia_deck',
        from: [-4.8, 7.2, 0.1],
        to: [4.8, 7.85, 2.0],
        material: 'limestone',
      },
      {
        primitive: 'wall',
        partGroup: 'manueline_loggia_arcade',
        from: [-4.6, 7.85, 0.35],
        to: [4.6, 7.85, 0.35],
        height: 3.3,
        thickness: 0.48,
        material: 'limestone',
        openings: [
          { offset: 1.15, width: 0.92, height: 2.3, sillHeight: 0.45 },
          { offset: 2.75, width: 0.92, height: 2.3, sillHeight: 0.45 },
          { offset: 4.6, width: 1.05, height: 2.4, sillHeight: 0.45 },
          { offset: 6.45, width: 0.92, height: 2.3, sillHeight: 0.45 },
          { offset: 8.05, width: 0.92, height: 2.3, sillHeight: 0.45 },
        ],
      },
      {
        primitive: 'roof',
        partGroup: 'manueline_loggia_canopy',
        from: [-4.8, 11.15, 0.1],
        to: [4.8, 12.15, 2.0],
        height: 1.0,
        hipRatio: 0.25,
        material: 'terracotta',
      },
      // Overhanging corbeled machicolation gallery & rooftop battlement parapet on the Keep
      {
        primitive: 'box',
        partGroup: 'keep_machicolation_cornice',
        from: [-5.55, 19.8, 1.85],
        to: [5.55, 21.0, 11.55],
        material: 'limestone',
      },
      {
        primitive: 'blocks',
        partGroup: 'keep_crown_merlons',
        gridSize: 1.0,
        origin: [0, 20.95, 0],
        material: 'limestone',
        runs: [
          { x: [-4, 4], y: 0, z: 3, step: 2 },
          { x: [-4, 4], y: 0, z: 11, step: 2 },
          { x: -5, y: 0, z: [5, 9], step: 2 },
          { x: 5, y: 0, z: [5, 9], step: 2 },
        ],
      },
      // Four upper corner watch turrets crowning the Torre de Menagem
      { shape: 'keep_corner_turret', partGroup: 'keep_corner_turrets', position: [-5.3, 19.6, 2.0] },
      { shape: 'keep_corner_turret', partGroup: 'keep_corner_turrets', position: [5.3, 19.6, 2.0] },
      { shape: 'keep_corner_turret', partGroup: 'keep_corner_turrets', position: [-5.3, 19.6, 11.3] },
      { shape: 'keep_corner_turret', partGroup: 'keep_corner_turrets', position: [5.3, 19.6, 11.3] },
    ],
  },

  // 1550 Lisboa · Mosteiro dos Jerónimos (Real Mosteiro de Santa Maria de Belém)
  // Built in golden-white pedra lioz limestone by Diogo de Boitaca & João de Castilho:
  // long hall-church nave with carved Manueline buttresses, ornate Portal Sul, twin octagonal
  // western bell towers with ribbed cupolas, and an adjoining two-story arcaded royal cloister.
  mosteiro_dos_jeronimos: {
    schemaVersion: '0.4',
    name: 'Mosteiro dos Jerónimos · Santa Maria de Belém',
    width: 38,
    length: 34,
    height: 19.5,
    foundationDepth: 4.5,
    materialKind: 12,
    roofPitch: 3.4,
    waterfront: false,
    shapes: {
      manueline_buttress: {
        primitive: 'group',
        children: [
          {
            primitive: 'box',
            from: [-0.48, 0, -0.65],
            to: [0.48, 12.2, 0.65],
            topInset: 0.1,
            material: 'limestone',
          },
          // Carved pinnacle finial above the cornice
          {
            primitive: 'cone',
            base: [0, 12.2, 0],
            height: 2.1,
            radiusBottom: 0.42,
            radiusTop: 0.05,
            segments: 6,
            material: 'limestone',
          },
        ],
      },
      jeronimos_bell_tower: {
        primitive: 'group',
        children: [
          {
            primitive: 'box',
            from: [-2.8, 0, -2.8],
            to: [2.8, 12.8, 2.8],
            topInset: 0.12,
            material: 'limestone',
          },
          {
            primitive: 'cylinder',
            base: [0, 12.8, 0],
            height: 3.6,
            radius: 2.35,
            segments: 8,
            material: 'limestone',
          },
          {
            primitive: 'dome',
            base: [0, 16.4, 0],
            radius: 2.4,
            height: 2.8,
            segments: 8,
            rings: 4,
            lantern: true,
            material: 'limestone',
          },
        ],
      },
    },
    primitives: [
      // Raised pedra lioz parvis terrace & steps facing the Tagus
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-18.5, -3.8, -14.5],
        to: [18.5, 0.75, 16.5],
        material: 'ashlar',
      },
      {
        primitive: 'stairs',
        partGroup: 'south_portal_steps',
        from: [0, 0.0, -16.8],
        to: [0, 0.75, -14.5],
        width: 9.5,
        material: 'limestone',
      },
      // Hall-church body (spanning cleanly between the twin west bell towers at x=-12.4 and transept at x=8.5)
      {
        primitive: 'box',
        partGroup: 'church_hall_nave',
        from: [-12.4, 0.75, -11.5],
        to: [8.5, 12.6, 1.5],
        material: 'whitewash',
      },
      // Western narthex bay between the twin bell towers
      {
        primitive: 'box',
        partGroup: 'church_hall_nave',
        from: [-18.0, 0.75, -7.0],
        to: [-12.4, 12.2, -3.0],
        material: 'whitewash',
      },
      // North transept & high altar chancel (Capela-Mor)
      {
        primitive: 'box',
        partGroup: 'transept_and_chancel',
        from: [8.5, 0.75, -12.8],
        to: [18.2, 13.4, 4.2],
        material: 'limestone',
      },
      // Ornate Portal Sul (South Portal by João de Castilho) with carved archivolts & gable tabernacle
      {
        primitive: 'box',
        partGroup: 'portal_sul_frontispiece',
        from: [-3.8, 0.75, -12.55],
        to: [3.8, 12.2, -11.5],
        material: 'limestone',
      },
      {
        primitive: 'arch',
        partGroup: 'portal_sul_arch',
        from: [-2.4, 0.75, -12.95],
        to: [2.4, 0.75, -12.95],
        height: 5.4,
        thickness: 0.85,
        voussoirs: 9,
        material: 'ashlar',
      },
      {
        primitive: 'cone',
        partGroup: 'portal_sul_pinnacle',
        base: [0, 12.2, -12.0],
        height: 3.2,
        radiusBottom: 0.85,
        radiusTop: 0.06,
        segments: 6,
        material: 'limestone',
      },
      // Iterated Manueline buttresses & pinnacles along the south facade (flanking Portal Sul cleanly)
      { shape: 'manueline_buttress', partGroup: 'south_facade_buttresses', position: [-10.5, 0.75, -12.1] },
      { shape: 'manueline_buttress', partGroup: 'south_facade_buttresses', position: [-6.2, 0.75, -12.1] },
      { shape: 'manueline_buttress', partGroup: 'south_facade_buttresses', position: [4.2, 0.75, -12.1] },
      { shape: 'manueline_buttress', partGroup: 'south_facade_buttresses', position: [7.8, 0.75, -12.1] },
      // Twin western bell towers with octagonal belfries & ribbed cupolas (flanking the west narthex)
      { shape: 'jeronimos_bell_tower', partGroup: 'west_bell_towers', position: [-15.2, 0.75, -9.8] },
      { shape: 'jeronimos_bell_tower', partGroup: 'west_bell_towers', position: [-15.2, 0.75, -0.2] },
      // Pitched terracotta roofs over the hall-church & transept (non-overlapping with towers)
      {
        primitive: 'roof',
        partGroup: 'church_nave_roof',
        from: [-12.4, 12.6, -11.5],
        to: [8.5, 16.0, 1.5],
        height: 3.4,
        hipRatio: 0.18,
        material: 'terracotta',
      },
      {
        primitive: 'dome',
        partGroup: 'crossing_lantern_dome',
        base: [13.2, 13.4, -4.2],
        drumHeight: 2.2,
        radius: 3.8,
        height: 3.4,
        segments: 8,
        lantern: true,
        material: 'limestone',
      },
      // Adjoining Two-Story Manueline Royal Cloister (Claustro Real) on the north side
      {
        primitive: 'box',
        partGroup: 'cloister_courtyard_paving',
        from: [-11.6, 0.75, 1.5],
        to: [6.6, 0.95, 12.2],
        material: 'cobble',
      },
      // Octagonal renaissance fountain in the center of the Claustro Real
      {
        primitive: 'cylinder',
        partGroup: 'cloister_fountain',
        base: [-2.5, 0.95, 6.8],
        height: 1.65,
        radius: 1.55,
        segments: 8,
        material: 'limestone',
      },
      // West, North, and East two-story cloister wings enclosing the courtyard (non-overlapping corners)
      {
        primitive: 'box',
        partGroup: 'cloister_west_wing',
        from: [-15.8, 0.75, 2.6],
        to: [-11.6, 8.6, 12.2],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'cloister_north_wing',
        from: [-15.8, 0.75, 12.2],
        to: [10.8, 8.6, 16.2],
        material: 'cream_stucco',
      },
      {
        primitive: 'box',
        partGroup: 'cloister_east_wing',
        from: [6.6, 0.75, 4.2],
        to: [10.8, 8.6, 12.2],
        material: 'cream_stucco',
      },
      // Cloister inner arcaded wall with round-headed Manueline openings
      {
        primitive: 'wall',
        partGroup: 'cloister_inner_arcade',
        from: [-11.4, 0.95, 11.8],
        to: [6.4, 0.95, 11.8],
        height: 7.4,
        thickness: 0.55,
        material: 'limestone',
        openings: [
          { offset: 3.0, width: 1.8, height: 3.2, sillHeight: 0.2 },
          { offset: 6.8, width: 1.8, height: 3.2, sillHeight: 0.2 },
          { offset: 10.6, width: 1.8, height: 3.2, sillHeight: 0.2 },
          { offset: 14.4, width: 1.8, height: 3.2, sillHeight: 0.2 },
        ],
      },
      // Terracotta hipped roofs over the three cloister ranges (cleanly abutted)
      {
        primitive: 'roof',
        partGroup: 'cloister_north_roof',
        from: [-15.8, 8.6, 12.2],
        to: [10.8, 10.8, 16.2],
        height: 2.2,
        hipRatio: 0.22,
        material: 'terracotta',
      },
      {
        primitive: 'roof',
        partGroup: 'cloister_west_roof',
        from: [-15.8, 8.6, 2.6],
        to: [-11.6, 10.6, 12.0],
        height: 2.0,
        hipRatio: 0.22,
        material: 'terracotta',
      },
      {
        primitive: 'roof',
        partGroup: 'cloister_east_roof',
        from: [6.6, 8.6, 4.2],
        to: [10.8, 10.6, 12.0],
        height: 2.0,
        hipRatio: 0.22,
        material: 'terracotta',
      },
    ],
  },

  // 1550 Lisboa · Sé Patriarcal de Lisboa (Santa Maria Maior)
  // Romanesque-Gothic fortress-cathedral founded 1147 above Alfama: twin square crenellated
  // western bell towers with voxel battlements, deep recessed Romanesque portal, rose oculus,
  // battlemented nave aisles, and octagonal crossing lantern tower (zimbório).
  se_patriarcal_de_lisboa: {
    schemaVersion: '0.4',
    name: 'Sé Patriarcal de Lisboa (Cathedral)',
    width: 24,
    length: 34,
    height: 19.0,
    foundationDepth: 5.5,
    materialKind: 11,
    roofPitch: 3.0,
    waterfront: false,
    shapes: {
      romanesque_bell_tower: {
        primitive: 'group',
        children: [
          // Lower Romanesque ashlar shaft
          {
            primitive: 'box',
            from: [-3.1, 0, -3.1],
            to: [3.1, 10.4, 3.1],
            topInset: 0.14,
            material: 'ashlar',
          },
          // Mid-tower Romanesque stringcourse belt (covers the 10.4m transition cleanly)
          {
            primitive: 'box',
            from: [-3.18, 10.35, -3.18],
            to: [3.18, 10.8, 3.18],
            material: 'limestone',
          },
          // Upper belfry stage with paired arched bell openings
          {
            primitive: 'box',
            from: [-2.95, 10.8, -2.95],
            to: [2.95, 16.8, 2.95],
            material: 'limestone',
          },
          {
            primitive: 'arch',
            from: [-2.1, 11.6, -2.85],
            to: [2.1, 11.6, -2.85],
            height: 4.2,
            thickness: 0.55,
            voussoirs: 7,
            material: 'ashlar',
          },
          {
            primitive: 'arch',
            from: [-2.1, 11.6, 2.85],
            to: [2.1, 11.6, 2.85],
            height: 4.2,
            thickness: 0.55,
            voussoirs: 7,
            material: 'ashlar',
          },
          // Projecting corbel cornice
          {
            primitive: 'box',
            from: [-3.35, 16.8, -3.35],
            to: [3.35, 17.5, 3.35],
            material: 'ashlar',
          },
          // Iconic flat crenellated fortress battlements (sitting flush at y = 17.45)
          {
            primitive: 'blocks',
            gridSize: 0.92,
            origin: [0, 17.45, 0],
            material: 'ashlar',
            runs: [
              { x: [-3, 3], y: 0, z: -3, step: 2 },
              { x: [-3, 3], y: 0, z: 3, step: 2 },
              { x: -3, y: 0, z: [-1, 1], step: 2 },
              { x: 3, y: 0, z: [-1, 1], step: 2 },
            ],
          },
        ],
      },
    },
    primitives: [
      // Stepped Alfama hillside stone terrace plinth
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-11.8, -5.0, -16.2],
        to: [11.8, 0.8, 16.2],
        material: 'ashlar',
      },
      {
        primitive: 'stairs',
        partGroup: 'west_parvis_steps',
        from: [0, 0.0, -18.5],
        to: [0, 0.8, -16.2],
        width: 8.2,
        material: 'ashlar',
      },
      // Fortress-like side aisles & central Romanesque clerestory nave (non-overlapping with west towers)
      {
        primitive: 'box',
        partGroup: 'side_aisles',
        from: [-9.8, 0.8, -9.4],
        to: [9.8, 7.8, 10.5],
        material: 'limestone',
      },
      {
        primitive: 'box',
        partGroup: 'central_nave',
        from: [-4.4, 0.8, -13.0],
        to: [4.4, 12.2, -9.4],
        material: 'limestone',
      },
      {
        primitive: 'box',
        partGroup: 'central_nave',
        from: [-5.2, 7.8, -9.4],
        to: [5.2, 12.2, 10.5],
        material: 'limestone',
      },
      // Projecting Romanesque transept & Gothic ambulatory apse
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [-11.8, 0.8, 1.5],
        to: [-9.8, 10.8, 7.8],
        material: 'limestone',
      },
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [9.8, 0.8, 1.5],
        to: [11.8, 10.8, 7.8],
        material: 'limestone',
      },
      {
        primitive: 'box',
        partGroup: 'transept_arms',
        from: [-9.8, 7.8, 1.5],
        to: [9.8, 10.8, 7.8],
        material: 'limestone',
      },
      {
        primitive: 'cylinder',
        partGroup: 'gothic_ambulatory_apse',
        base: [0, 0.8, 11.8],
        height: 9.6,
        radius: 5.2,
        segments: 8,
        material: 'limestone',
      },
      // Deep stepped Romanesque West Portal & Rose Window frontispiece between the twin towers
      {
        primitive: 'arch',
        partGroup: 'west_romanesque_portal',
        from: [-2.8, 0.8, -13.6],
        to: [2.8, 0.8, -13.6],
        height: 5.2,
        thickness: 1.0,
        voussoirs: 9,
        material: 'ashlar',
      },
      // Recessed Rose Window (Rosácea) frame above the portal
      {
        primitive: 'arch',
        partGroup: 'west_rose_window',
        from: [-2.4, 7.2, -13.35],
        to: [2.4, 7.2, -13.35],
        height: 3.4,
        thickness: 0.65,
        voussoirs: 9,
        material: 'ashlar',
      },
      // Twin Crenellated Western Bell Towers
      { shape: 'romanesque_bell_tower', partGroup: 'north_west_tower', position: [-7.6, 0.8, -12.6] },
      { shape: 'romanesque_bell_tower', partGroup: 'south_west_tower', position: [7.6, 0.8, -12.6] },
      // Octagonal crossing lantern tower (Zimbório) with crenellated parapet & pyramidal tile roof
      {
        primitive: 'cylinder',
        partGroup: 'crossing_zimborio_tower',
        base: [0, 14.8, 4.6],
        height: 3.2,
        radius: 4.0,
        segments: 8,
        material: 'ashlar',
      },
      {
        primitive: 'cone',
        partGroup: 'crossing_zimborio_roof',
        base: [0, 18.0, 4.6],
        height: 2.4,
        radiusBottom: 4.15,
        radiusTop: 0.25,
        segments: 8,
        material: 'terracotta',
      },
      // Pitched terracotta roofs over nave and transept
      {
        primitive: 'roof',
        partGroup: 'nave_roof',
        from: [-5.2, 12.2, -9.4],
        to: [5.2, 14.8, 10.5],
        height: 2.6,
        style: 'gable',
        material: 'terracotta',
        wallMaterial: 'limestone',
      },
      {
        primitive: 'roof',
        partGroup: 'transept_roof',
        from: [-11.8, 10.8, 1.5],
        to: [-5.2, 12.4, 7.8],
        height: 1.6,
        hipRatio: 0.22,
        material: 'terracotta',
      },
      {
        primitive: 'roof',
        partGroup: 'transept_roof',
        from: [5.2, 10.8, 1.5],
        to: [11.8, 12.4, 7.8],
        height: 1.6,
        hipRatio: 0.22,
        material: 'terracotta',
      },
    ],
  },

  // 1550–1585 Lisboa · Torreão do Paço da Ribeira & Galeria das Damas
  // Royal waterfront palace turret jutting directly over the Tagus quay between Terreiro do Paço
  // and Ribeira das Naus: battered river bastion plinth with water stairs, 3-story rusticated
  // ashlar turret with artillery casemates & royal library windows, monumental octagonal dome
  // with lantern, and adjoining two-story arcaded Galeria das Damas.
  paco_da_ribeira_torreao: {
    schemaVersion: '0.4',
    name: 'Torreão do Paço da Ribeira (Waterfront Palace Turret)',
    width: 18,
    length: 22,
    height: 20.5,
    foundationDepth: 9.5,
    materialKind: 11,
    roofPitch: 3.2,
    waterfront: true,
    shapes: {
      corner_obelisk_finial: {
        primitive: 'cone',
        base: [0, 0, 0],
        height: 2.1,
        radiusBottom: 0.42,
        radiusTop: 0.06,
        segments: 6,
        material: 'limestone',
      },
    },
    primitives: [
      // Battered stone river bastion plinth rising out of the Tagus channel
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-8.4, -8.5, -10.6],
        to: [8.4, 1.4, 10.6],
        topInset: 0.45,
        material: 'ashlar',
      },
      // Royal river embarkation steps descending to the Tagus waterline
      {
        primitive: 'stairs',
        partGroup: 'royal_water_stairs',
        from: [-11.2, -0.4, -4.5],
        to: [-8.42, 1.4, -4.5],
        width: 3.6,
        material: 'limestone',
      },
      // Lower rusticated artillery & treasury casemate tier
      {
        primitive: 'box',
        partGroup: 'torreao_lower_casemate',
        from: [-7.4, 1.4, -9.4],
        to: [7.4, 6.9, 5.0],
        topInset: 0.22,
        material: 'ashlar',
      },
      // Projecting stone stringcourse belt
      {
        primitive: 'box',
        partGroup: 'torreao_belt_cornice',
        from: [-7.65, 6.9, -9.65],
        to: [7.65, 7.55, 5.2],
        material: 'limestone',
      },
      // Upper two noble stories (Sala da Índia & Royal Library / Map Room)
      {
        primitive: 'box',
        partGroup: 'torreao_noble_stories',
        from: [-7.0, 7.55, -9.0],
        to: [7.0, 14.8, 5.0],
        material: 'whitewash',
      },
      // Seaward Tagus loggia arch & royal balcony on the south face
      {
        primitive: 'box',
        partGroup: 'seaward_royal_balcony',
        from: [-4.2, 7.3, -10.35],
        to: [4.2, 7.9, -9.0],
        material: 'limestone',
      },
      {
        primitive: 'arch',
        partGroup: 'seaward_royal_portal',
        from: [-2.4, 7.9, -9.45],
        to: [2.4, 7.9, -9.45],
        height: 4.4,
        thickness: 0.65,
        voussoirs: 7,
        material: 'limestone',
      },
      // Crowning balustrade cornice & 4 corner Herrerian/Manueline obelisk finials
      {
        primitive: 'box',
        partGroup: 'torreao_crown_cornice',
        from: [-7.45, 14.8, -9.45],
        to: [7.45, 15.65, 5.45],
        material: 'limestone',
      },
      { shape: 'corner_obelisk_finial', partGroup: 'corner_finials', position: [-6.9, 15.65, -8.9] },
      { shape: 'corner_obelisk_finial', partGroup: 'corner_finials', position: [6.9, 15.65, -8.9] },
      { shape: 'corner_obelisk_finial', partGroup: 'corner_finials', position: [-6.9, 15.65, 4.9] },
      { shape: 'corner_obelisk_finial', partGroup: 'corner_finials', position: [6.9, 15.65, 4.9] },
      // Monumental octagonal palace dome & lantern crowning the Torreão
      {
        primitive: 'dome',
        partGroup: 'torreao_imperial_dome',
        base: [0, 15.65, -2.0],
        drumHeight: 2.2,
        radius: 5.6,
        height: 4.8,
        segments: 8,
        rings: 5,
        lantern: true,
        material: 'terracotta',
      },
      // Adjoining landward Galeria das Damas wing with ground-floor stone arch loggia (flush at z = 5.0)
      {
        primitive: 'box',
        partGroup: 'galeria_das_damas_wing',
        from: [-6.2, 1.4, 5.0],
        to: [6.2, 12.2, 10.2],
        material: 'cream_stucco',
      },
      {
        primitive: 'arch',
        partGroup: 'galeria_arcade',
        from: [-4.2, 1.4, 10.55],
        to: [4.2, 1.4, 10.55],
        height: 4.2,
        thickness: 0.70,
        voussoirs: 7,
        material: 'limestone',
      },
      {
        primitive: 'roof',
        partGroup: 'galeria_roof',
        from: [-6.2, 12.2, 5.0],
        to: [6.2, 14.6, 10.2],
        height: 2.4,
        hipRatio: 0.25,
        material: 'terracotta',
      },
    ],
  },

  // 1550–1650 Spanish Main & Iberian Viceregal Port Landmark · Palacio de los Capitanes Generales
  // Two-story governor's palace facing the Plaza de Armas with 5-bay ground-floor radial stone
  // voussoir arcade (soportal), upper noble gallery, corner ashlar mirador towers, and central
  // royal coat-of-arms clock/bell turret.
  palacio_del_gobernador: {
    schemaVersion: '0.4',
    name: 'Palacio de los Capitanes Generales (Governor Palace)',
    width: 28,
    length: 20,
    height: 14.5,
    foundationDepth: 3.8,
    materialKind: 12,
    roofPitch: 2.8,
    waterfront: false,
    shapes: {
      arcade_arch_bay: {
        primitive: 'arch',
        from: [-1.65, 0, 0],
        to: [1.65, 0, 0],
        height: 4.45,
        thickness: 0.68,
        voussoirs: 7,
        openThrough: true,
        material: 'ashlar',
      },
      corner_mirador_tower: {
        primitive: 'group',
        children: [
          {
            primitive: 'box',
            from: [-2.6, 0, -2.6],
            to: [2.6, 12.6, 2.6],
            material: 'limestone',
          },
          {
            primitive: 'roof',
            from: [-2.75, 12.6, -2.75],
            to: [2.75, 14.8, 2.75],
            height: 2.2,
            hipRatio: 0.48,
            material: 'terracotta',
          },
        ],
      },
    },
    primitives: [
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-13.8, -3.5, -9.8],
        to: [13.8, 0.65, 9.8],
        material: 'ashlar',
      },
      // Main two-story palace block set behind the ground-floor vaulted portico (between the corner towers x=-8.4..8.4)
      {
        primitive: 'box',
        partGroup: 'palace_main_hall',
        from: [-8.4, 0.65, -6.2],
        to: [8.4, 9.8, 8.8],
        material: 'whitewash',
      },
      // Upper floor gallery projecting over the ground-floor arcade (between the corner towers)
      {
        primitive: 'box',
        partGroup: 'upper_noble_gallery',
        from: [-8.4, 5.1, -9.0],
        to: [8.4, 9.8, -6.2],
        material: 'cream_stucco',
      },
      // 4-bay ground-floor stone arch soportal along the plaza facade
      {
        primitive: 'repeat',
        partGroup: 'plaza_soportal_arcade',
        count: 4,
        step: [3.8, 0, 0],
        of: {
          shape: 'arcade_arch_bay',
          position: [-5.7, 0.65, -8.8],
        },
      },
      // Twin corner ashlar mirador towers (Torreones Esquineros) flanking the main hall cleanly
      { shape: 'corner_mirador_tower', partGroup: 'west_mirador_tower', position: [-11.0, 0.65, -6.4] },
      { shape: 'corner_mirador_tower', partGroup: 'east_mirador_tower', position: [11.0, 0.65, -6.4] },
      // Central royal heraldic frontispiece & domed clock/bell turret rising above the roof ridge
      {
        primitive: 'box',
        partGroup: 'central_heraldic_tower',
        from: [-2.4, 12.2, -5.8],
        to: [2.4, 14.6, -1.8],
        material: 'limestone',
      },
      {
        primitive: 'dome',
        partGroup: 'central_turret_dome',
        base: [0, 14.6, -3.8],
        radius: 2.0,
        height: 2.1,
        segments: 8,
        lantern: true,
        material: 'terracotta',
      },
      // Hipped terracotta roof over the main palace range (between the corner towers)
      {
        primitive: 'roof',
        partGroup: 'palace_main_roof',
        from: [-8.4, 9.8, -9.0],
        to: [8.4, 12.4, 8.8],
        height: 2.6,
        hipRatio: 0.24,
        material: 'terracotta',
      },
    ],
  },

  // 1550–1650 Acueducto Real de Sillería (Two-Tier Ashlar Stone Arch Aqueduct & Cistern Arcade)
  // Combines voxel-built stepped cutwater piers with repeated lower & upper radial stone voussoir
  // arches and a top stone water channel (specus).
  acueducto_de_piedra: {
    schemaVersion: '0.4',
    name: 'Acueducto Real de Sillería (Royal Stone Aqueduct)',
    width: 32,
    length: 6.5,
    height: 13.2,
    foundationDepth: 4.5,
    materialKind: 11,
    roofPitch: 0.8,
    waterfront: false,
    shapes: {
      lower_aqueduct_arch: {
        primitive: 'arch',
        from: [-2.8, 0, 0],
        to: [2.8, 0, 0],
        height: 6.8,
        thickness: 1.65,
        voussoirs: 9,
        openThrough: true,
        material: 'ashlar',
      },
      upper_aqueduct_arch: {
        primitive: 'arch',
        from: [-2.6, 0, 0],
        to: [2.6, 0, 0],
        height: 4.2,
        thickness: 1.35,
        voussoirs: 7,
        openThrough: true,
        material: 'limestone',
      },
    },
    primitives: [
      {
        primitive: 'box',
        partGroup: 'foundation_plinth',
        from: [-15.8, -4.0, -2.6],
        to: [15.8, 0.5, 2.6],
        material: 'ashlar',
      },
      // Voxel-built stepped cutwater buttresses at each pier base
      {
        primitive: 'blocks',
        partGroup: 'aqueduct_cutwater_piers',
        gridSize: 1.0,
        origin: [0, 0.5, 0],
        material: 'ashlar',
        runs: [
          { x: -14, y: [0, 2], z: [-2, 2] },
          { x: -8, y: [0, 2], z: [-2, 2] },
          { x: -3, y: [0, 2], z: [-2, 2] },
          { x: 3, y: [0, 2], z: [-2, 2] },
          { x: 8, y: [0, 2], z: [-2, 2] },
          { x: 14, y: [0, 2], z: [-2, 2] },
        ],
      },
      // 5 lower monumental stone arches
      {
        primitive: 'repeat',
        partGroup: 'lower_arch_tier',
        count: 5,
        step: [5.6, 0, 0],
        of: {
          shape: 'lower_aqueduct_arch',
          position: [-11.2, 0.5, 0],
        },
      },
      // Mid-tier stone stringcourse belt
      {
        primitive: 'box',
        partGroup: 'mid_tier_cornice',
        from: [-15.4, 7.3, -1.15],
        to: [15.4, 7.95, 1.15],
        material: 'limestone',
      },
      // 5 upper water-carrier arches
      {
        primitive: 'repeat',
        partGroup: 'upper_arch_tier',
        count: 5,
        step: [5.6, 0, 0],
        of: {
          shape: 'upper_aqueduct_arch',
          position: [-11.2, 7.95, 0],
        },
      },
      // Top stone water specus channel & side parapets
      {
        primitive: 'box',
        partGroup: 'aqueduct_water_channel',
        from: [-15.6, 12.15, -1.25],
        to: [15.6, 13.1, 1.25],
        material: 'ashlar',
      },
    ],
  },
};
