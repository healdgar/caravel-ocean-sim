// Delivered cadence drives every change. Resolution and polygon budgets are device-local;
// simulation stays intact. Nothing measures GPU load cheaply: timestamps stall Apple GPUs and
// their spans include waits. So while presentation sits at the display's cap, the only test of
// headroom is to try a little more detail. A try that costs the cadence is undone, and the next
// one waits twice as long, so a settled scene stops asking.
// A device that needs seconds per frame is the one most in need of reduction, so only
// a pause longer than this counts as an interruption. Hidden tabs are reported separately.
import { CONTINUUM_BASE_PIXEL_ERROR, CONTINUUM_TRIANGLE_BUDGET } from './continuum-core.js';
const ADAPTIVE_FRAME_LIMIT = 8;
// Normally judge at least a dozen frames, but do not wait a minute to see that
// frames are taking seconds: three of them over four seconds are enough.
function adaptiveWindowComplete(seconds, count, minimumSeconds, capacity) {
  if (count >= capacity) return true;
  if (seconds >= minimumSeconds && count >= 12) return true;
  return seconds >= 4 && count >= 3;
}
// Time at the target before raising a budget, and how a raised budget is judged.
const ADAPTIVE_PROVEN_SECONDS = 6;
const ADAPTIVE_LONGEST_WAIT_SECONDS = 240;
function createHeadroomProbe(firstWait) {
  let wait = firstWait, fast = 0, before = null, age = 0;
  return {
    // The scale to return to if the last raise is what slowed things down.
    slowed() {
      fast = 0;
      if (before === null) return null;
      const back = before;
      before = null;
      wait = Math.min(ADAPTIVE_LONGEST_WAIT_SECONDS, wait * 2);
      return back;
    },
    atTarget(seconds, scale, raised) {
      fast += seconds;
      if (before !== null) {
        age += seconds;
        if (age >= ADAPTIVE_PROVEN_SECONDS) { before = null; wait = firstWait; }
        return scale;
      }
      if (fast < wait) return scale;
      fast = 0; before = scale; age = 0;
      return raised;
    },
    hold() { fast = 0; },
    get trying() { return before !== null; },
    cancel() { before = null; fast = 0; },
  };
}
const RESOLUTION_RAISE = 1.06;
const VSYNC_HALVED_MS = 36;
// Startup streams and compiles for a few seconds, which says nothing about the running game.
const ADAPTIVE_STARTUP_SETTLE_SECONDS = 4;
const POLYGON_RAISE = 1.12;
const POLYGON_RECOVERY_RAISE = 1.3;
// Below this budget the loss starts to show, so polygons are restored ahead of sharpness.
export const POLYGON_COMFORT = 0.5;
const WORK_HEADROOM = 0.86;
const trimmedMean = (values, count) => {
  const sorted = values.slice(0, count).sort(), trim = Math.floor(count * 0.1);
  let total = 0;
  for (let i = trim; i < count - trim; i++) total += sorted[i];
  return total / (count - 2 * trim);
};
// Measured frame work can only forbid a raise: a CPU-bound frame gains nothing from fewer pixels.
function workForbidsRaise(work, count, budget) {
  const measured = work.slice(0, count).filter(Number.isFinite);
  return measured.length >= count * .8 && trimmedMean(Float64Array.from(measured), measured.length) > budget * WORK_HEADROOM;
}
export function createAdaptiveResolution(mode = 'auto', { initial = 1 } = {}) {
  const minimum = 0.35, targetFPS = 60, samples = new Float64Array(240), workSamples = new Float64Array(240);
  let scale = mode === 'auto' ? Math.max(minimum, Math.min(1, initial)) : mode === 'native' || mode === 'fixed' ? 1 : Number(mode);
  let count = 0, seconds = 0, settle = ADAPTIVE_STARTUP_SETTLE_SECONDS, fps = 0;
  const probe = createHeadroomProbe(3);
  const reset = () => { count = 0; seconds = 0; settle = 2; };
  return {
    get mode() { return mode; }, get scale() { return scale; }, get fps() { return fps; },
    // A try under way may be what slows the frame, so the other budget holds still meanwhile.
    get trying() { return probe.trying; },
    minimum, targetFPS, reset,
    setMode(next) {
      if (!['auto', 'native', 'fixed', '0.75', '0.5'].includes(next)) return;
      mode = next; scale = next === 'auto' ? scale : next === 'native' || next === 'fixed' ? 1 : Number(next);
      probe.cancel(); reset();
    },
    sample(elapsed, visible = true, workMs = null, { mayRaise = true, mayLower = true } = {}) {
      if (mode !== 'auto') return false;
      if (!visible || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > ADAPTIVE_FRAME_LIMIT) { reset(); return false; }
      if (settle > 0) { settle -= elapsed; return false; }
      samples[count] = elapsed * 1000;
      workSamples[count++] = Number.isFinite(workMs) && workMs > 0 ? workMs : NaN;
      seconds += elapsed;
      if (!adaptiveWindowComplete(seconds, count, 1.5, samples.length)) return false;
      // Ignore isolated scheduling hiccups; sustained slow frames remain visible.
      const ms = trimmedMean(samples, count);
      fps = 1000 / ms;
      let next = scale;
      const budget = 1000 / targetFPS;
      if (ms > budget * 1.01) {
        // Modest headroom above 60 leaves room for wave peaks after reducing. A frame just over
        // budget still shows as a halved cadence, so that alone asks for only a small step.
        const factor = ms <= VSYNC_HALVED_MS ? 0.9 : Math.max(0.7, Math.min(0.92, Math.sqrt((1000 / 66) / ms) * 0.96));
        const back = probe.slowed();
        if (back !== null) next = back;
        else if (mayLower) next = Math.max(minimum, Math.round(scale * factor * 100) / 100);
      } else if (mayRaise && scale < 1 && !workForbidsRaise(workSamples, count, budget)) {
        next = probe.atTarget(seconds, scale, Math.min(1, scale * RESOLUTION_RAISE));
      } else probe.hold();
      count = 0; seconds = 0;
      if (next === scale) return false;
      scale = next; reset(); return true;
    },
  };
}

const POLYGON_MODE_ALIASES = Object.freeze({
  auto: 'auto',
  native: 'native',
  high: 'native',
  '1': 'native',
  fixed: 'fixed',
  '0.75': '0.75',
  medium: '0.75',
  '0.5': '0.5',
  low: '0.5',
  '0.25': '0.25',
  mobile: '0.25',
  '0.1': '0.1',
  'ultra-low': '0.1',
});

// `minimum` is how far the governor may lower the budget by itself. A budget the player or the address
// bar chose is given as chosen, down to the least the game can draw with.
const POLYGON_CHOSEN_MINIMUM = 0.06;
// The scene's triangle budget aims the same scale at the share of the budget it would fill (POLYGON_BUDGET_AIM), from
// the count and the error the count was taken at, as submitted triangles go as the scale; never below this share of
// that scale for one count read, and back up only once the count is under POLYGON_BUDGET_RECOVER of the budget. The
// scalar glides to its aim (js/continuum-core.js stepContinuumPixelError), so detail yields through the morph and the
// sample-mask bands rather than at once.
const POLYGON_BUDGET_STEP = 0.5;
const POLYGON_BUDGET_AIM = 0.95;
const POLYGON_BUDGET_RECOVER = 0.8;
export function createAdaptivePolygons(initialMode = 'auto', { basePixelError = CONTINUUM_BASE_PIXEL_ERROR, minimum = POLYGON_CHOSEN_MINIMUM, targetFPS = 60 } = {}) {
  let mode = POLYGON_MODE_ALIASES[initialMode] ?? 'auto';
  let scale = mode === 'auto' || mode === 'native' || mode === 'fixed' ? 1 : Number(mode);
  const samples = new Float64Array(240), workSamples = new Float64Array(240);
  let count = 0, seconds = 0, settle = ADAPTIVE_STARTUP_SETTLE_SECONDS, fps = 0;
  const probe = createHeadroomProbe(4);
  const reset = () => { count = 0; seconds = 0; settle = 1.6; };
  // Two limits on the one scale: frame time (scale) and the scene's triangle budget (budgetScale). The tighter wins.
  let budgetScale = 1;
  const timeGranted = () => Math.max(mode === 'auto' ? minimum : Math.min(minimum, POLYGON_CHOSEN_MINIMUM), scale);
  const granted = () => Math.min(timeGranted(), Math.max(POLYGON_CHOSEN_MINIMUM, budgetScale));
  return {
    get mode() { return mode; },
    get scale() { return scale; },
    get grantedScale() { return granted(); },
    get fps() { return fps; },
    get trying() { return probe.trying; },
    get budgetScale() { return budgetScale; },
    get pixelError() { return basePixelError / Math.sqrt(granted()); },
    get oceanRangeScale() { return Math.sqrt(granted()); },
    maxNodes(baseMax = 8192) { return Math.max(256, Math.round(baseMax * granted())); },
    minimum, targetFPS, basePixelError, reset,
    setMode(next) {
      const normalized = POLYGON_MODE_ALIASES[next];
      if (!normalized) return;
      mode = normalized;
      scale = mode === 'auto' ? scale : mode === 'native' || mode === 'fixed' ? 1 : Number(mode);
      probe.cancel(); reset();
    },
    // The scene's one triangle budget (AGENTS.md rule 3, item 5), from the continuum census's count of submitted
    // triangles, read a few frames late, and `pixels`, the scene's error that count was taken at (the scalar glides,
    // so it may not yet be the one aimed at; without it, the one granted). Submitted triangles go as 1 / pixelError²,
    // that is as the scale granted, so over budget, or well under it, the scale is aimed at the one that fills
    // POLYGON_BUDGET_AIM of it, by no more than a bounded step a count. A fixed budget (tests, comparisons) is never
    // moved. True when the pixel error aimed at changed.
    observeTriangles(total, budget = CONTINUUM_TRIANGLE_BUDGET, pixels = null) {
      if (mode === 'fixed' || !(total > 0) || !(budget > 0)) return false;
      const before = granted(), at = pixels > 0 ? Math.min(1, (basePixelError / pixels) ** 2) : before;
      const filled = at * (budget * POLYGON_BUDGET_AIM) / total;
      let next = budgetScale;
      if (total > budget) next = Math.max(POLYGON_CHOSEN_MINIMUM, Math.min(before, Math.max(at * POLYGON_BUDGET_STEP, filled)));
      else if (budgetScale < 1 && budgetScale <= timeGranted() && total < budget * POLYGON_BUDGET_RECOVER) {
        next = Math.min(1, Math.max(budgetScale, Math.min(at / POLYGON_BUDGET_STEP, filled)));
      }
      next = Math.round(next * 1000) / 1000;
      if (next === budgetScale) return false;
      budgetScale = next;
      return granted() !== before;
    },
    sample(elapsed, visible = true, workMs = null, { mayLower = true, mayLowerFurther = true } = {}) {
      if (mode !== 'auto') return false;
      if (!visible || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > ADAPTIVE_FRAME_LIMIT) { reset(); return false; }
      if (settle > 0) { settle -= elapsed; return false; }
      samples[count] = elapsed * 1000;
      workSamples[count++] = Number.isFinite(workMs) && workMs > 0 ? workMs : NaN;
      seconds += elapsed;
      if (!adaptiveWindowComplete(seconds, count, 1.4, samples.length)) return false;
      const ms = trimmedMean(samples, count);
      fps = 1000 / ms;
      let next = scale;
      const budget = 1000 / targetFPS;
      if (ms > budget * 1.01) {
        // Active 2D surface/stand triangle count scales proportionally to 1/error^2 = scale.
        const factor = ms <= VSYNC_HALVED_MS ? 0.85 : Math.max(0.55, Math.min(0.9, ((1000 / 66) / ms) * 0.96));
        const back = probe.slowed();
        if (back !== null) next = back;
        else if (mayLower && (mayLowerFurther || scale > POLYGON_COMFORT)) next = Math.max(minimum, Math.round(scale * factor * 100) / 100);
      } else if (scale < 1 && !workForbidsRaise(workSamples, count, budget)) {
        next = probe.atTarget(seconds, scale, Math.min(1, Math.max(scale * (scale < POLYGON_COMFORT ? POLYGON_RECOVERY_RAISE : POLYGON_RAISE), scale + 0.06)));
      } else probe.hold();
      count = 0; seconds = 0;
      if (next === scale) return false;
      scale = next; reset(); return true;
    },
  };
}
