// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import {
  wrapAngleRad,
  deviceOrientationToViewAngles,
  computeStickVector,
} from '../js/free-cam-mobile.js';

const D2R = Math.PI / 180;
const close = (a, b, tol = 1e-4, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

test('deviceOrientationToViewAngles maps portrait and landscape W3C attitudes without gimbal lock', () => {
  assert.equal(deviceOrientationToViewAngles(null, 90, 0), null);
  assert.equal(deviceOrientationToViewAngles(NaN, 90, 0), null);

  // Portrait upright facing North -> yaw=0, pitch=0
  const north = deviceOrientationToViewAngles(0, 90, 0);
  close(north.yaw, 0, 1e-6, 'North yaw');
  close(north.pitch, 0, 1e-6, 'North pitch');

  // Portrait tilted back 30 deg -> looking +30 deg above horizon
  const up30 = deviceOrientationToViewAngles(0, 120, 0);
  close(up30.yaw, 0, 1e-6, 'Up yaw');
  close(up30.pitch, 30 * D2R, 1e-4, 'Up +30 pitch');

  // Portrait tilted forward 30 deg -> looking -30 deg below horizon
  const down30 = deviceOrientationToViewAngles(0, 60, 0);
  close(down30.yaw, 0, 1e-6, 'Down yaw');
  close(down30.pitch, -30 * D2R, 1e-4, 'Down -30 pitch');

  // Facing East (W3C alpha=270 CCW = 90 CW) -> yaw = +pi/2; West (alpha=90) -> yaw = -pi/2
  close(deviceOrientationToViewAngles(270, 90, 0).yaw, Math.PI / 2, 1e-5, 'East yaw');
  close(deviceOrientationToViewAngles(90, 90, 0).yaw, -Math.PI / 2, 1e-5, 'West yaw');

  // Landscape-left upright facing North (alpha=90, beta=0, gamma=-90) -> yaw=0, pitch=0
  const landLeft = deviceOrientationToViewAngles(90, 0, -90);
  close(landLeft.yaw, 0, 1e-5, 'Landscape-left North yaw');
  close(landLeft.pitch, 0, 1e-5, 'Landscape-left horizon pitch');

  // Wrap across +-pi boundary
  close(wrapAngleRad(Math.PI + 0.2), -Math.PI + 0.2, 1e-6, 'wrapAngleRad +pi');
  close(wrapAngleRad(-Math.PI - 0.2), Math.PI - 0.2, 1e-6, 'wrapAngleRad -pi');
});

test('computeStickVector enforces radial deadzone, proportional deflection, and outer-rim boost', () => {
  const zero = computeStickVector(2, -1, 40, 0.10);
  assert.equal(zero.magnitude, 0);
  assert.equal(zero.forward, 0);
  assert.equal(zero.strafe, 0);
  assert.equal(zero.rimBoost, false);

  const halfUp = computeStickVector(0, -22, 40, 0.10);
  close(halfUp.forward, (0.55 - 0.10) / 0.90, 1e-5, 'proportional forward');
  close(halfUp.strafe, 0, 1e-6);
  assert.equal(halfUp.rimBoost, false);

  const fullRight = computeStickVector(80, 0, 40, 0.10);
  close(fullRight.strafe, 1, 1e-6);
  close(fullRight.knobX, 40, 1e-6, 'knob clamped to maxRadius');
  assert.equal(fullRight.rimBoost, true);
});

let server, browser, origin;

before(async () => {
  server = createDevServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
  const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync(macChrome) ? macChrome : undefined);
  browser = await chromium.launch({
    executablePath,
    args: process.env.WEBGPU_BACKEND === 'metal' || (!process.env.WEBGPU_BACKEND && process.platform === 'darwin')
      ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog']
      : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'],
  });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  if (server) await new Promise(r => server.close(r));
});

test('mobile free-cam HUD provides >=44px WCAG touch targets, thumbstick flight, altitude, speed, and gyro look', { timeout: 120000 }, async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  try {
    await page.goto(`${origin}/docs/index.html?ocean=1&view=free&cam=0,25,60,0,-10&crew=0&follower=0&clouds=0&reset=1&newVoyage=1`);
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 90000 });
    assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');

    // Verify mobile free-cam HUD is visible and every button is >= 44x44 CSS px without clipping
    const metrics = await page.evaluate(() => {
      const fcm = document.getElementById('free-cam-controls');
      const ids = ['fcm-boost-btn', 'fcm-gyro-btn', 'fcm-aboard-btn', 'fcm-speed-down', 'fcm-speed-up', 'fcm-fire-btn', 'fcm-up-btn', 'fcm-down-btn'];
      const boxes = ids.map(id => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        return { id, w: r.width, h: r.height, left: r.left, right: r.right, bottom: r.bottom };
      });
      const helmDisplay = getComputedStyle(document.getElementById('helm-controls')).display;
      return { hidden: fcm.hidden, helmDisplay, boxes, vw: window.innerWidth, vh: window.innerHeight };
    });
    assert.equal(metrics.hidden, false, 'free-cam-controls shown automatically on mobile in free mode');
    assert.equal(metrics.helmDisplay, 'none', 'ship helm-controls hidden on mobile while free-cam-controls active');
    for (const b of metrics.boxes) {
      assert.ok(b.w >= 43.5 && b.h >= 43.5, `${b.id} meets 44x44 touch target (${b.w}x${b.h})`);
      assert.ok(b.left >= 0 && b.right <= metrics.vw && b.bottom <= metrics.vh, `${b.id} stays inside viewport`);
    }

    // Check 320px narrow viewport does not clip or overflow horizontally
    await page.setViewportSize({ width: 320, height: 640 });
    const narrowCheck = await page.evaluate(() => {
      const stick = document.getElementById('fcm-stick').getBoundingClientRect();
      const act = document.getElementById('fcm-actions').getBoundingClientRect();
      return { stickLeft: stick.left, stickRight: stick.right, actLeft: act.left, actRight: act.right, vw: window.innerWidth };
    });
    assert.ok(narrowCheck.stickLeft >= 0 && narrowCheck.actRight <= narrowCheck.vw && narrowCheck.stickRight < narrowCheck.actLeft, 'left stick and right actions do not collide at 320px width');
    await page.setViewportSize({ width: 390, height: 844 });

    // Drive virtual thumbstick forward + right and verify camera translates forward (-Z) and starboard (+X)
    const beforeFly = await page.evaluate(() => ({ ...window.oceanFleet.freeCam }));
    await page.evaluate(() => {
      const stick = document.getElementById('fcm-stick');
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
      stick.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, pointerType: 'touch', clientX: cx + 24, clientY: cy - 32, bubbles: true }));
    });
    await page.waitForTimeout(220);
    await page.evaluate(() => {
      document.getElementById('fcm-stick').dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, pointerType: 'touch', bubbles: true }));
    });
    const afterFly = await page.evaluate(() => ({ ...window.oceanFleet.freeCam }));
    assert.ok(afterFly.z < beforeFly.z - 0.5, `thumbstick forward moved camera -Z (${beforeFly.z} -> ${afterFly.z})`);
    assert.ok(afterFly.x > beforeFly.x + 0.3, `thumbstick strafe moved camera +X (${beforeFly.x} -> ${afterFly.x})`);

    // Hold Up button and verify camera ascends (+Y)
    await page.evaluate(() => {
      document.getElementById('fcm-up-btn').dispatchEvent(new PointerEvent('pointerdown', { pointerId: 12, pointerType: 'touch', bubbles: true }));
    });
    await page.waitForTimeout(180);
    await page.evaluate(() => {
      document.getElementById('fcm-up-btn').dispatchEvent(new PointerEvent('pointerup', { pointerId: 12, pointerType: 'touch', bubbles: true }));
    });
    const afterUp = await page.evaluate(() => ({ ...window.oceanFleet.freeCam }));
    assert.ok(afterUp.y > afterFly.y + 0.5, `Up button raised camera altitude (${afterFly.y} -> ${afterUp.y})`);

    // Enable gyroscope look, calibrate at North, then pan phone 35 deg East and tilt +15 deg Up
    await page.evaluate(async () => {
      await window.oceanFreeCamMobile.setGyroEnabled(true);
      window.oceanFreeCamMobile.feedOrientation(0, 90, 0);
    });
    const baseLook = await page.evaluate(() => ({ yaw: window.oceanFleet.freeCam.yaw, pitch: window.oceanFleet.freeCam.pitch }));
    await page.evaluate(() => {
      // alpha=325 deg CCW = 35 deg East; beta=105 deg = +15 deg pitch up
      window.oceanFreeCamMobile.feedOrientation(325, 105, 0);
    });
    await page.waitForTimeout(220);
    const afterGyro = await page.evaluate(() => ({ yaw: window.oceanFleet.freeCam.yaw, pitch: window.oceanFleet.freeCam.pitch }));
    assert.ok(afterGyro.yaw > baseLook.yaw + 0.35, `gyro yaw rotated East (${baseLook.yaw} -> ${afterGyro.yaw})`);
    assert.ok(afterGyro.pitch > baseLook.pitch + 0.15, `gyro pitch tilted Up (${baseLook.pitch} -> ${afterGyro.pitch})`);

    // Verify accidental browser page zoom is locked out across HUD controls, canvas, WebKit gestures, multi-touch, and double-tap
    const zoomLock = await page.evaluate(() => {
      const ta = (sel) => getComputedStyle(document.querySelector(sel)).touchAction;
      const gestureEvt = new Event('gesturestart', { bubbles: true, cancelable: true });
      document.getElementById('fcm-gyro-btn').dispatchEvent(gestureEvt);
      const multiTouchEvt = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(multiTouchEvt, 'touches', { value: [{ clientX: 50, clientY: 700 }, { clientX: 300, clientY: 400 }] });
      document.getElementById('fcm-stick').dispatchEvent(multiTouchEvt);
      const singleScrollEvt = new Event('touchmove', { bubbles: true, cancelable: true });
      Object.defineProperty(singleScrollEvt, 'touches', { value: [{ clientX: 200, clientY: 300 }] });
      document.querySelector('.panel-body').dispatchEvent(singleScrollEvt);
      const dblEvt = new MouseEvent('dblclick', { bubbles: true, cancelable: true });
      document.getElementById('fcm-speed-up').dispatchEvent(dblEvt);
      const ctrlWheelEvt = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -20 });
      document.getElementById('free-cam-controls').dispatchEvent(ctrlWheelEvt);
      return {
        bodyTA: ta('body'),
        canvasTA: ta('#c'),
        fcmTA: ta('#free-cam-controls'),
        pillTA: ta('#fcm-gyro-btn'),
        stepTA: ta('#fcm-speed-up'),
        helmTA: ta('#helm-controls'),
        dockTA: ta('#camera-dock'),
        panelBodyTA: ta('.panel-body'),
        rudderTA: ta('#boat-rudder'),
        gestureBlocked: gestureEvt.defaultPrevented,
        multiTouchBlocked: multiTouchEvt.defaultPrevented,
        singleTouchAllowed: !singleScrollEvt.defaultPrevented,
        dblClickBlocked: dblEvt.defaultPrevented,
        ctrlWheelBlocked: ctrlWheelEvt.defaultPrevented,
      };
    });
    assert.equal(zoomLock.bodyTA, 'none', 'body forbids browser pan/pinch-zoom');
    assert.equal(zoomLock.canvasTA, 'none', 'canvas forbids browser pan/pinch-zoom');
    assert.equal(zoomLock.fcmTA, 'none', 'free-cam-controls forbids pinch-zoom');
    assert.equal(zoomLock.pillTA, 'none', 'HUD pill buttons forbid pinch-zoom');
    assert.equal(zoomLock.stepTA, 'none', 'HUD stepper buttons forbid pinch-zoom');
    assert.equal(zoomLock.helmTA, 'none', 'helm-controls forbids pinch-zoom');
    assert.equal(zoomLock.dockTA, 'none', 'camera-dock forbids pinch-zoom');
    assert.equal(zoomLock.panelBodyTA, 'pan-y', 'settings panel-body preserves vertical scrolling without pinch-zoom');
    assert.equal(zoomLock.rudderTA, 'pan-x', 'range sliders preserve horizontal dragging without pinch-zoom');
    assert.equal(zoomLock.gestureBlocked, true, 'WebKit gesturestart prevented');
    assert.equal(zoomLock.multiTouchBlocked, true, 'two-finger cross-element touchmove prevented');
    assert.equal(zoomLock.singleTouchAllowed, true, 'single-finger panel scroll touchmove allowed');
    assert.equal(zoomLock.dblClickBlocked, true, 'rapid button double-tap zoom prevented');
    assert.equal(zoomLock.ctrlWheelBlocked, true, 'Ctrl+wheel trackpad pinch over HUD prevented');

    // Tap Aboard button -> returns to boat mode and hides free-cam-controls
    await page.click('#fcm-aboard-btn');
    const aboardState = await page.evaluate(() => ({
      padVisible: window.oceanFreeCamMobile.padVisible,
      boatEnabled: window.oceanFleet.vessels[0].boat.enabled,
    }));
    assert.equal(aboardState.padVisible, false);
    assert.equal(aboardState.boatEnabled, true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
