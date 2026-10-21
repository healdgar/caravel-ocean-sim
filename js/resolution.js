// Delivered cadence drives reductions. Measured work can establish restoration
// headroom even when presentation is capped at 60 Hz; it never forces a reduction.
// Resolution is device-local; scene quality settings and simulation stay intact.
export function createAdaptiveResolution(mode = 'auto') {
  const minimum = 0.35, targetFPS = 60, samples = new Float64Array(240), workSamples = new Float64Array(240);
  let scale = mode === 'auto' || mode === 'native' || mode === 'fixed' ? 1 : Number(mode);
  let count = 0, seconds = 0, settle = 2, fastSeconds = 0, fps = 0;
  const reset = () => { count = 0; seconds = 0; settle = 2; fastSeconds = 0; };
  return {
    get mode() { return mode; }, get scale() { return scale; }, get fps() { return fps; },
    minimum, targetFPS, reset,
    setMode(next) {
      if (!['auto', 'native', 'fixed', '0.75', '0.5'].includes(next)) return;
      mode = next; scale = next === 'auto' ? scale : next === 'native' || next === 'fixed' ? 1 : Number(next);
      reset();
    },
    sample(elapsed, visible = true, workMs = null) {
      if (mode !== 'auto') return false;
      if (!visible || !Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 1) { reset(); return false; }
      if (settle > 0) { settle -= elapsed; return false; }
      samples[count] = elapsed * 1000;
      workSamples[count++] = Number.isFinite(workMs) && workMs > 0 ? workMs : NaN;
      seconds += elapsed;
      if ((seconds < 1.5 || count < 12) && count < samples.length) return false;
      // Ignore isolated scheduling hiccups; sustained slow frames remain visible.
      const sorted = samples.slice(0, count).sort(), trim = Math.floor(count * 0.1);
      let ms = 0;
      for (let i = trim; i < count - trim; i++) ms += sorted[i];
      ms /= count - 2 * trim; fps = 1000 / ms;
      let next = scale;
      const budget = 1000 / targetFPS;
      if (ms > budget * 1.01) {
        // Modest headroom above 60 leaves room for wave peaks after reducing.
        const factor = Math.max(0.7, Math.min(0.92, Math.sqrt((1000 / 66) / ms) * 0.96));
        next = Math.max(minimum, Math.round(scale * factor * 100) / 100);
        fastSeconds = 0;
      } else {
        const work = workSamples.slice(0, count).filter(Number.isFinite).sort();
        const measured = work.length >= count * .8;
        let headroom = fps > targetFPS * 1.4;
        if (measured) {
          const workTrim = Math.floor(work.length * .1);let cost = 0;
          for (let i = workTrim; i < work.length - workTrim; i++) cost += work[i];
          cost /= work.length - 2 * workTrim;
          // Raising scale 5% increases pixel work about 10%. Require more
          // margin than that and stable target cadence before restoring detail.
          headroom = fps >= targetFPS * .99 && cost <= budget * .86;
        }
        if (headroom) {
          fastSeconds += seconds;
          if (fastSeconds >= 10) next = Math.min(1, scale * 1.05);
        } else fastSeconds = 0;
      }
      count = 0; seconds = 0;
      if (next === scale) return false;
      scale = next; reset(); return true;
    },
  };
}
