// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ship's colours as a material of her hull shader (js/wgsl/caravel.js): the bunting of her ensign and her masthead
// pennant (js/vessel-detail.js puts the cloth in her assembly and flies it in her pose pass), woven with the pattern of
// the colours she wears (js/ship-colors.js SHIP_COLORS, by code; 8 is the white flag she strikes to).

// The hull program reads a flag's corner as its own material: the cloth's bunting (VESSEL_ENSIGN_MATERIAL 29,
// VESSEL_PENNANT_MATERIAL 30) is told apart from every other material by VESSEL_COLOURS_MATERIAL plus the colours'
// code, plus VESSEL_COLOURS_PENNANT on the pennant.
export const VESSEL_ENSIGN_MATERIAL = 29;
export const VESSEL_PENNANT_MATERIAL = 30;
export const VESSEL_COLOURS_MATERIAL = 64;
export const VESSEL_COLOURS_PENNANT = 16;

// u along the fly from the hoist, v down the hoist; `weave` fades the weave out where a pixel spans its threads.
export const VESSEL_COLOURS_WGSL = /* wgsl */ `
fn vesselColoursPattern(u: f32, v: f32, code: i32, pennant: bool, weaveFade: f32) -> vec3f {
  let cx = u - 0.46;
  let cy = v - 0.50;
  let weave = 1.0 + 0.04 * weaveFade * sin(u * 140.0) * sin(v * 95.0);
  // The hem's doubled cloth.
  let border = min(min(u, 1.0 - u), min(v, 1.0 - v));
  let hem = smoothstep(0.0, 0.025, border);
  let hemShade = 0.90 + 0.10 * hem;
  if (code == 8) {
    // The white flag of surrender.
    let truceSeam = 0.94 + 0.04 * smoothstep(0.01, 0.03, abs(v - 0.5));
    return vec3f(0.92, 0.91, 0.87) * weave * truceSeam * (0.92 + 0.08 * hem);
  }
  if (code == 9) {
    // The Indigenous Confederacy: wampum indigo, a terracotta border, a white shell belt and a golden sun disc.
    var col = vec3f(0.11, 0.19, 0.36);
    if (v < 0.20 || v > 0.80) { col = vec3f(0.62, 0.16, 0.08); }
    let beltY = abs(v - 0.50);
    let diamond = abs(fract(u * 7.0) - 0.5) * 0.12 + beltY;
    if (beltY < 0.045 || (diamond < 0.095 && beltY < 0.11)) { col = vec3f(0.88, 0.85, 0.77); }
    let sx = (u - 0.44) * 1.38;
    let sy = v - 0.50;
    let r = length(vec2f(sx, sy));
    let ray = 0.035 * max(0.0, cos(atan2(sy, sx) * 8.0));
    if (r < 0.145 + ray) { col = vec3f(0.86, 0.64, 0.16); }
    return col * weave * hemShade;
  }
  if (code == 7) {
    // Sans quartier: solid crimson.
    return vec3f(0.58, 0.05, 0.05) * weave * (0.88 + 0.12 * hem);
  }
  if (code == 6) {
    // The Jolly Roger: a black field, a white skull and crossed bones; the pennant is striped.
    var col = vec3f(0.045, 0.045, 0.052);
    if (pennant) {
      col = mix(col, vec3f(0.84, 0.82, 0.76), step(0.38, abs(v - 0.5)) * 0.7);
      return col * weave * hemShade;
    }
    let sx = (u - 0.46) * 1.45;
    let sy = v - 0.42;
    let cranium = length(vec2f(sx, sy * 1.15)) < 0.19;
    let jaw = abs(sx) < 0.095 && sy > 0.08 && sy < 0.23;
    let leftEye = length(vec2f(sx + 0.068, sy + 0.015)) < 0.044;
    let rightEye = length(vec2f(sx - 0.068, sy + 0.015)) < 0.044;
    let nose = abs(sx) < 0.024 && sy > 0.02 && sy < 0.075;
    let teeth = sy > 0.145 && sy < 0.175 && abs(sx) < 0.08 && fract(sx * 28.0) < 0.35;
    let skull = (cranium || jaw) && !leftEye && !rightEye && !nose && !teeth;
    let bx = (u - 0.46) * 1.25;
    let by = v - 0.52;
    let reach = length(vec2f(bx, by));
    let bones = reach < 0.34 && reach > 0.15 && (abs(bx * 0.52 - by * 0.85) < 0.028 || abs(bx * 0.52 + by * 0.85) < 0.028);
    if (skull || bones) { col = vec3f(0.88, 0.86, 0.80); }
    return col * weave * hemShade;
  }
  if (code == 2) {
    // Castile: a white field and the crimson ragged Cross of Burgundy.
    var col = vec3f(0.88, 0.85, 0.78);
    let sx = u - 0.48;
    let sy = v - 0.50;
    let notch1 = 0.022 * step(0.45, fract((sx + sy) * 9.5));
    let notch2 = 0.022 * step(0.45, fract((sx - sy) * 9.5));
    if (abs(sx * 0.62 - sy * 0.78) < 0.055 + notch1 || abs(sx * 0.62 + sy * 0.78) < 0.055 + notch2) { col = vec3f(0.66, 0.07, 0.08); }
    return col * weave * hemShade;
  }
  if (code == 3) {
    // France: a royal blue field, a white cross and golden fleurs-de-lis.
    var col = vec3f(0.08, 0.16, 0.46);
    if (abs(u - 0.44) < 0.065 || abs(v - 0.50) < 0.095) {
      col = vec3f(0.89, 0.88, 0.84);
    } else if (length(vec2f((abs(u - 0.44) - 0.22) * 1.3, abs(v - 0.50) - 0.24)) < 0.065) {
      col = vec3f(0.82, 0.65, 0.14);
    }
    return col * weave * hemShade;
  }
  if (code == 4) {
    // Vizcaya: a crimson field, a green saltire and a white cross.
    var col = vec3f(0.64, 0.08, 0.09);
    let sx = u - 0.48;
    let sy = v - 0.50;
    if (abs(sx * 0.62 - sy * 0.78) < 0.05 || abs(sx * 0.62 + sy * 0.78) < 0.05) { col = vec3f(0.12, 0.38, 0.18); }
    if (abs(u - 0.48) < 0.055 || abs(v - 0.50) < 0.085) { col = vec3f(0.89, 0.87, 0.82); }
    return col * weave * hemShade;
  }
  if (code == 5) {
    // England: a white field and the red cross of Saint George.
    var col = vec3f(0.89, 0.87, 0.82);
    if (abs(u - 0.46) < 0.065 || abs(v - 0.50) < 0.10) { col = vec3f(0.68, 0.07, 0.08); }
    return col * weave * hemShade;
  }
  // Portugal (1): a white field, the crimson Cross of the Order of Christ and the blue quinas on their shield.
  var col = vec3f(0.89, 0.86, 0.79);
  let dx = abs(cx);
  let dy = abs(cy);
  let patteeV = dx < (0.052 + 0.085 * smoothstep(0.18, 0.34, dy));
  let patteeH = dy < (0.068 + 0.095 * smoothstep(0.15, 0.28, dx));
  if (dx < 0.30 && dy < 0.36 && (patteeV || patteeH)) {
    col = vec3f(0.66, 0.07, 0.07);
    if ((dx < 0.022 && dy < 0.30) || (dy < 0.028 && dx < 0.25)) { col = vec3f(0.91, 0.89, 0.84); }
  }
  if (dx < 0.095 && dy < 0.125) {
    col = vec3f(0.68, 0.08, 0.08);
    if (dx < 0.068 && dy < 0.092) {
      col = vec3f(0.90, 0.88, 0.83);
      let quina = (dx < 0.018 && dy < 0.024) || (dx < 0.018 && abs(dy - 0.052) < 0.020) || (abs(dx - 0.038) < 0.016 && dy < 0.024);
      if (quina) { col = vec3f(0.09, 0.20, 0.52); }
    }
  }
  return col * weave * hemShade;
}
`;
