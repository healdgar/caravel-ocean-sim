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

const careerEl = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'action') node.dataset.action = value;
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'onclick') node.onclick = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter(Boolean));
  return node;
};
export function careerMoney(currency, amount) {
  const whole = Math.round(amount);
  return `${whole.toLocaleString('en-US')} ${whole === 1 ? currency.singular : currency.plural}`;
}
const careerButton = (label, action, disabled, onclick, extra = '') => careerEl('button', { type: 'button', class: `port-button ${extra}`.trim(), text: label, action, disabled, onclick });

// The ship's business in port. Every action goes straight through to the career port,
// which saves it, and then the panel redraws from what is now true.
export function showPortPanel(parent, port, { getDateLabel = () => '', onClose = () => {} } = {}) {
  const backdrop = careerEl('div', { id: 'port-panel' });
  const card = careerEl('div', { class: 'port-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'port-panel-title' });
  backdrop.append(card);
  let retireArmed = false;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    onClose();
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const act = (fn) => () => { fn(); render(); };

  function marketSection(view) {
    const money = (n) => careerMoney(view.currency, n);
    const room = view.hold.capacity - view.hold.used;
    const rows = [...view.goods].sort((a, b) => Number(b.held > 0) - Number(a.held > 0) || Number(b.offered) - Number(a.offered) || a.name.localeCompare(b.name));
    const section = careerEl('section', { class: 'port-section' }, careerEl('h3', { text: 'Market' }),
      careerEl('p', { class: 'port-note', text: `Per tonne: what it costs here, and what this market pays. Hold ${view.hold.used} of ${view.hold.capacity} t.` }));
    for (const good of rows) {
      const affordable = good.buy <= view.purse && room >= 1;
      const actions = careerEl('div', { class: 'port-actions' });
      if (good.offered) {
        actions.append(careerButton('Buy 1', `buy-${good.id}`, !affordable, act(() => port.buy(good.id, 1))));
        actions.append(careerButton('Buy 5', `buy5-${good.id}`, !affordable || room < 5, act(() => port.buy(good.id, 5))));
      }
      if (good.held > 0) {
        actions.append(careerButton('Sell 1', `sell-${good.id}`, false, act(() => port.sell(good.id, 1))));
        actions.append(careerButton('Sell all', `sellall-${good.id}`, false, act(() => port.sell(good.id))));
      }
      section.append(careerEl('div', { class: 'port-row', 'data-good': good.id },
        careerEl('div', { class: 'port-good' },
          careerEl('strong', { text: good.name }),
          careerEl('span', { text: `${good.offered ? `Costs ${good.buy.toLocaleString('en-US')} · ` : ''}Pays ${good.sell.toLocaleString('en-US')}${good.held ? ` · ${good.held} t aboard` : ''}` })),
        actions));
    }
    if (!rows.length) section.append(careerEl('p', { class: 'port-note', text: 'Nothing is traded here.' }));
    section.setAttribute('aria-label', `Market, purse ${money(view.purse)}`);
    return section;
  }
  function businessSection(view) {
    const money = (n) => careerMoney(view.currency, n);
    const row = (title, detail, button) => careerEl('div', { class: 'port-row' },
      careerEl('div', { class: 'port-good' }, careerEl('strong', { text: title }), careerEl('span', { text: detail })),
      careerEl('div', { class: 'port-actions' }, button));
    const { wages, stores, crew, repair } = view;
    return careerEl('section', { class: 'port-section' }, careerEl('h3', { text: 'Ship’s business' }),
      row('Harbor pilot', 'Takes her out past the bar to open water, ready for a course',
        careerButton(`Put to sea for ${money(view.pilotFee)}`, 'put-to-sea', false, () => { close(); port.putToSea(); })),
      row('Wages', wages.due > 0 ? `${money(wages.due)} owed for ${wages.days} days` : 'The crew are paid up',
        wages.due > 0 ? careerButton(view.purse >= wages.due ? 'Pay' : 'Pay what we can', 'pay-wages', view.purse < 1, act(() => port.payWages())) : null),
      row('Stores', `Food ${Math.ceil(stores.foodDays)} days, water ${Math.ceil(stores.waterDays)} days`,
        stores.cost > 0 ? careerButton(`Fill for ${money(stores.cost)}`, 'provision', stores.cost > view.purse, act(() => port.provision())) : null),
      row('Hands', crew.needed > 0 ? `${crew.able} of ${crew.total} fit for duty` : `All ${crew.total} fit for duty`,
        crew.needed > 0 ? careerButton(`Hire and tend for ${money(crew.cost)}`, 'hire', crew.cost > view.purse, act(() => port.hireCrew())) : null),
      row('Repairs', repair.needed
        ? `Hull ${Math.round((1 - repair.hull) * 100)}%, rig ${Math.round((1 - repair.rig) * 100)}%. ${repair.days} day${repair.days === 1 ? '' : 's'} in the yard${repair.limit < 1 ? ', patching only' : ''}`
        : `Hull ${Math.round((1 - repair.hull) * 100)}%, rig ${Math.round((1 - repair.rig) * 100)}%${repair.limit < 1 ? '. No more can be done here' : ''}`,
      repair.needed ? careerButton(`Repair for ${money(repair.cost)}`, 'repair', repair.cost > view.purse, act(() => port.repair())) : null));
  }
  function yardSection(view) {
    if (!view.ships.length) return null;
    const money = (n) => careerMoney(view.currency, n);
    const section = careerEl('section', { class: 'port-section' }, careerEl('h3', { text: 'Shipyard' }),
      careerEl('p', { class: 'port-note', text: `Your present hull is worth ${money(view.ships[0].tradeIn)} in part exchange.` }));
    for (const ship of view.ships) {
      section.append(careerEl('div', { class: 'port-row' },
        careerEl('div', { class: 'port-good' }, careerEl('strong', { text: ship.name }),
          careerEl('span', { text: ship.fits ? `Carries ${ship.capacity} t` : `Carries ${ship.capacity} t, less than the cargo aboard` })),
        careerEl('div', { class: 'port-actions' }, careerButton(`Buy for ${money(ship.cost)}`, `ship-${ship.id}`, !ship.fits || ship.cost > view.purse, () => port.buyShip(ship.id)))));
    }
    return section;
  }
  function retireSection(view) {
    return careerEl('section', { class: 'port-section' }, careerEl('h3', { text: 'Retire ashore' }),
      careerEl('p', { class: 'port-note', text: `All you own comes to ${careerMoney(view.currency, view.worth)}. Retiring ends this life at sea.` }),
      careerButton(retireArmed ? 'Leave the sea for good?' : 'Retire ashore', 'retire', false, () => {
        if (!retireArmed) { retireArmed = true; render(); return; }
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        port.retire();
      }, retireArmed ? 'port-danger' : ''));
  }
  function render() {
    const view = port.view();
    if (!view) { close(); return; }
    const focused = document.activeElement?.dataset?.action, scroll = card.scrollTop;
    card.replaceChildren(
      careerEl('header', { class: 'port-header' },
        careerEl('div', {},
          careerEl('h2', { id: 'port-panel-title', text: view.port.name }),
          careerEl('p', { class: 'port-note', text: [view.power ? `${view.power} port` : null, getDateLabel()].filter(Boolean).join(' · ') })),
        careerEl('p', { class: 'port-purse', role: 'status', text: careerMoney(view.currency, view.purse) }),
        careerEl('button', { type: 'button', class: 'port-close', 'aria-label': 'Back to the ship', text: '✕', onclick: close })),
      marketSection(view), businessSection(view), yardSection(view) ?? '', retireSection(view));
    card.scrollTop = scroll;
    const again = focused && card.querySelector(`[data-action="${focused}"]`);
    if (again && !again.disabled) again.focus();
  }
  parent.append(backdrop);
  render();
  card.querySelector('.port-close')?.focus();
  return { element: backdrop, close, refresh: render };
}

// How a life at sea ended. Only what the game actually tracked is shown.
export function showCareerEnding(parent, ending, { onNewLife = () => {} } = {}) {
  const money = careerMoney(ending.currency, ending.worth);
  const lines = [
    ['Worth', money],
    ['Years at sea', ending.years.toFixed(1)],
    ['Ports of call', String(ending.ports)],
    ['Tonnes traded', Math.round(ending.tonnesTraded).toLocaleString('en-US')],
    ['Prizes taken', String(ending.prizesTaken)],
    ['Ships lost', String(ending.shipsLost)],
    ['Hands lost', String(ending.handsLost)],
  ];
  const list = careerEl('dl', { class: 'career-ending-lines' });
  for (const [term, value] of lines) list.append(careerEl('div', {}, careerEl('dt', { text: term }), careerEl('dd', { text: value })));
  const again = careerEl('button', { type: 'button', class: 'career-continue', text: 'Begin a new life', onclick: onNewLife });
  const backdrop = careerEl('div', { id: 'career-prompt', class: 'career-ending' },
    careerEl('div', { class: 'career-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'career-ending-title' },
      careerEl('h2', { id: 'career-ending-title', text: ending.title }),
      careerEl('p', { class: 'career-summary', text: `Retired ashore at ${ending.portName}, ${formatJulianDate(ending.dateMs)}.` }),
      list,
      careerEl('div', { class: 'career-actions' }, again)));
  parent.append(backdrop);
  again.focus();
  return backdrop;
}
