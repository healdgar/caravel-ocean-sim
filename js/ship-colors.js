// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './wgsl/common.js';
import { SKY_RENDER_FUNCS } from './wgsl/sky.js';
import { VESSEL_LIGHTING } from './wgsl/vessel.js';
import { SCENE_SHADOW_SAMPLE } from './wgsl/shadows.js';
import { boatRotate, crowsNestDesignStation, sternEnsignDesignStation } from './boat.js';
import { vesselHull, modelDeck } from './hull.js';
export { sternEnsignDesignStation };

// Historically grounded 16th-century & Age-of-Sail naval ensigns ("ship's colors").
export const SHIP_COLORS = Object.freeze({
  portugal: Object.freeze({
    id: 'portugal',
    code: 1,
    name: 'Kingdom of Portugal (Quinas & Cross of Christ)',
    shortLabel: 'Portugal 🇵🇹',
    faction: 'portuguese',
    isHostile: false,
    isSurrender: false,
    description: 'Royal white field bearing the crimson Order of Christ cross and the five blue escutcheons (quinas) of Lisbon.',
  }),
  castile: Object.freeze({
    id: 'castile',
    code: 2,
    name: 'Crown of Castile (Cross of Burgundy)',
    shortLabel: 'Castile / Spain 🇪🇸',
    faction: 'spanish',
    isHostile: false,
    isSurrender: false,
    description: 'White naval ensign with the crimson ragged saltire of Saint Andrew (Cruz de Borgoña) flown by Spanish naos.',
  }),
  france: Object.freeze({
    id: 'france',
    code: 3,
    name: 'Kingdom of France (Pavillon Royal / Huguenot)',
    shortLabel: 'France 🇫🇷',
    faction: 'french',
    isHostile: false,
    isSurrender: false,
    description: 'Maritime blue field quartered by a white cross with gold fleurs-de-lis flown by Norman and La Rochelle vessels.',
  }),
  basque: Object.freeze({
    id: 'basque',
    code: 4,
    name: 'Señorío de Vizcaya (Biscayan Merchant Colors)',
    shortLabel: 'Vizcaya / Basque',
    faction: 'basque',
    isHostile: false,
    isSurrender: false,
    description: 'Crimson and white merchant ensign of Bilbao and San Sebastián iron-and-wool traders.',
  }),
  england: Object.freeze({
    id: 'england',
    code: 5,
    name: 'Kingdom of England (Tudor St. George Cross)',
    shortLabel: 'England 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    faction: 'english',
    isHostile: false,
    isSurrender: false,
    description: 'White field quartered by the red cross of Saint George.',
  }),
  'jolly-roger': Object.freeze({
    id: 'jolly-roger',
    code: 6,
    name: 'Jolly Roger (Pirate / Sea-Rover Colors)',
    shortLabel: 'Jolly Roger 🏴‍☠️',
    faction: 'pirate',
    isHostile: true,
    isSurrender: false,
    description: 'Black sea-rover ensign bearing a white skull and crossed bones to demand immediate surrender.',
  }),
  'blood-flag': Object.freeze({
    id: 'blood-flag',
    code: 7,
    name: 'Sans Quartier (Red Flag of No Quarter)',
    shortLabel: 'Blood Flag 🚩',
    faction: 'corsair',
    isHostile: true,
    isSurrender: false,
    description: 'Solid crimson battle banner signalling combat to the death without quarter.',
  }),
  surrender: Object.freeze({
    id: 'surrender',
    code: 8,
    name: 'White Flag of Surrender (Struck Colors)',
    shortLabel: 'Surrendered 🏳️',
    faction: 'neutral',
    isHostile: false,
    isSurrender: true,
    description: 'Plain white flag hoisted after striking national colors to signal surrender and ask for quarter.',
  }),
  'indigenous-confederacy': Object.freeze({
    id: 'indigenous-confederacy',
    code: 9,
    name: 'Sovereign Indigenous Confederacy (Wampum & Sun Zemi Banner)',
    shortLabel: 'Indigenous Confederacy ☀️',
    faction: 'indigenous',
    isHostile: false,
    isSurrender: false,
    description: 'Wampum-indigo and terracotta-ochre treaty banner bearing a golden Guanín sun disc and white shell-wampum belt.',
  }),
});

export const DEFAULT_SHIP_COLORS = 'portugal';

export function getShipColorsInfo(colorsId) {
  return SHIP_COLORS[colorsId] ?? SHIP_COLORS[DEFAULT_SHIP_COLORS];
}

export function setVesselColors(boat, colorsId) {
  if (!boat) return getShipColorsInfo(DEFAULT_SHIP_COLORS);
  const info = getShipColorsInfo(colorsId);
  boat.colors = info.id;
  if (info.isSurrender) {
    if (boat.damage) boat.damage.surrendered = true;
  } else if (boat.damage && boat.damage.surrendered && colorsId !== 'surrender') {
    boat.damage.surrendered = false;
    boat.damage.surrenderReason = null;
  }
  return info;
}

export function hoistBattleColors(boat, battleColorsId = 'jolly-roger') {
  if (!boat || boat.damage?.surrendered) return getShipColorsInfo(boat?.colors);
  if (!boat.falseColors && boat.colors && boat.colors !== battleColorsId) {
    boat.falseColors = boat.colors;
  }
  return setVesselColors(boat, battleColorsId);
}

export function strikeVesselColors(boat, reason = 'Struck colors') {
  if (!boat) return null;
  if (boat.colors && boat.colors !== 'surrender') {
    boat.previousColors = boat.colors;
  }
  boat.colors = 'surrender';
  boat.sailSet = 0;
  boat.targetSpeed = 0;
  if (boat.damage) {
    const alreadySurrendered = Boolean(boat.damage.surrendered);
    boat.damage.surrendered = true;
    boat.damage.surrenderReason = reason;
    boat.damage.moraleState = 'broken';
    if (!alreadySurrendered) {
      boat.onSurrender?.(boat, boat.damage, reason);
    }
  }
  return SHIP_COLORS.surrender;
}

export const SHIP_COLORS_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + SKY_RENDER_FUNCS + VESSEL_LIGHTING + SCENE_SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var<storage, read> sunVis: array<f32>;
struct ShipColorsPose {
  right: vec4f,
  up: vec4f,
  aft: vec4f,
  origin: vec4f,
  ensignBase: vec4f,
  crowsNest: vec4f,
  windAndState: vec4f,
};
@group(0) @binding(6) var<uniform> P: ShipColorsPose;

struct ColorsVertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uvMode: vec4f,
};

@vertex fn vs(
  @location(0) pos: vec3f,
  @location(1) norm: vec3f,
  @location(2) uvMode: vec4f,
) -> ColorsVertexOut {
  let mode = uvMode.z;
  let u = uvMode.x;
  let v = uvMode.y;
  let sx = P.right.w;
  let sy = P.up.w;
  let sz = P.aft.w;
  let time = P.origin.w;
  let windSpeed = clamp(P.windAndState.z, 1.5, 22.0);
  let surrendered = P.windAndState.w > 0.5;

  var localPos = pos;
  var localNorm = norm;

  if (mode > 3.5) {
    // mode 4 (world-space hemp mooring/grappling line) or mode 5 (world-space oak boarding gangplank)
    var out: ColorsVertexOut;
    out.position = F.viewProj * vec4f(earthCurve(pos - F.camPos.xyz, F.camPos.y), 1.0);
    out.world = pos;
    out.normal = normalize(norm);
    out.uvMode = vec4f(u, v, mode, P.ensignBase.w);
    return out;
  }

  if (mode < 0.5) {
    // mode 0: Crow's nest basket (cesto de gavia) centered on P.crowsNest.xyz
    let cn = P.crowsNest.xyz;
    localPos = vec3f((cn.x + pos.x) * sx, (cn.y + pos.y) * sy, (cn.z + pos.z) * sz);
  } else if (mode < 1.5) {
    // mode 1: Stern flagstaff pole anchored at P.ensignBase.xyz
    let base = P.ensignBase.xyz;
    localPos = vec3f((base.x + pos.x) * sx, (base.y + pos.y) * sy, (base.z + pos.z) * sz);
  } else {
    // mode 2 (stern ensign cloth) or mode 3 (masthead pennant)
    let isPennant = mode > 2.5;
    let base = select(P.ensignBase.xyz, P.crowsNest.xyz + vec3f(0.0, P.crowsNest.w, 0.0), isPennant);
    let rake = select(0.58, 0.0, isPennant);
    // When surrendered, hoist flag slightly lower on the staff (dipped in truce)
    let hoistDip = select(0.0, -0.32, surrendered && !isPennant);
    let hoistTopY = base.y + select(2.35, 1.15, isPennant) + hoistDip;
    let flagHeight = select(1.28, 0.24 * (1.0 - 0.72 * u), isPennant);
    let flagLength = select(2.25, 2.85, isPennant);

    let hoistY = hoistTopY - v * flagHeight;
    let hoistZ = select(base.z + (hoistY - base.y) * rake, base.z, isPennant);
    let anchorWorld = P.origin.xyz
      + P.right.xyz * (base.x * sx)
      + P.up.xyz * (hoistY * sy)
      + P.aft.xyz * (hoistZ * sz);

    // Stream downwind in world XZ with travelling cloth wave; deflect stern ensign
    // abaft the taffrail into the lee quarter when running downwind so it never clips the mizzen sail.
    let windDir2 = normalize(select(vec2f(0.7, 0.7), P.windAndState.xy, length(P.windAndState.xy) > 1e-3));
    let windWorld = vec3f(windDir2.x, 0.0, windDir2.y);
    let windRight = dot(windWorld, P.right.xyz);
    let windAft = dot(windWorld, P.aft.xyz);
    let ensignAft = max(0.42, windAft);
    let leeSign = select(-1.0, 1.0, windRight >= 0.0);
    let ensignRight = select(windRight, leeSign * max(abs(windRight), 0.52), windAft < 0.42);
    let rawStream = select(
      P.aft.xyz * ensignAft + P.right.xyz * ensignRight - P.up.xyz * 0.06,
      vec3f(windDir2.x, -0.06, windDir2.y),
      isPennant
    );
    let streamDir = normalize(rawStream);
    let sideDir = normalize(vec3f(-streamDir.z, 0.0, streamDir.x));
    let phase = time * (3.2 + 0.38 * windSpeed) - u * 6.8 + v * 0.9;
    let flutter = (sin(phase) + 0.38 * sin(phase * 2.3 + 1.1)) * (0.06 + 0.16 * u * u);
    let sag = u * (1.0 - 0.35 * u) * select(0.14, 0.26, surrendered);

    let world = anchorWorld
      + streamDir * (u * flagLength * max(0.85, sx))
      + sideDir * (flutter * max(0.85, sx))
      - vec3f(0.0, sag * sy, 0.0);

    let dWave = cos(phase) * 0.85 * u;
    let nWorld = normalize(sideDir * select(1.0, -1.0, norm.x < 0.0) - streamDir * dWave * 0.32 + vec3f(0.0, 0.12, 0.0));
    var out: ColorsVertexOut;
    out.position = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
    out.world = world;
    out.normal = nWorld;
    out.uvMode = vec4f(u, v, mode, P.ensignBase.w);
    return out;
  }

  let world = P.origin.xyz + P.right.xyz * localPos.x + P.up.xyz * localPos.y + P.aft.xyz * localPos.z;
  let nWorld = normalize(P.right.xyz * localNorm.x + P.up.xyz * localNorm.y + P.aft.xyz * localNorm.z);
  var out: ColorsVertexOut;
  out.position = F.viewProj * vec4f(earthCurve(world - F.camPos.xyz, F.camPos.y), 1.0);
  out.world = world;
  out.normal = nWorld;
  out.uvMode = vec4f(u, v, mode, P.ensignBase.w);
  return out;
}

fn evalEnsignColor(u: f32, v: f32, code: i32, isPennant: bool) -> vec3f {
  let cx = u - 0.46;
  let cy = v - 0.50;
  let weave = 0.96 + 0.04 * sin(u * 140.0) * sin(v * 95.0);

  // Border hem shading
  let border = min(min(u, 1.0 - u), min(v, 1.0 - v));
  let hem = smoothstep(0.0, 0.025, border);

  if (code == 8) {
    // White Flag of Surrender / Truce
    let truceSeam = 0.94 + 0.04 * smoothstep(0.01, 0.03, abs(v - 0.5));
    return vec3f(0.92, 0.91, 0.87) * weave * truceSeam * (0.92 + 0.08 * hem);
  }
  if (code == 9) {
    // Sovereign Indigenous Confederacy Banner (Wampum indigo, terracotta-ochre border, white shell-wampum belt, golden Guanín sun disc)
    var col = vec3f(0.11, 0.19, 0.36);
    if (v < 0.20 || v > 0.80) {
      col = vec3f(0.62, 0.16, 0.08);
    }
    // White shell-wampum stepped diamond treaty belt
    let beltY = abs(v - 0.50);
    let diamond = abs(fract(u * 7.0) - 0.5) * 0.12 + beltY;
    if (beltY < 0.045 || (diamond < 0.095 && beltY < 0.11)) {
      col = vec3f(0.88, 0.85, 0.77);
    }
    // Golden Guanín Sun Zemi disc at hoist center
    let sx = (u - 0.44) * 1.38;
    let sy = v - 0.50;
    let r = length(vec2f(sx, sy));
    let ang = atan2(sy, sx);
    let ray = 0.035 * max(0.0, cos(ang * 8.0));
    if (r < 0.145 + ray) {
      col = vec3f(0.86, 0.64, 0.16);
    }
    return col * weave * (0.90 + 0.10 * hem);
  }
  if (code == 7) {
    // Blood Flag (Sans Quartier — solid crimson)
    return vec3f(0.58, 0.05, 0.05) * weave * (0.88 + 0.12 * hem);
  }
  if (code == 6) {
    // Jolly Roger (Black field with white skull & crossed bones)
    var col = vec3f(0.045, 0.045, 0.052);
    if (isPennant) {
      let stripe = step(0.38, abs(v - 0.5));
      col = mix(col, vec3f(0.84, 0.82, 0.76), stripe * 0.7);
      return col * weave;
    }
    // Skull cranium + jaw
    let sx = (u - 0.46) * 1.45;
    let sy = (v - 0.42);
    let cranium = length(vec2f(sx, sy * 1.15)) < 0.19;
    let jaw = abs(sx) < 0.095 && sy > 0.08 && sy < 0.23;
    let leftEye = length(vec2f(sx + 0.068, sy + 0.015)) < 0.044;
    let rightEye = length(vec2f(sx - 0.068, sy + 0.015)) < 0.044;
    let nose = abs(sx) < 0.024 && sy > 0.02 && sy < 0.075;
    let teethGroove = sy > 0.145 && sy < 0.175 && (abs(sx) < 0.08) && (fract(sx * 28.0) < 0.35);
    let skull = (cranium || jaw) && !leftEye && !rightEye && !nose && !teethGroove;

    // Crossed bones behind/below skull
    let bx = (u - 0.46) * 1.25;
    let by = (v - 0.52);
    let d1 = abs(bx * 0.52 - by * 0.85);
    let d2 = abs(bx * 0.52 + by * 0.85);
    let span = length(vec2f(bx, by)) < 0.34 && length(vec2f(bx, by)) > 0.15;
    let bones = span && (d1 < 0.028 || d2 < 0.028);

    if (skull || bones) {
      col = vec3f(0.88, 0.86, 0.80);
    }
    return col * weave;
  }
  if (code == 2) {
    // Castile / Spain — White field with crimson ragged Cross of Burgundy (saltire)
    var col = vec3f(0.88, 0.85, 0.78);
    let sx = (u - 0.48);
    let sy = (v - 0.50);
    let arm1 = abs(sx * 0.62 - sy * 0.78);
    let arm2 = abs(sx * 0.62 + sy * 0.78);
    let notch1 = 0.022 * step(0.45, fract((sx + sy) * 9.5));
    let notch2 = 0.022 * step(0.45, fract((sx - sy) * 9.5));
    if (arm1 < 0.055 + notch1 || arm2 < 0.055 + notch2) {
      col = vec3f(0.66, 0.07, 0.08);
    }
    return col * weave;
  }
  if (code == 3) {
    // Kingdom of France — Royal blue field, white cross, gold fleurs-de-lis
    var col = vec3f(0.08, 0.16, 0.46);
    let cross = abs(u - 0.44) < 0.065 || abs(v - 0.50) < 0.095;
    if (cross) {
      col = vec3f(0.89, 0.88, 0.84);
    } else {
      let qx = abs(u - 0.44) - 0.22;
      let qy = abs(v - 0.50) - 0.24;
      if (length(vec2f(qx * 1.3, qy)) < 0.065) {
        col = vec3f(0.82, 0.65, 0.14);
      }
    }
    return col * weave;
  }
  if (code == 4) {
    // Vizcaya / Basque — Crimson field with white saltire & green cross
    var col = vec3f(0.64, 0.08, 0.09);
    let sx = u - 0.48;
    let sy = v - 0.50;
    if (abs(sx * 0.62 - sy * 0.78) < 0.05 || abs(sx * 0.62 + sy * 0.78) < 0.05) {
      col = vec3f(0.12, 0.38, 0.18);
    }
    if (abs(u - 0.48) < 0.055 || abs(v - 0.50) < 0.085) {
      col = vec3f(0.89, 0.87, 0.82);
    }
    return col * weave;
  }
  if (code == 5) {
    // England — White field with red St. George's Cross
    var col = vec3f(0.89, 0.87, 0.82);
    if (abs(u - 0.46) < 0.065 || abs(v - 0.50) < 0.10) {
      col = vec3f(0.68, 0.07, 0.08);
    }
    return col * weave;
  }

  // Default (code == 1): Kingdom of Portugal — White field, crimson Order of Christ cross,
  // white inner cross, and central blue Quinas shield with red bordure
  var col = vec3f(0.89, 0.86, 0.79);
  let dx = abs(cx);
  let dy = abs(cy);
  let armSpan = dx < 0.30 && dy < 0.36;
  let patteeV = dx < (0.052 + 0.085 * smoothstep(0.18, 0.34, dy));
  let patteeH = dy < (0.068 + 0.095 * smoothstep(0.15, 0.28, dx));
  if (armSpan && (patteeV || patteeH)) {
    col = vec3f(0.66, 0.07, 0.07);
    let innerV = dx < 0.022 && dy < 0.30;
    let innerH = dy < 0.028 && dx < 0.25;
    if (innerV || innerH) {
      col = vec3f(0.91, 0.89, 0.84);
    }
  }
  // Central Portuguese royal shield & 5 blue Quinas
  if (dx < 0.095 && dy < 0.125) {
    col = vec3f(0.68, 0.08, 0.08); // crimson castle bordure
    if (dx < 0.068 && dy < 0.092) {
      col = vec3f(0.90, 0.88, 0.83); // silver inner escutcheon
      let qCenter = dx < 0.018 && dy < 0.024;
      let qTopBottom = dx < 0.018 && abs(dy - 0.052) < 0.020;
      let qLeftRight = abs(dx - 0.038) < 0.016 && dy < 0.024;
      if (qCenter || qTopBottom || qLeftRight) {
        col = vec3f(0.09, 0.20, 0.52); // 5 blue Quinas
      }
    }
  }
  return col * weave;
}

@fragment fn fs(v: ColorsVertexOut) -> @location(0) vec4f {
  let n = normalize(v.normal);
  let eye = normalize(F.camPos.xyz - v.world);
  let mode = v.uvMode.z;
  let code = i32(round(v.uvMode.w));

  var color = vec3f(0.11, 0.075, 0.042);
  var rough = 0.78;
  var f0 = vec3f(0.035);

  if (mode < 1.5) {
    // Wood & iron bands of the crow's nest basket (mode 0) and stern flagstaff (mode 1)
    let isIronBand = v.uvMode.x > 0.5;
    let grain = 0.92 + 0.08 * sin(v.world.y * 95.0 + sin(v.world.x * 55.0) + v.world.z * 48.0);
    color = select(vec3f(0.115, 0.078, 0.042) * grain, vec3f(0.038, 0.040, 0.044), isIronBand);
    rough = select(0.76, 0.42, isIronBand);
    f0 = select(vec3f(0.035), vec3f(0.12), isIronBand);
  } else if (mode < 3.5) {
    // Woven bunting cloth (stern ensign or masthead pennant)
    color = evalEnsignColor(clamp(v.uvMode.x, 0.0, 1.0), clamp(v.uvMode.y, 0.0, 1.0), code, mode > 2.5);
    rough = 0.86;
  } else if (mode < 4.5) {
    // mode 4: Braided hemp mooring / grappling line with forged iron hook at tip (u > 0.94)
    let isHook = v.uvMode.x > 0.94;
    let twist = 0.88 + 0.12 * sin(v.uvMode.x * 120.0 + v.uvMode.y * 18.0);
    color = select(vec3f(0.44, 0.34, 0.19) * twist, vec3f(0.055, 0.058, 0.062), isHook);
    rough = select(0.84, 0.42, isHook);
    f0 = select(vec3f(0.035), vec3f(0.14), isHook);
  } else {
    // mode 5: Weathered oak boarding gangplank with iron cleats
    let plankGrain = 0.90 + 0.10 * sin(v.uvMode.x * 38.0 + v.uvMode.y * 12.0);
    let cleat = step(0.86, fract(v.uvMode.x * 6.0));
    color = mix(vec3f(0.24, 0.16, 0.088) * plankGrain, vec3f(0.14, 0.095, 0.052), cleat * 0.6);
    rough = 0.78;
  }

  let shadowSample = vesselShadow(v.world, n);
  let sun = sunIlluminance() * sunVis[0] * step(0.0, F.sunDir.y) * solarShadowVisibility(shadowSample);
  let sky = textureSampleLevel(envCube, sampC, vec3f(0, 1, 0), 7).rgb;
  let sea = textureSampleLevel(envCube, sampC, vec3f(0, -1, 0), 7).rgb;
  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  // Cloth translucency when backlit by the sun
  let backlit = select(0.0, max(dot(-n, F.sunDir.xyz), 0.0) * 0.38, mode > 1.5);
  var radiance = color * vesselAmbient(n, sky, sea)
    + sun * (color / PI * (nDotL + backlit) + vesselSpecular(n, eye, F.sunDir.xyz, rough, f0) * nDotL);
  radiance += lunarSurface(n, eye, color, rough, f0, sunVis[1] * lunarShadowVisibility(shadowSample))
    + lightningSurface(n, eye, color, rough);
  return vec4f(surfaceAir(radiance, v.world), 1.0);
}
`;

export function buildShipColorsGeometry() {
  const values = [];
  const put = (p, n, u, v, mode) => {
    values.push(p[0], p[1], p[2], n[0], n[1], n[2], u, v, mode, 1);
  };
  const addTube = (a, b, r0, r1, sides, mode, ironFlag = 0) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const d = [dx / len, dy / len, dz / len];
    const seed = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const ux = d[1] * seed[2] - d[2] * seed[1];
    const uy = d[2] * seed[0] - d[0] * seed[2];
    const uz = d[0] * seed[1] - d[1] * seed[0];
    const um = Math.hypot(ux, uy, uz) || 1;
    const u = [ux / um, uy / um, uz / um];
    const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    for (let i = 0; i < sides; i++) {
      const t0 = (i / sides) * Math.PI * 2;
      const t1 = ((i + 1) / sides) * Math.PI * 2;
      const n0 = [u[0] * Math.cos(t0) + v[0] * Math.sin(t0), u[1] * Math.cos(t0) + v[1] * Math.sin(t0), u[2] * Math.cos(t0) + v[2] * Math.sin(t0)];
      const n1 = [u[0] * Math.cos(t1) + v[0] * Math.sin(t1), u[1] * Math.cos(t1) + v[1] * Math.sin(t1), u[2] * Math.cos(t1) + v[2] * Math.sin(t1)];
      const a0 = [a[0] + n0[0] * r0, a[1] + n0[1] * r0, a[2] + n0[2] * r0];
      const a1 = [a[0] + n1[0] * r0, a[1] + n1[1] * r0, a[2] + n1[2] * r0];
      const b0 = [b[0] + n0[0] * r1, b[1] + n0[1] * r1, b[2] + n0[2] * r1];
      const b1 = [b[0] + n1[0] * r1, b[1] + n1[1] * r1, b[2] + n1[2] * r1];
      put(a0, n0, ironFlag, 0, mode);
      put(a1, n1, ironFlag, 0, mode);
      put(b0, n0, ironFlag, 1, mode);
      put(b0, n0, ironFlag, 1, mode);
      put(a1, n1, ironFlag, 0, mode);
      put(b1, n1, ironFlag, 1, mode);
    }
  };

  // 1. Mode 0: 3D Crow's Nest Basket (cesto de gavia) centered at origin of lookout station
  const ringSegs = 12;
  const rBottom = 0.44;
  const rTop = 0.56;
  const hBasket = 0.78;
  for (let i = 0; i < ringSegs; i++) {
    const a0 = (i / ringSegs) * Math.PI * 2;
    const a1 = ((i + 1) / ringSegs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    // Floor ring, mid iron hoop, and top breast-rail ring
    addTube([c0 * rBottom, 0, s0 * rBottom], [c1 * rBottom, 0, s1 * rBottom], 0.042, 0.042, 6, 0, 0);
    addTube([c0 * 0.50, hBasket * 0.52, s0 * 0.50], [c1 * 0.50, hBasket * 0.52, s1 * 0.50], 0.026, 0.026, 5, 0, 1);
    addTube([c0 * rTop, hBasket, s0 * rTop], [c1 * rTop, hBasket, s1 * rTop], 0.046, 0.046, 6, 0, 0);
    // Vertical oak staves + floor radial knees supporting the basket
    addTube([c0 * rBottom, 0, s0 * rBottom], [c0 * rTop, hBasket, s0 * rTop], 0.028, 0.024, 5, 0, 0);
    addTube([c0 * 0.14, -0.22, s0 * 0.14], [c0 * rBottom, 0, s0 * rBottom], 0.032, 0.028, 5, 0, 0);
  }

  // 2. Mode 1: Outrigger taffrail bracket & Angled Stern Flagstaff (0.58 aft rake, matching ensign hoist)
  addTube([0, -0.04, -0.34], [0, 0, 0], 0.038, 0.036, 8, 1, 0);
  addTube([0, 0, 0], [0, 2.45, 1.42], 0.036, 0.022, 8, 1, 0);
  // Gilt truck ball at top of stern staff
  addTube([0, 2.43, 1.41], [0, 2.52, 1.46], 0.048, 0.015, 8, 1, 1);

  // 3. Mode 2: Two-sided subdivided Stern Ensign Cloth (14 x 8 grid)
  const nu = 14, nv = 8;
  for (const side of [1, -1]) {
    const n = [side, 0, 0];
    for (let i = 0; i < nu; i++) {
      const u0 = i / nu, u1 = (i + 1) / nu;
      for (let j = 0; j < nv; j++) {
        const v0 = j / nv, v1 = (j + 1) / nv;
        const p00 = [0, 0, 0], p10 = [0, 0, 0], p01 = [0, 0, 0], p11 = [0, 0, 0];
        if (side > 0) {
          put(p00, n, u0, v0, 2);
          put(p10, n, u1, v0, 2);
          put(p01, n, u0, v1, 2);
          put(p01, n, u0, v1, 2);
          put(p10, n, u1, v0, 2);
          put(p11, n, u1, v1, 2);
        } else {
          put(p00, n, u0, v0, 2);
          put(p01, n, u0, v1, 2);
          put(p10, n, u1, v0, 2);
          put(p01, n, u0, v1, 2);
          put(p11, n, u1, v1, 2);
          put(p10, n, u1, v0, 2);
        }
      }
    }
  }

  // 4. Mode 3: Masthead Pennant / Streamer above the mainmast
  const pu = 10, pv = 2;
  for (const side of [1, -1]) {
    const n = [side, 0, 0];
    for (let i = 0; i < pu; i++) {
      const u0 = i / pu, u1 = (i + 1) / pu;
      for (let j = 0; j < pv; j++) {
        const v0 = j / pv, v1 = (j + 1) / pv;
        const p = [0, 0, 0];
        if (side > 0) {
          put(p, n, u0, v0, 3);
          put(p, n, u1, v0, 3);
          put(p, n, u0, v1, 3);
          put(p, n, u0, v1, 3);
          put(p, n, u1, v0, 3);
          put(p, n, u1, v1, 3);
        } else {
          put(p, n, u0, v0, 3);
          put(p, n, u0, v1, 3);
          put(p, n, u1, v0, 3);
          put(p, n, u0, v1, 3);
          put(p, n, u1, v1, 3);
          put(p, n, u1, v0, 3);
        }
      }
    }
  }

  return new Float32Array(values);
}

export async function createShipColorsRenderer({
  device,
  frameUBO,
  transView,
  skyView,
  sampClamp,
  envCubeView,
  sunVisBuf,
  shadows,
  shader,
  format,
  samples,
  maxVessels = 4,
}) {
  const B = GPUBufferUsage;
  const vertices = buildShipColorsGeometry();
  const vertexCount = vertices.length / 10;
  const vertexBuffer = device.createBuffer({
    label: 'ship colors & crows nest geometry',
    size: vertices.byteLength,
    usage: B.VERTEX | B.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);

  const maxMooringVerts = 4096;
  const mooringVertexBuffer = device.createBuffer({
    label: 'mooring lines & boarding gangplanks geometry',
    size: maxMooringVerts * 40,
    usage: B.VERTEX | B.COPY_DST,
  });
  let mooringVertexCount = 0;

  const layout = [{
    arrayStride: 40,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x4' },
    ],
  }];

  const module = await shader(SHIP_COLORS_RENDER, 'ship colors & crows nest');
  const pipeline = await device.createRenderPipelineAsync({
    label: 'ship colors pipeline',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: layout },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    multisample: { count: samples },
  });

  const lighting = shadows.bind(pipeline);
  const slots = [];
  const axis = [0, 0, 0];

  for (let i = 0; i < maxVessels; i++) {
    const poseData = new Float32Array(28);
    const poseBuffer = device.createBuffer({
      label: `ship colors pose ${i}`,
      size: poseData.byteLength,
      usage: B.UNIFORM | B.COPY_DST,
    });
    const resources = [
      { buffer: frameUBO },
      transView,
      skyView,
      sampClamp,
      envCubeView,
      { buffer: sunVisBuf },
      { buffer: poseBuffer },
    ];
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource })),
    });
    slots.push({ poseData, poseBuffer, bindGroup, active: false });
  }

  return {
    updateVessel(index, boat, time, windDirX = 0.7, windDirZ = 0.7, windSpeed = 8) {
      const slot = slots[index];
      if (!slot) return;
      if (!boat) {
        slot.active = false;
        return;
      }
      slot.active = true;
      const hull = vesselHull(boat);
      const f = hull.frame;
      const sx = (boat.beam ?? f.beam) / f.beam;
      const sy = f.verticalScale;
      const sz = (boat.length ?? f.length) / f.length;
      const h = (boat.heading ?? 0) * Math.PI / 180;
      const pitch = boat.pitch ?? 0;
      const roll = boat.roll ?? 0;
      const p = slot.poseData;

      boatRotate(axis, 1, 0, 0, h, pitch, roll);
      p[0] = axis[0]; p[1] = axis[1]; p[2] = axis[2]; p[3] = sx;
      boatRotate(axis, 0, 1, 0, h, pitch, roll);
      p[4] = axis[0]; p[5] = axis[1]; p[6] = axis[2]; p[7] = sy;
      boatRotate(axis, 0, 0, 1, h, pitch, roll);
      p[8] = axis[0]; p[9] = axis[1]; p[10] = axis[2]; p[11] = sz;

      p[12] = boat.x ?? 0;
      p[13] = boat.heave ?? 0;
      p[14] = boat.z ?? 0;
      p[15] = time ?? 0;

      const stern = sternEnsignDesignStation(boat);
      const colorsInfo = getShipColorsInfo(boat.damage?.surrendered ? 'surrender' : (boat.colors ?? DEFAULT_SHIP_COLORS));
      p[16] = stern.x;
      p[17] = stern.y;
      p[18] = stern.z;
      p[19] = colorsInfo.code;

      const cn = crowsNestDesignStation(boat);
      p[20] = cn.x;
      p[21] = cn.y;
      p[22] = cn.z;
      p[23] = cn.pennantLift ?? 1.25;

      p[24] = windDirX;
      p[25] = windDirZ;
      p[26] = windSpeed;
      p[27] = boat.damage?.surrendered ? 1.0 : 0.0;

      device.queue.writeBuffer(slot.poseBuffer, 0, p);
    },
    updateMooringVertices(verts) {
      if (!verts || !verts.length) {
        mooringVertexCount = 0;
        return;
      }
      const count = Math.min(maxMooringVerts, Math.floor(verts.length / 10));
      mooringVertexCount = count;
      if (count > 0) {
        device.queue.writeBuffer(mooringVertexBuffer, 0, verts.buffer, verts.byteOffset, count * 40);
      }
    },
    draw(pass, count = slots.length) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, lighting);
      pass.setVertexBuffer(0, vertexBuffer);
      const n = Math.min(count, slots.length);
      for (let i = 0; i < n; i++) {
        if (!slots[i].active) continue;
        pass.setBindGroup(0, slots[i].bindGroup);
        pass.draw(vertexCount);
      }
      if (mooringVertexCount > 0 && slots[0]) {
        pass.setBindGroup(0, slots[0].bindGroup);
        pass.setVertexBuffer(0, mooringVertexBuffer);
        pass.draw(mooringVertexCount);
      }
    },
    destroy() {
      vertexBuffer.destroy();
      mooringVertexBuffer.destroy();
      for (const s of slots) s.poseBuffer.destroy();
    },
  };
}
