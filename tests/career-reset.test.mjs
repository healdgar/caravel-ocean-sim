// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// A button that erases a career asks once more before it does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { armBeforeErasing } from '../js/voyage/voyage-controller.js';

function fixture(prompt = 'Erase saved career?') {
  const button = { textContent: 'Reset voyage', dataset: {}, onclick: null };
  const timers = [];
  let erased = 0, clock = 0;
  armBeforeErasing(button, {
    prompt,
    onConfirm: () => { erased++; },
    standDownMs: 6000,
    schedule: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    cancel: (id) => { if (timers[id]) timers[id].live = false; },
    now: () => clock,
  });
  const elapse = () => { for (const timer of timers) if (timer.live) { timer.live = false; timer.fn(); } };
  // A person takes about a second to read the question and click again.
  const wait = (ms = 1000) => { clock += ms; };
  return { button, timers, elapse, wait, erased: () => erased };
}

test('the first click erases nothing and says what the second will erase', () => {
  const { button, timers, wait, erased } = fixture();
  button.onclick();
  assert.equal(erased(), 0);
  assert.equal(button.textContent, 'Erase saved career?');
  assert.equal(button.dataset.armed, '1');
  assert.equal(timers[0].ms, 6000);
  wait();
  button.onclick();
  assert.equal(erased(), 1, 'the second click erases, once');
  assert.equal(button.textContent, 'Reset voyage', 'and the button is as it was');
  assert.equal(button.dataset.armed, undefined);
  assert.equal(timers[0].live, false, 'with no stand-down left to fire');
});

test('an armed button left alone stands down, so a later stray click erases nothing', () => {
  const { button, elapse, erased } = fixture(() => 'Abandon this voyage?');
  button.onclick();
  assert.equal(button.textContent, 'Abandon this voyage?', 'the prompt is asked for when the button is armed');
  elapse();
  assert.equal(button.textContent, 'Reset voyage');
  assert.equal(button.dataset.armed, undefined);
  button.onclick();
  assert.equal(erased(), 0, 'the next click only arms it again');
  assert.equal(button.dataset.armed, '1');
});

test('a double-click does not erase: the second click comes before anyone could have read the question', () => {
  const { button, wait, erased } = fixture();
  button.onclick();
  wait(180);
  button.onclick();
  assert.equal(erased(), 0, 'the second click of a double-click is not a decision');
  assert.equal(button.dataset.armed, '1', 'and the question still stands');
  wait(600);
  button.onclick();
  assert.equal(erased(), 1, 'a click after reading it erases');
});
