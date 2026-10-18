// Authored caravel sail plan and aerodynamic response; not a calibrated polar.
// World wind is a velocity toward (cos(direction), sin(direction)) in X/Z.
export const SAIL_PLAN = [
  { id: 1, mast: 0, z: -4.15, top: 6.65, width: 4.9, height: 2.9, belly: 0.7 },
  { id: 2, mast: 0, z: -4.15, top: 8.85, width: 3.25, height: 1.5, belly: 0.42 },
  { id: 3, mast: 1, z: 0.85, top: 8.0, width: 5.9, height: 3.25, belly: 0.88 },
  { id: 4, mast: 1, z: 0.85, top: 10.9, width: 3.95, height: 1.65, belly: 0.52 },
];
export const LATEEN_CORNERS = [[0, 8.05, 5.9], [0, 4.5, 2.6], [1.1, 4.15, 6.3]];
export const SAIL_KEYS = ['sailFore', 'sailMain', 'sailMizzen'];
const squareAreas = [0, 0];
for (const sail of SAIL_PLAN) squareAreas[sail.mast] += sail.width * sail.height * 0.95;
export const SAIL_AREAS = [...squareAreas, 7.63];
const sailClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sailSmooth = (lo, hi, x) => { const t = sailClamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

export function sailingState(boat) {
  if (!boat.sailState) boat.sailState = {
    set: new Float64Array(SAIL_KEYS.map(key => sailClamp(boat[key] ?? 1, 0, 1))),
    squareYaw: 0, lateenYaw: 0, tack: 1, canvasTack: 1, forward: 0, side: 0, area: 0,
    apparentSpeed: 0, apparentAngle: 0, squareFill: 0, lateenFill: 0,
    squareTarget: 0, lateenTarget: 0, windSide: 0, windForward: 0,
  };
  return boat.sailState;
}

export function apparentWind(out, heading, speed, sideways, windSpeed, windDirection) {
  const h = heading * Math.PI / 180, wx = Math.cos(windDirection) * windSpeed, wz = Math.sin(windDirection) * windSpeed;
  out.windForward = wx * Math.sin(h) - wz * Math.cos(h) - speed;
  out.windSide = wx * Math.cos(h) + wz * Math.sin(h) - sideways;
  out.apparentSpeed = Math.hypot(out.windForward, out.windSide);
  out.apparentAngle = out.apparentSpeed > 1e-6 ? Math.atan2(-out.windSide, -out.windForward) : 0;
  // Retain the last tack near a dead run or calm to avoid chattering across the stern.
  if (Math.abs(out.windSide) > 0.12) out.tack = out.windSide < 0 ? 1 : -1;
  const angle = Math.abs(out.apparentAngle), degrees = angle * 180 / Math.PI;
  out.squareTarget = out.tack * sailClamp((Math.PI / 2 - angle + 0.23) * (1 - sailSmooth(110, 165, degrees)), -Math.PI / 3, Math.PI / 3);
  out.lateenTarget = -out.tack * sailClamp(angle * 0.5 - 0.12, 0.08, 1.2);
  return out;
}

export function advanceSails(boat, dt, windSpeed, windDirection) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0, windSpeed, windDirection);
  for (let i = 0; i < 3; i++) s.set[i] += sailClamp(sailClamp(boat[SAIL_KEYS[i]] ?? 1, 0, 1) - s.set[i], -dt * 0.18, dt * 0.18);
  // Yards and lateen take time to brace/tack; forces use this actual trim.
  s.squareYaw += sailClamp(s.squareTarget - s.squareYaw, -dt * 0.55, dt * 0.55);
  s.lateenYaw += sailClamp(s.lateenTarget - s.lateenYaw, -dt * 0.65, dt * 0.65);
  s.canvasTack += sailClamp(s.tack - s.canvasTack, -dt * 1.2, dt * 1.2);
}

export function sailForces(boat, windSpeed, windDirection, velocity, sideways = 0) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, velocity, sideways, windSpeed, windDirection);
  const speed = s.apparentSpeed, angle = Math.abs(s.apparentAngle), degrees = angle * 180 / Math.PI;
  const squareTrim = Math.max(0, Math.cos(2 * (s.squareYaw - s.squareTarget)));
  const lateenTrim = Math.max(0, Math.cos(2 * (s.lateenYaw - s.lateenTarget)));
  const squarePower = sailSmooth(55, 75, degrees) * squareTrim * squareTrim;
  const lateenPower = sailSmooth(42, 60, degrees) * lateenTrim * lateenTrim;
  const squareArea = (SAIL_AREAS[0] * s.set[0] + SAIL_AREAS[1] * s.set[1]) * boat.beam / 3.6;
  const lateenArea = SAIL_AREAS[2] * s.set[2] * boat.length / 12;
  s.area = squareArea + lateenArea;
  s.squareFill = sailSmooth(0.5, 5, speed) * squarePower;
  s.lateenFill = sailSmooth(0.5, 5, speed) * lateenPower;
  const area = squareArea * squarePower + lateenArea * lateenPower;
  const q = 0.5 * 1.225 * speed * speed * area;
  const drag = 0.10 + 1.2 * Math.sin(Math.max(0, angle - Math.PI / 2)) ** 2;
  const f = speed > 1e-6 ? s.windForward / speed : 0, r = speed > 1e-6 ? s.windSide / speed : 0;
  // Ease into drag-dominated flow off the wind; keep net side force leeward.
  let lift = 1.1 * Math.sin(angle) * (1 - sailSmooth(90, 125, degrees));
  if (f > 0) lift = Math.min(lift, 0.85 * drag * Math.abs(r) / f);
  s.forward = q * (lift * Math.abs(r) + drag * f);
  s.side = q * (lift * -f * Math.sign(r) + drag * r);
  return s;
}

export function pointOfSail(angle, speed) {
  if (speed < 0.5) return 'Calm';
  const a = Math.abs(angle) * 180 / Math.PI;
  return a < 42 ? 'In irons' : a < 60 ? 'Close-hauled · weak drive' : a < 80 ? 'Close reach'
    : a < 110 ? 'Beam reach' : a < 165 ? 'Broad reach' : 'Running';
}
