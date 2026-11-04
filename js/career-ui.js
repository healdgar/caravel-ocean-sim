// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The start-of-session choice: carry on the saved voyage or begin another.
import { formatJulianDate } from './voyage/ocean-climate.js';

export function careerSaveSummary(save) {
  const voyage = save?.voyage;
  if (!voyage) return '';
  const lost = save.career?.shipsLost ?? 0;
  return [
    voyage.shipName,
    Number.isFinite(voyage.dateMs) ? formatJulianDate(voyage.dateMs) : null,
    Number.isFinite(voyage.dayAtSea) ? `day ${voyage.dayAtSea}` : null,
    lost ? `${lost} ship${lost > 1 ? 's' : ''} lost` : null,
  ].filter(Boolean).join(' · ');
}

export function showCareerPrompt(parent, { save, onContinue, onNewVoyage }) {
  const backdrop = document.createElement('div');
  backdrop.id = 'career-prompt';
  backdrop.innerHTML = `<div class="career-card" role="dialog" aria-modal="true" aria-labelledby="career-title">
    <h2 id="career-title">A voyage is laid up in the log</h2>
    <p class="career-summary"></p>
    <div class="career-actions">
      <button type="button" class="career-continue">Continue voyage</button>
      <button type="button" class="career-new">New voyage</button>
    </div>
  </div>`;
  backdrop.querySelector('.career-summary').textContent = careerSaveSummary(save);
  const continueButton = backdrop.querySelector('.career-continue');
  const newButton = backdrop.querySelector('.career-new');
  const close = () => backdrop.remove();
  continueButton.onclick = () => {
    close();
    onContinue?.();
  };
  // Erasing a voyage takes a second, deliberate click.
  newButton.onclick = () => {
    if (newButton.dataset.armed !== '1') {
      newButton.dataset.armed = '1';
      newButton.textContent = 'Erase saved voyage?';
      return;
    }
    close();
    onNewVoyage?.();
  };
  parent.append(backdrop);
  continueButton.focus();
  return backdrop;
}
