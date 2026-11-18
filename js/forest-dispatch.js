// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The forest's passes run one thread a root (or a list entry) in workgroups of 64. One dimension of a dispatch holds
// at most 65,535 workgroups, the least every device allows, so a forest of more than 4,194,240 roots spreads its
// workgroups over a second; each thread finds its own place from both. A kernel run this way names
// @builtin(num_workgroups) and takes its index as id.x+id.y*groups.x*64u, and returns past the count it serves.
export const FOREST_DISPATCH_ROW = 65535;
export const FOREST_DISPATCH_GROUP = 64;

// The workgroups, x and y, that cover this many threads.
export function forestDispatchSize(threads) {
  const groups = Math.ceil(Math.max(0, threads) / FOREST_DISPATCH_GROUP);
  if (groups <= FOREST_DISPATCH_ROW) return [groups, 1];
  return [FOREST_DISPATCH_ROW, Math.ceil(groups / FOREST_DISPATCH_ROW)];
}

export function forestDispatch(pass, threads) {
  const [x, y] = forestDispatchSize(threads);
  if (x > 0) pass.dispatchWorkgroups(x, y);
}
