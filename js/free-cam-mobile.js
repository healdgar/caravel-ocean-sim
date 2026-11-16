// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Mobile locomotion & gyroscope motion controls for Free Camera (flight and ashore walk).
// Pure O(1) event-driven state; zero per-frame DOM layout reads or allocations.

const D2R = Math.PI / 180;
const PITCH_LIMIT = 1.5;

export function wrapAngleRad(rad) {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

// Converts W3C DeviceOrientation (alpha, beta, gamma in degrees) into Waterworld camera
// { yaw, pitch } in radians (+X East, +Y Up, -Z North; forward = [cos(p)*sin(y), sin(p), -cos(p)*cos(y)]).
// Evaluates R_z(alpha) * R_x(beta) * R_y(gamma) * [0, 0, -1]^T directly on the sphere so portrait,
// landscape-left, and landscape-right orientations share one singularity-free horizon mapping.
export function deviceOrientationToViewAngles(alphaDeg, betaDeg, gammaDeg) {
  if (alphaDeg == null || betaDeg == null || gammaDeg == null) return null;
  const a = Number(alphaDeg), b = Number(betaDeg), g = Number(gammaDeg);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(g)) return null;
  const ar = a * D2R, br = b * D2R, gr = g * D2R;
  const ca = Math.cos(ar), sa = Math.sin(ar);
  const cb = Math.cos(br), sb = Math.sin(br);
  const cg = Math.cos(gr), sg = Math.sin(gr);
  const east = -ca * sg - sa * sb * cg;
  const north = -sa * sg + ca * sb * cg;
  const up = Math.max(-1, Math.min(1, -cb * cg));
  const horiz = Math.hypot(east, north);
  const yaw = horiz > 1e-5 ? Math.atan2(east, north) : 0;
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Math.asin(up)));
  return { yaw, pitch };
}

export function computeStickVector(dx, dy, maxRadius = 40, deadzone = 0.10) {
  const r = Math.max(1, maxRadius);
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-5) {
    return { strafe: 0, forward: 0, magnitude: 0, rimBoost: false, knobX: 0, knobY: 0 };
  }
  const ux = dx / dist, uy = dy / dist;
  const clamped = Math.min(dist, r);
  const rawMag = clamped / r;
  const eff = rawMag <= deadzone ? 0 : (rawMag - deadzone) / Math.max(1e-5, 1 - deadzone);
  return {
    strafe: ux * eff,
    forward: -uy * eff,
    magnitude: eff,
    rimBoost: eff > 0.88,
    knobX: ux * clamped,
    knobY: uy * clamped,
  };
}

function formatFlySpeed(speed) {
  const s = Number(speed) || 0;
  return s < 10 ? `${s.toFixed(1)} m/s` : `${Math.round(s)} m/s`;
}

const guardedDocs = new WeakSet();

// Blocks accidental mobile browser viewport zoom during two-thumb camera control
// (WebKit gesturestart/gesturechange, cross-element multi-touch touchmove, rapid double-tap
// dblclick on HUD buttons, and Ctrl+wheel trackpad pinch over HUD overlays) while preserving
// single-finger vertical scrolling inside open settings/modal panels.
export function installViewportZoomGuard(targetDoc = typeof document !== 'undefined' ? document : null) {
  if (!targetDoc || typeof targetDoc.addEventListener !== 'function' || guardedDocs.has(targetDoc)) return false;
  guardedDocs.add(targetDoc);

  const blockGesture = (e) => {
    e.preventDefault();
  };
  targetDoc.addEventListener('gesturestart', blockGesture, { passive: false });
  targetDoc.addEventListener('gesturechange', blockGesture, { passive: false });
  targetDoc.addEventListener('gestureend', blockGesture, { passive: false });

  targetDoc.addEventListener('touchmove', (e) => {
    if ((e.touches && e.touches.length > 1) || (typeof e.scale === 'number' && e.scale !== 1)) {
      e.preventDefault();
    }
  }, { passive: false });

  targetDoc.addEventListener('dblclick', (e) => {
    const t = e.target;
    if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
  }, { passive: false });

  targetDoc.addEventListener('wheel', (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  return true;
}

export function createFreeCamMobileControls({
  getCamera,
  getCameraMode,
  isAshore = () => false,
  isDuelActive = () => false,
  onReturnAboard = () => {},
  onLookActivity = () => {},
  onToast = null,
  forceVisible = false,
} = {}) {
  const coarseQuery = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : { matches: false, addEventListener() {} };
  let hasTouch = Boolean(forceVisible || coarseQuery.matches);
  let manualPadEnabled = Boolean(forceVisible);
  installViewportZoomGuard();

  const state = {
    forward: 0,
    strafe: 0,
    up: 0,
    boost: false,
    rimBoost: false,
    firing: false,
  };

  let boostLatched = false;
  let upHeld = 0;
  let downHeld = 0;
  let stickPointerId = null;
  let stickCenter = { x: 0, y: 0, radius: 40 };

  let gyroEnabled = false;
  let gyroCalibrated = false;
  let rawSensorAngles = null;
  let gyroYawOffset = 0;
  let gyroPitchOffset = 0;
  let listeningOrientation = false;

  const root = document.createElement('section');
  root.id = 'free-cam-controls';
  root.hidden = true;
  root.setAttribute('aria-label', 'Free camera mobile controls');
  root.innerHTML = `
    <div class="fcm-left">
      <button type="button" id="fcm-boost-btn" class="fcm-pill" aria-pressed="false" aria-label="Toggle fast movement">Fast</button>
      <div class="fcm-stick" id="fcm-stick" role="group" aria-label="Move camera">
        <span class="fcm-ring" aria-hidden="true"></span>
        <span class="fcm-knob" id="fcm-knob" aria-hidden="true"></span>
      </div>
    </div>
    <div class="fcm-right">
      <div class="fcm-pills">
        <button type="button" id="fcm-gyro-btn" class="fcm-pill" aria-pressed="false" aria-label="Toggle gyroscope motion look" title="Aim free camera by tilting and turning your device">Motion</button>
        <button type="button" id="fcm-recenter-btn" class="fcm-pill" hidden aria-label="Recenter motion view" title="Align motion sensor horizon with current view">Center</button>
        <button type="button" id="fcm-aboard-btn" class="fcm-pill fcm-pill-gold" aria-label="Return aboard ship">Aboard</button>
      </div>
      <div class="fcm-speed-bar" id="fcm-speed-bar" role="group" aria-label="Flying speed">
        <button type="button" id="fcm-speed-down" class="fcm-step-btn" aria-label="Decrease flying speed">&minus;</button>
        <output id="fcm-speed-readout" aria-live="off">45 m/s</output>
        <button type="button" id="fcm-speed-up" class="fcm-step-btn" aria-label="Increase flying speed">+</button>
      </div>
      <div class="fcm-actions" id="fcm-actions">
        <button type="button" id="fcm-fire-btn" class="fcm-fire-btn" aria-label="Fire 24-pounder cannon">Fire</button>
        <div class="fcm-altitude" id="fcm-altitude" role="group" aria-label="Vertical altitude">
          <button type="button" id="fcm-up-btn" class="fcm-alt-btn" aria-label="Fly up">&#9650;</button>
          <button type="button" id="fcm-down-btn" class="fcm-alt-btn" aria-label="Fly down">&#9660;</button>
        </div>
      </div>
    </div>
  `;

  const stickEl = root.querySelector('#fcm-stick');
  const knobEl = root.querySelector('#fcm-knob');
  const boostBtn = root.querySelector('#fcm-boost-btn');
  const gyroBtn = root.querySelector('#fcm-gyro-btn');
  const recenterBtn = root.querySelector('#fcm-recenter-btn');
  const aboardBtn = root.querySelector('#fcm-aboard-btn');
  const speedBar = root.querySelector('#fcm-speed-bar');
  const speedDownBtn = root.querySelector('#fcm-speed-down');
  const speedUpBtn = root.querySelector('#fcm-speed-up');
  const speedReadout = root.querySelector('#fcm-speed-readout');
  const fireBtn = root.querySelector('#fcm-fire-btn');
  const altitudeGroup = root.querySelector('#fcm-altitude');
  const upBtn = root.querySelector('#fcm-up-btn');
  const downBtn = root.querySelector('#fcm-down-btn');

  // Stop canvas look-pointer capture from stealing touches meant for HUD controls
  root.addEventListener('pointerdown', (e) => e.stopPropagation());

  function updateStickVisual(kx, ky) {
    knobEl.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0)`;
  }

  function resetStick() {
    stickPointerId = null;
    state.forward = 0;
    state.strafe = 0;
    state.rimBoost = false;
    state.boost = boostLatched;
    stickEl.dataset.active = 'false';
    updateStickVisual(0, 0);
  }

  stickEl.addEventListener('pointerdown', (e) => {
    if (stickPointerId !== null) return;
    e.preventDefault();
    hasTouch = hasTouch || e.pointerType === 'touch';
    const rect = stickEl.getBoundingClientRect();
    stickCenter = {
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
      radius: Math.max(24, rect.width * 0.38),
    };
    stickPointerId = e.pointerId;
    stickEl.dataset.active = 'true';
    try { stickEl.setPointerCapture(e.pointerId); } catch { /* synthetic events may lack capture */ }
    const v = computeStickVector(e.clientX - stickCenter.x, e.clientY - stickCenter.y, stickCenter.radius);
    state.strafe = v.strafe;
    state.forward = v.forward;
    state.rimBoost = v.rimBoost;
    state.boost = boostLatched || v.rimBoost;
    updateStickVisual(v.knobX, v.knobY);
    onLookActivity();
  });

  stickEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointerId) return;
    e.preventDefault();
    const v = computeStickVector(e.clientX - stickCenter.x, e.clientY - stickCenter.y, stickCenter.radius);
    state.strafe = v.strafe;
    state.forward = v.forward;
    state.rimBoost = v.rimBoost;
    state.boost = boostLatched || v.rimBoost;
    updateStickVisual(v.knobX, v.knobY);
  });

  const endStick = (e) => {
    if (e.pointerId === stickPointerId) resetStick();
  };
  stickEl.addEventListener('pointerup', endStick);
  stickEl.addEventListener('pointercancel', endStick);
  stickEl.addEventListener('lostpointercapture', endStick);

  function bindHoldButton(btn, onChange) {
    const activeIds = new Set();
    const release = (e) => {
      if (!activeIds.delete(e.pointerId)) return;
      btn.dataset.held = activeIds.size > 0 ? 'true' : 'false';
      onChange(activeIds.size > 0);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      activeIds.add(e.pointerId);
      btn.dataset.held = 'true';
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      onChange(true);
      onLookActivity();
    });
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    return () => {
      activeIds.clear();
      btn.dataset.held = 'false';
      onChange(false);
    };
  }

  const clearUpHold = bindHoldButton(upBtn, (held) => {
    upHeld = held ? 1 : 0;
    state.up = upHeld - downHeld;
  });
  const clearDownHold = bindHoldButton(downBtn, (held) => {
    downHeld = held ? 1 : 0;
    state.up = upHeld - downHeld;
  });
  const clearFireHold = bindHoldButton(fireBtn, (held) => {
    state.firing = held;
  });

  boostBtn.addEventListener('click', () => {
    boostLatched = !boostLatched;
    state.boost = boostLatched || state.rimBoost;
    sync();
  });

  aboardBtn.addEventListener('click', () => {
    resetTransientHolds();
    onReturnAboard();
  });

  function adjustSpeed(factor) {
    const cam = getCamera?.();
    if (!cam) return;
    cam.speed = Math.max(0.5, Math.min(400, cam.speed * factor));
    sync();
  }
  speedDownBtn.addEventListener('click', () => adjustSpeed(1 / 1.45));
  speedUpBtn.addEventListener('click', () => adjustSpeed(1.45));

  function calibrateGyroToCurrentView() {
    const cam = getCamera?.();
    if (!cam || !rawSensorAngles) {
      gyroCalibrated = false;
      return;
    }
    gyroYawOffset = wrapAngleRad(cam.yaw - rawSensorAngles.yaw);
    // Comfortable natural hand-hold offset: if phone is held angled in lap (< -15 deg), center horizon on current hold
    const holdDelta = cam.pitch - rawSensorAngles.pitch;
    gyroPitchOffset = Math.max(-0.55, Math.min(0.95, holdDelta));
    gyroCalibrated = true;
  }

  function handleDeviceOrientation(e) {
    const angles = deviceOrientationToViewAngles(e.alpha, e.beta, e.gamma);
    if (!angles) return;
    rawSensorAngles = angles;
    if (gyroEnabled && !gyroCalibrated) {
      calibrateGyroToCurrentView();
    }
    onLookActivity();
  }

  function ensureOrientationListener(on) {
    if (typeof addEventListener !== 'function') return;
    if (on && !listeningOrientation) {
      addEventListener('deviceorientation', handleDeviceOrientation, true);
      listeningOrientation = true;
    } else if (!on && listeningOrientation) {
      removeEventListener('deviceorientation', handleDeviceOrientation, true);
      listeningOrientation = false;
    }
  }

  async function setGyroEnabled(wantOn) {
    if (!wantOn) {
      gyroEnabled = false;
      gyroCalibrated = false;
      ensureOrientationListener(false);
      sync();
      return false;
    }
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      onToast?.('Motion sensors are not available on this device.', 4);
      gyroEnabled = false;
      sync();
      return false;
    }
    try {
      if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
        const perm = await window.DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          onToast?.('Motion sensor permission was not granted.', 4);
          gyroEnabled = false;
          sync();
          return false;
        }
      }
    } catch {
      onToast?.('Motion sensors require HTTPS and permission on this browser.', 4);
      gyroEnabled = false;
      sync();
      return false;
    }
    gyroEnabled = true;
    gyroCalibrated = false;
    ensureOrientationListener(true);
    if (rawSensorAngles) calibrateGyroToCurrentView();
    sync();
    return true;
  }

  gyroBtn.addEventListener('click', () => {
    void setGyroEnabled(!gyroEnabled);
  });

  recenterBtn.addEventListener('click', () => {
    calibrateGyroToCurrentView();
  });

  function resetTransientHolds() {
    resetStick();
    clearUpHold();
    clearDownHold();
    clearFireHold();
  }

  function shouldShowControls() {
    if (getCameraMode?.() !== 'free') return false;
    return Boolean(hasTouch || coarseQuery.matches || manualPadEnabled || gyroEnabled);
  }

  let externalSyncListeners = [];

  function sync() {
    const activeFree = getCameraMode?.() === 'free';
    if (!activeFree && (stickPointerId !== null || upHeld || downHeld || state.firing)) {
      resetTransientHolds();
    }
    const visible = shouldShowControls();
    root.hidden = !visible;
    document.body.classList.toggle('free-cam-mobile-active', visible);

    const ashore = Boolean(isAshore?.());
    const duel = Boolean(isDuelActive?.());
    boostBtn.textContent = ashore ? 'Run' : 'Fast';
    boostBtn.setAttribute('aria-label', ashore ? 'Toggle running pace ashore' : 'Toggle fast flight boost');
    boostBtn.setAttribute('aria-pressed', String(boostLatched));

    gyroBtn.setAttribute('aria-pressed', String(gyroEnabled));
    recenterBtn.hidden = !gyroEnabled;
    aboardBtn.hidden = duel;

    speedBar.hidden = ashore;
    altitudeGroup.hidden = ashore;
    fireBtn.hidden = ashore || duel;

    const cam = getCamera?.();
    if (cam && !ashore) {
      speedReadout.textContent = formatFlySpeed(cam.speed);
    }
    for (const fn of externalSyncListeners) fn({ visible, gyroEnabled, manualPadEnabled, hasTouch });
  }

  coarseQuery.addEventListener?.('change', () => {
    if (coarseQuery.matches) hasTouch = true;
    sync();
  });
  addEventListener('blur', resetTransientHolds);
  document.addEventListener?.('visibilitychange', () => {
    if (document.hidden) resetTransientHolds();
  });

  return {
    element: root,
    state,
    get gyroActive() { return gyroEnabled; },
    get padVisible() { return !root.hidden; },
    get manualPadEnabled() { return manualPadEnabled; },
    noteTouch() {
      if (!hasTouch) {
        hasTouch = true;
        sync();
      }
    },
    setManualPadEnabled(on) {
      manualPadEnabled = Boolean(on);
      sync();
    },
    toggleGyro: () => setGyroEnabled(!gyroEnabled),
    setGyroEnabled,
    recenterGyro: calibrateGyroToCurrentView,
    // Feed simulated or custom orientation samples directly (also powers deterministic automated tests).
    feedOrientation(alpha, beta, gamma) {
      handleDeviceOrientation({ alpha, beta, gamma });
    },
    addLookOffset(dYaw, dPitch) {
      if (!gyroEnabled) return;
      gyroYawOffset = wrapAngleRad(gyroYawOffset + dYaw);
      gyroPitchOffset = Math.max(-1.2, Math.min(1.2, gyroPitchOffset + dPitch));
    },
    applyGyro(cam, dt) {
      if (!gyroEnabled || !gyroCalibrated || !rawSensorAngles || !cam) return false;
      const targetYaw = wrapAngleRad(rawSensorAngles.yaw + gyroYawOffset);
      const targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, rawSensorAngles.pitch + gyroPitchOffset));
      const blend = 1 - Math.exp(-Math.max(0.001, dt) * 22);
      cam.yaw = wrapAngleRad(cam.yaw + wrapAngleRad(targetYaw - cam.yaw) * blend);
      cam.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cam.pitch + (targetPitch - cam.pitch) * blend));
      return true;
    },
    onSync(fn) {
      externalSyncListeners.push(fn);
    },
    sync,
  };
}
