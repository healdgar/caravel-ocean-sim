// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Counts flashes: pixels far brighter than the same neighbourhood one frame before and one after.
// A shared tool, not a test: tests/hdr-flash-gpu.test.mjs and scripts/flash-survey.mjs both use it.
//
// It wraps WebGPU from the page's side, so the game carries no capture code. It copies the resolved
// HDR target, before bloom and tone mapping, together with the swap chain the player sees, and it
// drives the game's requestAnimationFrame at an even 60 Hz so that counts per second do not depend on
// how busy the GPU is. Reading back in JavaScript is fine here: this measures frames, it draws none.
export const FLASH_DEFAULTS = Object.freeze({
  // A flash must stand this far above the brightest pixel within two pixels, one frame either side.
  ratio: 3,
  // ...and be bright enough to matter once exposed. 1 is a white wall in the sun.
  minExposed: 1,
  // In the image the player sees, gamma coded 0 to 1, what counts as a flash the eye can catch.
  displayMin: 0.55,
  displayJump: 0.2,
});

export function installFlashProbe() {
  const T = GPUTextureUsage, B = GPUBufferUsage;
  const probe = (window.flashProbe = {
    device: null, hdr: null, swap: null, capture: false, pending: [], free: [], mute: null,
    pumping: false, queued: [], now: 0, labels: new Map(), startTimes: [], gpuMs: [],
  });
  const realRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    if (!probe.pumping) return realRAF(callback);
    probe.queued.push(callback);
    return 0;
  };
  probe.step = () => new Promise((resolve) => realRAF(() => {
    const list = probe.queued;
    probe.queued = [];
    probe.now += 1000 / 60;
    for (const callback of list) callback(probe.now);
    resolve();
  }));

  const views = new WeakMap();
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    probe.device = this;
    if (d.format === 'rgba16float' && (d.sampleCount ?? 1) === 1 && (d.usage & T.RENDER_ATTACHMENT)) d = { ...d, usage: d.usage | T.COPY_SRC };
    return createTexture.call(this, d);
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (...args) {
    const view = createView.apply(this, args);
    views.set(view, this);
    return view;
  };
  const current = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function (...args) {
    return (probe.swap = current.apply(this, args));
  };
  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (desc) {
    const target = desc.colorAttachments?.[0]?.resolveTarget;
    if (target && views.get(target)?.format === 'rgba16float') this.flashHdr = views.get(target);
    return beginRenderPass.call(this, desc);
  };

  // Muting draws by pipeline label names which material is making a flash.
  const pass = GPURenderPassEncoder.prototype, muted = new WeakSet();
  const setPipeline = pass.setPipeline;
  pass.setPipeline = function (pipeline) {
    const label = pipeline.label || '(unlabelled)';
    probe.labels.set(label, (probe.labels.get(label) ?? 0) + 1);
    if (probe.mute?.test(label)) muted.add(this);
    else muted.delete(this);
    return setPipeline.call(this, pipeline);
  };
  for (const name of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    const draw = pass[name];
    pass[name] = function (...args) {
      if (muted.has(this)) return undefined;
      return draw.apply(this, args);
    };
  }
  const bundles = pass.executeBundles;
  pass.executeBundles = function (list) {
    const label = 'render bundle';
    probe.labels.set(label, (probe.labels.get(label) ?? 0) + 1);
    if (probe.mute?.test(label)) return undefined;
    return bundles.call(this, list);
  };

  const finish = GPUCommandEncoder.prototype.finish;
  GPUCommandEncoder.prototype.finish = function (...args) {
    if (probe.capture && this.flashHdr && probe.swap) {
      const { width, height } = this.flashHdr;
      const hdrStride = Math.ceil((width * 8) / 256) * 256, swapStride = Math.ceil((width * 4) / 256) * 256;
      let slot = probe.free.pop();
      if (!slot || slot.width !== width || slot.height !== height) {
        slot = {
          width, height, hdrStride, swapStride,
          hdr: probe.device.createBuffer({ label: 'flash probe hdr', size: hdrStride * height, usage: B.COPY_DST | B.MAP_READ }),
          swap: probe.device.createBuffer({ label: 'flash probe swap', size: swapStride * height, usage: B.COPY_DST | B.MAP_READ }),
        };
      }
      this.copyTextureToBuffer({ texture: this.flashHdr }, { buffer: slot.hdr, bytesPerRow: hdrStride }, [width, height]);
      this.copyTextureToBuffer({ texture: probe.swap }, { buffer: slot.swap, bytesPerRow: swapStride }, [width, height]);
      probe.pending.push(slot);
    }
    return finish.apply(this, args);
  };

  const halves = new Float32Array(65536);
  {
    const u = new Uint32Array(1), f = new Float32Array(u.buffer);
    for (let i = 0; i < 65536; i++) {
      const sign = (i >> 15) & 1, exponent = (i >> 10) & 31, mantissa = i & 1023;
      let value;
      if (exponent === 31) value = mantissa ? NaN : Infinity;
      else if (exponent === 0) value = mantissa * 2 ** -24;
      else value = (1 + mantissa / 1024) * 2 ** (exponent - 15);
      u[0] = 0;
      f[0] = sign ? -value : value;
      halves[i] = f[0];
    }
  }

  // Each pixel takes the largest of its 5 x 5 neighbourhood, so that a highlight sliding a pixel or
  // two between frames is not mistaken for one that appeared from nothing.
  function dilate(source, width, height, scratch) {
    const out = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let best = source[row + x];
        for (let k = -2; k <= 2; k++) {
          const q = x + k;
          if (q >= 0 && q < width && source[row + q] > best) best = source[row + q];
        }
        scratch[row + x] = best;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = scratch[y * width + x];
        for (let k = -2; k <= 2; k++) {
          const q = y + k;
          if (q >= 0 && q < height && scratch[q * width + x] > best) best = scratch[q * width + x];
        }
        out[y * width + x] = best;
      }
    }
    return out;
  }

  function components(mask, width, height) {
    const stack = [], found = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start]) continue;
      mask[start] = 0;
      stack.push(start);
      const pixels = [];
      while (stack.length) {
        const i = stack.pop(), x = i % width, y = (i - x) / width;
        pixels.push(i);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const u = x + dx, v = y + dy;
          if (u < 0 || v < 0 || u >= width || v >= height) continue;
          const j = v * width + u;
          if (mask[j]) { mask[j] = 0; stack.push(j); }
        }
      }
      found.push(pixels);
    }
    return found;
  }

  async function readFrame(slot, keepImage) {
    await Promise.all([slot.hdr.mapAsync(GPUMapMode.READ), slot.swap.mapAsync(GPUMapMode.READ)]);
    const { width, height, hdrStride, swapStride } = slot;
    const hdr = new Uint16Array(slot.hdr.getMappedRange()), swap = new Uint8Array(slot.swap.getMappedRange());
    const L = new Float32Array(width * height), D = new Float32Array(width * height), green = new Float32Array(width * height), red = new Float32Array(width * height), blue = new Float32Array(width * height);
    const image = keepImage ? new Uint8ClampedArray(width * height * 4) : null;
    const counts = { nan: 0, inf: 0, negative: 0, max: 0, white: 0, over16: 0 };
    const rowHdr = hdrStride / 2;
    const bgra = probe.swapFormatBGRA;
    let total = 0, shownTotal = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const h = y * rowHdr + x * 4, s = y * swapStride + x * 4, i = y * width + x;
        const hr = hdr[h], hg = hdr[h + 1], hb = hdr[h + 2];
        const nonFinite = (hr & 0x7c00) === 0x7c00 || (hg & 0x7c00) === 0x7c00 || (hb & 0x7c00) === 0x7c00;
        if (nonFinite) {
          if (((hr & 0x7c00) === 0x7c00 && hr & 1023) || ((hg & 0x7c00) === 0x7c00 && hg & 1023) || ((hb & 0x7c00) === 0x7c00 && hb & 1023)) counts.nan++;
          else counts.inf++;
          L[i] = 1e9;
        } else {
          const r = halves[hr], g = halves[hg], b = halves[hb];
          if (r < 0 || g < 0 || b < 0) counts.negative++;
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          L[i] = luma;
          red[i] = r; green[i] = g; blue[i] = b;
          if (luma > counts.max) counts.max = luma;
          if (luma >= 16) counts.over16++;
          total += luma;
        }
        const sr = swap[s + (bgra ? 2 : 0)], sg = swap[s + 1], sb = swap[s + (bgra ? 0 : 2)];
        D[i] = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / 255;
        shownTotal += D[i];
        if (D[i] >= 0.95) counts.white++;
        if (image) {
          image[i * 4] = sr;
          image[i * 4 + 1] = sg;
          image[i * 4 + 2] = sb;
          image[i * 4 + 3] = 255;
        }
      }
    }
    slot.hdr.unmap();
    slot.swap.unmap();
    probe.free.push(slot);
    return { L, D, red, green, blue, image, counts, width, height, mean: total / (width * height), shownMean: shownTotal / (width * height) };
  }

  // Sets the camera each frame and returns what flashed. `pose` is the source of a function of the frame number.
  probe.measure = async ({ frames = 120, settle = 30, pose = null, exposure = 1.35, ratio, minExposed, displayMin, displayJump, keepPictures = 0 }) => {
    const device = probe.device;
    probe.swapFormatBGRA = /^bgra/.test(probe.swap?.format ?? 'bgra8unorm');
    probe.now = performance.now();
    probe.pumping = true;
    const path = pose ? (0, eval)(`(${pose})`) : null;
    const camera = window.oceanFleet.camera;
    const place = (i) => { if (path) Object.assign(camera, path(i)); };
    for (let i = 0; i < settle; i++) {
      place(0);
      await probe.step();
      await device.queue.onSubmittedWorkDone();
    }
    const minRaw = minExposed / exposure;
    const window3 = [];
    const scratchSize = { n: 0, array: null };
    const flashes = [], display = [];
    const totals = { nan: 0, inf: 0, negative: 0, nanFrames: 0, frames: 0 };
    const means = [], pictures = [], frameStats = [];
    let finished = 0;
    const analyse = (prev, cur, next, index) => {
      const { width, height } = cur;
      const hdrMask = new Uint8Array(width * height), displayMask = new Uint8Array(width * height);
      const P = prev.dilL, N = next.dilL, PD = prev.dilD, ND = next.dilD;
      for (let i = 0; i < width * height; i++) {
        const value = cur.L[i];
        if (value >= minRaw && value >= ratio * Math.max(P[i], N[i], 1e-5)) hdrMask[i] = 1;
        const shown = cur.D[i];
        if (shown >= displayMin && shown - Math.max(PD[i], ND[i]) >= displayJump) displayMask[i] = 1;
      }
      for (const pixels of components(hdrMask, width, height)) {
        let peak = 0, at = pixels[0];
        for (const i of pixels) if (cur.L[i] > peak) { peak = cur.L[i]; at = i; }
        flashes.push({ frame: index, x: at % width, y: Math.floor(at / width), size: pixels.length, peak: Math.round(peak * exposure * 100) / 100, before: Math.round(prev.dilL[at] * exposure * 100) / 100, after: Math.round(next.dilL[at] * exposure * 100) / 100, display: Math.round(cur.D[at] * 255), rgb: [cur.red[at], cur.green[at], cur.blue[at]].map((v) => Math.round(v * 100) / 100) });
      }
      for (const pixels of components(displayMask, width, height)) {
        let peak = 0, at = pixels[0];
        for (const i of pixels) if (cur.D[i] > peak) { peak = cur.D[i]; at = i; }
        display.push({ frame: index, x: at % width, y: Math.floor(at / width), size: pixels.length, peak: Math.round(peak * 255), before: Math.round(prev.dilD[at] * 255), after: Math.round(next.dilD[at] * 255), raw: Math.round(cur.L[at] * exposure * 100) / 100 });
      }
    };
    for (let i = 0; i < frames + 2; i++) {
      place(i);
      probe.pending.length = 0;
      probe.capture = true;
      await probe.step();
      probe.capture = false;
      await device.queue.onSubmittedWorkDone();
      const slot = probe.pending.pop();
      if (!slot) throw new Error('flash probe: no frame captured');
      const frame = await readFrame(slot, keepPictures > 0);
      if (scratchSize.n !== frame.L.length) { scratchSize.n = frame.L.length; scratchSize.array = new Float32Array(frame.L.length); }
      frame.dilL = dilate(frame.L, frame.width, frame.height, scratchSize.array);
      frame.dilD = dilate(frame.D, frame.width, frame.height, scratchSize.array);
      totals.nan += frame.counts.nan;
      totals.inf += frame.counts.inf;
      totals.negative += frame.counts.negative;
      if (frame.counts.nan + frame.counts.inf) totals.nanFrames++;
      means.push(frame.shownMean);
      frameStats.push({ peak: frame.counts.max, over16: frame.counts.over16, white: frame.counts.white, shown: frame.shownMean });
      window3.push(frame);
      if (window3.length === 3) {
        const before = flashes.length + display.length;
        analyse(window3[0], window3[1], window3[2], i - 1);
        finished++;
        if (keepPictures && flashes.length + display.length > before) {
          const worst = [...display, ...flashes].filter((f) => f.frame === i - 1).sort((a, b) => b.peak - a.peak)[0];
          pictures.push({ frame: i - 1, worst, peak: worst.peak, images: [window3[0].image, window3[1].image, window3[2].image], width: frame.width, height: frame.height });
          pictures.sort((a, b) => b.peak - a.peak);
          pictures.length = Math.min(pictures.length, keepPictures);
        }
        window3.shift();
      }
    }
    totals.frames = finished;
    probe.pictures = pictures;
    return { flashes, display, totals, means, frameStats, width: window3[0].width, height: window3[0].height };
  };

  const oneFrame = async (pose, settle, keepImage) => {
    const device = probe.device;
    if (!probe.pumping) { probe.now = performance.now(); probe.pumping = true; }
    probe.swapFormatBGRA = /^bgra/.test(probe.swap?.format ?? 'bgra8unorm');
    const camera = window.oceanFleet.camera;
    for (let i = 0; i < settle; i++) {
      Object.assign(camera, pose);
      await probe.step();
      await device.queue.onSubmittedWorkDone();
    }
    probe.pending.length = 0;
    probe.capture = true;
    await probe.step();
    probe.capture = false;
    await device.queue.onSubmittedWorkDone();
    return readFrame(probe.pending.pop(), keepImage);
  };
  const pixelAt = (frame, x, y) => {
    const i = y * frame.width + x;
    return { x, y, rgb: [frame.red[i], frame.green[i], frame.blue[i]], shown: Math.round(frame.D[i] * 255) };
  };

  // One frame at one camera, for asking what a pixel holds with this or that draw muted.
  probe.grab = async ({ pose, points, settle = 3 }) => {
    const frame = await oneFrame(pose, settle, false);
    return points.map(([x, y]) => pixelAt(frame, x, y));
  };

  // One frame at one camera as pictures, whole and magnified about a point, for before and after.
  probe.grabPicture = async ({ pose, x, y, crop = 48, zoom = 10, settle = 3 }) => {
    const frame = await oneFrame(pose, settle, true);
    probe.pictures = [{ width: frame.width, height: frame.height, images: [frame.image], worst: { x, y } }];
    return { whole: probe.picture(0, 0), zoom: probe.picture(0, 0, crop, zoom), ...pixelAt(frame, x, y) };
  };

  // Hands back a kept picture as PNG data, whole or as a magnified crop centred on the flash.
  probe.picture = (index, which, crop = 0, zoom = 1) => {
    const picture = probe.pictures[index];
    if (!picture) return null;
    const { width, height, images, worst } = picture;
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    source.getContext('2d').putImageData(new ImageData(images[which], width, height), 0, 0);
    if (!crop) return source.toDataURL('image/png');
    const out = document.createElement('canvas');
    out.width = crop * zoom;
    out.height = crop * zoom;
    const context = out.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.drawImage(source, worst.x - crop / 2, worst.y - crop / 2, crop, crop, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };
}

// Turns what the page measured into the summary that goes in a report and a test failure.
export function summariseFlashes(result, frameRate = 60) {
  // Bloom shows as the whole picture brightening for a frame, which no single pixel's test can see.
  let wholeFrame = 0;
  for (let i = 1; i + 1 < (result.means?.length ?? 0); i++) wholeFrame = Math.max(wholeFrame, result.means[i] - Math.max(result.means[i - 1], result.means[i + 1]));
  const seconds = result.totals.frames / frameRate, per = (n) => Math.round((n / seconds) * 10) / 10;
  const bins = [1, 4, 16, 64, 256, 1024], hdr = {};
  for (const low of bins) hdr[`>=${low}`] = per(result.flashes.filter((f) => f.peak >= low).length);
  return {
    seconds: Math.round(seconds * 100) / 100,
    hdrFlashesPerSecond: per(result.flashes.length),
    hdrByPeak: hdr,
    displayFlashesPerSecond: per(result.display.length),
    nan: result.totals.nan,
    inf: result.totals.inf,
    negative: result.totals.negative,
    nonFiniteFrames: result.totals.nanFrames,
    wholeFrameJump: Math.round(wholeFrame * 25500) / 100,
    peakExposed: Math.round(Math.max(0, ...result.flashes.map((f) => f.peak)) * 10) / 10,
    worst: [...result.flashes].sort((a, b) => b.peak - a.peak).slice(0, 3),
    worstDisplay: [...result.display].sort((a, b) => b.peak - b.before - (a.peak - a.before)).slice(0, 3),
  };
}

export async function runFlashMeasure(page, options) {
  return page.evaluate((o) => window.flashProbe.measure(o), { ...FLASH_DEFAULTS, ...options });
}

// Moves the sun through the same slider a player uses, which also rebuilds the sky's light.
export async function setSun(page, elevation, azimuth) {
  await page.evaluate(([e, a]) => {
    for (const [id, value] of [['sea-sunElev', e], ['sea-sunAzim', ((a % 360) + 360) % 360]]) {
      const input = document.getElementById(id);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [elevation, azimuth]);
}
