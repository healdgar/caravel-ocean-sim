// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ocean-going merchant ships (cogs, hulks, carracks) and inland river trade barges from Castle & Commons,
// modeled on cogGeom and bargeGeom and animated smoothly under both 1x real-time play and Chart Course warp.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { SHADOW_FRAME } from './wgsl/shadows.js';
import { terrainSurfaceSample } from './terrain-model.js';

export const TRADE_VESSEL_VERTEX_FLOATS = 8;
export const TRADE_VESSEL_INSTANCE_FLOATS = 8;
export const TRADE_VESSEL_ARCHETYPES = 7; // 0: cog sail, 1: cog moored, 2: carrack sail, 3: carrack moored, 4: river barge, 5: lateen caravel, 6: harbor barque
export const MAX_TRADE_VESSELS = 96;

function pushTri(out, a, b, c, matId, tone = 0.5) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-8) return;
  nx /= len; ny /= len; nz /= len;
  out.push(
    a[0], a[1], a[2], nx, ny, nz, matId, tone,
    b[0], b[1], b[2], nx, ny, nz, matId, tone,
    c[0], c[1], c[2], nx, ny, nz, matId, tone,
  );
}

function pushQuad(out, a, b, c, d, matId, tone = 0.5) {
  pushTri(out, a, b, c, matId, tone);
  pushTri(out, a, c, d, matId, tone);
}

function pushBox(out, cx, cy, cz, w, h, d, matId, tone = 0.5, tiltX = 0) {
  const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
  const ct = Math.cos(tiltX), st = Math.sin(tiltX);
  const pt = (lx, ly, lz) => [cx + lx, cy + ly * ct - lz * st, cz + ly * st + lz * ct];
  const p000 = pt(-hw, -hh, -hd), p100 = pt(hw, -hh, -hd), p010 = pt(-hw, hh, -hd), p110 = pt(hw, hh, -hd);
  const p001 = pt(-hw, -hh, hd), p101 = pt(hw, -hh, hd), p011 = pt(-hw, hh, hd), p111 = pt(hw, hh, hd);
  pushQuad(out, p001, p101, p111, p011, matId, tone); // +z bow/front
  pushQuad(out, p100, p000, p010, p110, matId, tone); // -z stern
  pushQuad(out, p101, p100, p110, p111, matId, tone); // +x stbd
  pushQuad(out, p000, p001, p011, p010, matId, tone); // -x port
  pushQuad(out, p011, p111, p110, p010, matId, tone); // +y deck/top
  pushQuad(out, p000, p100, p101, p001, matId, tone); // -y keel
}

// Tapered hull prism with wider top/amidships flare and sharp stempost toward +Z.
function pushHullSection(out, z0, y0, y1, wBot0, wTop0, z1, y0b, y1b, wBot1, wTop1, matId, tone = 0.45) {
  const a0 = [-wBot0, y0, z0], a1 = [wBot0, y0, z0], a2 = [wTop0, y1, z0], a3 = [-wTop0, y1, z0];
  const b0 = [-wBot1, y0b, z1], b1 = [wBot1, y0b, z1], b2 = [wTop1, y1b, z1], b3 = [-wTop1, y1b, z1];
  pushQuad(out, b0, b1, b2, b3, matId, tone); // forward cap
  pushQuad(out, a1, a0, a3, a2, matId, tone); // aft cap
  pushQuad(out, a1, a2, b2, b1, matId, tone); // starboard
  pushQuad(out, b0, b3, a3, a0, matId, tone); // port
  pushQuad(out, a3, b3, b2, a2, 1, tone + 0.15); // deck top (matId 1)
  pushQuad(out, b0, a0, a1, b1, matId, tone * 0.7); // bottom
}

function pushOctCylinder(out, cx, cy, cz, rBot, rTop, len, matId, tone = 0.5, axis = 'y') {
  const N = 8;
  const ring = (pos, r) => {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      if (axis === 'y') pts.push([cx + Math.cos(a) * r, cy + pos, cz + Math.sin(a) * r]);
      else pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz + pos]);
    }
    return pts;
  };
  const r0 = ring(-len * 0.5, rBot), r1 = ring(len * 0.5, rTop);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    pushQuad(out, r0[i], r0[j], r1[j], r1[i], matId, tone);
  }
}

function pushBillowedSail(out, cx, cy, cz, width, height, belly = 1.15, bands = true) {
  const cols = 4, rows = 4;
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const row = [];
    const wy = cy + (v - 0.5) * height;
    const wSpan = width * (0.94 + 0.08 * Math.sin(v * Math.PI));
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const wx = cx + (u - 0.5) * wSpan;
      const wz = cz + Math.sin(v * Math.PI) * (0.45 + 0.55 * Math.sin(u * Math.PI)) * belly;
      row.push([wx, wy, wz]);
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    const bandMat = bands && r === 1 ? 4 : 3;
    const tone = r === 1 ? 0.85 : 0.65;
    for (let c = 0; c < cols; c++) {
      // Double-sided canvas faces
      pushQuad(out, grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c], bandMat, tone);
      pushQuad(out, grid[r][c + 1], grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], bandMat, tone);
    }
  }
}

function buildCogGeometry(underSail) {
  const v = [];
  // Clinker round-bellied hull facing +Z (LOA ~16.5 m, beam ~5.6 m)
  pushHullSection(v, -7.2, -0.5, 2.5, 1.35, 2.25, -2.5, -0.8, 2.3, 1.95, 2.85, 0, 0.45);
  pushHullSection(v, -2.5, -0.8, 2.3, 1.95, 2.85, 3.8, -0.7, 2.4, 1.65, 2.55, 0, 0.50);
  pushHullSection(v, 3.8, -0.7, 2.4, 1.65, 2.55, 8.2, 0.1, 2.7, 0.22, 0.55, 0, 0.42);
  // Forecastle (+Z) & elevated sterncastle (-Z)
  pushBox(v, 0, 3.3, 5.9, 3.8, 1.6, 3.2, 0, 0.55);
  pushBox(v, 0, 3.55, -5.8, 4.4, 2.1, 3.9, 0, 0.52);
  pushBox(v, 0, 4.7, -5.8, 4.6, 0.35, 4.1, 1, 0.65);
  // Cargo hatch amidships
  pushBox(v, 0, 2.6, 0.8, 2.2, 0.65, 2.8, 5, 0.45);
  // Central mast, crow's nest, and cross-yard
  pushOctCylinder(v, 0, 8.4, 0.4, 0.30, 0.16, 12.6, 2, 0.45, 'y');
  pushBox(v, 0, 13.8, 0.4, 1.1, 0.45, 1.1, 2, 0.4);
  pushBox(v, 0, 11.8, 0.65, 8.4, 0.24, 0.24, 2, 0.5);
  // Red pennant flying from masthead
  pushQuad(v, [0, 14.5, 0.4], [0, 14.5, -1.6], [0, 15.1, -1.3], [0, 15.1, 0.4], 4, 0.85);
  pushQuad(v, [0, 14.5, -1.6], [0, 14.5, 0.4], [0, 15.1, 0.4], [0, 15.1, -1.3], 4, 0.85);
  if (underSail) {
    pushBillowedSail(v, 0, 8.0, 0.85, 7.6, 7.4, 1.25, true);
  } else {
    // Furled linen bundle lashed along the main yard
    pushBox(v, 0, 11.45, 0.65, 7.8, 0.65, 0.65, 3, 0.6);
  }
  return new Float32Array(v);
}

function buildCarrackGeometry(underSail) {
  const v = [];
  // High-sided ocean carrack facing +Z (LOA ~24 m, beam ~7.4 m)
  pushHullSection(v, -10.5, -0.7, 3.2, 1.8, 2.9, -3.5, -1.0, 3.0, 2.65, 3.75, 0, 0.45);
  pushHullSection(v, -3.5, -1.0, 3.0, 2.65, 3.75, 5.2, -0.9, 3.1, 2.25, 3.35, 0, 0.50);
  pushHullSection(v, 5.2, -0.9, 3.1, 2.25, 3.35, 11.4, 0.2, 3.6, 0.28, 0.72, 0, 0.42);
  // Overhanging beak forecastle & tiered quarterdeck/stern gallery
  pushBox(v, 0, 4.4, 9.6, 4.6, 2.1, 5.0, 0, 0.58);
  pushBox(v, 0, 4.2, -7.2, 5.6, 2.1, 6.2, 0, 0.52);
  pushBox(v, 0, 5.7, -8.5, 4.9, 1.5, 4.0, 0, 0.55);
  // Bowsprit & three masts
  pushBox(v, 0, 5.6, 13.5, 0.24, 0.24, 6.2, 2, 0.5, -0.32);
  pushOctCylinder(v, 0, 10.6, 0.4, 0.38, 0.18, 16.0, 2, 0.45, 'y'); // main
  pushOctCylinder(v, 0, 9.6, 7.6, 0.28, 0.14, 11.2, 2, 0.45, 'y'); // fore
  pushOctCylinder(v, 0, 9.5, -6.2, 0.24, 0.12, 9.5, 2, 0.45, 'y'); // mizzen
  pushBox(v, 0, 14.8, 0.68, 10.4, 0.28, 0.28, 2, 0.5);
  pushBox(v, 0, 12.6, 7.85, 7.2, 0.22, 0.22, 2, 0.5);
  pushBox(v, 0, 17.6, 0.62, 6.2, 0.2, 0.2, 2, 0.5);
  // Banners
  pushQuad(v, [0, 18.2, 0.4], [0, 18.2, -2.0], [0, 19.0, -1.6], [0, 19.0, 0.4], 4, 0.9);
  pushQuad(v, [0, 18.2, -2.0], [0, 18.2, 0.4], [0, 19.0, 0.4], [0, 19.0, -1.6], 4, 0.9);
  if (underSail) {
    pushBillowedSail(v, 0, 9.9, 0.95, 9.6, 8.8, 1.55, true);
    pushBillowedSail(v, 0, 15.8, 0.85, 5.6, 3.6, 0.85, false);
    pushBillowedSail(v, 0, 9.2, 8.0, 6.6, 6.2, 1.15, true);
    // Mizzen lateen canvas
    pushQuad(v, [0, 7.8, -5.8], [0, 7.8, -10.5], [0.55, 11.2, -6.0], [0.55, 13.0, -4.4], 3, 0.7);
    pushQuad(v, [0, 7.8, -10.5], [0, 7.8, -5.8], [0.55, 13.0, -4.4], [0.55, 11.2, -6.0], 3, 0.7);
  } else {
    pushBox(v, 0, 14.4, 0.68, 9.6, 0.72, 0.72, 3, 0.6);
    pushBox(v, 0, 12.2, 7.85, 6.6, 0.6, 0.6, 3, 0.6);
  }
  return new Float32Array(v);
}

function buildBargeGeometry() {
  const v = [];
  // Flat-bottomed river & estuary trade barge modeled on bargeGeom() facing +Z (~11.5 m LOA, 3.4 m beam)
  pushHullSection(v, -5.4, -0.22, 0.92, 0.95, 1.45, -2.0, -0.25, 0.88, 1.38, 1.72, 0, 0.48);
  pushHullSection(v, -2.0, -0.25, 0.88, 1.38, 1.72, 2.8, -0.25, 0.90, 1.32, 1.66, 0, 0.50);
  pushHullSection(v, 2.8, -0.25, 0.90, 1.32, 1.66, 5.8, 0.08, 1.05, 0.35, 0.62, 0, 0.44);
  // Deck planks & low gunwale rails
  pushBox(v, -1.62, 1.06, 0.2, 0.14, 0.32, 8.2, 0, 0.55);
  pushBox(v, 1.62, 1.06, 0.2, 0.14, 0.32, 8.2, 0, 0.55);
  // Stacked cargo: wine casks, grain sacks & bound crates
  pushBox(v, -0.45, 1.55, -1.8, 1.7, 1.25, 2.2, 5, 0.55);
  pushBox(v, 0.55, 1.45, 0.6, 1.5, 1.05, 1.8, 5, 0.38);
  pushOctCylinder(v, -0.65, 1.45, 1.2, 0.52, 0.52, 1.45, 0, 0.35, 'z');
  pushBox(v, 0.15, 2.25, -1.5, 1.1, 0.72, 1.2, 3, 0.65); // linen bale cover
  // Stern sweep tiller
  pushBox(v, 0, 1.15, -5.9, 0.14, 0.14, 2.4, 2, 0.42, 0.15);
  // Poling boatman on the bow deck (+Z), matId = 6 triggers animated setting-pole stroke in VS
  pushBox(v, 0.0, 1.38, 3.85, 0.32, 0.9, 0.28, 5, 0.28); // legs/skirt
  pushBox(v, 0.0, 2.08, 3.85, 0.54, 0.78, 0.36, 5, 0.25); // tunic
  pushBox(v, 0.0, 2.66, 3.85, 0.26, 0.30, 0.26, 5, 0.85); // head + wool cap
  // Long setting pole (matId 6 = articulated pole & arms anchored near shoulder [0, 2.1, 4.1])
  pushBox(v, 0.42, 1.85, 4.25, 0.09, 4.6, 0.09, 6, 0.48, 0.42);
  pushBox(v, 0.36, 2.15, 4.02, 0.16, 0.52, 0.16, 6, 0.25, 0.35);
  return new Float32Array(v);
}

function pushLateenSail(out, cx, yLow, zFront, yPeak, zAft, yClew, zClew, belly = 0.68, stripe = true) {
  const rows = 4, cols = 4;
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const v = r / rows; // 0 at yard foot -> 1 at peak
    const ySpar = yLow + (yPeak - yLow) * v;
    const zSpar = zFront + (zAft - zFront) * v;
    const yLeech = yClew + (yPeak - yClew) * v;
    const zLeech = zClew + (zAft - zClew) * v;
    const row = [];
    for (let c = 0; c <= cols; c++) {
      const u = c / cols;
      const y = ySpar + (yLeech - ySpar) * u;
      const z = zSpar + (zLeech - zSpar) * u;
      const camber = Math.sin(v * Math.PI) * Math.sin(u * Math.PI) * (1 - 0.35 * v) * belly;
      row.push([cx + camber, y, z]);
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    const bandMat = stripe && r === 1 ? 4 : 3;
    const tone = r === 1 ? 0.85 : 0.72;
    for (let c = 0; c < cols; c++) {
      pushQuad(out, grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c], bandMat, tone);
      pushQuad(out, grid[r][c + 1], grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], bandMat, tone);
    }
  }
}

function buildLateenCaravelGeometry() {
  const v = [];
  // Sleek Iberian lateen caravel / fragata facing +Z (~15.5 m LOA, narrow beam, raked stem, low quarterdeck)
  pushHullSection(v, -6.6, -0.45, 2.25, 1.05, 1.65, -2.2, -0.75, 1.95, 1.55, 2.15, 0, 0.48);
  pushHullSection(v, -2.2, -0.75, 1.95, 1.55, 2.15, 3.6, -0.68, 2.05, 1.32, 1.88, 0, 0.52);
  pushHullSection(v, 3.6, -0.68, 2.05, 1.32, 1.88, 8.4, 0.25, 2.65, 0.16, 0.42, 0, 0.44);
  // Low quarterdeck & timber cargo amidships
  pushBox(v, 0, 2.55, -4.7, 3.1, 1.05, 3.8, 0, 0.54);
  pushBox(v, 0, 2.25, 0.4, 1.85, 0.55, 2.4, 5, 0.42);
  // Two masts & angled lateen yards
  pushOctCylinder(v, 0, 7.6, 1.8, 0.24, 0.12, 11.4, 2, 0.46, 'y');
  pushOctCylinder(v, 0, 6.2, -4.0, 0.19, 0.10, 8.8, 2, 0.46, 'y');
  pushBox(v, 0.18, 9.2, 1.2, 0.16, 0.16, 11.2, 2, 0.48, -0.58);
  pushBox(v, 0.14, 7.2, -4.4, 0.13, 0.13, 8.2, 2, 0.48, -0.54);
  // Red pennant at mainmast truck
  pushQuad(v, [0, 12.8, 1.8], [0, 12.8, -0.1], [0, 13.4, 0.2], [0, 13.4, 1.8], 4, 0.88);
  pushQuad(v, [0, 12.8, -0.1], [0, 12.8, 1.8], [0, 13.4, 1.8], [0, 13.4, 0.2], 4, 0.88);
  // Sweeping billowing lateen sails on main & mizzen
  pushLateenSail(v, 0.22, 5.2, 5.9, 13.0, -3.5, 4.0, -2.4, 0.88, true);
  pushLateenSail(v, 0.18, 4.3, -1.0, 10.2, -7.2, 3.6, -5.8, 0.62, false);
  return new Float32Array(v);
}

function buildHarborBarqueGeometry() {
  const v = [];
  // Agile bay lighter / fishing barque facing +Z (~9.6 m LOA, beam 2.8 m)
  pushHullSection(v, -4.2, -0.30, 1.15, 0.72, 1.15, -1.0, -0.42, 1.05, 1.08, 1.44, 0, 0.46);
  pushHullSection(v, -1.0, -0.42, 1.05, 1.08, 1.44, 2.4, -0.38, 1.12, 0.92, 1.28, 0, 0.50);
  pushHullSection(v, 2.4, -0.38, 1.12, 0.92, 1.28, 5.2, 0.12, 1.42, 0.14, 0.34, 0, 0.44);
  // Coamings, stowed nets & cargo casks
  pushBox(v, -0.25, 1.28, -0.6, 1.15, 0.72, 1.8, 5, 0.36);
  pushOctCylinder(v, 0.42, 1.28, 0.6, 0.38, 0.38, 1.1, 0, 0.38, 'z');
  // Steersman
  pushBox(v, 0.0, 1.38, -2.9, 0.34, 0.72, 0.26, 5, 0.30);
  pushBox(v, 0.0, 1.88, -2.9, 0.22, 0.24, 0.22, 5, 0.85);
  // Short mast, canted spar, and dipped lateen lugsail
  pushOctCylinder(v, 0, 4.4, 0.8, 0.14, 0.08, 6.4, 2, 0.45, 'y');
  pushBox(v, 0.12, 5.4, 0.5, 0.11, 0.11, 6.4, 2, 0.48, -0.52);
  pushLateenSail(v, 0.15, 2.8, 3.4, 7.6, -2.1, 2.2, -1.5, 0.52, false);
  return new Float32Array(v);
}

const ARCHETYPE_MESHES = [
  () => buildCogGeometry(true),
  () => buildCogGeometry(false),
  () => buildCarrackGeometry(true),
  () => buildCarrackGeometry(false),
  () => buildBargeGeometry(),
  () => buildLateenCaravelGeometry(),
  () => buildHarborBarqueGeometry(),
];

function hashU32(a, b = 0) {
  let x = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177) | 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function buildPolylineRoute(rawPts, origin, elevationAt = null) {
  const pts = [];
  let total = 0;
  for (let i = 0; i < rawPts.length; i++) {
    const p = rawPts[i];
    const x = origin.x + p.x;
    const z = origin.z + p.z;
    const y = Number.isFinite(p.wy) ? p.wy : (elevationAt ? elevationAt(x, z) : 0);
    if (pts.length) {
      const prev = pts[pts.length - 1];
      const seg = Math.hypot(x - prev.x, z - prev.z);
      if (seg < 0.5 && i < rawPts.length - 1) continue;
      total += seg;
    }
    pts.push({ x, y, z, acc: total });
  }
  return pts.length >= 2 && total > 1 ? { pts, totalLen: total } : null;
}

function evalPolylineAt(pts, dist) {
  if (dist <= 0) {
    const dx = pts[1].x - pts[0].x, dz = pts[1].z - pts[0].z;
    return { x: pts[0].x, y: pts[0].y, z: pts[0].z, tx: dx / (Math.hypot(dx, dz) || 1), tz: dz / (Math.hypot(dx, dz) || 1) };
  }
  const last = pts[pts.length - 1];
  if (dist >= last.acc) {
    const prev = pts[pts.length - 2];
    const dx = last.x - prev.x, dz = last.z - prev.z;
    return { x: last.x, y: last.y, z: last.z, tx: dx / (Math.hypot(dx, dz) || 1), tz: dz / (Math.hypot(dx, dz) || 1) };
  }
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].acc >= dist) {
      const a = pts[i - 1], b = pts[i], span = Math.max(1e-4, b.acc - a.acc), u = (dist - a.acc) / span;
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      return {
        x: a.x + dx * u,
        y: a.y + (b.y - a.y) * u,
        z: a.z + dz * u,
        tx: dx / len,
        tz: dz / len,
      };
    }
  }
  return { x: last.x, y: last.y, z: last.z, tx: 0, tz: 1 };
}

/**
 * Normalizes live board merchant ships (`W.ships`), sea/river caravans, and navigable `riverReaches`
 * into an ordered list of vessel route records for rendering or CPU verification.
 */
export function buildTradeVesselRoutes(snapshot, origin = { x: 0, z: 0 }, { riverReaches = [], places = [], seaLevel = 0, heights = null, region = null, port = null, bridges = [] } = {}) {
  const routes = [];
  const ox = origin.x || 0, oz = origin.z || 0;
  const hasBedSampler = Boolean(heights && region && Number.isFinite(region.span) && region.span > 0);
  const bedRegion = hasBedSampler ? (region.size ? region : { ...region, size: Math.round(Math.sqrt(heights.length)) }) : null;
  const bedElevationAt = (wx, wz) => {
    if (!bedRegion || !bedRegion.size) return -12;
    const half = bedRegion.span * 0.5 - 0.5;
    const cx = Math.max(bedRegion.x - half, Math.min(bedRegion.x + half, wx));
    const cz = Math.max(bedRegion.z - half, Math.min(bedRegion.z + half, wz));
    const y = terrainSurfaceSample(heights, cx, cz, bedRegion);
    return Number.isFinite(y) ? y : -12;
  };
  const dockBerth = port?.dockBerth || null;
  const berthX = dockBerth ? (dockBerth.wx ?? dockBerth.x ?? NaN) : NaN;
  const berthZ = dockBerth ? (dockBerth.wz ?? dockBerth.z ?? NaN) : NaN;
  const isSafeWater = (wx, wz, maxBedY = -2.6, clearance = 18) => {
    if (Number.isFinite(berthX) && Number.isFinite(berthZ) && Math.hypot(wx - berthX, wz - berthZ) < 52) {
      return false;
    }
    if (bedElevationAt(wx, wz) > maxBedY) return false;
    if (clearance > 0 && bedRegion) {
      if (bedElevationAt(wx + clearance, wz) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx - clearance, wz) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx, wz + clearance) > maxBedY + 0.35) return false;
      if (bedElevationAt(wx, wz - clearance) > maxBedY + 0.35) return false;
    }
    return true;
  };
  const nearestSafeWater = (wx, wz, maxBedY = -2.6, minDist = 0, maxRadius = 420, clearance = 18) => {
    if (isSafeWater(wx, wz, maxBedY, clearance) && minDist <= 0) return { x: wx, z: wz };
    for (let r = Math.max(22, minDist); r <= maxRadius; r += 22) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const cx = wx + Math.cos(ang) * r;
        const cz = wz + Math.sin(ang) * r;
        if (isSafeWater(cx, cz, maxBedY, clearance)) return { x: cx, z: cz };
      }
    }
    return { x: wx, z: wz };
  };
  const clampSeaPolyToSafeWater = (poly, maxBedY = -2.4, clearance = 14) => {
    if (!poly || !bedRegion) return poly;
    const pts = [];
    let acc = 0;
    for (let i = 0; i < poly.pts.length; i++) {
      const p = poly.pts[i];
      const safe = nearestSafeWater(p.x, p.z, maxBedY, 0, 360, clearance);
      if (pts.length) {
        const prev = pts[pts.length - 1];
        const seg = Math.hypot(safe.x - prev.x, safe.z - prev.z);
        if (seg < 0.5 && i < poly.pts.length - 1) continue;
        acc += seg;
      }
      pts.push({ x: safe.x, y: p.y, z: safe.z, acc });
    }
    return pts.length >= 2 && acc > 1 ? { pts, totalLen: acc } : poly;
  };
  const isSegmentSafeWater = (a, b, maxBedY = -1.6, clearance = 14) => {
    for (let k = 0; k <= 4; k++) {
      const u = k / 4;
      if (!isSafeWater(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u, maxBedY, clearance)) return false;
    }
    return true;
  };

  const parseFlatPairs = (arr) => {
    const out = [];
    for (let i = 0; i + 1 < arr.length; i += 2) out.push({ x: arr[i], z: arr[i + 1] });
    return out;
  };
  const reachStations = (r) => {
    if (Array.isArray(r?.stations)) return r.stations;
    if (Array.isArray(r?.points)) return r.points.map(([wx, wz, hw, wy]) => ({ wx, wz, hw, wy }));
    return [];
  };
  const riverYAt = (wx, wz) => {
    let bestD = Infinity, bestY = seaLevel + 0.04;
    for (const reach of riverReaches) {
      for (const st of reachStations(reach)) {
        const d = (st.wx - wx) ** 2 + (st.wz - wz) ** 2;
        if (d < bestD) { bestD = d; bestY = st.wy; }
      }
    }
    return bestD < 2500 ? bestY : seaLevel + 0.04;
  };
  const blockedByLowBridge = (wx, wz, wy) => {
    for (const b of bridges ?? []) {
      if (!b || !Number.isFinite(b.deckY)) continue;
      const reach = Math.max(8, (b.length || 12) * 0.55);
      if (Math.hypot(wx - b.x, wz - b.z) <= reach && (b.deckY - wy) < 3.2) return true;
    }
    return false;
  };

  for (const sh of snapshot?.ships ?? []) {
    const carrack = sh.kind === 'carrack' || sh.kind === 'hulk';
    const scale = sh.kind === 'carrack' ? 1.18 : sh.kind === 'hulk' ? 1.05 : sh.kind === 'great cog' ? 0.96 : 0.85;
    const rawPoly = Array.isArray(sh.points) && sh.points.length >= 4 ? buildPolylineRoute(parseFlatPairs(sh.points), { x: ox, z: oz }, () => seaLevel) : null;
    const poly = rawPoly ? clampSeaPolyToSafeWater(rawPoly, -2.4, carrack ? 20 : 14) : null;
    if (sh.phase === 'dock' && sh.berth) {
      const safeB = nearestSafeWater(ox + sh.berth.x, oz + sh.berth.z, -2.6, 0, 420, carrack ? 22 : 16);
      routes.push({
        id: `ship:${sh.id}`, mode: 'sea', phase: 'dock',
        archetype: carrack ? 3 : 1,
        scale,
        depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1,
        berth: { x: safeB.x, y: seaLevel, z: safeB.z, rot: sh.berth.rot || 0 },
        pts: poly?.pts ?? null, totalLen: poly?.totalLen ?? 0,
        phaseOffset: (hashU32(sh.id | 0, 17) % 1000) / 1000,
      });
      continue;
    }
    if (!poly) continue;
    routes.push({
      id: `ship:${sh.id}`, mode: 'sea', phase: sh.phase === 'out' ? 'out' : 'in',
      archetype: carrack ? 2 : 0,
      scale,
      depart: sh.t0 ?? 0, arrive: sh.t1 ?? 1,
      berth: null,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset: (hashU32(sh.id | 0, 29) % 1000) / 1000,
    });
  }

  for (const c of snapshot?.list ?? []) {
    if (c.mode !== 'sea' && c.mode !== 'river') continue;
    if (!Array.isArray(c.points) || c.points.length < 4) continue;
    const isRiver = c.mode === 'river';
    const rawPoly = buildPolylineRoute(parseFlatPairs(c.points), { x: ox, z: oz }, isRiver ? riverYAt : () => seaLevel);
    const poly = rawPoly && !isRiver ? clampSeaPolyToSafeWater(rawPoly, -2.2, 14) : rawPoly;
    if (!poly) continue;
    const seaArchetype = [5, 0, 2, 5][(hashU32(c.index | 0, 41)) & 3];
    routes.push({
      id: `caravan:${c.key ?? c.index}`, mode: c.mode, phase: 'caravan',
      archetype: isRiver ? 4 : seaArchetype,
      scale: isRiver ? 0.96 : seaArchetype === 5 ? 0.88 : 0.90,
      depart: c.depart ?? 0, arrive: Math.max((c.depart ?? 0) + 0.1, c.arrive ?? 1),
      berth: null,
      pts: poly.pts, totalLen: poly.totalLen,
      phaseOffset: (hashU32(c.index | 0, 53) % 1000) / 1000,
    });
  }

  // Add deterministic navigable-reach river trade barges along contiguous stretches clear of low bridges.
  const navigable = [];
  for (const r of riverReaches) {
    const stations = reachStations(r);
    let seg = [];
    const flush = () => {
      if (seg.length >= 3) {
        let len = 0;
        for (let i = 1; i < seg.length; i++) len += Math.hypot(seg[i].wx - seg[i - 1].wx, seg[i].wz - seg[i - 1].wz);
        if (len >= 160) navigable.push({ stations: seg.slice(), length: len });
      }
      seg = [];
    };
    for (const s of stations) {
      if ((s.hw ?? r.minHalfWidth ?? 0) >= 1.75 && !blockedByLowBridge(s.wx, s.wz, s.wy)) seg.push(s);
      else flush();
    }
    flush();
  }
  navigable.sort((a, b) => b.length - a.length);
  for (let ri = 0; ri < navigable.length && routes.length < MAX_TRADE_VESSELS; ri++) {
    const reach = navigable[ri];
    const pts = reach.stations.map((s) => ({ x: s.wx, z: s.wz, wy: s.wy }));
    let acc = 0;
    const linePts = pts.map((p, idx) => {
      if (idx > 0) acc += Math.hypot(p.x - pts[idx - 1].x, p.z - pts[idx - 1].z);
      return { x: p.x, y: p.wy, z: p.z, acc };
    });
    const boats = reach.length > 900 ? 2 : 1;
    for (let b = 0; b < boats && routes.length < MAX_TRADE_VESSELS; b++) {
      routes.push({
        id: `reach:${ri}:${b}`, mode: 'river', phase: 'shuttle',
        archetype: 4, scale: 0.92 + (b * 0.08),
        depart: 0, arrive: 1, berth: null,
        pts: linePts, totalLen: acc,
        phaseOffset: ((hashU32(ri + 1, b + 7) % 1000) / 1000),
      });
    }
  }

  // Synthesize a procedural harbor & bay fleet: anchored ocean carracks/cogs + moving lateen caravels and harbor barques.
  const harbors = (places ?? []).filter((p) => p && (p.harbor || p.harbour || p.kind === 'capital' || p.kind === 'town' || p.kind === 'village'));
  const primary = harbors.find((p) => p.harbor || p.harbour || p.kind === 'capital' || p.kind === 'town')
    || (dockBerth ? { x: berthX, z: berthZ, kind: 'town', harbor: true } : harbors[0]);
  if (primary) {
    const hx = primary.x, hz = primary.z;
    const existingDockSpots = routes.filter((r) => r.phase === 'dock' && r.berth).map((r) => r.berth);
    const farAnchor = existingDockSpots.length < 4;
    if (farAnchor) {
      let addedAnchor = 0;
      const anchorSpots = [];
      for (let dist = 160; dist <= 520 && addedAnchor < 4; dist += 90) {
        for (let a = 0; a < 16 && addedAnchor < 4; a++) {
          const ang = (a / 16) * Math.PI * 2 + dist * 0.017;
          const ax = hx + Math.cos(ang) * dist;
          const az = hz + Math.sin(ang) * dist;
          if (!isSafeWater(ax, az, -3.0, 22)) continue;
          if (existingDockSpots.some((e) => Math.hypot(e.x - ax, e.z - az) < 75)) continue;
          if (anchorSpots.some((e) => Math.hypot(e.x - ax, e.z - az) < 75)) continue;
          anchorSpots.push({ x: ax, z: az });
          const arch = (addedAnchor % 2 === 0) ? 3 : 1;
          routes.push({
            id: `roadstead:${addedAnchor}`, mode: 'sea', phase: 'dock',
            archetype: arch, scale: arch === 3 ? 1.10 : 0.92,
            depart: 0, arrive: 1,
            berth: { x: ax, y: seaLevel, z: az, rot: ang + Math.PI * 0.5 + (addedAnchor * 0.35) },
            pts: null, totalLen: 0,
            phaseOffset: ((hashU32(addedAnchor + 11, 71) % 1000) / 1000),
          });
          addedAnchor++;
        }
      }
    }

    const harborShuttleCount = routes.filter((r) => r.id.startsWith('harbor:')).length;
    if (harborShuttleCount < 4 && routes.length < MAX_TRADE_VESSELS) {
      const candidateTracks = [];
      // 1. Cross-bay & inter-harbor sea shuttle tracks
      for (let i = 0; i < harbors.length; i++) {
        for (let j = i + 1; j < harbors.length; j++) {
          const a = nearestSafeWater(harbors[i].x, harbors[i].z, -2.0, 70, 380, 14);
          const b = nearestSafeWater(harbors[j].x, harbors[j].z, -2.0, 70, 380, 14);
          const mid = nearestSafeWater((a.x + b.x) * 0.5, (a.z + b.z) * 0.5, -2.2, 0, 340, 14);
          if (Math.hypot(b.x - a.x, b.z - a.z) >= 240 && isSegmentSafeWater(a, mid, -1.8, 12) && isSegmentSafeWater(mid, b, -1.8, 12)) {
            candidateTracks.push([a, mid, b]);
          }
        }
      }
      // 2. Offshore harbor traffic crescent lanes
      for (let band = 0; band < 6 && candidateTracks.length < 7; band++) {
        const radius = 260 + band * 165;
        const arc0 = (band * 0.95) - 1.2;
        const rawWaypoints = [];
        for (let step = 0; step < 5; step++) {
          const ang = arc0 + step * 0.42;
          const wx = hx + Math.cos(ang) * radius;
          const wz = hz + Math.sin(ang) * radius;
          if (isSafeWater(wx, wz, -2.0, 14)) rawWaypoints.push({ x: wx, z: wz });
        }
        const safeTrack = [];
        for (const wp of rawWaypoints) {
          if (!safeTrack.length || isSegmentSafeWater(safeTrack[safeTrack.length - 1], wp, -1.8, 12)) safeTrack.push(wp);
        }
        if (safeTrack.length >= 2) candidateTracks.push(safeTrack);
      }

      let addedShuttles = 0;
      for (let ti = 0; ti < candidateTracks.length && addedShuttles < 5 && routes.length < MAX_TRADE_VESSELS; ti++) {
        const raw = candidateTracks[ti];
        let acc = 0;
        const linePts = raw.map((p, idx) => {
          if (idx > 0) acc += Math.hypot(p.x - raw[idx - 1].x, p.z - raw[idx - 1].z);
          return { x: p.x, y: seaLevel, z: p.z, acc };
        });
        if (acc < 120) continue;
        const arch = (ti % 2 === 0) ? 6 : 5;
        routes.push({
          id: `harbor:${ti}`, mode: 'sea', phase: 'shuttle',
          archetype: arch, scale: arch === 5 ? 0.92 : 0.88,
          depart: 0, arrive: 1, berth: null,
          pts: linePts, totalLen: acc,
          phaseOffset: ((hashU32(ti + 5, 97) % 1000) / 1000),
        });
        addedShuttles++;
      }
    }
  }

  return routes.slice(0, MAX_TRADE_VESSELS);
}

/**
 * Computes world pose `(x, y, z, yaw, scale, phase, archetype, motion)` at simulation time `elapsedSec`
 * using the same calendar-plus-real-time-floor velocity law as land caravans.
 */
export function sampleTradeVesselState(route, boardDay, daysPerSecond, elapsedSec) {
  const phaseRad = (route.phaseOffset || 0) * Math.PI * 2;
  if (route.phase === 'dock' && route.berth) {
    const bob = Math.sin(elapsedSec * 1.15 + phaseRad) * 0.14;
    return {
      x: route.berth.x,
      y: route.berth.y + bob,
      z: route.berth.z,
      yaw: route.berth.rot,
      scale: route.scale,
      phase: phaseRad,
      archetype: route.archetype,
      motion: 0,
    };
  }
  const L = Math.max(1, route.totalLen);
  const days = Math.max(0.01, route.arrive - route.depart);
  const minSpeed = route.mode === 'river' ? 1.15 : 2.25;
  const calSpeed = (route.phase === 'shuttle' ? 0 : (L / days) * Math.max(0, daysPerSecond || 0));
  const useFloor = route.phase === 'shuttle' || calSpeed < minSpeed;
  let dist, forwardSign = 1;
  if (route.phase === 'shuttle') {
    const raw = (route.phaseOffset * L + minSpeed * elapsedSec);
    const span = L * 2;
    const m = ((raw % span) + span) % span;
    if (m <= L) { dist = m; forwardSign = 1; }
    else { dist = span - m; forwardSign = -1; }
  } else {
    const rawShare = Math.max(0, Math.min(1, (boardDay - route.depart) / days));
    const share = route.phase === 'out' ? 1 - rawShare : rawShare;
    const baseDist = share * L;
    if (useFloor) {
      const cycle = L + 60;
      const vFloor = Math.max(0, minSpeed - calSpeed);
      const progressed = baseDist + (route.phase === 'out' ? -1 : 1) * vFloor * elapsedSec;
      dist = ((progressed % cycle) + cycle) % cycle;
      if (dist > L) dist = L;
      if (route.phase === 'out') forwardSign = -1;
    } else {
      dist = baseDist;
      if (route.phase === 'out') forwardSign = -1;
    }
  }
  const at = evalPolylineAt(route.pts, Math.max(0, Math.min(L, dist)));
  const tx = at.tx * forwardSign, tz = at.tz * forwardSign;
  const yaw = Math.atan2(tx, tz);
  const swellBob = route.mode === 'sea' ? Math.sin(elapsedSec * 1.1 + phaseRad) * 0.16 : Math.sin(elapsedSec * 1.8 + phaseRad) * 0.03;
  return {
    x: at.x,
    y: at.y + swellBob,
    z: at.z,
    yaw,
    scale: route.scale,
    phase: phaseRad,
    archetype: route.archetype,
    motion: Math.max(calSpeed, minSpeed) / minSpeed,
  };
}

export const TRADE_VESSELS_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + SHADOW_FRAME + /* wgsl */ `
struct TradeNearDomain { domain: vec4f, grid: vec4f };

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(12) var<uniform> nearTerrain: TradeNearDomain;
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;

struct TVVertexIn {
  @location(0) pos: vec3f,
  @location(1) norm: vec3f,
  @location(2) matTone: vec2f,
  @location(3) instPosYaw: vec4f,   // xyz, yaw
  @location(4) instScaleMeta: vec4f, // scale, phase, archetype, motion
};

struct TVVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) matTone: vec2f,
  @location(3) localY: f32,
};

fn animateVesselLocal(pos: vec3f, norm: vec3f, matTone: vec2f, inst: vec4f) -> array<vec3f, 2> {
  var p = pos;
  var n = norm;
  let phase = inst.y;
  let motion = inst.w;
  // Mat ID 6 is the barge boatman's setting pole; sweep it forward and dip rhythmically while underway.
  if (matTone.x > 5.5 && motion > 0.05) {
    let t = F.camPos.w;
    let cyc = t * 2.2 + phase;
    let sweep = sin(cyc) * 0.42 * min(motion, 1.5);
    let pivot = vec3f(0.36, 2.15, 4.0);
    let d = p - pivot;
    let c = cos(sweep);
    let s = sin(sweep);
    p = pivot + vec3f(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
    n = vec3f(n.x, n.y * c - n.z * s, n.y * s + n.z * c);
  }
  return array<vec3f, 2>(p, n);
}

fn vesselWorldTransform(pos: vec3f, norm: vec3f, matTone: vec2f, posYaw: vec4f, scaleMeta: vec4f) -> array<vec3f, 2> {
  let anim = animateVesselLocal(pos, norm, matTone, scaleMeta);
  let yaw = posYaw.w;
  let sc = scaleMeta.x;
  let cy = cos(yaw);
  let sy = sin(yaw);
  // Gentle roll in waves proportional to hull size & speed
  let roll = sin(F.camPos.w * 0.9 + scaleMeta.y * 1.7) * select(select(0.032, 0.025, scaleMeta.z > 4.5), 0.014, abs(scaleMeta.z - 4.0) < 0.5);
  let cr = cos(roll);
  let sr = sin(roll);
  let lp = anim[0] * sc;
  let rp = vec3f(lp.x * cr - lp.y * sr, lp.x * sr + lp.y * cr, lp.z);
  let ln = anim[1];
  let rn = vec3f(ln.x * cr - ln.y * sr, ln.x * sr + ln.y * cr, ln.z);
  let wp = posYaw.xyz + vec3f(rp.x * cy + rp.z * sy, rp.y, -rp.x * sy + rp.z * cy);
  let wn = normalize(vec3f(rn.x * cy + rn.z * sy, rn.y, -rn.x * sy + rn.z * cy));
  return array<vec3f, 2>(wp, wn);
}

@vertex fn tvVS(v: TVVertexIn) -> TVVertexOut {
  let tr = vesselWorldTransform(v.pos, v.norm, v.matTone, v.instPosYaw, v.instScaleMeta);
  let shifted = tr[0] + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  var o: TVVertexOut;
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  o.world = shifted;
  o.normal = tr[1];
  o.matTone = v.matTone;
  o.localY = v.pos.y * v.instScaleMeta.x;
  return o;
}

@fragment fn tvFS(in: TVVertexOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let mat = i32(round(in.matTone.x));
  let tone = in.matTone.y;
  var baseCol = vec3f(0.052, 0.031, 0.017);
  if (mat == 0) {
    // Calibrated linear-HDR hull oak: dark pitch-tarred strakes near waterline, weathered timber above.
    let wet = 1.0 - smoothstep(0.10, 0.85, in.localY);
    let strake = 0.91 + 0.09 * sin(in.localY * 18.0);
    baseCol = mix(vec3f(0.052, 0.031, 0.017), vec3f(0.018, 0.013, 0.010), wet) * (0.84 + 0.32 * tone) * strake;
  } else if (mat == 1) {
    baseCol = vec3f(0.105, 0.074, 0.044) * (0.88 + 0.25 * tone);
  } else if (mat == 2 || mat == 6) {
    baseCol = vec3f(0.068, 0.045, 0.025);
  } else if (mat == 3) {
    baseCol = vec3f(0.29, 0.26, 0.20) * (0.90 + 0.14 * tone);
  } else if (mat == 4) {
    baseCol = vec3f(0.19, 0.026, 0.018);
  } else {
    baseCol = vec3f(0.085, 0.062, 0.036) * (0.75 + 0.45 * tone);
  }
  let sunDir = normalize(F.sunDir.xyz);
  let sunVis = sunIlluminance();
  let isSail = (mat == 3 || mat == 4);
  let nDotL = select(max(dot(n, sunDir), 0.0), max(abs(dot(n, sunDir)) * 0.85, 0.28), isSail);
  let skyCol = skyAtmo(normalize(vec3f(n.x * 0.4, max(n.y, 0.18), n.z * 0.4)));
  let lit = baseCol * (sunVis * nDotL * 0.95 + skyCol * (0.45 + 0.35 * max(n.y, 0.0)));
  return vec4f(surfaceAir(lit, in.world), 1.0);
}

@vertex fn tvShadowVS(v: TVVertexIn) -> @builtin(position) vec4f {
  let tr = vesselWorldTransform(v.pos, v.norm, v.matTone, v.instPosYaw, v.instScaleMeta);
  let shifted = tr[0] + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  return landSH.lightView * vec4f(shifted - landSH.origin.xyz, 1.0);
}
`;

export function createTradeVessels({
  device,
  format,
  samples = 1,
  shader,
  resources,
  shadowFormat = 'depth32float',
} = {}) {
  if (!device || !shader || !resources) return null;

  let lastContext = null;
  const meshes = ARCHETYPE_MESHES.map((build, i) => {
    const data = build();
    const buf = device.createBuffer({
      label: `trade vessel archetype ${i}`,
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buf, 0, data);
    return { buffer: buf, vertexCount: data.length / TRADE_VESSEL_VERTEX_FLOATS };
  });

  const instanceBuffers = meshes.map((_, i) => device.createBuffer({
    label: `trade vessel instances ${i}`,
    size: MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  }));

  const vertexBuffers = [
    {
      arrayStride: TRADE_VESSEL_VERTEX_FLOATS * 4,
      stepMode: 'vertex',
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
      ],
    },
    {
      arrayStride: TRADE_VESSEL_INSTANCE_FLOATS * 4,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32x4' },
        { shaderLocation: 4, offset: 16, format: 'float32x4' },
      ],
    },
  ];

  let pipe = null, shadowPipe = null, bindGroup = null, shadowBindGroup = null;
  const modulePromise = Promise.resolve(shader(TRADE_VESSELS_WGSL, 'trade vessels'));
  let routes = [];
  let boardDay = 0, daysPerSecond = 0, simElapsedSec = 0, hasSimClock = false;
  let lastUploadTime = -Infinity;
  const counts = new Uint32Array(TRADE_VESSEL_ARCHETYPES);
  const scratch = Array.from({ length: TRADE_VESSEL_ARCHETYPES }, () => new Float32Array(MAX_TRADE_VESSELS * TRADE_VESSEL_INSTANCE_FLOATS));

  const pickEntries = (targetPipe, needed) => {
    const byBinding = new Map(resources.map(([b, r]) => [b, r]));
    return device.createBindGroup({
      layout: targetPipe.getBindGroupLayout(0),
      entries: needed.map((b) => ({ binding: b, resource: byBinding.get(b) })),
    });
  };

  modulePromise.then((module) => Promise.all([
    device.createRenderPipelineAsync({
      label: 'trade vessels render',
      layout: 'auto',
      vertex: { module, entryPoint: 'tvVS', buffers: vertexBuffers },
      fragment: { module, entryPoint: 'tvFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    }),
    device.createRenderPipelineAsync({
      label: 'trade vessels shadow',
      layout: 'auto',
      vertex: { module, entryPoint: 'tvShadowVS', buffers: vertexBuffers },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: shadowFormat, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    }),
  ])).then(([p, sp]) => {
    pipe = p;
    shadowPipe = sp;
    bindGroup = pickEntries(p, [0, 1, 2, 3, 12]);
    shadowBindGroup = pickEntries(sp, [0, 12, 19]);
  }).catch((err) => { console.error('[trade-vessels]', err); });

  function updateInstances(elapsedSec) {
    if (!routes.length) { counts.fill(0); return; }
    if (Math.abs(elapsedSec - lastUploadTime) < 1 / 65) return;
    lastUploadTime = elapsedSec;
    counts.fill(0);
    for (const r of routes) {
      const s = sampleTradeVesselState(r, boardDay, daysPerSecond, elapsedSec);
      const a = Math.max(0, Math.min(TRADE_VESSEL_ARCHETYPES - 1, s.archetype | 0));
      const idx = counts[a];
      if (idx >= MAX_TRADE_VESSELS) continue;
      const dst = scratch[a];
      const off = idx * TRADE_VESSEL_INSTANCE_FLOATS;
      dst[off] = s.x; dst[off + 1] = s.y; dst[off + 2] = s.z; dst[off + 3] = s.yaw;
      dst[off + 4] = s.scale; dst[off + 5] = s.phase; dst[off + 6] = s.archetype; dst[off + 7] = s.motion;
      counts[a] = idx + 1;
    }
    for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
      if (counts[a] > 0) {
        device.queue.writeBuffer(instanceBuffers[a], 0, scratch[a], 0, counts[a] * TRADE_VESSEL_INSTANCE_FLOATS);
      }
    }
  }

  return {
    get count() { return routes.length; },
    setTraffic(snapshot, origin, riverReaches = [], places = [], context = null) {
      if (context) lastContext = context;
      routes = buildTradeVesselRoutes(snapshot, origin, { riverReaches, places, ...(lastContext || {}) });
      lastUploadTime = -Infinity;
      if (Number.isFinite(snapshot?.day)) boardDay = snapshot.day;
    },
    locate(elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      return routes.map((r) => ({ id: r.id, mode: r.mode, phase: r.phase, ...sampleTradeVesselState(r, boardDay, daysPerSecond, t) }));
    },
    setBoardClock(day, rate, elapsedSec = NaN) {
      if (Number.isFinite(day)) boardDay = day;
      if (Number.isFinite(rate)) daysPerSecond = rate;
      if (Number.isFinite(elapsedSec)) { simElapsedSec = elapsedSec; hasSimClock = true; }
    },
    rebind(nextResources) {
      resources = nextResources;
      if (pipe) bindGroup = pickEntries(pipe, [0, 1, 2, 3, 12]);
      if (shadowPipe) shadowBindGroup = pickEntries(shadowPipe, [0, 12, 19]);
    },
    draw(pass, elapsedSec = NaN) {
      const t = Number.isFinite(elapsedSec) ? elapsedSec : (hasSimClock ? simElapsedSec : performance.now() * 0.001);
      updateInstances(t);
      if (!pipe || !bindGroup) return;
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bindGroup);
      for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
        if (!counts[a]) continue;
        pass.setVertexBuffer(0, meshes[a].buffer);
        pass.setVertexBuffer(1, instanceBuffers[a]);
        pass.draw(meshes[a].vertexCount, counts[a]);
      }
    },
    drawShadow(pass) {
      if (!shadowPipe || !shadowBindGroup) return;
      pass.setPipeline(shadowPipe);
      pass.setBindGroup(0, shadowBindGroup);
      for (let a = 0; a < TRADE_VESSEL_ARCHETYPES; a++) {
        if (!counts[a]) continue;
        pass.setVertexBuffer(0, meshes[a].buffer);
        pass.setVertexBuffer(1, instanceBuffers[a]);
        pass.draw(meshes[a].vertexCount, counts[a]);
      }
    },
    destroy() {
      for (const m of meshes) m.buffer?.destroy?.();
      for (const b of instanceBuffers) b?.destroy?.();
      routes = [];
    },
  };
}
