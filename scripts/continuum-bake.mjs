// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What every rigid family's continuum bake shares (AGENTS.md rule 3): nearest points on triangles, the half-edge
// collapse chain the far body morphs along, and the outline it must keep. Used by scripts/prepare-city-continuum.mjs.
// The people's bake (scripts/prepare-crew-continuum.mjs) holds the posed forms of the same measures.

// Ericson's closest point on triangle a + s*e0 + t*e1 to p: writes [squared distance, s, t] into `closest`.
export const closest = new Float64Array(3);
export function closestOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let s, t;
  if (d1 <= 0 && d2 <= 0) { s = 0; t = 0; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { s = 1; t = 0; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { s = d1 / (d1 - d3); t = 0; } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { s = 0; t = 1; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { s = 0; t = d2 / (d2 - d6); } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { t = (d4 - d3) / (d4 - d3 + (d5 - d6)); s = 1 - t; } else if (va + vb + vc > 1e-30) {
              const denominator = 1 / (va + vb + vc);
              s = vb * denominator; t = vc * denominator;
            } else {
              // A sliver with no area: the nearest of its three edges.
              const onEdge = (ex, ey, ez, ox, oy, oz) => { const l = ex * ex + ey * ey + ez * ez; return l > 1e-30 ? Math.min(1, Math.max(0, ((px - ox) * ex + (py - oy) * ey + (pz - oz) * ez) / l)) : 0; };
              const u = onEdge(abx, aby, abz, ax, ay, az), w = onEdge(acx, acy, acz, ax, ay, az), m = onEdge(cx - bx, cy - by, cz - bz, bx, by, bz);
              const gap = (ss, tt) => (ax + abx * ss + acx * tt - px) ** 2 + (ay + aby * ss + acy * tt - py) ** 2 + (az + abz * ss + acz * tt - pz) ** 2;
              [s, t] = [[u, 0], [0, w], [1 - m, m]].reduce((best, o) => (gap(o[0], o[1]) < gap(best[0], best[1]) ? o : best));
            }
          }
        }
      }
    }
  }
  const qx = ax + abx * s + acx * t - px, qy = ay + aby * s + acy * t - py, qz = az + abz * s + acz * t - pz;
  closest[0] = qx * qx + qy * qy + qz * qz; closest[1] = s; closest[2] = t;
}
// Each listed triangle's bounding sphere (x, y, z, r), for pruning.
export function triangleSpheres(position, corners, triangles) {
  const out = new Float64Array(triangles.length * 4);
  triangles.forEach((t, k) => {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const cx = (position[a] + position[b] + position[c]) / 3, cy = (position[a + 1] + position[b + 1] + position[c + 1]) / 3, cz = (position[a + 2] + position[b + 2] + position[c + 2]) / 3;
    let r = 0;
    for (const v of [a, b, c]) r = Math.max(r, Math.hypot(position[v] - cx, position[v + 1] - cy, position[v + 2] - cz));
    out.set([cx, cy, cz, r], k * 4);
  });
  return out;
}
// The nearest point of a list of triangles of `mesh` ({position, corners}) to p, pruned by `spheres` (one per list
// entry). Returns the entry's place in the list, its barycentric pair in `closest`; -1 for an empty list.
export function nearestTriangle(px, py, pz, list, mesh, spheres) {
  let best = Infinity, found = -1, bs = 0, bt = 0;
  for (let k = 0; k < list.length; k++) {
    const sx = spheres[k * 4] - px, sy = spheres[k * 4 + 1] - py, sz = spheres[k * 4 + 2] - pz;
    const gap = Math.sqrt(sx * sx + sy * sy + sz * sz) - spheres[k * 4 + 3];
    if (gap > 0 && gap * gap >= best) continue;
    const t = list[k], a = mesh.corners[t * 3] * 3, b = mesh.corners[t * 3 + 1] * 3, c = mesh.corners[t * 3 + 2] * 3, X = mesh.position;
    closestOnTriangle(px, py, pz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]);
    if (closest[0] < best) { best = closest[0]; found = k; bs = closest[1]; bt = closest[2]; }
  }
  closest[0] = best; closest[1] = bs; closest[2] = bt;
  return found;
}
// Nearest-triangle queries over a whole mesh, through a uniform grid of its triangles' bounds.
export function triangleGrid(position, corners, cell) {
  const T = corners.length / 3, lo = [Infinity, Infinity, Infinity];
  for (let v = 0; v < position.length / 3; v++) for (let k = 0; k < 3; k++) lo[k] = Math.min(lo[k], position[v * 3 + k]);
  const cells = new Map(), key = (i, j, k) => (i + 1024) * 4194304 + (j + 1024) * 2048 + (k + 1024);
  const all = Array.from({ length: T }, (_, t) => t), spheres = triangleSpheres(position, corners, all);
  for (let t = 0; t < T; t++) {
    const range = [0, 1, 2].map((k) => [Math.floor((spheres[t * 4 + k] - spheres[t * 4 + 3] - lo[k]) / cell), Math.floor((spheres[t * 4 + k] + spheres[t * 4 + 3] - lo[k]) / cell)]);
    for (let i = range[0][0]; i <= range[0][1]; i++) for (let j = range[1][0]; j <= range[1][1]; j++) for (let k = range[2][0]; k <= range[2][1]; k++) {
      const at = key(i, j, k), list = cells.get(at);
      if (list) list.push(t); else cells.set(at, [t]);
    }
  }
  const mesh = { position, corners };
  // The nearest triangle to p: rings of cells outward until the best found is nearer than the next ring.
  return (px, py, pz, accept = null) => {
    const ci = Math.floor((px - lo[0]) / cell), cj = Math.floor((py - lo[1]) / cell), ck = Math.floor((pz - lo[2]) / cell);
    let best = Infinity, found = -1, bs = 0, bt = 0;
    const seen = new Set();
    for (let ring = 0; ring < 4096; ring++) {
      if (found >= 0 && (ring - 1) * cell > Math.sqrt(best)) break;
      if (ring > 2 && cells.size && ring * cell > 1e4) break;
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) for (let k = ck - ring; k <= ck + ring; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== ring) continue;
        for (const t of cells.get(key(i, j, k)) ?? []) {
          if (seen.has(t) || (accept && !accept(t))) continue;
          seen.add(t);
          const sx = spheres[t * 4] - px, sy = spheres[t * 4 + 1] - py, sz = spheres[t * 4 + 2] - pz, gap = Math.sqrt(sx * sx + sy * sy + sz * sz) - spheres[t * 4 + 3];
          if (gap > 0 && gap * gap >= best) continue;
          const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3, X = mesh.position;
          closestOnTriangle(px, py, pz, X[a], X[a + 1], X[a + 2], X[b], X[b + 1], X[b + 2], X[c], X[c + 1], X[c + 2]);
          if (closest[0] < best) { best = closest[0]; found = t; bs = closest[1]; bt = closest[2]; }
        }
      }
    }
    closest[0] = best; closest[1] = bs; closest[2] = bt;
    return found;
  };
}
export function edgeCensus(index) {
  const edges = new Map();
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = index[t + k], b = index[t + ((k + 1) % 3)], key = a < b ? a * 1048576 + b : b * 1048576 + a;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; if (n > 2) nonManifold++; }
  return { edges: edges.size, boundary, nonManifold };
}
export const surfaceArea = (corners, triangles, X) => triangles.reduce((sum, t) => {
  const [a, b, c] = [0, 1, 2].map((k) => corners[t * 3 + k] * 3), e = [0, 1, 2].map((k) => X[b + k] - X[a + k]), f = [0, 1, 2].map((k) => X[c + k] - X[a + k]);
  return sum + 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
}, 0);

// Half-edge collapses, cheapest first by quadric error (Garland and Heckbert), each vertex moving onto a neighbour so
// every survivor keeps its own attributes. A collapse that would fold a triangle over or pinch the surface (the link
// condition) is refused, so a closed body stays closed and keeps its genus to the last step.
export function collapseChain(position, index, least) {
  const V = position.length / 3, T = index.length / 3, corners = Int32Array.from(index), alive = new Uint8Array(T).fill(1), death = new Int32Array(T).fill(-1);
  const Q = new Float64Array(V * 10), fans = Array.from({ length: V }, () => []);
  const p = (v, k) => position[v * 3 + k];
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
    const e = [0, 1, 2].map((k) => p(b, k) - p(a, k)), f = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]], l = Math.hypot(...n) || 1e-12, w = l / 2;
    const [nx, ny, nz] = n.map((x) => x / l), d = -(nx * p(a, 0) + ny * p(a, 1) + nz * p(a, 2));
    const q = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) { for (let k = 0; k < 10; k++) Q[v * 10 + k] += w * q[k]; fans[v].push(t); }
  }
  const quadric = (u, v) => {
    const x = p(v, 0), y = p(v, 1), z = p(v, 2), q = (k) => Q[u * 10 + k] + Q[v * 10 + k];
    return q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
  };
  const ring = (v) => { const s = new Set(); for (const t of fans[v]) if (alive[t]) for (let k = 0; k < 3; k++) if (corners[t * 3 + k] !== v) s.add(corners[t * 3 + k]); return s; };
  const cost = (u, v) => {
    const l2 = (p(u, 0) - p(v, 0)) ** 2 + (p(u, 1) - p(v, 1)) ** 2 + (p(u, 2) - p(v, 2)) ** 2;
    return Math.max(0, quadric(u, v)) + 1e-4 * l2 * l2;
  };
  const normalOf = (a, b, c) => {
    const e = [0, 1, 2].map((k) => p(b, k) - p(a, k)), f = [0, 1, 2].map((k) => p(c, k) - p(a, k));
    return [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
  };
  let living = T;
  // Folds are refused while the body has triangles to spare; near the core, only a triangle turned right over is.
  const valid = (u, v) => {
    const fold = living > 400 ? 0.2 : living > 60 ? -0.3 : -0.9;
    const ru = ring(u), rv = ring(v);
    let shared = 0, common = 0;
    for (const t of fans[u]) if (alive[t] && (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v)) shared++;
    for (const w of ru) if (rv.has(w)) common++;
    if (shared !== 2 || common !== 2) return false;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      const [a, b, c] = [corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2]];
      if (a === v || b === v || c === v) continue;
      const before = normalOf(a, b, c), after = normalOf(a === u ? v : a, b === u ? v : b, c === u ? v : c);
      const lb = Math.hypot(...before), la = Math.hypot(...after);
      if (la < 1e-10 || (lb > 1e-10 && (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (lb * la) < fold)) return false;
    }
    return true;
  };
  // A binary heap of [cost, u, v, stamp of u, stamp of v].
  const heap = [], stamp = new Int32Array(V);
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  const offer = (u) => { for (const w of ring(u)) { push([cost(u, w), u, w, stamp[u], stamp[w]]); push([cost(w, u), w, u, stamp[w], stamp[u]]); } };
  for (let v = 0; v < V; v++) for (const w of ring(v)) push([cost(v, w), v, w, stamp[v], stamp[w]]);
  const dieStep = new Int32Array(V).fill(-1), target = new Int32Array(V).fill(-1), steps = [];
  while (living > least && heap.length) {
    const [, u, v, su, sv] = pop();
    if (su !== stamp[u] || sv !== stamp[v] || dieStep[u] >= 0 || dieStep[v] >= 0 || !valid(u, v)) continue;
    const step = steps.length;
    steps.push({ u, v });
    dieStep[u] = step; target[u] = v;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      if (corners[t * 3] === v || corners[t * 3 + 1] === v || corners[t * 3 + 2] === v) { alive[t] = 0; death[t] = step + 1; living--; continue; }
      for (let k = 0; k < 3; k++) if (corners[t * 3 + k] === u) corners[t * 3 + k] = v;
      fans[v].push(t);
    }
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    const neighbours = ring(v);
    stamp[v]++;
    for (const w of neighbours) stamp[w]++;
    offer(v);
    for (const w of neighbours) offer(w);
  }
  return { dieStep, target, death, steps, living };
}
// Where vertex v has gone by step s.
export const ancestor = (chain, v, s) => { while (chain.dieStep[v] >= 0 && chain.dieStep[v] < s) v = chain.target[v]; return v; };

// The outline a mesh casts along each of `views` (pairs of axes across and up, and the depth axis) on a grid over
// the body: cells covered, and each cell's nearest triangle's label. `inflate` grows the surface along its normals.
export function outline(position, normal, corners, triangles, inflate, frame, labelOf = null, views = [[0, 1, 2], [2, 1, 0], [0, 2, 1]]) {
  const { low, size, cells } = frame, result = [];
  for (const [ax, ay, az] of views) {
    const depth = new Float32Array(cells * cells).fill(Infinity), label = new Int16Array(cells * cells).fill(-1);
    for (const t of triangles) {
      const v = [0, 1, 2].map((k) => corners[t * 3 + k]);
      const x = v.map((w) => ((position[w * 3 + ax] + normal[w * 3 + ax] * inflate - low[ax]) / size) * cells);
      const y = v.map((w) => ((position[w * 3 + ay] + normal[w * 3 + ay] * inflate - low[ay]) / size) * cells);
      const z = v.map((w) => position[w * 3 + az]);
      const area = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
      if (Math.abs(area) < 1e-12) continue;
      const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(cells - 1, Math.ceil(Math.max(...x))), y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(cells - 1, Math.ceil(Math.max(...y)));
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5, cy = py + 0.5, w0 = ((x[1] - cx) * (y[2] - cy) - (x[2] - cx) * (y[1] - cy)) / area, w1 = ((x[2] - cx) * (y[0] - cy) - (x[0] - cx) * (y[2] - cy)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * z[0] + w1 * z[1] + w2 * z[2], at = py * cells + px;
        if (d < depth[at]) { depth[at] = d; label[at] = labelOf ? labelOf(t) : 0; }
      }
    }
    let covered = 0;
    for (const r of label) if (r >= 0) covered++;
    result.push({ covered, label });
  }
  return result;
}
