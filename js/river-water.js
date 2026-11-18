// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The water of a river port. A tidal river stands at the sea's own level, but the elevation survey reads its surface
// a metre or a few above the datum (the Guadalquivir at Seville's Arenal, the Douro at Porto's Ribeira), so ground
// that holds a river and no sea read as all land, and the port was moved to the nearest coast, tens of kilometres
// from its city. Here such a ground's water is read where it is: the river is the low ground that runs from one edge
// of the ground to another at the least height, within a tide's reach of the datum; it is water as far as it lies
// level with its own floor nearby, which may rise a little upstream.

// The highest a tidal river's surface may read above the datum and still be the sea's water.
export const RIVER_TIDE_METRES = 6;
// How far above the level it crosses at the river's low ground may run on (its reaches rise upstream), how far above
// its own floor nearby a reading may lie and still be water, the reach of that floor, and the most of a ground a
// river may cover (more is a flat plain, not a river).
export const RIVER_READING = Object.freeze({ rise: 3, within: 1, reach: 160, most: 0.35 });

// The least (or greatest) of each cell and its eight neighbours.
function riverNeighbourhood(src, n, greatest) {
  const across = new Float32Array(n * n), out = new Float32Array(n * n), pick = greatest ? Math.max : Math.min;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    let v = src[k];
    if (i > 0) v = pick(v, src[k - 1]);
    if (i < n - 1) v = pick(v, src[k + 1]);
    across[k] = v;
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    let v = across[k];
    if (j > 0) v = pick(v, across[k - n]);
    if (j < n - 1) v = pick(v, across[k + n]);
    out[k] = v;
  }
  return out;
}

// `dem` is a square of `n` by `n` surveyed heights `step` metres apart, row by row from the north. Returns null where
// no river crosses the ground within a tide's reach of the datum, or {level, count, water}: the height at which the
// river's low ground first runs from edge to edge, how many cells are its water, and a mask of them.
export function readCrossingRiver(dem, n, step, { tide = RIVER_TIDE_METRES, rise = RIVER_READING.rise, within = RIVER_READING.within, reach = RIVER_READING.reach, most = RIVER_READING.most } = {}) {
  const N = n * n;
  // A bridge or a causeway the survey reads across the water is narrower than three cells: opened out of it.
  const surface = riverNeighbourhood(riverNeighbourhood(dem, n, false), n, true);
  // Low ground joined cell by cell from the lowest, until one body of it touches two edges of the ground.
  const order = new Uint32Array(N);
  for (let k = 0; k < N; k++) order[k] = k;
  order.sort((p, q) => surface[p] - surface[q]);
  const parent = new Int32Array(N).fill(-1), edges = new Uint8Array(N);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  let level = Infinity, root = -1;
  for (let o = 0; o < N && root < 0; o++) {
    const k = order[o];
    if (!(surface[k] <= tide)) break;
    const i = k % n, j = (k / n) | 0;
    parent[k] = k;
    edges[k] = (j === 0 ? 1 : 0) | (i === n - 1 ? 2 : 0) | (j === n - 1 ? 4 : 0) | (i === 0 ? 8 : 0);
    for (const q of [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, j > 0 ? k - n : -1, j < n - 1 ? k + n : -1]) {
      if (q < 0 || parent[q] < 0) continue;
      const a = find(k), b = find(q);
      if (a !== b) { parent[b] = a; edges[a] |= edges[b]; }
    }
    const r = find(k);
    if ((edges[r] & (edges[r] - 1)) !== 0) { level = surface[k]; root = r; }
  }
  if (root < 0) return null;
  // The river's low ground: that body, and all joined to it a little above the level it crossed at.
  const channel = new Uint8Array(N), queue = [];
  for (let k = 0; k < N; k++) if (parent[k] >= 0 && find(k) === root) { channel[k] = 1; queue.push(k); }
  for (let h = 0; h < queue.length; h++) {
    const k = queue[h], i = k % n, j = (k / n) | 0;
    for (const q of [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, j > 0 ? k - n : -1, j < n - 1 ? k + n : -1]) {
      if (q < 0 || channel[q] || !(surface[q] <= level + rise)) continue;
      channel[q] = 1; queue.push(q);
    }
  }
  // Its floor nearby: the least of its low ground within reach, read through the mean of a few cells so that a lone
  // reading below the water does not set it.
  const mean = new Float32Array(N);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < n && jj < n) { sum += surface[jj * n + ii]; count++; }
    }
    mean[j * n + i] = sum / count;
  }
  const r = Math.max(1, Math.round(reach / step)), across = new Float32Array(N), floor = new Float32Array(N);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let v = Infinity;
    for (let d = Math.max(0, i - r); d <= Math.min(n - 1, i + r); d++) if (channel[j * n + d]) v = Math.min(v, mean[j * n + d]);
    across[j * n + i] = v;
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let v = Infinity;
    for (let d = Math.max(0, j - r); d <= Math.min(n - 1, j + r); d++) v = Math.min(v, across[d * n + i]);
    floor[j * n + i] = v;
  }
  const water = new Uint8Array(N);
  let count = 0;
  for (let k = 0; k < N; k++) if (channel[k] && surface[k] <= floor[k] + within) { water[k] = 1; count++; }
  return count > 0 && count <= most * N ? { level, count, water } : null;
}
