// A cluster DAG build's input and output (build.ts). Two kinds of geometry: solid triangles ("bark", kind 0) and
// alpha-tested cards ("leaves", kind 1: quads whose coarser levels keep their coverage, leaves.ts). A plain mesh is
// bark with no leaves.

/** Solid triangles (a tree's bark), in metres: positions, normals, uvs (2 per vertex), triangles. */
export interface BarkSource {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
}

/** Leaf cards of one tree: `vpl` vertices per leaf (4, or 8 for crossed double cards), quads in order. */
export interface LeafSource {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  vpl: number;
}

export interface DagRequest {
  id: number;
  bark: BarkSource;
  leaves: LeafSource;
  /** A coarser leaf level's error, as a share of its (grown) leaf size (leaves.ts; ?leaferr=). */
  leafErr?: number;
  /** The leaf texture's alpha (coverage.ts): coarser levels cover what the finer did (none: area kept; ?leafcover=0). */
  leafMask?: LeafMask;
  /** Scales of the bark simplifier's normal and uv weights (build.ts BARK_WEIGHTS; ?barkattr=n,uv). */
  barkAttr?: [number, number];
  /** How a bark group's error adds to its children's: the max (default: each switch moves <= tau) or the sum (?barkerr=sum). */
  barkErr?: 'sum' | 'max';
  /**
   * Each bark vertex's part. A cluster then holds one part only. The caller makes every part boundary a seam
   * (vertices duplicated, one copy per part), so the simplifier coarsens a boundary on both sides alike and never
   * makes a triangle that spans two parts.
   */
  barkParts?: ArrayLike<number>;
  /**
   * The parts never come apart (the pieces of one skin): cluster groups then span them, so a boundary between two
   * coarsens level by level like the surface about it. Without it a part is grouped alone and its boundary is held at
   * every level.
   */
  barkJoined?: boolean;
  /**
   * A bark group's own error, measured by the caller from the group's merged child triangles and their
   * simplification (global vertex indices) and the simplifier's own error; the larger of the two is kept.
   */
  barkGroupError?: (children: Uint32Array, simplified: Uint32Array, error: number) => number;
  /**
   * More attributes of each bark vertex that the simplifier keeps beside the normals and uv: `stride` floats a vertex
   * (at most 27, meshoptimizer's 32 less the 5), each weighed by `weights`. A skinned body gives its posed shapes, so
   * a coarser level keeps what bends.
   */
  barkExtra?: { attr: Float32Array; stride: number; weights: number[] };
}

/** A leaf texture's alpha as a coarse mask: `size` x `size`, 1 = opaque, rows from the image's top. */
export interface LeafMask {
  size: number;
  bits: Uint8Array;
}

export interface DagStats {
  barkTris: number;
  leafTris: number;
  barkClusters: number;
  leafClusters: number;
  barkLevels: number;
  leafLevels: number;
  barkRoots: number;
  leafRoots: number;
  /** Each leaf level's mean growth of the kept cards (sqrt(2): area kept). */
  leafGrowth: number[];
  ms: number;
}

/**
 * The packed DAG: `vtx` 8 floats per vertex (x y z u nx ny nz v); `idx` triangles of every cluster, back to back;
 * `rec` 16 floats per cluster (LOD sphere, parent LOD sphere, culling sphere, error, parent error, level, kind 0 bark
 * / 1 leaf); `meta` 4 uints per cluster (first index, triangles, level, kind).
 */
export interface DagResult {
  id: number;
  vtx: Float32Array;
  idx: Uint32Array;
  rec: Float32Array;
  meta: Uint32Array;
  /** 2 ints per cluster: the bark group it was simplified in and the one it was merged into (-1: none). */
  groups: Int32Array;
  stats: DagStats;
  /** For each leaf vertex after the bark's, the source leaf vertex it came from. */
  leafSource: Uint32Array;
  /** How many bark vertices come first in `vtx`. */
  barkVertices: number;
}
