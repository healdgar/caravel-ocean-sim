// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// High-detail organic 16th-century livestock & horse tack meshes, and the road vehicles: the sources
// scripts/prepare-animal-continuum.mjs bakes into the animal continuum, which is all the game draws them from.
// Species order: 0 = sheep (Merino/Churra), 1 = cattle (Barrosã/Mertolenga), 2 = swine (Porco Preto), 3 = horse (Lusitano + sela à gineta tack).
// Vertex layout (8 floats = 32 bytes): [px, py, pz, nx, ny, nz, part, coat].

export const LIVESTOCK_SPECIES_COUNT = 4;
export const LIVESTOCK_VERTEX_FLOATS = 8;

const LIVESTOCK_NAMES = ["sheep", "cattle", "swine", "horse"];

// The pack (scripts/bake-livestock-meshes.py): a header, then each species' rig, vertices and indices. Each species
// also carries an old per-vertex morph record, which is skipped: the continuum's bake supersedes it.
export function decodeLivestockPack(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 16 || dv.getUint32(0, true) !== 0x4b54534c) {
    throw new Error("Invalid livestock continuum binary header");
  }
  const version = dv.getUint32(4, true);
  const hasUV = version >= 2;
  const speciesCount = dv.getUint32(8, true);
  let off = 16;
  const out = [];
  for (let s = 0; s < speciesCount; s++) {
    const neckX = dv.getFloat32(off, true);
    const neckY = dv.getFloat32(off + 4, true);
    const neckZ = dv.getFloat32(off + 8, true);
    const legY = dv.getFloat32(off + 12, true);
    const frontZ = dv.getFloat32(off + 16, true);
    const backZ = dv.getFloat32(off + 20, true);
    const height = dv.getFloat32(off + 24, true);
    const vc = dv.getUint32(off + 32, true);
    const ic = dv.getUint32(off + 36, true);
    const idxFlags = dv.getUint32(off + 44, true);
    off += 48;

    const vStride = hasUV ? 20 : 16;
    const verts = new Float32Array(vc * 8);
    const uvs = hasUV ? new Float32Array(vc * 2) : null;
    for (let i = 0; i < vc; i++) {
      const vo = off + i * vStride, w = i * 8;
      verts[w] = dv.getInt16(vo, true) * 0.001;
      verts[w + 1] = dv.getInt16(vo + 2, true) * 0.001;
      verts[w + 2] = dv.getInt16(vo + 4, true) * 0.001;
      const nx = dv.getInt16(vo + 6, true) / 16384;
      const ny = dv.getInt16(vo + 8, true) / 16384;
      const nz = dv.getInt16(vo + 10, true) / 16384;
      const nl = Math.hypot(nx, ny, nz) || 1;
      verts[w + 3] = nx / nl;
      verts[w + 4] = ny / nl;
      verts[w + 5] = nz / nl;
      verts[w + 6] = dv.getInt16(vo + 12, true) * 0.001;
      const ctRaw = dv.getInt16(vo + 14, true);
      verts[w + 7] = ctRaw < 0 ? (-ctRaw) * 0.001 : (ctRaw > 0 ? 16.0 + ctRaw : 0.0);
      if (hasUV) {
        uvs[i * 2] = dv.getUint16(vo + 16, true) / 65535;
        uvs[i * 2 + 1] = dv.getUint16(vo + 18, true) / 65535;
      }
    }
    off += vc * vStride;

    const indices = new Uint32Array(ic);
    if (hasUV && (idxFlags & 1)) {
      for (let k = 0; k < ic; k++) indices[k] = dv.getUint32(off + k * 4, true);
      off += ic * 4;
    } else {
      for (let k = 0; k < ic; k++) indices[k] = dv.getUint16(off + k * 2, true);
      off += ic * 2 + ((ic * 2) % 4);
    }
    if (!hasUV) off += vc * 8;

    out.push(Object.freeze({
      name: LIVESTOCK_NAMES[s] ?? ("species_" + s),
      neckPivot: Object.freeze([neckX, neckY, neckZ]),
      legY,
      frontZ,
      backZ,
      height,
      vertices: verts,
      uvs,
      indices,
      indexCount: ic,
    }));
  }
  return Object.freeze(out);
}

let cachedLivestockMeshes = null;

// The pack, read from disk where it lies (the bake and the tests run under node).
export function getLivestockMeshes() {
  if (cachedLivestockMeshes) return cachedLivestockMeshes;
  if (typeof process !== "undefined" && process.versions?.node && typeof process.getBuiltinModule === "function") {
    const fsSync = process.getBuiltinModule("node:fs");
    const pathMod = process.getBuiltinModule("node:path");
    const urlMod = process.getBuiltinModule("node:url");
    const dir = pathMod.dirname(urlMod.fileURLToPath(import.meta.url));
    const buf = fsSync.readFileSync(pathMod.resolve(dir, "../../assets/wildlife/livestock-1550.bin"));
    cachedLivestockMeshes = decodeLivestockPack(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return cachedLivestockMeshes;
  }
  throw new Error("The livestock pack is a bake source, read under node");
}

// Sixteenth-century Iberian road vehicles in the livestock vertex layout (8 floats = 32 bytes):
//   species 4 = carreta (4-wheel covered freight wain drawn by a yoked pair of oxen)
//   species 5 = coche (4-wheel panelled passenger/merchant coach drawn by a harnessed pair of horses)
//   species 6 = carro de bois (2-wheel heavy cargo ox-cart stacked with casks, sacks & crates)
// Coordinate frame: +Z forward toward draft team, Y up from ground (y = 0), X right.
// Parts: 0 = chassis/body/cargo, 7 = spoked wheels turned around their axles, 8 = articulated draft pole + yoke/harness.
// Zones: 0 = structural timber, 1 = forged iron / dark interior recess, 2 = dyed tilt cloth / roof leather / sackcloth, 3 = gilt/brass trim & hoops.
export const VEHICLE_SPECIES_COUNT = 3;
export const WAGON_FRONT_AXLE = Object.freeze({ z: 1.05, r: 0.50 });
export const WAGON_REAR_AXLE = Object.freeze({ z: -1.10, r: 0.60 });
export const COACH_FRONT_AXLE = Object.freeze({ z: 1.18, r: 0.46 });
export const COACH_REAR_AXLE = Object.freeze({ z: -1.18, r: 0.62 });
export const OX_CART_AXLE = Object.freeze({ z: 0.0, r: 0.62 });

function createVehicleMeshBuilder() {
  const v = [], idx = [];
  const norm3 = (n) => {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const vert = (p, n, part, zone, ao) => {
    const nn = norm3(n);
    v.push(
      p[0], p[1], p[2],
      nn[0], nn[1], nn[2],
      part,
      zone + Math.min(0.98, Math.max(0.08, ao)),
    );
    return v.length / 8 - 1;
  };

  // Emit a single triangle guaranteed CCW-outward with respect to the outward normal `nRef`.
  const tri = (pa, pb, pc, na, nb, nc, nRef, part, zone, aoA, aoB = aoA, aoC = aoA) => {
    const g = cross3(sub3(pb, pa), sub3(pc, pa));
    if (Math.hypot(g[0], g[1], g[2]) < 1e-8) return;
    const flip = dot3(g, nRef) < 0;
    const nA = dot3(na, nRef) < 0 ? [-na[0], -na[1], -na[2]] : na;
    const nB = dot3(nb, nRef) < 0 ? [-nb[0], -nb[1], -nb[2]] : nb;
    const nC = dot3(nc, nRef) < 0 ? [-nc[0], -nc[1], -nc[2]] : nc;
    const ia = vert(pa, nA, part, zone, aoA);
    const ib = vert(pb, nB, part, zone, aoB);
    const ic = vert(pc, nC, part, zone, aoC);
    if (flip) idx.push(ia, ic, ib);
    else idx.push(ia, ib, ic);
  };

  const quad = (a, b, c, d, n, part, zone, ao) => {
    const nn = norm3(n);
    tri(a, b, c, nn, nn, nn, nn, part, zone, ao);
    tri(a, c, d, nn, nn, nn, nn, part, zone, ao);
  };

  const smoothQuad = (a, b, c, d, na, nb, nc, nd, part, zone, aoA, aoB = aoA, aoC = aoB, aoD = aoA) => {
    const nAvg = norm3([na[0] + nb[0] + nc[0] + nd[0], na[1] + nb[1] + nc[1] + nd[1], na[2] + nb[2] + nc[2] + nd[2]]);
    tri(a, b, c, na, nb, nc, nAvg, part, zone, aoA, aoB, aoC);
    tri(a, c, d, na, nc, nd, nAvg, part, zone, aoA, aoC, aoD);
  };

  const box = (x0, y0, z0, x1, y1, z1, zone, ao = 0.82, part = 0) => {
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const lz = Math.min(z0, z1), hz = Math.max(z0, z1);
    if (hx - lx < 1e-5 || hy - ly < 1e-5 || hz - lz < 1e-5) return;
    quad([hx, ly, lz], [hx, hy, lz], [hx, hy, hz], [hx, ly, hz], [1, 0, 0], part, zone, ao);
    quad([lx, ly, hz], [lx, hy, hz], [lx, hy, lz], [lx, ly, lz], [-1, 0, 0], part, zone, ao);
    quad([lx, hy, lz], [lx, hy, hz], [hx, hy, hz], [hx, hy, lz], [0, 1, 0], part, zone, Math.min(0.98, ao + 0.1));
    quad([lx, ly, lz], [hx, ly, lz], [hx, ly, hz], [lx, ly, hz], [0, -1, 0], part, zone, Math.max(0.12, ao * 0.48));
    quad([lx, ly, hz], [hx, ly, hz], [hx, hy, hz], [lx, hy, hz], [0, 0, 1], part, zone, ao);
    quad([hx, ly, lz], [lx, ly, lz], [lx, hy, lz], [hx, hy, lz], [0, 0, -1], part, zone, ao);
  };

  // Oriented 3D rectangular timber/iron bar from p0 to p1 with cross-section (2*hw) x (2*hh).
  const beam = (p0, p1, hw, hh, zone, ao = 0.78, part = 0, capEnds = true, upHint = [0, 1, 0]) => {
    const d = sub3(p1, p0);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-5) return;
    const u = [d[0] / len, d[1] / len, d[2] / len];
    let r = cross3(upHint, u);
    if (Math.hypot(r[0], r[1], r[2]) < 1e-3) r = cross3([1, 0, 0], u);
    r = norm3(r);
    const up = norm3(cross3(u, r));
    const corner = (p, sx, sy) => [
      p[0] + r[0] * sx * hw + up[0] * sy * hh,
      p[1] + r[1] * sx * hw + up[1] * sy * hh,
      p[2] + r[2] * sx * hw + up[2] * sy * hh,
    ];
    const a00 = corner(p0, -1, -1), a10 = corner(p0, 1, -1), a11 = corner(p0, 1, 1), a01 = corner(p0, -1, 1);
    const b00 = corner(p1, -1, -1), b10 = corner(p1, 1, -1), b11 = corner(p1, 1, 1), b01 = corner(p1, -1, 1);
    quad(a10, a11, b11, b10, r, part, zone, ao);
    quad(b00, b01, a01, a00, [-r[0], -r[1], -r[2]], part, zone, ao);
    quad(a01, b01, b11, a11, up, part, zone, Math.min(0.98, ao + 0.08));
    quad(a00, a10, b10, b00, [-up[0], -up[1], -up[2]], part, zone, Math.max(0.14, ao * 0.55));
    if (capEnds) {
      quad(a10, a00, a01, a11, [-u[0], -u[1], -u[2]], part, zone, ao * 0.85);
      quad(b00, b10, b11, b01, u, part, zone, ao * 0.85);
    }
  };

  // Closed 3D cylinder / tapered frustum from p0 to p1.
  const cylinder = (p0, p1, r0, r1, sides, zone, ao = 0.78, part = 0, capEnds = true) => {
    const d = sub3(p1, p0);
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-5) return;
    const u = [d[0] / len, d[1] / len, d[2] / len];
    let e1 = cross3([0, 1, 0], u);
    if (Math.hypot(e1[0], e1[1], e1[2]) < 1e-3) e1 = cross3([1, 0, 0], u);
    e1 = norm3(e1);
    const e2 = norm3(cross3(u, e1));
    const slope = (r0 - r1) / len;
    const ringPt = (p, rad, a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      return [
        p[0] + (e1[0] * ca + e2[0] * sa) * rad,
        p[1] + (e1[1] * ca + e2[1] * sa) * rad,
        p[2] + (e1[2] * ca + e2[2] * sa) * rad,
      ];
    };
    const ringNrm = (a) => {
      const ca = Math.cos(a), sa = Math.sin(a);
      return norm3([
        e1[0] * ca + e2[0] * sa + u[0] * slope,
        e1[1] * ca + e2[1] * sa + u[1] * slope,
        e1[2] * ca + e2[2] * sa + u[2] * slope,
      ]);
    };
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      const p00 = ringPt(p0, r0, a0), p01 = ringPt(p0, r0, a1);
      const p11 = ringPt(p1, r1, a1), p10 = ringPt(p1, r1, a0);
      const n0 = ringNrm(a0), n1 = ringNrm(a1);
      const shade0 = ao * (0.82 + 0.18 * Math.max(0, n0[1]));
      const shade1 = ao * (0.82 + 0.18 * Math.max(0, n1[1]));
      smoothQuad(p00, p01, p11, p10, n0, n1, n1, n0, part, zone, shade0, shade1, shade1, shade0);
      if (capEnds) {
        if (r0 > 1e-4) {
          const nCap0 = [-u[0], -u[1], -u[2]];
          tri(p0, p01, p00, nCap0, nCap0, nCap0, nCap0, part, zone, ao * 0.8);
        }
        if (r1 > 1e-4) {
          const nCap1 = u;
          tri(p1, p10, p11, nCap1, nCap1, nCap1, nCap1, part, zone, ao * 0.8);
        }
      }
    }
  };

  // Real 3D spoked wooden wheel (`part = 7`): iron-hooped nave hub, radial 3D wooden spokes,
  // 3D wooden felloe ring, and forged iron tyre band — 100% outward CCW wound.
  const spokedWheel = (x, axle, side, spokeCount = 10, rimSegs = 14) => {
    const { z: zc, r } = axle;
    const tRim = 0.044, tTyre = 0.047;
    const rTyreInner = r - 0.024;
    const rFelloeInner = r * 0.79;
    const rHub = Math.max(0.082, r * 0.185);
    const dish = side * 0.018;

    // 1. Turned wooden hub (nave) + forged iron nave hoops + outer linchpin cap
    cylinder([x - side * 0.11, r, zc], [x + side * 0.145, r, zc], rHub * 0.92, rHub * 0.84, 8, 0, 0.72, 7, true);
    cylinder([x - side * 0.095, r, zc], [x - side * 0.065, r, zc], rHub * 0.98, rHub * 0.98, 8, 1, 0.62, 7, false);
    cylinder([x + side * 0.085, r, zc], [x + side * 0.118, r, zc], rHub * 0.95, rHub * 0.95, 8, 1, 0.62, 7, false);
    cylinder([x + side * 0.145, r, zc], [x + side * 0.185, r, zc], rHub * 0.46, rHub * 0.38, 6, 1, 0.58, 7, true);

    // 2. Radial 3D wooden spokes mortised from hub into felloe
    for (let s = 0; s < spokeCount; s++) {
      const a = (s / spokeCount) * Math.PI * 2 + (side > 0 ? 0.14 : 0);
      const cy = Math.cos(a), sz = Math.sin(a);
      const pHub = [x - dish * 0.35, r + cy * rHub * 0.72, zc + sz * rHub * 0.72];
      const pRim = [x + dish, r + cy * (rFelloeInner + 0.018), zc + sz * (rFelloeInner + 0.018)];
      beam(pHub, pRim, 0.019, 0.024, 0, 0.78, 7, false, [1, 0, 0]);
    }

    // 3. Curved 3D wooden felloe ring + forged iron tyre band
    const xRim = x + dish;
    const pt = (a, rad, dx) => [xRim + dx, r + Math.cos(a) * rad, zc + Math.sin(a) * rad];
    for (let k = 0; k < rimSegs; k++) {
      const a0 = (k / rimSegs) * Math.PI * 2;
      const a1 = ((k + 1) / rimSegs) * Math.PI * 2;
      const nOut0 = [0, Math.cos(a0), Math.sin(a0)], nOut1 = [0, Math.cos(a1), Math.sin(a1)];
      const nIn0 = [0, -Math.cos(a0), -Math.sin(a0)], nIn1 = [0, -Math.cos(a1), -Math.sin(a1)];

      // Forged iron tyre outer tread + side lips (zone = 1)
      smoothQuad(
        pt(a0, r, -tTyre), pt(a1, r, -tTyre), pt(a1, r, tTyre), pt(a0, r, tTyre),
        nOut0, nOut1, nOut1, nOut0, 7, 1, 0.68,
      );
      quad(pt(a0, rTyreInner, -tTyre), pt(a1, rTyreInner, -tTyre), pt(a1, r, -tTyre), pt(a0, r, -tTyre), [-1, 0, 0], 7, 1, 0.64);
      quad(pt(a0, r, tTyre), pt(a1, r, tTyre), pt(a1, rTyreInner, tTyre), pt(a0, rTyreInner, tTyre), [1, 0, 0], 7, 1, 0.64);

      // Wooden felloe left/right cheeks & inner arch (zone = 0)
      quad(pt(a0, rFelloeInner, -tRim), pt(a1, rFelloeInner, -tRim), pt(a1, rTyreInner, -tRim), pt(a0, rTyreInner, -tRim), [-1, 0, 0], 7, 0, 0.78);
      quad(pt(a0, rTyreInner, tRim), pt(a1, rTyreInner, tRim), pt(a1, rFelloeInner, tRim), pt(a0, rFelloeInner, tRim), [1, 0, 0], 7, 0, 0.78);
      smoothQuad(
        pt(a0, rFelloeInner, tRim), pt(a1, rFelloeInner, tRim), pt(a1, rFelloeInner, -tRim), pt(a0, rFelloeInner, -tRim),
        nIn0, nIn1, nIn1, nIn0, 7, 0, 0.62,
      );
    }
  };

  // Articulated Iberian oak draft pole (`cabeçalho`) + carved `canga` double ox-yoke (`part = 8`) reaching z = +4.55 m
  // so the yoke rests directly across the paired draft oxen's necks/withers (placed at +4.05 m, neck at +4.55 m).
  const oxYokeAssembly = (zPivot, yPivot) => {
    const zYoke = 4.55, yYoke = 1.16;
    // Diagonal timber hounds bracing pole into front axle bolster
    beam([-0.34, yPivot, zPivot], [0, yPivot + 0.08, zPivot + 0.65], 0.036, 0.038, 0, 0.72, 8);
    beam([0.34, yPivot, zPivot], [0, yPivot + 0.08, zPivot + 0.65], 0.036, 0.038, 0, 0.72, 8);
    // Main central oak draft pole (cabeçalho) + forged iron pole-crab & yoke clasp
    beam([0, yPivot, zPivot], [0, yYoke - 0.03, zYoke + 0.14], 0.048, 0.052, 0, 0.78, 8);
    box(-0.075, yYoke - 0.09, zYoke - 0.08, 0.075, yYoke + 0.09, zYoke + 0.08, 1, 0.62, 8);

    // Carved Iberian double neck-yoke (`canga`) spanning both oxen at x = ±0.62 m
    beam([-0.92, yYoke, zYoke], [0.92, yYoke, zYoke], 0.055, 0.068, 0, 0.84, 8);
    for (const sx of [-1, 1]) {
      const cx = sx * 0.62;
      // Sculpted crest arch (`molhelha` pad + carved top crest) over each ox's neck
      box(cx - 0.18, yYoke + 0.05, zYoke - 0.055, cx + 0.18, yYoke + 0.14, zYoke + 0.055, 0, 0.88, 8);
      // Four descending wooden `cangalhas` neck-pins & leather under-throat bow straddling each ox's neck
      beam([cx - 0.19, yYoke + 0.04, zYoke], [cx - 0.17, yYoke - 0.34, zYoke - 0.03], 0.022, 0.022, 0, 0.74, 8);
      beam([cx + 0.19, yYoke + 0.04, zYoke], [cx + 0.17, yYoke - 0.34, zYoke - 0.03], 0.022, 0.022, 0, 0.74, 8);
      beam([cx - 0.17, yYoke - 0.33, zYoke - 0.03], [cx + 0.17, yYoke - 0.33, zYoke - 0.03], 0.018, 0.018, 1, 0.58, 8);
    }
    // Side draft chain/trace stays from doubletree to yoke
    beam([-0.52, yPivot + 0.04, zPivot + 0.32], [0.52, yPivot + 0.04, zPivot + 0.32], 0.035, 0.035, 0, 0.74, 8);
    for (const sx of [-1, 1]) {
      beam([sx * 0.48, yPivot + 0.04, zPivot + 0.34], [sx * 0.56, yYoke - 0.08, zYoke - 0.06], 0.016, 0.016, 1, 0.6, 8);
    }
  };

  // Articulated coach pole + doubletree/swinglebars + paired horse breast-collars & leather traces (`part = 8`).
  const horseHarnessAssembly = (zPivot, yPivot) => {
    const zCollar = 4.52, yCollar = 1.12;
    const zTree = zPivot + 0.42, yTree = yPivot + 0.08;
    // Futchells / hounds + central tapered coach pole
    beam([-0.36, yPivot, zPivot], [0, yTree, zTree + 0.25], 0.034, 0.036, 0, 0.74, 8);
    beam([0.36, yPivot, zPivot], [0, yTree, zTree + 0.25], 0.034, 0.036, 0, 0.74, 8);
    beam([0, yPivot + 0.02, zPivot], [0, yCollar - 0.12, zCollar + 0.12], 0.042, 0.044, 0, 0.8, 8);
    // Iron pole-crab at tip connecting to both horses' collars
    beam([-0.42, yCollar - 0.10, zCollar + 0.04], [0.42, yCollar - 0.10, zCollar + 0.04], 0.018, 0.018, 1, 0.66, 8);

    // Master doubletree + left/right swingletrees behind horses' heels (z ≈ 2.85 m)
    const zSwingle = 2.86, ySwingle = 0.74;
    beam([-0.74, ySwingle, zSwingle], [0.74, ySwingle, zSwingle], 0.032, 0.036, 0, 0.8, 8);
    beam([0, yTree, zTree + 0.15], [0, ySwingle, zSwingle], 0.024, 0.024, 1, 0.62, 8);
    for (const sx of [-1, 1]) {
      const cx = sx * 0.62;
      beam([cx - 0.24, ySwingle + 0.03, zSwingle + 0.08], [cx + 0.24, ySwingle + 0.03, zSwingle + 0.08], 0.024, 0.026, 0, 0.82, 8);
      // Outer & inner leather/iron trace bars running past flanks to horse hames/collars at z = +4.52 m
      beam([cx - 0.23, ySwingle + 0.03, zSwingle + 0.10], [cx - 0.19, yCollar - 0.04, zCollar - 0.04], 0.015, 0.022, 1, 0.64, 8);
      beam([cx + 0.23, ySwingle + 0.03, zSwingle + 0.10], [cx + 0.19, yCollar - 0.04, zCollar - 0.04], 0.015, 0.022, 1, 0.64, 8);
      // Padded leather & brass-mounted hames horse collar resting on each horse's shoulders
      beam([cx - 0.19, yCollar - 0.14, zCollar], [cx - 0.14, yCollar + 0.20, zCollar - 0.08], 0.026, 0.030, 1, 0.68, 8);
      beam([cx + 0.19, yCollar - 0.14, zCollar], [cx + 0.14, yCollar + 0.20, zCollar - 0.08], 0.026, 0.030, 1, 0.68, 8);
      beam([cx - 0.15, yCollar + 0.20, zCollar - 0.08], [cx + 0.15, yCollar + 0.20, zCollar - 0.08], 0.024, 0.028, 3, 0.86, 8);
      beam([cx - 0.18, yCollar - 0.14, zCollar + 0.02], [cx + 0.18, yCollar - 0.14, zCollar + 0.02], 0.022, 0.024, 1, 0.62, 8);
    }
  };

  return { v, idx, vert, tri, quad, smoothQuad, box, beam, cylinder, spokedWheel, oxYokeAssembly, horseHarnessAssembly };
}

// Species 4: 4-wheel covered freight wain (`carreta`), drawn by a yoked pair of oxen.
function buildWagonMesh() {
  const m = createVehicleMeshBuilder();
  const { v, idx, quad, smoothQuad, box, beam, spokedWheel, oxYokeAssembly } = m;

  // Timber undercarriage, axle bolsters, longitudinal reach beam & planked wain bed
  box(-0.84, WAGON_FRONT_AXLE.r - 0.055, WAGON_FRONT_AXLE.z - 0.065, 0.84, WAGON_FRONT_AXLE.r + 0.065, WAGON_FRONT_AXLE.z + 0.065, 0, 0.56);
  box(-0.84, WAGON_REAR_AXLE.r - 0.055, WAGON_REAR_AXLE.z - 0.065, 0.84, WAGON_REAR_AXLE.r + 0.065, WAGON_REAR_AXLE.z + 0.065, 0, 0.56);
  box(-0.46, WAGON_FRONT_AXLE.r + 0.06, WAGON_FRONT_AXLE.z - 0.08, 0.46, 0.72, WAGON_FRONT_AXLE.z + 0.08, 0, 0.62);
  box(-0.46, WAGON_REAR_AXLE.r + 0.06, WAGON_REAR_AXLE.z - 0.08, 0.46, 0.72, WAGON_REAR_AXLE.z + 0.08, 0, 0.62);
  beam([0, 0.60, WAGON_REAR_AXLE.z], [0, 0.56, WAGON_FRONT_AXLE.z + 0.25], 0.055, 0.05, 0, 0.58);

  // Bed planks, side raves, exterior vertical stakes & iron corner straps
  box(-0.64, 0.72, -1.58, 0.64, 0.84, 1.48, 0, 0.72);
  box(-0.68, 0.84, -1.60, -0.59, 1.28, 1.50, 0, 0.84);
  box(0.59, 0.84, -1.60, 0.68, 1.28, 1.50, 0, 0.84);
  box(-0.62, 0.84, 1.42, 0.62, 1.22, 1.50, 0, 0.80);
  box(-0.62, 0.84, -1.60, 0.62, 1.24, -1.52, 0, 0.80);
  for (const zStake of [-1.42, -0.72, -0.02, 0.68, 1.36]) {
    for (const sx of [-1, 1]) {
      box(sx * 0.68 - (sx < 0 ? 0.035 : 0), 0.74, zStake - 0.03, sx * 0.68 + (sx > 0 ? 0.035 : 0), 1.32, zStake + 0.03, 0, 0.82);
    }
  }
  for (const sz of [-1.605, 1.505]) {
    for (const sx of [-0.66, 0.62]) box(sx, 0.74, sz - 0.018, sx + 0.04, 1.26, sz + 0.018, 1, 0.64);
  }

  // Double-sided manifold canvas tilt over bent ash hoops (`zone = 2`): outer surface wound strictly outward,
  // inner liner inset by 3 cm and wound strictly inward toward the bed interior.
  const hoopN = 10, rxOut = 0.67, ryOut = 0.62, rxIn = 0.635, ryIn = 0.585, cy = 1.28, z0 = -1.50, z1 = 1.40;
  for (let k = 0; k < hoopN; k++) {
    const a0 = (k / hoopN) * Math.PI, a1 = ((k + 1) / hoopN) * Math.PI;
    const o00 = [Math.cos(a0) * rxOut, cy + Math.sin(a0) * ryOut, z0];
    const o10 = [Math.cos(a1) * rxOut, cy + Math.sin(a1) * ryOut, z0];
    const o11 = [Math.cos(a1) * rxOut, cy + Math.sin(a1) * ryOut, z1];
    const o01 = [Math.cos(a0) * rxOut, cy + Math.sin(a0) * ryOut, z1];
    const n0 = [Math.cos(a0), Math.sin(a0), 0], n1 = [Math.cos(a1), Math.sin(a1), 0];
    const ao0 = 0.64 + 0.34 * Math.sin(a0), ao1 = 0.64 + 0.34 * Math.sin(a1);
    smoothQuad(o00, o01, o11, o10, n0, n0, n1, n1, 0, 2, ao0, ao0, ao1, ao1);

    const i00 = [Math.cos(a0) * rxIn, cy + Math.sin(a0) * ryIn, z0 + 0.02];
    const i10 = [Math.cos(a1) * rxIn, cy + Math.sin(a1) * ryIn, z0 + 0.02];
    const i11 = [Math.cos(a1) * rxIn, cy + Math.sin(a1) * ryIn, z1 - 0.02];
    const i01 = [Math.cos(a0) * rxIn, cy + Math.sin(a0) * ryIn, z1 - 0.02];
    const m0 = [-n0[0], -n0[1], 0], m1 = [-n1[0], -n1[1], 0];
    smoothQuad(i00, i10, i11, i01, m0, m1, m1, m0, 0, 2, 0.34);

    // Gathered drawstring end-rims closing outer tilt to inner valence at front & rear openings
    const rim0 = (a, f) => [Math.cos(a) * rxOut * f, cy + Math.sin(a) * ryOut * f, z0];
    const rim1 = (a, f) => [Math.cos(a) * rxOut * f, cy + Math.sin(a) * ryOut * f, z1];
    quad(rim0(a0, 1), rim0(a1, 1), rim0(a1, 0.76), rim0(a0, 0.76), [0, 0, -1], 0, 2, 0.52);
    quad(rim1(a1, 1), rim1(a0, 1), rim1(a0, 0.76), rim1(a1, 0.76), [0, 0, 1], 0, 2, 0.52);
  }
  // Visible interior cargo crates & sacks under the open tilt arch
  box(-0.44, 0.84, -1.15, 0.12, 1.24, -0.35, 0, 0.55);
  box(-0.18, 0.84, 0.10, 0.44, 1.20, 0.92, 2, 0.58);

  // Articulated draft pole + carved Iberian double ox-yoke (`part = 8`)
  oxYokeAssembly(1.35, 0.56);

  // Four 3D spoked wooden wheels (`part = 7`)
  for (const [x, side] of [[-0.86, -1], [0.86, 1]]) {
    spokedWheel(x, WAGON_FRONT_AXLE, side, 8, 12);
    spokedWheel(x, WAGON_REAR_AXLE, side, 10, 14);
  }

  return Object.freeze({
    name: 'wagon',
    neckPivot: Object.freeze([WAGON_FRONT_AXLE.r, 0.56, 1.35]),
    legY: WAGON_REAR_AXLE.r,
    frontZ: WAGON_FRONT_AXLE.z,
    backZ: WAGON_REAR_AXLE.z,
    height: cy + ryOut,
    vertices: new Float32Array(v),
    indices: new Uint32Array(idx),
    indexCount: idx.length,
  });
}

// Species 5: 4-wheel Renaissance passenger / merchant coach (`coche`), drawn by a harnessed pair of horses.
function buildCoachMesh() {
  const m = createVehicleMeshBuilder();
  const { v, idx, smoothQuad, box, beam, cylinder, spokedWheel, horseHarnessAssembly } = m;

  // Undercarriage: front & rear axle trees, carved perch beam, leather thoroughbraces
  box(-0.84, COACH_FRONT_AXLE.r - 0.05, COACH_FRONT_AXLE.z - 0.06, 0.84, COACH_FRONT_AXLE.r + 0.06, COACH_FRONT_AXLE.z + 0.06, 0, 0.56);
  box(-0.86, COACH_REAR_AXLE.r - 0.055, COACH_REAR_AXLE.z - 0.065, 0.86, COACH_REAR_AXLE.r + 0.065, COACH_REAR_AXLE.z + 0.065, 0, 0.56);
  beam([0, 0.54, COACH_REAR_AXLE.z], [0, 0.52, COACH_FRONT_AXLE.z + 0.24], 0.06, 0.055, 0, 0.62);
  for (const sx of [-0.46, 0.46]) {
    beam([sx, 0.62, COACH_REAR_AXLE.z], [sx, 0.72, 0.96], 0.038, 0.032, 1, 0.6);
  }

  // Enclosed panelled walnut/oak coach cabin (`z = -1.04 .. +0.96`) with recessed 3D side window openings
  // Lower boat-shaped rocker & floor pan
  box(-0.62, 0.68, -0.98, 0.62, 0.80, 0.92, 0, 0.68);
  // Dark interior cabin core & cushioned seats visible through recessed side windows (`zone = 1`)
  box(-0.56, 0.80, -0.90, 0.56, 1.72, 0.84, 1, 0.28);
  box(-0.54, 0.82, -0.88, 0.54, 1.08, -0.44, 2, 0.52);
  box(-0.54, 0.82, 0.40, 0.54, 1.08, 0.82, 2, 0.52);

  // Lower solid wainscot side panels + front & rear cabin bulkheads (`zone = 0`)
  box(-0.66, 0.78, -1.02, -0.56, 1.28, 0.94, 0, 0.84);
  box(0.56, 0.78, -1.02, 0.66, 1.28, 0.94, 0, 0.84);
  box(-0.64, 0.78, -1.02, 0.64, 1.78, -0.90, 0, 0.82);
  box(-0.64, 0.78, 0.82, 0.64, 1.78, 0.94, 0, 0.82);

  // Upper corner pillars, central door stiles, and upper frieze rails framing 2 recessed side windows per side
  for (const sx of [-1, 1]) {
    const xIn = sx > 0 ? 0.56 : -0.66, xOut = sx > 0 ? 0.66 : -0.56;
    for (const [zA, zB] of [[-1.02, -0.82], [-0.11, 0.09], [0.74, 0.94]]) {
      box(xIn, 1.28, zA, xOut, 1.78, zB, 0, 0.86);
    }
    box(xIn, 1.68, -1.02, xOut, 1.80, 0.94, 0, 0.88);
    // Gilt/brass waist moulding & cornice rail (`zone = 3`) + iron carriage step-plate (`zone = 1`)
    box(sx > 0 ? 0.655 : -0.685, 1.25, -1.04, sx > 0 ? 0.685 : -0.655, 1.30, 0.96, 3, 0.92);
    box(sx > 0 ? 0.655 : -0.685, 1.75, -1.05, sx > 0 ? 0.685 : -0.655, 1.80, 0.97, 3, 0.92);
    box(sx > 0 ? 0.64 : -0.78, 0.50, -0.18, sx > 0 ? 0.78 : -0.64, 0.54, 0.14, 1, 0.66);
    beam([sx * 0.60, 0.72, -0.02], [sx * 0.70, 0.52, -0.02], 0.018, 0.018, 1, 0.62);
  }

  // Cambered leather / crimson-velvet pavilion roof (`zone = 2`) with brass finials (`zone = 3`)
  const roofSegs = 8, zR0 = -1.08, zR1 = 1.00, yRBase = 1.78;
  for (let k = 0; k < roofSegs; k++) {
    const u0 = -1 + (2 * k) / roofSegs, u1 = -1 + (2 * (k + 1)) / roofSegs;
    const x0 = u0 * 0.70, x1 = u1 * 0.70;
    const y0 = yRBase + (1 - u0 * u0 * 0.82) * 0.22;
    const y1 = yRBase + (1 - u1 * u1 * 0.82) * 0.22;
    const n0 = [u0 * 0.36, 1, 0], n1 = [u1 * 0.36, 1, 0];
    smoothQuad([x0, y0, zR0], [x0, y0, zR1], [x1, y1, zR1], [x1, y1, zR0], n0, n0, n1, n1, 0, 2, 0.92);
    // Solid gable end-fills under cambered roof
    box(Math.min(x0, x1), yRBase - 0.02, zR0, Math.max(x0, x1), Math.min(y0, y1), zR0 + 0.08, 0, 0.8);
    box(Math.min(x0, x1), yRBase - 0.02, zR1 - 0.08, Math.max(x0, x1), Math.min(y0, y1), zR1, 0, 0.8);
  }
  for (const sx of [-0.64, 0.64]) {
    for (const sz of [-1.02, 0.94]) cylinder([sx, 1.80, sz], [sx, 1.93, sz], 0.032, 0.012, 6, 3, 0.94);
  }

  // Elevated front coachman box seat (`pescante`) + angled footboard + iron side lamps
  box(-0.48, 0.80, 0.94, 0.48, 1.24, 1.38, 0, 0.78);
  box(-0.50, 1.24, 0.94, 0.50, 1.34, 1.36, 2, 0.86);
  beam([-0.46, 0.86, 1.36], [-0.46, 0.68, 1.66], 0.03, 0.04, 0, 0.74);
  beam([0.46, 0.86, 1.36], [0.46, 0.68, 1.66], 0.03, 0.04, 0, 0.74);
  box(-0.48, 0.66, 1.52, 0.48, 0.73, 1.70, 0, 0.76);
  for (const sx of [-0.68, 0.68]) cylinder([sx, 1.42, 0.88], [sx, 1.62, 0.88], 0.05, 0.065, 6, 3, 0.92);

  // Rear luggage rack + iron-bound merchant leather trunk
  beam([-0.48, 0.74, -1.00], [-0.48, 0.70, -1.48], 0.032, 0.032, 0, 0.7);
  beam([0.48, 0.74, -1.00], [0.48, 0.70, -1.48], 0.032, 0.032, 0, 0.7);
  box(-0.46, 0.73, -1.46, 0.46, 1.12, -1.04, 0, 0.78);
  for (const sx of [-0.30, 0.30]) box(sx - 0.025, 0.725, -1.47, sx + 0.025, 1.13, -1.03, 1, 0.64);

  // Articulated coach pole + doubletree + paired horse breast-collars & traces (`part = 8`)
  horseHarnessAssembly(1.40, 0.58);

  // Four 10/12-spoked carriage wheels (`part = 7`)
  for (const [x, side] of [[-0.86, -1], [0.86, 1]]) {
    spokedWheel(x, COACH_FRONT_AXLE, side, 10, 12);
    spokedWheel(x, COACH_REAR_AXLE, side, 12, 14);
  }

  return Object.freeze({
    name: 'coach',
    neckPivot: Object.freeze([COACH_FRONT_AXLE.r, 0.58, 1.40]),
    legY: COACH_REAR_AXLE.r,
    frontZ: COACH_FRONT_AXLE.z,
    backZ: COACH_REAR_AXLE.z,
    height: 2.02,
    vertices: new Float32Array(v),
    indices: new Uint32Array(idx),
    indexCount: idx.length,
  });
}

// Species 6: 2-wheel heavy Iberian cargo ox-cart (`carro de bois`), stacked with physical wine casks, sacks & crates.
function buildOxCartMesh() {
  const m = createVehicleMeshBuilder();
  const { v, idx, box, beam, cylinder, spokedWheel, oxYokeAssembly } = m;

  // Heavy oak axle tree & twin curved `chedeiro` side-frame rails converging toward the central draft pole
  box(-0.86, OX_CART_AXLE.r - 0.06, -0.075, 0.86, OX_CART_AXLE.r + 0.06, 0.075, 0, 0.56);
  box(-0.56, OX_CART_AXLE.r + 0.06, -0.14, 0.56, 0.74, 0.14, 0, 0.62);
  box(-0.62, 0.72, -1.38, 0.62, 0.83, 1.24, 0, 0.76);
  beam([-0.60, 0.77, 1.20], [-0.10, 0.64, 1.65], 0.055, 0.055, 0, 0.76);
  beam([0.60, 0.77, 1.20], [0.10, 0.64, 1.65], 0.055, 0.055, 0, 0.76);

  // Side ladder-slats & vertical `fueiros` hardwood stakes retaining the cargo
  for (const sx of [-1, 1]) {
    const xS = sx * 0.61;
    beam([xS, 1.02, -1.34], [xS, 1.02, 1.20], 0.026, 0.032, 0, 0.82);
    beam([xS, 1.24, -1.34], [xS, 1.24, 1.20], 0.026, 0.032, 0, 0.85);
    for (const zF of [-1.26, -0.64, 0.0, 0.62, 1.14]) {
      beam([xS, 0.74, zF], [xS + sx * 0.03, 1.34, zF], 0.025, 0.025, 0, 0.82);
    }
  }
  box(-0.60, 0.83, -1.38, 0.60, 1.18, -1.30, 0, 0.80);
  box(-0.58, 0.83, 1.16, 0.58, 1.14, 1.24, 0, 0.80);

  // Physical 3D freight load on the cart bed:
  // 1) Two coopered oak wine/olive-oil casks (`pipas`) with bilge swell & forged iron hoops (`zone = 1`)
  const barrel = (cx, cy, cz, halfL, rEnd, rMid) => {
    cylinder([cx - halfL, cy, cz], [cx, cy, cz], rEnd, rMid, 10, 0, 0.84, 0, true);
    cylinder([cx, cy, cz], [cx + halfL, cy, cz], rMid, rEnd, 10, 0, 0.84, 0, true);
    for (const hx of [-halfL * 0.76, -halfL * 0.28, halfL * 0.28, halfL * 0.76]) {
      const t = Math.abs(hx) / halfL;
      const rh = (rMid * (1 - t) + rEnd * t) + 0.008;
      cylinder([cx + hx - 0.02, cy, cz], [cx + hx + 0.02, cy, cz], rh, rh, 10, 1, 0.66, 0, false);
    }
  };
  barrel(0, 1.12, -0.58, 0.48, 0.25, 0.30);
  barrel(0, 1.10, 0.12, 0.46, 0.24, 0.285);

  // 2) Iron-strapped merchant crate forward (`zone = 0` + `zone = 3` cordage) & plump grain/wool sacks (`zone = 2`)
  box(-0.48, 0.83, 0.50, 0.16, 1.25, 1.10, 0, 0.82);
  box(-0.49, 1.01, 0.49, 0.17, 1.06, 1.11, 3, 0.78);
  cylinder([0.32, 0.98, 0.52], [0.30, 1.00, 1.08], 0.17, 0.15, 8, 2, 0.86, 0, true);
  cylinder([-0.14, 1.44, -0.24], [0.18, 1.44, 0.26], 0.18, 0.17, 8, 2, 0.90, 0, true);

  // Articulated `cabeçalho` draft pole + carved `canga` double ox-yoke (`part = 8`)
  oxYokeAssembly(1.15, 0.62);

  // Two large 10-spoked Iberian cart wheels at z = 0 (`part = 7`)
  for (const [x, side] of [[-0.86, -1], [0.86, 1]]) {
    spokedWheel(x, OX_CART_AXLE, side, 10, 14);
  }

  return Object.freeze({
    name: 'ox_cart',
    neckPivot: Object.freeze([OX_CART_AXLE.r, 0.62, 1.15]),
    legY: OX_CART_AXLE.r,
    frontZ: OX_CART_AXLE.z,
    backZ: OX_CART_AXLE.z,
    height: 1.64,
    vertices: new Float32Array(v),
    indices: new Uint32Array(idx),
    indexCount: idx.length,
  });
}

let cachedWagonMesh = null;
let cachedCoachMesh = null;
let cachedOxCartMesh = null;
let cachedVehicleMeshes = null;

export function getWagonMesh() { return cachedWagonMesh ??= buildWagonMesh(); }
export function getCoachMesh() { return cachedCoachMesh ??= buildCoachMesh(); }
export function getOxCartMesh() { return cachedOxCartMesh ??= buildOxCartMesh(); }
export function getVehicleMeshes() {
  return cachedVehicleMeshes ??= Object.freeze([getWagonMesh(), getCoachMesh(), getOxCartMesh()]);
}
