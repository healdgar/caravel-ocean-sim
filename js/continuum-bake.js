// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's simplifier (AGENTS.md rule 3): one rigid body's bake, the same code offline and in game. The
// offline bakes (scripts/prepare-city-continuum.mjs for the city's types, scripts/prepare-prefab-continuum.mjs for
// the coasts' prefabs, scripts/prepare-prop-continuum.mjs, scripts/prepare-animal-continuum.mjs,
// scripts/prepare-meadow-grass.mjs, and scripts/prepare-ship-continuum.mjs, whose far bodies are voxel pieces below)
// import it under Node; the page's bake worker (js/continuum-bake-worker.js, bundled by
// build.mjs into assets/continuum/bake-worker.js) runs it in the browser for whatever the offline bakes did not
// cover. It is no part of the page's own bundle.
//   clusters   a cluster hierarchy the GPU cuts by projected error. Every part of the body's assembly is clustered
//              apart, its boundary a seam both sides coarsen alike, so no simplified triangle spans two parts and a
//              shot part's own triangles are always its own.
//   far body   the body's outside, wrapped: its triangles are stood in a grid of cells, the cells within closed,
//              gaps narrower than a few cells bridged, the grid made well-composed and its faces taken as a closed
//              manifold surface, simplified within a cell and collapsed one half-edge at a time to one closed core of
//              a few triangles, however many shells or holes it began with.
//              Each triangle wears the kind of the body's surface nearest it; each step's error is measured against
//              the wrap, and the wrap's against what of the body can be seen from outside it, so a filled yard or
//              a bridged eave is counted. What a collapse takes off the outline is given back along the normals.
//   splat      one view-facing ellipse with the body's outline area above its floor, and its walls' and roof's kinds.
// A body is given as js/old-world-buildings.js compileContinuumBody makes it: every drawn corner (8 floats:
// position, normal, kind) in triangles, and each triangle's part.
import { MeshoptSimplifier } from 'meshoptimizer';
import { buildDag } from '../third_party/threejs-nanites/dag/build.ts';
import { CONTINUUM_STEP_WORDS, CONTINUUM_HOPS } from './continuum-core.js';

// ------------------------------------------------------------------------------------------------ measures
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
  const mesh = { position, corners }, seen = new Int32Array(T);
  let query = 0;
  // The nearest triangle to p: rings of cells outward until the best found is nearer than the next ring.
  return (px, py, pz, accept = null) => {
    const ci = Math.floor((px - lo[0]) / cell), cj = Math.floor((py - lo[1]) / cell), ck = Math.floor((pz - lo[2]) / cell);
    let best = Infinity, found = -1, bs = 0, bt = 0;
    query++;
    for (let ring = 0; ring < 4096; ring++) {
      if (found >= 0 && (ring - 1) * cell > Math.sqrt(best)) break;
      if (ring > 2 && cells.size && ring * cell > 1e4) break;
      for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) for (let k = ck - ring; k <= ck + ring; k++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== ring) continue;
        for (const t of cells.get(key(i, j, k)) ?? []) {
          if (seen[t] === query || (accept && !accept(t))) continue;
          seen[t] = query;
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
// A surface's edges: how many there are, how many have one triangle (a boundary) or more than two (non-manifold), and
// its Euler characteristic (vertices less edges plus faces; two less twice the genus for each closed shell). Edges are
// keyed by the vertex count, exactly for any surface under ninety million vertices.
export function edgeCensus(index) {
  let most = 0;
  for (let i = 0; i < index.length; i++) if (index[i] > most) most = index[i];
  const stride = most + 1, edges = new Map();
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = index[t + k], b = index[t + ((k + 1) % 3)], key = a < b ? a * stride + b : b * stride + a;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; if (n > 2) nonManifold++; }
  const vertices = new Set(index).size;
  return { edges: edges.size, boundary, nonManifold, euler: vertices - edges.size + index.length / 3 };
}
export const surfaceArea = (corners, triangles, X) => triangles.reduce((sum, t) => {
  const [a, b, c] = [0, 1, 2].map((k) => corners[t * 3 + k] * 3), e = [0, 1, 2].map((k) => X[b + k] - X[a + k]), f = [0, 1, 2].map((k) => X[c + k] - X[a + k]);
  return sum + 0.5 * Math.hypot(e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]);
}, 0);

// Half-edge collapses, cheapest first by quadric error (Garland and Heckbert), each vertex moving onto a neighbour so
// every survivor keeps its own attributes (its place, its kind, the source vertex it rides). A collapse that would
// pinch the surface (the link condition), lay two triangles on the same corners, or turn a triangle further than
// `fold(living)` allows (the least cosine, given how many triangles are left) is refused, so a closed body stays closed
// and keeps its genus while it can. Where `region` gives each vertex a class (a ship's wood, canvas, iron and paint), a
// collapse across a border of class costs `border` times as much, so borders go last.
export const CHAIN_FOLD = (living) => (living > 400 ? 0.2 : living > 60 ? -0.3 : -0.9);
export function collapseChain(position, index, least, { region = null, border = 6, fold = CHAIN_FOLD } = {}) {
  const V = position.length / 3, T = index.length / 3, corners = Int32Array.from(index), alive = new Uint8Array(T).fill(1), death = new Int32Array(T).fill(-1);
  const Q = new Float64Array(V * 10), fans = Array.from({ length: V }, () => []);
  for (let t = 0; t < T; t++) {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
    const ex = position[b] - position[a], ey = position[b + 1] - position[a + 1], ez = position[b + 2] - position[a + 2];
    const fx = position[c] - position[a], fy = position[c + 1] - position[a + 1], fz = position[c + 2] - position[a + 2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1e-12, w = l / 2;
    nx /= l; ny /= l; nz /= l;
    const d = -(nx * position[a] + ny * position[a + 1] + nz * position[a + 2]);
    for (let k = 0; k < 3; k++) {
      const v = corners[t * 3 + k], o = v * 10;
      Q[o] += w * nx * nx; Q[o + 1] += w * nx * ny; Q[o + 2] += w * nx * nz; Q[o + 3] += w * nx * d; Q[o + 4] += w * ny * ny;
      Q[o + 5] += w * ny * nz; Q[o + 6] += w * ny * d; Q[o + 7] += w * nz * nz; Q[o + 8] += w * nz * d; Q[o + 9] += w * d * d;
      fans[v].push(t);
    }
  }
  const cost = (u, v) => {
    const x = position[v * 3], y = position[v * 3 + 1], z = position[v * 3 + 2], a = u * 10, b = v * 10, q = (k) => Q[a + k] + Q[b + k];
    const e = q(0) * x * x + 2 * q(1) * x * y + 2 * q(2) * x * z + 2 * q(3) * x + q(4) * y * y + 2 * q(5) * y * z + 2 * q(6) * y + q(7) * z * z + 2 * q(8) * z + q(9);
    const l2 = (position[u * 3] - x) ** 2 + (position[u * 3 + 1] - y) ** 2 + (position[u * 3 + 2] - z) ** 2;
    return (Math.max(0, e) + 1e-4 * l2 * l2) * (region && region[u] !== region[v] ? border : 1);
  };
  const hasCorner = (t, w) => corners[t * 3] === w || corners[t * 3 + 1] === w || corners[t * 3 + 2] === w;
  // A triangle about w as the two corners it has besides w: one number, whichever way round it is wound.
  const pairKey = (t, w) => {
    const a = corners[t * 3], b = corners[t * 3 + 1], c = corners[t * 3 + 2], p = a === w ? b : a, q = c === w ? b : c;
    return p < q ? p * V + q : q * V + p;
  };
  // A vertex's ring, into `out`, its dead triangles dropped from its fan as it goes; `mark` stamped with the tick.
  const markA = new Int32Array(V), markB = new Int32Array(V);
  let tick = 0;
  const ring = (v, out, mark) => {
    tick++;
    out.length = 0;
    const fan = fans[v];
    let n = 0;
    for (let i = 0; i < fan.length; i++) {
      const t = fan[i];
      if (!alive[t]) continue;
      fan[n++] = t;
      for (let k = 0; k < 3; k++) { const c = corners[t * 3 + k]; if (c !== v && mark[c] !== tick) { mark[c] = tick; out.push(c); } }
    }
    fan.length = n;
    return tick;
  };
  // The cosine a triangle (a, b, c) turns through when u goes to v; -2 if it is left with no area.
  const turn = (a, b, c, u, v) => {
    const P = position, A = (a === u ? v : a) * 3, B = (b === u ? v : b) * 3, C = (c === u ? v : c) * 3, a3 = a * 3, b3 = b * 3, c3 = c * 3;
    const ex = P[b3] - P[a3], ey = P[b3 + 1] - P[a3 + 1], ez = P[b3 + 2] - P[a3 + 2], fx = P[c3] - P[a3], fy = P[c3 + 1] - P[a3 + 1], fz = P[c3 + 2] - P[a3 + 2];
    const gx = P[B] - P[A], gy = P[B + 1] - P[A + 1], gz = P[B + 2] - P[A + 2], hx = P[C] - P[A], hy = P[C + 1] - P[A + 1], hz = P[C + 2] - P[A + 2];
    const n0x = ey * fz - ez * fy, n0y = ez * fx - ex * fz, n0z = ex * fy - ey * fx, n1x = gy * hz - gz * hy, n1y = gz * hx - gx * hz, n1z = gx * hy - gy * hx;
    const l0 = Math.hypot(n0x, n0y, n0z), l1 = Math.hypot(n1x, n1y, n1z);
    if (l1 < 1e-12) return -2;
    return l0 < 1e-12 ? 1 : (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1);
  };
  const ringU = [], ringV = [], scratch = [], about = new Set();
  let living = T;
  const valid = (u, v) => {
    const tu = ring(u, ringU, markA);
    ring(v, ringV, markB);
    let shared = 0, common = 0;
    for (const t of fans[u]) if (hasCorner(t, v)) shared++;
    for (const w of ringV) if (w !== u && markA[w] === tu) common++;
    if (shared !== 2 || common !== 2) return false;
    const least = fold(living);
    for (const t of fans[u]) {
      if (hasCorner(t, v)) continue;
      if (turn(corners[t * 3], corners[t * 3 + 1], corners[t * 3 + 2], u, v) < least) return false;
    }
    // Nor one that would lay two triangles on the same corners (a tetrahedron's last edge): they enclose nothing.
    about.clear();
    for (const t of fans[v]) if (!hasCorner(t, u)) about.add(pairKey(t, v));
    for (const t of fans[u]) if (!hasCorner(t, v) && about.has(pairKey(t, u))) return false;
    return true;
  };
  // A binary heap of (cost, u, v, u's stamp) in typed arrays. Each vertex offers its cheapest collapse; a refused one
  // makes way for its next cheapest that is allowed.
  let hc = new Float64Array(1 << 16), hu = new Int32Array(1 << 16), hv = new Int32Array(1 << 16), hs = new Int32Array(1 << 16), hn = 0;
  const push = (c, u, v, s) => {
    if (hn === hc.length) {
      const grow = (a) => { const b = new a.constructor(a.length * 2); b.set(a); return b; };
      hc = grow(hc); hu = grow(hu); hv = grow(hv); hs = grow(hs);
    }
    let i = hn++;
    while (i > 0) { const j = (i - 1) >> 1; if (hc[j] <= c) break; hc[i] = hc[j]; hu[i] = hu[j]; hv[i] = hv[j]; hs[i] = hs[j]; i = j; }
    hc[i] = c; hu[i] = u; hv[i] = v; hs[i] = s;
  };
  let topU = 0, topV = 0, topS = 0;
  const pop = () => {
    topU = hu[0]; topV = hv[0]; topS = hs[0];
    const n = --hn, c = hc[n], u = hu[n], v = hv[n], s = hs[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = -1, mc = c;
      if (l < n && hc[l] < mc) { m = l; mc = hc[l]; }
      if (r < n && hc[r] < mc) { m = r; mc = hc[r]; }
      if (m < 0) break;
      hc[i] = hc[m]; hu[i] = hu[m]; hv[i] = hv[m]; hs[i] = hs[m]; i = m;
    }
    hc[i] = c; hu[i] = u; hv[i] = v; hs[i] = s;
  };
  const stamp = new Int32Array(V), dieStep = new Int32Array(V).fill(-1), target = new Int32Array(V).fill(-1), steps = [];
  const offer = (u) => {
    ring(u, scratch, markA);
    let best = Infinity, to = -1;
    for (const w of scratch) { const c = cost(u, w); if (c < best) { best = c; to = w; } }
    if (to >= 0) push(best, u, to, stamp[u]);
  };
  const offerAllowed = (u, refused) => {
    ring(u, scratch, markA);
    const options = scratch.filter((w) => w !== refused).map((w) => [cost(u, w), w]).sort((p, q) => p[0] - q[0]);
    for (const [c, w] of options) if (valid(u, w)) { push(c, u, w, stamp[u]); return; }
  };
  // u taken into v: u's triangles across the edge die, the rest become v's.
  const collapse = (u, v) => {
    const step = steps.length;
    steps.push({ u, v });
    dieStep[u] = step; target[u] = v;
    for (const t of fans[u]) {
      if (!alive[t]) continue;
      if (hasCorner(t, v)) { alive[t] = 0; death[t] = step + 1; living--; continue; }
      for (let k = 0; k < 3; k++) if (corners[t * 3 + k] === u) corners[t * 3 + k] = v;
      fans[v].push(t);
    }
    fans[u].length = 0;
    for (let k = 0; k < 10; k++) Q[v * 10 + k] += Q[u * 10 + k];
    return step;
  };
  for (let v = 0; v < V; v++) offer(v);
  const neighbours = [];
  while (living > least && hn) {
    pop();
    const u = topU, v = topV;
    if (topS !== stamp[u] || dieStep[u] >= 0 || dieStep[v] >= 0) continue;
    if (!valid(u, v)) { offerAllowed(u, v); continue; }
    collapse(u, v);
    ring(v, neighbours, markB);
    const around = neighbours.slice();
    stamp[v]++;
    for (const w of around) stamp[w]++;
    offer(v);
    for (const w of around) offer(w);
  }
  // Where the link condition stops it short of the core, the body is in several shells (a jetty's pilings, a tower
  // apart from its church, a ship's sails apart from her hull) or has a hole through it (an arch, a cloister's garth,
  // a gunport). Then each shell but the largest is drawn in on itself and taken into the nearest point of the rest,
  // smallest first; and what is left is collapsed without the link condition, cheapest first. A collapse is a
  // simplicial map, so every edge keeps an even number of triangles: the body stays closed, and comes down to one core
  // of `least` triangles or fewer, never under four.
  const force = (u, v) => {
    // Only into a vertex still standing: a chain must never come round on itself.
    if (dieStep[u] >= 0 || dieStep[v] >= 0 || u === v) throw Error(`collapse ${u} → ${v} of a vertex already gone`);
    const step = collapse(u, v), seen = new Map();
    // Two triangles on the same corners enclose nothing: both go.
    for (const t of fans[v]) {
      if (!alive[t]) continue;
      const key = pairKey(t, v), twin = seen.get(key);
      if (twin === undefined) { seen.set(key, t); continue; }
      alive[t] = 0; alive[twin] = 0; death[t] = death[twin] = step + 1; living -= 2; seen.delete(key);
    }
  };
  const area = (t) => {
    const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3, X = position;
    const ex = X[b] - X[a], ey = X[b + 1] - X[a + 1], ez = X[b + 2] - X[a + 2], fx = X[c] - X[a], fy = X[c + 1] - X[a + 1], fz = X[c + 2] - X[a + 2];
    return 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
  };
  const shells = () => {
    const root = new Int32Array(V).map((_, v) => v), find = (v) => { while (root[v] !== v) v = root[v] = root[root[v]]; return v; };
    for (let t = 0; t < T; t++) if (alive[t]) for (let k = 1; k < 3; k++) { const a = find(corners[t * 3]), b = find(corners[t * 3 + k]); if (a !== b) root[a] = b; }
    const byRoot = new Map();
    for (let t = 0; t < T; t++) {
      if (!alive[t]) continue;
      const r = find(corners[t * 3]);
      if (!byRoot.has(r)) byRoot.set(r, { vertices: new Set(), area: 0 });
      const shell = byRoot.get(r);
      shell.area += area(t);
      for (let k = 0; k < 3; k++) shell.vertices.add(corners[t * 3 + k]);
    }
    return [...byRoot.values()].sort((a, b) => a.area - b.area);
  };
  const gap2 = (a, b) => (position[a * 3] - position[b * 3]) ** 2 + (position[a * 3 + 1] - position[b * 3 + 1]) ** 2 + (position[a * 3 + 2] - position[b * 3 + 2]) ** 2;
  if (living > least) {
    const all = shells();
    for (let i = 0; i < all.length - 1; i++) {
      // Into the shells still standing: those no smaller than it.
      const shell = all[i], rest = all.slice(i + 1).flatMap((other) => [...other.vertices]);
      let at = -1, into = -1, best = Infinity;
      for (const u of shell.vertices) for (const w of rest) { const d = gap2(u, w); if (d < best) { best = d; at = u; into = w; } }
      // Drawn in on its point nearest the rest, farthest first, then that point taken in.
      const order = [...shell.vertices].filter((u) => u !== at).sort((a, b) => gap2(b, at) - gap2(a, at));
      for (const u of order) force(u, at);
      force(at, into);
    }
  }
  const counts = new Map();
  while (living > least) {
    let pick = null;
    for (const strict of [true, false]) {
      for (let t = 0; t < T; t++) {
        if (!alive[t]) continue;
        for (let k = 0; k < 3; k++) for (const [u, v] of [[corners[t * 3 + k], corners[t * 3 + ((k + 1) % 3)]], [corners[t * 3 + ((k + 1) % 3)], corners[t * 3 + k]]]) {
          let dying = 0, flips = false;
          // What survives about v once u is taken into it, by corners: a pair on the same corners goes too.
          counts.clear();
          for (const f of fans[v]) if (alive[f] && !hasCorner(f, u)) { const key = pairKey(f, v); counts.set(key, (counts.get(key) ?? 0) + 1); }
          for (const f of fans[u]) {
            if (!alive[f]) continue;
            if (hasCorner(f, v)) { dying++; continue; }
            const key = pairKey(f, u);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            if (turn(corners[f * 3], corners[f * 3 + 1], corners[f * 3 + 2], u, v) < -0.9) flips = true;
          }
          for (const n of counts.values()) dying += n - (n % 2);
          if (living - dying < 4 || (strict && flips)) continue;
          const c = cost(u, v);
          if (!pick || c < pick[0]) pick = [c, u, v];
        }
      }
      if (pick) break;
    }
    if (!pick) break;
    force(pick[1], pick[2]);
  }
  return { dieStep, target, death, steps, living, corners, alive };
}
// Where vertex v has gone by step s.
export const ancestor = (chain, v, s) => { while (chain.dieStep[v] >= 0 && chain.dieStep[v] < s) v = chain.target[v]; return v; };

// The outline a mesh casts along each of `views` (pairs of axes across and up, and the depth axis) on a grid over
// the body: cells covered, and each cell's nearest triangle's label (-1 where none; the triangle itself, if
// `labelOf` is (t) => t). `inflate` grows the surface along its normals.
export function outline(position, normal, corners, triangles, inflate, frame, labelOf = null, views = [[0, 1, 2], [2, 1, 0], [0, 2, 1]]) {
  const { low, size, cells } = frame, result = [];
  for (const [ax, ay, az] of views) {
    const depth = new Float32Array(cells * cells).fill(Infinity), label = new Int32Array(cells * cells).fill(-1);
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

// ------------------------------------------------------------------------------------------------ voxel shells
// A far body for what moves in pieces (a ship's rigid hull and spars, and her canvas, which brails up its yard): each
// piece voxelized apart, closed over its own gaps, its surface taken by marching tetrahedra and smoothed, the pieces
// then simplified together to a base, never across a piece (each vertex keeps its piece as its region). Each base
// vertex then rides the source vertex of its own piece nearest it, so the far body moves as the source does.

// A piece's triangles (`triangles` of `index` over `position`, metres) as voxels `h` metres wide, closed over gaps of
// `close` cells and filled within, each 6-connected part of fewer than `least` voxels dropped. `away` is the outside
// grown by the closing: a voxel solid but not away was buried by it, and cannot be seen from outside.
export function voxelShell(position, index, triangles, h, close, least) {
  const P = position, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) for (let c = 0; c < 3; c++) { const v = index[t * 3 + c]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[v * 3 + k]); hi[k] = Math.max(hi[k], P[v * 3 + k]); } }
  const pad = close + 2, origin = lo.map((l) => l - pad * h), dims = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k]) / h) + 2 * pad + 1);
  const [nx, ny, nz] = dims, N = nx * ny * nz, surface = new Uint8Array(N);
  const cellOf = (x, y, z) => Math.floor((x - origin[0]) / h) + nx * (Math.floor((y - origin[1]) / h) + ny * Math.floor((z - origin[2]) / h));
  for (const t of triangles) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k] * 3);
    const longest = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]));
    const n = Math.max(1, Math.ceil(longest / (h / 3)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, r = 1 - u - w;
      surface[cellOf(r * P[a] + u * P[b] + w * P[c], r * P[a + 1] + u * P[b + 1] + w * P[c + 1], r * P[a + 2] + u * P[b + 2] + w * P[c + 2])] = 1;
    }
  }
  const strides = [1, nx, nx * ny];
  // A cube's dilation, an axis at a time, by a running count over each line.
  const dilate = (src, r) => {
    let a = src.slice(), b = new Uint8Array(N);
    if (r <= 0) return a;
    for (let axis = 0; axis < 3; axis++) {
      const len = dims[axis], stride = strides[axis], [u, w] = [0, 1, 2].filter((k) => k !== axis);
      for (let j = 0; j < dims[w]; j++) for (let i = 0; i < dims[u]; i++) {
        const start = i * strides[u] + j * strides[w];
        let count = 0;
        for (let k = 0; k < Math.min(r, len); k++) count += a[start + k * stride];
        for (let k = 0; k < len; k++) {
          if (k + r < len) count += a[start + (k + r) * stride];
          if (k - r - 1 >= 0) count -= a[start + (k - r - 1) * stride];
          b[start + k * stride] = count > 0 ? 1 : 0;
        }
      }
      [a, b] = [b, a];
    }
    return a;
  };
  const grown = dilate(surface, close), outside = new Uint8Array(N), queue = new Int32Array(N);
  let head = 0, tail = 0;
  const reach = (i) => { if (!grown[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) reach(x + nx * (y + ny * z));
  while (head < tail) {
    const i = queue[head++], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    if (x > 0) reach(i - 1); if (x < nx - 1) reach(i + 1);
    if (y > 0) reach(i - nx); if (y < ny - 1) reach(i + nx);
    if (z > 0) reach(i - nx * ny); if (z < nz - 1) reach(i + nx * ny);
  }
  // Closing: what the grown outside does not reach, with every surface voxel kept and grown by one, so a sheet is
  // three voxels thick and never touches itself only across a corner (which would open a handle in it).
  const away = dilate(outside, close), thick = dilate(surface, 1), solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = !away[i] || thick[i] ? 1 : 0;
  // Parts: 6-connected; the small ones go.
  const label = new Int32Array(N).fill(-1), sizes = [];
  for (let start = 0; start < N; start++) {
    if (!solid[start] || label[start] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    head = tail = 0;
    label[start] = id; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      size++;
      for (const [ok, j] of [[x > 0, i - 1], [x < nx - 1, i + 1], [y > 0, i - nx], [y < ny - 1, i + nx], [z > 0, i - nx * ny], [z < nz - 1, i + nx * ny]]) {
        if (ok && solid[j] && label[j] < 0) { label[j] = id; queue[tail++] = j; }
      }
    }
    sizes.push(size);
  }
  let dropped = 0;
  for (let i = 0; i < N; i++) if (solid[i] && sizes[label[i]] < least) { solid[i] = 0; dropped++; }
  const kept = sizes.filter((n) => n >= least).length;
  // Whether a point (metres) lies in a voxel the closing buried.
  const buried = (x, y, z) => { const i = cellOf(x, y, z); return solid[i] === 1 && !away[i]; };
  return { solid, away, dims, origin, h, pieces: kept, droppedPieces: sizes.length - kept, droppedVoxels: dropped, buried };
}
// The solid's surface by marching tetrahedra over the voxel centres, each cube cut into the six tetrahedra about its
// main diagonal (Kuhn's), the same in every cube, so the surface is closed and every edge has two triangles.
export function marchingTetrahedra({ solid, dims, origin, h }) {
  const [nx, ny] = dims, sxy = nx * ny, offsets = [0, 1, nx, nx + 1, sxy, sxy + 1, sxy + nx, sxy + nx + 1];
  const tets = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(([a, b]) => [0, 1 << a, (1 << a) | (1 << b), 7]);
  const vertexOf = new Map(), position = [], index = [];
  const at = (i) => [origin[0] + ((i % nx) + 0.5) * h, origin[1] + ((Math.floor(i / nx) % ny) + 0.5) * h, origin[2] + (Math.floor(i / sxy) + 0.5) * h];
  // The vertex halfway along the edge from corner ca to corner cb (ca's bits a subset of cb's) of the cube at `base`.
  const edge = (base, ca, cb) => {
    const lowCorner = (ca & cb) === ca ? ca : cb, high = lowCorner === ca ? cb : ca, i = base + offsets[lowCorner], key = i * 8 + (high ^ lowCorner);
    let v = vertexOf.get(key);
    if (v === undefined) {
      const p = at(i), q = at(base + offsets[high]);
      v = position.length / 3;
      position.push((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2);
      vertexOf.set(key, v);
    }
    return v;
  };
  const emit = (a, b, c, inward, outward) => {
    const P = position, e = [0, 1, 2].map((k) => P[b * 3 + k] - P[a * 3 + k]), f = [0, 1, 2].map((k) => P[c * 3 + k] - P[a * 3 + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
    const g = [0, 1, 2].map((k) => outward[k] - inward[k]);
    if (n[0] * g[0] + n[1] * g[1] + n[2] * g[2] >= 0) index.push(a, b, c); else index.push(a, c, b);
  };
  const corner = (base, c) => at(base + offsets[c]);
  for (let z = 0; z < dims[2] - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    const base = x + nx * (y + ny * z);
    let mask = 0;
    for (let c = 0; c < 8; c++) if (solid[base + offsets[c]]) mask |= 1 << c;
    if (mask === 0 || mask === 255) continue;
    for (const tet of tets) {
      const inside = tet.filter((c) => mask & (1 << c)), outside = tet.filter((c) => !(mask & (1 << c)));
      if (!inside.length || !outside.length) continue;
      const mean = (cs) => { const s = [0, 0, 0]; for (const c of cs) { const p = corner(base, c); for (let k = 0; k < 3; k++) s[k] += p[k] / cs.length; } return s; };
      const inward = mean(inside), outward = mean(outside);
      if (inside.length === 1) emit(edge(base, inside[0], outside[0]), edge(base, inside[0], outside[1]), edge(base, inside[0], outside[2]), inward, outward);
      else if (outside.length === 1) emit(edge(base, outside[0], inside[0]), edge(base, outside[0], inside[1]), edge(base, outside[0], inside[2]), inward, outward);
      else {
        const [i0, i1] = inside, [o0, o1] = outside, A = edge(base, i0, o0), B = edge(base, i0, o1), C = edge(base, i1, o1), D = edge(base, i1, o0);
        emit(A, B, C, inward, outward);
        emit(A, C, D, inward, outward);
      }
    }
  }
  return { position: Float32Array.from(position), index: Uint32Array.from(index) };
}
// Uniform Taubin smoothing (lambda 0.5, mu -0.53): takes the voxel lattice's steps off a closed surface without
// shrinking it.
export function taubin(position, index, rounds) {
  const V = position.length / 3, count = new Int32Array(V + 1);
  for (let i = 0; i < index.length; i++) count[index[i] + 1]++;
  for (let v = 0; v < V; v++) count[v + 1] += count[v];
  const fill = count.slice(0, V), next = new Int32Array(index.length);
  // Each half-edge a -> b gives a its neighbour b; on a closed surface, each neighbour once.
  for (let t = 0; t < index.length; t += 3) for (let k = 0; k < 3; k++) next[fill[index[t + k]]++] = index[t + ((k + 1) % 3)];
  const out = Float32Array.from(position), mean = new Float32Array(V * 3);
  for (let r = 0; r < rounds * 2; r++) {
    const f = r % 2 ? -0.53 : 0.5;
    mean.fill(0);
    for (let v = 0; v < V; v++) {
      const n = count[v + 1] - count[v];
      if (!n) continue;
      for (let i = count[v]; i < count[v + 1]; i++) for (let k = 0; k < 3; k++) mean[v * 3 + k] += out[next[i] * 3 + k] / n;
    }
    for (let v = 0; v < V; v++) if (count[v + 1] > count[v]) for (let k = 0; k < 3; k++) out[v * 3 + k] += f * (mean[v * 3 + k] - out[v * 3 + k]);
  }
  return out;
}
// The nearest of a set of points (`members` of `position`) to p, by a uniform grid of cells `cell` metres wide.
export function pointGrid(position, members, cell) {
  const buckets = new Map(), key = (x, y, z) => ((x + 4096) * 8192 + (y + 4096)) * 8192 + (z + 4096);
  for (const v of members) {
    const k = key(Math.floor(position[v * 3] / cell), Math.floor(position[v * 3 + 1] / cell), Math.floor(position[v * 3 + 2] / cell));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(v);
  }
  return (px, py, pz) => {
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell);
    let best = -1, bestD = Infinity;
    for (let ring = 0; ring < 4096; ring++) {
      if (best >= 0 && (ring - 1) * cell > Math.sqrt(bestD)) break;
      for (let x = cx - ring; x <= cx + ring; x++) for (let y = cy - ring; y <= cy + ring; y++) for (let z = cz - ring; z <= cz + ring; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue;
        for (const v of buckets.get(key(x, y, z)) ?? []) {
          const d = (position[v * 3] - px) ** 2 + (position[v * 3 + 1] - py) ** 2 + (position[v * 3 + 2] - pz) ** 2;
          if (d < bestD) { bestD = d; best = v; }
        }
      }
    }
    return best;
  };
}
// The pieces' far body before its chain: `pieces` is [{ triangles, close, name }] of the source (`position` in metres,
// `index`), each voxelized `h` metres wide and closed over `close` metres, parts under `least` voxels dropped. The
// surfaces, smoothed by `smooth` Taubin rounds, are simplified together to `base` triangles with no triangle turned
// further than `fold` allows, never across a piece. Returns the base (its vertices' piece in `piece`, area-weighted
// normals), each piece's voxels and census, and `rides`: each base vertex's nearest source vertex of its own piece.
export function voxelPieces(position, index, pieces, { h, least = 27, smooth = 8, base, fold = () => 0.5, lap = () => {} }) {
  const merged = { position: [], index: [], piece: [] }, out = [];
  pieces.forEach((piece, p) => {
    if (!piece.triangles.length) return;
    const close = Math.max(1, Math.round(piece.close / h)), voxels = voxelShell(position, index, piece.triangles, h, close, least), surface = marchingTetrahedra(voxels);
    const census = edgeCensus(surface.index);
    if (census.boundary || census.nonManifold) throw Error(`The voxel surface of ${piece.name ?? `piece ${p}`} is open: ${JSON.stringify(census)}`);
    const at = merged.position.length / 3;
    for (const x of surface.position) merged.position.push(x);
    for (const v of surface.index) merged.index.push(v + at);
    for (let v = 0; v < surface.position.length / 3; v++) merged.piece.push(p);
    const genus = (2 * voxels.pieces - census.euler) / 2;
    out.push({ piece: p, voxels, close: close * h, count: voxels.pieces, genus, surface: surface.index.length / 3 });
    lap(`${piece.name ?? `piece ${p}`}: voxels ${voxels.dims.join('x')} at ${(h * 100).toFixed(1)} cm closed over ${(close * h * 100).toFixed(0)} cm, ${voxels.pieces} parts of genus ${genus} in all, ${surface.index.length / 3} triangles`);
  });
  const surfaceIndex = Uint32Array.from(merged.index), smoothed = taubin(Float32Array.from(merged.position), surfaceIndex, smooth), mergedPiece = Uint8Array.from(merged.piece);
  const reduced = collapseChain(smoothed, surfaceIndex, base, { region: mergedPiece, fold }), kept = [];
  for (let t = 0; t < reduced.alive.length; t++) if (reduced.alive[t]) kept.push(reduced.corners[t * 3], reduced.corners[t * 3 + 1], reduced.corners[t * 3 + 2]);
  const used = [...new Set(kept)], local = new Map(used.map((v, i) => [v, i])), V = used.length, T = kept.length / 3;
  const baseIndex = Uint32Array.from(kept, (v) => local.get(v)), basePosition = new Float32Array(V * 3), piece = Uint8Array.from(used, (v) => mergedPiece[v]);
  used.forEach((v, i) => basePosition.set(smoothed.subarray(v * 3, v * 3 + 3), i * 3));
  const census = edgeCensus(baseIndex);
  if (census.boundary || census.nonManifold) throw Error(`The far body's base is open: ${JSON.stringify(census)}`);
  const { normal } = normalsOf(basePosition, baseIndex);
  // Each base vertex rides the nearest source vertex of its own piece.
  const rides = new Uint32Array(V), sourceVertices = pieces.map(() => []), baseVertices = pieces.map(() => []);
  pieces.forEach((p, k) => {
    const referenced = new Uint8Array(position.length / 3);
    for (const t of p.triangles) for (let c = 0; c < 3; c++) referenced[index[t * 3 + c]] = 1;
    for (let v = 0; v < referenced.length; v++) if (referenced[v]) sourceVertices[k].push(v);
  });
  for (let i = 0; i < V; i++) baseVertices[piece[i]].push(i);
  pieces.forEach((_, k) => {
    if (!baseVertices[k].length) return;
    const nearest = pointGrid(position, sourceVertices[k], 0.25);
    for (const i of baseVertices[k]) rides[i] = nearest(basePosition[i * 3], basePosition[i * 3 + 1], basePosition[i * 3 + 2]);
  });
  return { position: basePosition, index: baseIndex, normal, piece, rides, pieces: out, census, sourceVertices, baseVertices };
}

// The far body's cells: about this many across a type's longest side, within these sizes (metres).
const WRAP_CELLS = 80, WRAP_FINEST = 0.04, WRAP_COARSEST = 0.3;
// A far body that will not simplify below this many triangles and stay manifold is wrapped again in coarser cells.
const WRAP_MOST_TRIANGLES = 4096;
// Gaps up to about twice this many cells wide are bridged before the surface is taken.
const WRAP_CLOSING = 2;
// The far body's core: it collapses until no more than this many triangles are left, one closed body (a closed body
// needs four), whatever shells or holes it began with (collapseChain).
const CHAIN_LEAST_TRIANGLES = 6;
// What a far-body triangle never wears: glass, the dark of a recess, iron. They are too small to be seen there.
const APERTURES = new Set([14, 16, 18]);
const ROOFS = new Set([13, 15]);

// ------------------------------------------------------------------------------------------------ the drawn mesh
// The drawn mesh welded where corners agree in everything and lie in one part.
function weldDrawn(type) {
  const F = type.vertices, T = type.triangles, map = new Map(), position = [], normal = [], kind = [], part = [], index = new Uint32Array(T * 3);
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const at = (t * 3 + k) * 8, key = `${Array.from(F.subarray(at, at + 8)).join(',')}|${type.parts[t]}`;
    let v = map.get(key);
    if (v === undefined) {
      v = position.length / 3;
      map.set(key, v);
      position.push(F[at], F[at + 1], F[at + 2]); normal.push(F[at + 3], F[at + 4], F[at + 5]); kind.push(F[at + 6], F[at + 7]); part.push(type.parts[t]);
    }
    index[t * 3 + k] = v;
  }
  return { position: Float32Array.from(position), normal: Float32Array.from(normal), kind: Float32Array.from(kind), part: Uint32Array.from(part), index, count: position.length / 3 };
}

// ------------------------------------------------------------------------------------------------ clusters
async function bakeClusters(w) {
  const dag = await buildDag({
    id: 0, bark: { pos: w.position, nrm: w.normal, uv: w.kind, idx: w.index },
    leaves: { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), vpl: 8 }, barkParts: w.part,
  });
  const count = dag.meta.length / 4, records = [];
  for (let c = 0; c < count; c++) {
    const r = dag.rec.subarray(c * 16, c * 16 + 16), first = dag.meta[c * 4], parent = dag.groups[c * 2 + 1];
    records.push({
      cluster: c, lod: Array.from(r.subarray(0, 4)), parentLod: Array.from(r.subarray(parent >= 0 ? 4 : 0, parent >= 0 ? 8 : 4)), cull: Array.from(r.subarray(8, 12)),
      error: r[12], parentError: parent >= 0 ? r[13] : Infinity, first, triangles: dag.meta[c * 4 + 1], level: dag.meta[c * 4 + 2], part: w.part[dag.idx[first]],
    });
  }
  // Coarsest parent first: what a building can draw at its nearest point is then a prefix.
  records.sort((p, q) => q.parentError - p.parentError || q.error - p.error || p.cluster - q.cluster);
  const local = new Int32Array(w.count).fill(-1), order = [], indices = [];
  for (const record of records) {
    const at = record.first;
    record.first = indices.length;
    for (let i = 0; i < record.triangles * 3; i++) {
      const v = dag.idx[at + i];
      if (local[v] < 0) { local[v] = order.length; order.push(v); }
      indices.push(local[v]);
    }
  }
  const finest = records.filter((r) => r.level === 0).reduce((n, r) => n + r.triangles, 0);
  return { records, order, indices, count, levels: dag.stats.barkLevels, roots: dag.stats.barkRoots, finestTriangles: finest, rootError: Math.max(...records.map((r) => r.error)) };
}

// ------------------------------------------------------------------------------------------------ the wrap
// The type's outside as a closed, manifold surface of grid faces. `exterior` says which cells were reachable from
// outside before any gap was bridged: what lies by them can be seen.
function wrap(type, coarser = 1) {
  const F = type.vertices, T = type.triangles, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < F.length; at += 8) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], F[at + k]); hi[k] = Math.max(hi[k], F[at + k]); }
  const extent = Math.max(...hi.map((v, k) => v - lo[k])), h = Math.min(WRAP_COARSEST, Math.max(WRAP_FINEST, extent / WRAP_CELLS)) * coarser, pad = WRAP_CLOSING + 3;
  const n = [0, 1, 2].map((k) => Math.ceil((hi[k] - lo[k]) / h) + 2 * pad + 1), origin = lo.map((v) => v - pad * h), N = n[0] * n[1] * n[2];
  const cell = (i, j, k) => (k * n[1] + j) * n[0] + i;
  const surface = new Uint8Array(N);
  for (let t = 0; t < T; t++) {
    const p = [0, 1, 2].map((c) => F.subarray((t * 3 + c) * 8, (t * 3 + c) * 8 + 3));
    const long = Math.max(Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]), Math.hypot(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]), Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]));
    const m = Math.max(1, Math.ceil(long / (h * 0.35)));
    for (let a = 0; a <= m; a++) for (let b = 0; b <= m - a; b++) {
      const s = a / m, u = b / m, ijk = [0, 1, 2].map((k) => Math.floor((p[0][k] + (p[1][k] - p[0][k]) * s + (p[2][k] - p[0][k]) * u - origin[k]) / h));
      surface[cell(ijk[0], ijk[1], ijk[2])] = 1;
    }
  }
  const queue = new Int32Array(N), steps = [1, -1, n[0], -n[0], n[0] * n[1], -n[0] * n[1]];
  const onBorder = (c) => { const i = c % n[0], j = Math.floor(c / n[0]) % n[1], k = Math.floor(c / (n[0] * n[1])); return i === 0 || j === 0 || k === 0 || i === n[0] - 1 || j === n[1] - 1 || k === n[2] - 1; };
  // The empty cells reachable from the grid's border through empty cells, face to face.
  const flood = (solid) => {
    const outside = new Uint8Array(N);
    let head = 0, tail = 0;
    const visit = (e) => { if (!solid[e] && !outside[e]) { outside[e] = 1; queue[tail++] = e; } };
    for (let c = 0; c < N; c++) if (!solid[c] && onBorder(c)) { outside[c] = 1; queue[tail++] = c; }
    while (head < tail) {
      const c = queue[head++], i = c % n[0], j = Math.floor(c / n[0]) % n[1], k = Math.floor(c / (n[0] * n[1]));
      if (i > 0) visit(c - 1); if (i < n[0] - 1) visit(c + 1);
      if (j > 0) visit(c - n[0]); if (j < n[1] - 1) visit(c + n[0]);
      if (k > 0) visit(c - n[0] * n[1]); if (k < n[2] - 1) visit(c + n[0] * n[1]);
    }
    return outside;
  };
  const exterior = flood(surface), solid = new Uint8Array(N);
  for (let c = 0; c < N; c++) solid[c] = surface[c] || !exterior[c] ? 1 : 0;
  // Close: dilate, then erode, by the cross of the six face neighbours, WRAP_CLOSING times each.
  const inner = (c) => !onBorder(c);
  for (let r = 0; r < WRAP_CLOSING; r++) {
    const was = solid.slice();
    for (let c = 0; c < N; c++) if (!was[c] && inner(c)) for (const d of steps) if (was[c + d]) { solid[c] = 1; break; }
  }
  for (let r = 0; r < WRAP_CLOSING; r++) {
    const was = solid.slice();
    for (let c = 0; c < N; c++) if (was[c]) { if (!inner(c)) { solid[c] = 0; continue; } for (const d of steps) if (!was[c + d]) { solid[c] = 0; break; } }
  }
  for (let c = 0; c < N; c++) if (surface[c]) solid[c] = 1;
  const outside = flood(solid);
  for (let c = 0; c < N; c++) if (!outside[c]) solid[c] = 1;
  // Well-composed (Latecki): no two cells that meet only along an edge or at a corner without a third between them,
  // in either the solid or the space round it. Only cells are added, so it ends; its faces are then a manifold.
  let added = 0;
  for (let round = 0, changed = true; changed && round < 256; round++) {
    changed = false;
    for (let k = 0; k < n[2] - 1; k++) for (let j = 0; j < n[1] - 1; j++) for (let i = 0; i < n[0] - 1; i++) {
      const at = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => cell(i + (b & 1), j + ((b >> 1) & 1), k + ((b >> 2) & 1)));
      // Each 2x2 square through this block's lower corner, one to an axis.
      for (const square of [[0, 1, 2, 3], [0, 1, 4, 5], [0, 2, 4, 6]]) {
        const [a, b, c, d] = square.map((q) => at[q]);
        if (solid[a] && solid[d] && !solid[b] && !solid[c]) { solid[b] = 1; changed = true; added++; }
        else if (solid[b] && solid[c] && !solid[a] && !solid[d]) { solid[a] = 1; changed = true; added++; }
      }
      let filled = 0, mask = 0;
      for (let b = 0; b < 8; b++) if (solid[at[b]]) { filled++; mask |= 1 << b; }
      if (filled === 2 || filled === 6) {
        const set = filled === 2 ? mask : ~mask & 255;
        for (let b = 0; b < 8; b++) if ((set >> b) & 1 && (set >> (b ^ 7)) & 1) {
          // Two cells meeting at a corner alone: fill one between them. Two holes so: fill one of them.
          const fill = filled === 2 ? at[b ^ 1] : at[b];
          if (!solid[fill]) { solid[fill] = 1; changed = true; added++; }
          break;
        }
      }
    }
  }
  // The surface: every face between a solid cell and an empty one, wound outward.
  const corners = new Map(), position = [], index = [];
  const corner = (i, j, k) => {
    const key = (k * (n[1] + 1) + j) * (n[0] + 1) + i;
    let v = corners.get(key);
    if (v === undefined) { v = position.length / 3; corners.set(key, v); position.push(origin[0] + i * h, origin[1] + j * h, origin[2] + k * h); }
    return v;
  };
  for (let k = 0; k < n[2]; k++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    if (!solid[cell(i, j, k)]) continue;
    const ijk = [i, j, k];
    for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
      const m = ijk.slice(); m[a] += s;
      if (m[a] >= 0 && m[a] < n[a] && solid[cell(m[0], m[1], m[2])]) continue;
      const u = (a + 1) % 3, v = (a + 2) % 3, q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([du, dv]) => { const c = ijk.slice(); c[a] += s > 0 ? 1 : 0; c[u] += du; c[v] += dv; return corner(c[0], c[1], c[2]); });
      if (s > 0) index.push(q[0], q[1], q[2], q[0], q[2], q[3]); else index.push(q[0], q[2], q[1], q[0], q[3], q[2]);
    }
  }
  const census = edgeCensus(index);
  if (census.boundary || census.nonManifold) throw Error(`${type.name}: the wrap is not closed and manifold (${JSON.stringify(census)})`);
  const exteriorAt = (x, y, z) => {
    const i = Math.floor((x - origin[0]) / h), j = Math.floor((y - origin[1]) / h), k = Math.floor((z - origin[2]) / h);
    for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj, c = k + dk;
      if (a < 0 || b < 0 || c < 0 || a >= n[0] || b >= n[1] || c >= n[2] || exterior[cell(a, b, c)]) return true;
    }
    return false;
  };
  return { position: Float32Array.from(position), index: Uint32Array.from(index), h, cells: n, added, exteriorAt };
}

// The wrap simplified within as much of a cell as leaves it closed and manifold: the simplifier keeps neither
// promise, so it is asked for less and less until it keeps both.
function simplifyWrap(name, w) {
  for (let error = w.h; error > w.h / 16; error *= 0.8) {
    const [index] = MeshoptSimplifier.simplify(w.index, w.position, 3, 12, error, ['ErrorAbsolute']);
    const census = edgeCensus(index);
    if (census.boundary || census.nonManifold || index.length < 12) continue;
    const used = [...new Set(index)].sort((a, b) => a - b), local = new Map(used.map((v, i) => [v, i])), position = new Float32Array(used.length * 3);
    used.forEach((v, i) => position.set(w.position.subarray(v * 3, v * 3 + 3), i * 3));
    return { position, index: Uint32Array.from(index, (v) => local.get(v)), error, census };
  }
  throw Error(`${name}: the wrap would not simplify and stay manifold`);
}

// Area-weighted vertex normals and each triangle's own.
function normalsOf(position, index) {
  const V = position.length / 3, T = index.length / 3, normal = new Float32Array(V * 3), face = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k] * 3), e = [0, 1, 2].map((k) => position[b + k] - position[a + k]), f = [0, 1, 2].map((k) => position[c + k] - position[a + k]);
    const n = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]], l = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) { face[t * 3 + k] = n[k] / l; for (const v of [a, b, c]) normal[v + k] += n[k]; }
  }
  for (let v = 0; v < V; v++) { const l = Math.hypot(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]) || 1; for (let k = 0; k < 3; k++) normal[v * 3 + k] /= l; }
  return { normal, face };
}

// ------------------------------------------------------------------------------------------------ far body
function bakeFar(type, welded) {
  let wrapped, base;
  if (type.closed) {
    // A body closed in itself (a rod, say), its corners joined where they meet whatever their normals, is its own
    // far base, exactly: nothing is wrapped round it, which at the wrap's finest cells would be coarser than it is.
    const at = new Map(), position = [], index = new Uint32Array(welded.index.length);
    welded.index.forEach((v, i) => {
      const p = welded.position.subarray(v * 3, v * 3 + 3), key = p.join(',');
      let u = at.get(key);
      if (u === undefined) { u = position.length / 3; at.set(key, u); position.push(...p); }
      index[i] = u;
    });
    const census = edgeCensus(index);
    if (census.boundary || census.nonManifold || census.euler !== 2) throw Error(`${type.name}: said to be closed, it is not`);
    base = { position: Float32Array.from(position), index, error: 0, census };
    wrapped = { h: 0, cells: [0, 0, 0], added: 0, index, exteriorAt: () => true };
  }
  // A wrap the simplifier cannot bring down and keep manifold is taken again in coarser cells.
  else for (let coarser = 1; ; coarser *= 1.5) {
    try { wrapped = wrap(type, coarser); base = simplifyWrap(type.name, wrapped); } catch (error) { if (coarser > 5) throw error; continue; }
    if (base.index.length / 3 <= WRAP_MOST_TRIANGLES || coarser > 5) break;
  }
  const position = base.position, index = base.index;
  const V = position.length / 3, T = index.length / 3, { normal, face } = normalsOf(position, index), allBase = Array.from({ length: T }, (_, t) => t);
  // How far the wrap is from what it stands for, both ways: each of its points from the type's nearest surface, and
  // each point of the type that can be seen from outside (a vertex, a triangle's middle) from the wrap.
  const source = triangleGrid(welded.position, welded.index, Math.max(wrapped.h * 4, 0.5)), wrapGrid = triangleGrid(position, index, Math.max(wrapped.h * 4, 0.5));
  let outward = 0, inward = 0;
  for (let v = 0; v < V; v++) { source(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]); outward = Math.max(outward, Math.sqrt(closest[0])); }
  const seen = (x, y, z) => { if (!wrapped.exteriorAt(x, y, z)) return; wrapGrid(x, y, z); inward = Math.max(inward, Math.sqrt(closest[0])); };
  for (let v = 0; v < welded.count; v++) seen(welded.position[v * 3], welded.position[v * 3 + 1], welded.position[v * 3 + 2]);
  for (let t = 0; t < welded.index.length / 3; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => welded.index[t * 3 + k] * 3), P = welded.position;
    seen((P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3);
  }
  const baseError = Math.max(outward, inward, base.error);
  // Each wrap triangle wears the kind of the nearest surface of the type that is not glass, a recess or iron.
  const solidSurface = (t) => !APERTURES.has(Math.floor(welded.kind[welded.index[t * 3] * 2] + 0.01));
  const kinds = new Float32Array(T * 2);
  for (let t = 0; t < T; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k] * 3);
    const found = source((position[a] + position[b] + position[c]) / 3, (position[a + 1] + position[b + 1] + position[c + 1]) / 3, (position[a + 2] + position[b + 2] + position[c + 2]) / 3, solidSurface);
    const v = found >= 0 ? welded.index[found * 3] : 0;
    kinds[t * 2] = welded.kind[v * 2]; kinds[t * 2 + 1] = welded.kind[v * 2 + 1];
  }

  const chain = collapseChain(position, index, CHAIN_LEAST_TRIANGLES), S = chain.steps.length;
  let depth = 0;
  for (let v = 0; v < V; v++) { let d = 0; for (let w = v; chain.dieStep[w] >= 0; w = chain.target[w]) d++; depth = Math.max(depth, d); }
  // The GPU follows a vertex's collapses only so far (js/wgsl/continuum-cut.js continuumAncestor).
  if (depth > CONTINUUM_HOPS) throw Error(`${type.name}: a far-body vertex collapses ${depth} times, past the GPU's ${CONTINUUM_HOPS}`);
  // Errors and inflation, measured at every eighth step and the last few, between them taken in proportion.
  const baseFans = Array.from({ length: V }, () => []);
  allBase.forEach((t) => { for (let k = 0; k < 3; k++) baseFans[index[t * 3 + k]].push(t); });
  const low = [0, 1, 2].map((k) => Math.min(...Array.from({ length: V }, (_, i) => position[i * 3 + k]))), high = [0, 1, 2].map((k) => Math.max(...Array.from({ length: V }, (_, i) => position[i * 3 + k])));
  const span = Math.max(...high.map((v, k) => v - low[k])), margin = span * 0.15;
  const frame = { low: low.map((v) => v - margin), size: span + 2 * margin, cells: 128 };
  const roofOf = (t) => (ROOFS.has(Math.floor(kinds[t * 2] + 0.01)) ? 1 : 0);
  const baseOutline = outline(position, normal, index, allBase, 0, frame, roofOf);
  const wanted = baseOutline.reduce((n, view) => n + view.covered, 0);
  const near = (px, py, pz, list, corners) => {
    let best = Infinity;
    for (const t of list) {
      const a = corners[t * 3] * 3, b = corners[t * 3 + 1] * 3, c = corners[t * 3 + 2] * 3;
      closestOnTriangle(px, py, pz, position[a], position[a + 1], position[a + 2], position[b], position[b + 1], position[b + 2], position[c], position[c + 1], position[c + 2]);
      best = Math.min(best, closest[0]);
    }
    return Math.sqrt(best);
  };
  const measured = new Map(), sampled = new Set([0, S]);
  for (let s = 0; s <= S; s += 8) sampled.add(s);
  for (let s = Math.max(0, S - 48); s <= S; s++) sampled.add(s);
  const stepCorners = new Uint32Array(T * 3);
  for (const s of [...sampled].sort((p, q) => p - q)) {
    const living = allBase.filter((t) => chain.death[t] < 0 || chain.death[t] > s);
    for (const t of living) for (let k = 0; k < 3; k++) stepCorners[t * 3 + k] = ancestor(chain, index[t * 3 + k], s);
    const fans = new Map();
    for (const t of living) for (let k = 0; k < 3; k++) { const a = stepCorners[t * 3 + k]; if (!fans.has(a)) fans.set(a, []); fans.get(a).push(t); }
    let error = 0;
    // Each wrap point against the triangles of the vertex it has collapsed into.
    for (let v = 0; v < V; v++) { const list = fans.get(ancestor(chain, v, s)); if (list) error = Math.max(error, near(position[v * 3], position[v * 3 + 1], position[v * 3 + 2], list, stepCorners)); }
    // Each surviving triangle's middle against the wrap it has replaced.
    const members = new Map();
    for (let v = 0; v < V; v++) { const a = ancestor(chain, v, s); if (!members.has(a)) members.set(a, []); members.get(a).push(v); }
    for (const t of living) {
      const [a, b, c] = [0, 1, 2].map((k) => stepCorners[t * 3 + k]), candidates = new Set();
      for (const corner of [a, b, c]) for (const m of members.get(corner) ?? []) for (const u of baseFans[m]) candidates.add(u);
      error = Math.max(error, near((position[a * 3] + position[b * 3] + position[c * 3]) / 3, (position[a * 3 + 1] + position[b * 3 + 1] + position[c * 3 + 1]) / 3, (position[a * 3 + 2] + position[b * 3 + 2] + position[c * 3 + 2]) / 3, [...candidates], index));
    }
    // How far along its normals the surface must grow to cast the wrap's outline again.
    let inflate = 0;
    const cast = (d) => outline(position, normal, stepCorners, living, d, frame).reduce((n, view) => n + view.covered, 0);
    if (s > 0 && cast(0) < wanted) {
      let lo = 0, hi = span * 0.1;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (cast(mid) < wanted) lo = mid; else hi = mid; }
      inflate = (lo + hi) / 2;
    }
    measured.set(s, { error: baseError + error, inflate });
  }
  const keys = [...measured.keys()].sort((p, q) => p - q), errors = new Float32Array(S + 1), inflates = new Float32Array(S + 1);
  for (let i = 0; i < keys.length; i++) {
    const s0 = keys[i], s1 = keys[Math.min(i + 1, keys.length - 1)], m0 = measured.get(s0), m1 = measured.get(s1);
    for (let s = s0; s <= s1; s++) {
      const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      errors[s] = m0.error + (m1.error - m0.error) * f;
      inflates[s] = m0.inflate + (m1.inflate - m0.inflate) * f;
    }
  }
  // Rising strictly, so the morph search always has room between one step and the next: by a few float32 ulps, not a
  // proportion, which over thousands of steps would compound into metres.
  for (let s = 1; s <= S; s++) errors[s] = Math.max(errors[s], errors[s - 1] * (1 + 4e-6) + 1e-7);
  if (!(errors[S] < 2 * span)) throw Error(`${type.name}: the far body's last step is ${errors[S]} m in error`);
  // Triangles in order of death, latest first: those alive at step s are a prefix.
  const order = allBase.slice().sort((p, q) => (chain.death[q] < 0 ? Infinity : chain.death[q]) - (chain.death[p] < 0 ? Infinity : chain.death[p]));
  const steps = new Uint32Array((S + 1) * CONTINUUM_STEP_WORDS), stepFloats = new Float32Array(steps.buffer);
  const dying = new Int32Array(S + 2);
  for (let t = 0; t < T; t++) if (chain.death[t] >= 0) dying[chain.death[t]]++;
  for (let s = 0, alive = T; s <= S; s++) {
    alive -= dying[s];
    steps[s * CONTINUUM_STEP_WORDS] = alive;
    stepFloats[s * CONTINUUM_STEP_WORDS + 1] = errors[s];
    stepFloats[s * CONTINUUM_STEP_WORDS + 2] = inflates[s];
  }
  if (steps[S * CONTINUUM_STEP_WORDS] !== order.filter((t) => chain.death[t] < 0 || chain.death[t] > S).length) throw Error('Chain prefix counts disagree');

  // The splat: the wrap above the type's floor, front and side, with the outline's area and its roof's share.
  const top = high[1], floor = Math.max(low[1], 0), ry = Math.max((top - floor) / 2, 0.05), cellArea = (frame.size / frame.cells) ** 2;
  let area = 0, roofCells = 0, cellsAbove = 0;
  for (const view of baseOutline.slice(0, 2)) {
    for (let at = 0; at < view.label.length; at++) {
      if (view.label[at] < 0) continue;
      const y = frame.low[1] + ((Math.floor(at / frame.cells) + 0.5) / frame.cells) * frame.size;
      if (y < floor) continue;
      cellsAbove++; roofCells += view.label[at];
    }
  }
  area = (cellsAbove / 2) * cellArea;
  // The walls' and the roof's kinds: the largest triangle of the material that covers most of each.
  const tally = (wanted) => {
    const byMaterial = new Map();
    for (let t = 0; t < T; t++) {
      if (ROOFS.has(Math.floor(kinds[t * 2] + 0.01)) !== wanted) continue;
      const [a, b, c] = [0, 1, 2].map((k) => index[t * 3 + k]);
      if (Math.max(position[a * 3 + 1], position[b * 3 + 1], position[c * 3 + 1]) < floor) continue;
      const m = Math.floor(kinds[t * 2] + 0.01), size = surfaceArea(index, [t], position), entry = byMaterial.get(m) ?? { area: 0, largest: 0, kind: [kinds[t * 2], kinds[t * 2 + 1]] };
      entry.area += size;
      if (size > entry.largest) { entry.largest = size; entry.kind = [kinds[t * 2], kinds[t * 2 + 1]]; }
      byMaterial.set(m, entry);
    }
    return [...byMaterial.values()].sort((p, q) => q.area - p.area)[0]?.kind ?? null;
  };
  const wallKind = tally(false), roofKind = tally(true);
  const splat = {
    centre: [(low[0] + high[0]) / 2, (top + floor) / 2, (low[2] + high[2]) / 2].map((v) => +v.toFixed(4)), ry: +ry.toFixed(4), rx: +Math.max(area / (Math.PI * ry), 0.05).toFixed(4),
    roofShare: +(roofKind && cellsAbove ? roofCells / cellsAbove : 0).toFixed(4), wallKind: (wallKind ?? roofKind).map((v) => +v.toFixed(5)), roofKind: (roofKind ?? wallKind).map((v) => +v.toFixed(5)),
  };
  return {
    position, normal, index, kinds, chain, steps, order, splat, face, baseError,
    stats: {
      cell: +wrapped.h.toFixed(4), cells: wrapped.cells, wellComposedCells: wrapped.added, wrapTriangles: wrapped.index.length / 3, baseTriangles: T, baseVertices: V,
      baseError: +baseError.toFixed(4), outward: +outward.toFixed(4), inward: +inward.toFixed(4), simplifyError: +base.error.toFixed(4),
      steps: S, coreTriangles: steps[S * CONTINUUM_STEP_WORDS], depth, errorRange: [+errors[0].toFixed(4), +errors[S].toFixed(4)], inflateMax: +Math.max(...inflates).toFixed(4),
    },
  };
}


// One body baked: its drawn mesh welded, its clusters, its far body and splat, and the step from which the far body
// takes over (the first no heavier than the clusters' coarsest cut, their roots; finer steps are the clusters').
export async function bakeContinuumBody(body) {
  await MeshoptSimplifier.ready;
  const welded = weldDrawn(body), clusters = await bakeClusters(welded), far = bakeFar(body, welded);
  const rootTriangles = clusters.records.reduce((n, record) => n + (record.parentError === Infinity ? record.triangles : 0), 0);
  far.farFirst = 0;
  while (far.farFirst < far.chain.steps.length && far.steps[far.farFirst * CONTINUUM_STEP_WORDS] > rootTriangles) far.farFirst++;
  Object.assign(far.stats, { rootTriangles, farFirst: far.farFirst, farFirstTriangles: far.steps[far.farFirst * CONTINUUM_STEP_WORDS], handoffError: +new Float32Array(far.steps.buffer)[far.farFirst * CONTINUUM_STEP_WORDS + 1].toFixed(4) });
  return { welded, clusters, far };
}

// A struck building's pieces (js/building-fracture.js), each piece a part: welded and clustered like any body, never
// simplified across a piece, and given no far body, for a broken instance is drawn as clusters alone.
export async function bakeContinuumPiecesBody(body) {
  await MeshoptSimplifier.ready;
  const welded = weldDrawn(body);
  return { welded, clusters: await bakeClusters(welded) };
}

export { weldDrawn, bakeClusters, wrap, simplifyWrap, bakeFar };
