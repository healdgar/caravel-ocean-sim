// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The storyteller's door into the running game. A dungeon master (mcp/waterworld-dm.mjs: an MCP server the player
// adds to an agent app on this computer) asks the game what it knows and puts words on its screen, and the game
// tells it what the player does. In the story it is the captain's first mate. They speak over one WebSocket to
// 127.0.0.1, opened from here once the player has typed the pairing code the storyteller gave them: it opens to no
// one without the code, and nothing leaves the machine by it.
// With no storyteller at all the mate still speaks: the panel here offers the questions that fit the moment, and
// the mate answers each from what the game already holds (js/mate-counsel.js).
import { folkCardFacts } from './folk-card.js';

export const STORYTELLER_PORT = 7467;
const STORYTELLER_CODE = /^[A-Z]{5}\d$/, STORYTELLER_KEPT = 'waterworld.storyteller.code', STORYTELLER_OPEN = 'waterworld.mate.open', STORYTELLER_LINES = 60, STORYTELLER_SAID_MOST = 600;

// Where a pairing code leads: five letters, then which of the storyteller's ten ports it took. null if it is no code.
export function storytellerAddress(code) {
  const tidy = String(code ?? '').trim().toUpperCase();
  return STORYTELLER_CODE.test(tidy) ? `ws://127.0.0.1:${STORYTELLER_PORT + Number(tidy[5])}/?code=${tidy}` : null;
}

// The callings a mate is likeliest to come from, best first: those who already know boats, rope and timber.
export const MATE_CALLINGS = Object.freeze(['boatman', 'fisher', 'roper', 'carpenter', 'cooper', 'salter', 'merchant', 'carter', 'smith', 'chandler']);
// Who of a port's grown people might sign on as mate: of an age to go to sea and to be obeyed, of the sea's callings
// before the land's, no more than two of one calling, and no one who stands a post (`away`, a set of numbers). The
// same people in the same order every time it is asked of the same port on the same day.
export function mateShortlist(souls, { n = 6, away = null } = {}) {
  const rank = (soul) => { const at = MATE_CALLINGS.indexOf(soul.role); return at < 0 ? MATE_CALLINGS.length + (soul.role ? 0 : 2) : at; };
  const fit = (souls ?? []).filter((soul) => soul && Number.isFinite(soul.id) && soul.age >= 18 && soul.age <= 46 && !away?.has(soul.id))
    .sort((a, b) => rank(a) - rank(b) || Math.abs(a.age - 30) - Math.abs(b.age - 30) || a.id - b.id);
  const chosen = [], of = new Map();
  for (const soul of fit) {
    const had = of.get(soul.role ?? '') ?? 0;
    if (had >= 2) continue;
    of.set(soul.role ?? '', had + 1); chosen.push(soul);
    if (chosen.length >= Math.max(1, Math.min(12, n | 0 || 6))) break;
  }
  return chosen;
}

// One person as whoever plays them is to be told: the model's card of them read into facts, with where they are,
// the day, and what is common talk. `answer` is what the model says of them ({card}); `status` its word on the realm.
export function storytellerScene({ soul, answer, doing = '', place = {}, status = null, news = [], harbour = '' }) {
  const card = folkCardFacts(answer?.card ?? ''), title = card.title.split(' — ')[0].trim();
  return {
    person: { id: soul.id, name: soul.name || title || 'Someone', age: soul.age, sex: soul.sex ?? null, role: soul.role ?? null },
    card: { facts: card.facts, household: card.household, skills: card.skills, nature: card.nature, learning: card.learning, life: card.life },
    doing, place, date: { text: status?.date ?? '', day: status?.day, year: status?.year }, weather: status?.weather ?? '',
    news: (news ?? []).slice(-10).map((line) => ({ date: line.date, text: line.text })), harbour,
  };
}

const STORYTELLER_STYLE = `
#storyteller { margin-top:14px; padding-top:10px; border-top:1px solid #c9a46a55; }
#storyteller h3 { margin:0 0 4px; font-size:15px; font-weight:400; color:#edb86b; }
#storyteller p { margin:0 0 8px; font-size:13px; }
#storyteller form, #storyteller-says form, #folk-card .folk-talk { display:flex; gap:6px; }
#storyteller input, #storyteller-says input, #folk-card .folk-talk input { flex:1; min-width:0; min-height:32px; padding:3px 8px; border:1px solid #c9a46a; border-radius:7px; background:#14120d; color:#f0e4ca; font:14px Georgia,serif; }
#storyteller-code { max-width:8.5em; letter-spacing:.18em; text-transform:uppercase; font-family:ui-monospace,monospace !important; }
#storyteller button, #storyteller-says button, #folk-card .folk-talk button { min-height:32px; padding:3px 12px; border:1px solid #c9a46a; border-radius:7px; background:#1c1a14; color:#f0e4ca; font:13px Georgia,serif; cursor:pointer; }
#storyteller-says { position:fixed; z-index:30; left:max(12px,env(safe-area-inset-left)); bottom:calc(var(--instruments-bottom,92px) + 14px); max-width:calc(100vw - 24px); box-sizing:border-box; padding:6px 10px; border:1px solid #c9a46a88; border-radius:9px; background:#17140fe6; color:#f1e3c4; font:15px/1.35 'IM Fell English','Palatino Linotype',Palatino,Georgia,serif; }
#storyteller-says[data-open="1"] { width:min(430px,calc(100vw - 24px)); padding:8px 12px 10px; }
#storyteller-says .mate-bar { display:block; width:100%; min-height:30px; padding:2px 0; border:0; background:none; color:#edb86b; font:inherit; text-align:left; cursor:pointer; }
#storyteller-says .mate-bar::before { content:'▸ '; }
#storyteller-says[data-open="1"] .mate-bar::before { content:'▾ '; }
#storyteller-says .mate-body { margin-top:6px; }
.mate-topics { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 8px; }
.mate-topics button { min-height:30px; padding:3px 10px; border:1px solid #c9a46a; border-radius:14px; background:#1c1a14; color:#f0e4ca; font:13px Georgia,serif; cursor:pointer; }
.mate-topics button:disabled { opacity:.55; cursor:default; }
#folk-card .mate-topics { margin-top:8px; }
#storyteller-says ol { list-style:none; margin:0 0 8px; padding:0; max-height:34vh; overflow-y:auto; }
#storyteller-says li { margin:0 0 6px; }
#storyteller-says li b, #folk-card .folk-talk-log b { font-weight:400; color:#edb86b; }
#storyteller-says li.narrate { font-style:italic; color:#d9ccb0; }
#storyteller-says li.mine, #folk-card .folk-talk-log li.mine { color:#b9ad95; }
#folk-card .folk-talk-log { list-style:none; margin:8px 0 6px; padding:0; font-size:14px; }
#folk-card .folk-talk-log li { margin:0 0 5px; }
`;

/**
 * The door. `game` is what the game answers the storyteller with: situation(), world(path), find(name, n),
 * inspect(code, name), chronicle(args), panel(args), nearby(), person(id), mateCandidates(n), mateChoose(id),
 * nameOf(person) and mate() (the first mate as chosen, or null). `counsel` is the mate's own word with no storyteller
 * by: who() the mate ({name}), topics() the questions that fit the moment ([{id, label}]) and answer(id) the mate's
 * reply ({text, topics} : `topics` what may be asked next, if the answer opens a choice). `Socket` and `storage` are
 * the browser's unless a test gives its own; `documentRef` may be null where there is no page.
 */
export function createStoryteller({ game, counsel = null, documentRef = globalThis.document ?? null, Socket = globalThis.WebSocket, storage = null, onState = null } = {}) {
  let socket = null, state = 'apart', said = '', code = '', retries = 0, wanted = false, timer = null;
  const lines = [], hearers = new Set(), topicEls = new Set();
  let stateEl = null, codeEl = null, saysEl = null, listEl = null, speakEl = null, barEl = null, bodyEl = null, topicsEl = null;
  let unfolded = false, follow = null, asking = false;
  const mateName = () => counsel?.who?.()?.name ?? game.mate?.()?.name ?? 'The mate';
  // The panel is there whenever there is a mate to ask or a storyteller to hear.
  const shown = () => Boolean(counsel) || state === 'paired' || lines.length > 0;
  function setOpen(next) {
    unfolded = Boolean(next);
    if (!saysEl) return;
    saysEl.dataset.open = unfolded ? '1' : '0'; bodyEl.hidden = !unfolded; barEl.setAttribute('aria-expanded', String(unfolded));
    try { storage?.setItem(STORYTELLER_OPEN, unfolded ? '1' : '0'); } catch { /* a private window */ }
    if (unfolded) { renderTopics(); listEl.scrollTop = listEl.scrollHeight; }
  }
  // The questions on offer just now, wherever they are shown: in the panel, and on the mate's own card.
  function renderTopics() {
    if (!documentRef) return;
    let topics = [];
    if (counsel) { try { topics = follow ?? counsel.topics() ?? []; } catch (fault) { console.error(fault); } }
    for (const el of [...topicEls]) {
      if (el !== topicsEl && !el.isConnected) { topicEls.delete(el); continue; }
      el.replaceChildren(...topics.map((topic) => { const button = make('button', '', topic.label); button.type = 'button'; button.disabled = asking; button.addEventListener('click', () => ask(topic)); return button; }));
      el.hidden = !topics.length;
    }
    if (barEl) barEl.textContent = `${mateName()}, first mate`;
    if (saysEl) saysEl.hidden = !shown();
  }
  // The captain asks one of them: the mate answers from what the game holds, and a storyteller who is by hears of it.
  async function ask(topic) {
    if (asking || !counsel || !topic) return false;
    if (topic.id === 'back') { follow = null; renderTopics(); return true; }
    asking = true; renderTopics();
    show({ kind: 'mine', who: 'You', person: game.mate?.()?.id ?? null, text: topic.label });
    let reply = null;
    try { reply = await counsel.answer(topic.id); } catch (fault) { console.error(fault); }
    const text = String(reply?.text ?? '').trim() || 'I cannot say, captain.';
    show({ kind: 'say', who: mateName(), person: game.mate?.()?.id ?? null, text });
    follow = reply?.topics?.length ? reply.topics : null; asking = false; renderTopics();
    tell({ kind: 'counsel', topic: topic.id, asked: topic.label, answer: text });
    return true;
  }
  const make = (tag, className, text) => { const node = documentRef.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };

  function set(next, words) {
    state = next; said = words;
    if (stateEl) stateEl.textContent = words;
    if (saysEl) { saysEl.hidden = !shown(); if (speakEl) speakEl.hidden = state !== 'paired'; }
    try { onState?.(state, words); } catch (fault) { console.error(fault); }
  }
  const send = (message) => { try { socket?.send(JSON.stringify(message)); return Boolean(socket); } catch { return false; } };
  // Tell the storyteller something the player did. False when it is not here to be told.
  const tell = (event) => state === 'paired' && send({ event });

  // Put a line where the player reads it: {kind: 'say' | 'narrate' | 'mine', who, person, text}.
  function show(line) {
    const text = String(line.text ?? '').trim().slice(0, 4000);
    if (!text) throw new Error('Nothing to say');
    const kept = { kind: line.kind, who: line.who ?? '', person: line.person ?? null, text, at: Date.now() };
    lines.push(kept); if (lines.length > STORYTELLER_LINES) lines.shift();
    if (listEl) {
      const item = make('li', kept.kind === 'narrate' ? 'narrate' : kept.kind === 'mine' ? 'mine' : '');
      if (kept.kind !== 'narrate') item.append(make('b', '', kept.who + ': '));
      item.append(kept.kind === 'narrate' ? text : '“' + text + '”');
      listEl.append(item); while (listEl.children.length > 8) listEl.firstChild.remove();
      saysEl.hidden = false; if (!unfolded) setOpen(true);
      listEl.scrollTop = listEl.scrollHeight;
    }
    for (const hear of [...hearers]) { try { if (hear(kept) === false) hearers.delete(hear); } catch (fault) { console.error(fault); hearers.delete(hear); } }
    return { shown: true };
  }
  // What the storyteller may ask of the game.
  const ops = {
    situation: () => game.situation(), world: ({ path }) => game.world(path || ''), find: ({ name, n }) => game.find(name, n), inspect: ({ code: c, name }) => game.inspect(c, name),
    chronicle: (args) => game.chronicle(args), panel: (args) => game.panel(args), nearby: () => game.nearby(), person: ({ id }) => game.person(Number(id)),
    mateCandidates: ({ n }) => game.mateCandidates(n), mateChoose: ({ id }) => game.mateChoose(Number(id)),
    say: async ({ person, text }) => show({ kind: 'say', person: person ?? game.mate?.()?.id ?? null, who: await game.nameOf(person ?? null), text }),
    narrate: ({ text }) => show({ kind: 'narrate', text }),
  };
  function heard(data) {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message.op !== 'string') return;
    const id = message.id;
    Promise.resolve().then(() => { if (!Object.hasOwn(ops, message.op)) throw new Error(`The game does not know how to "${message.op}"`); return ops[message.op](message.args ?? {}); })
      .then((result) => send({ id, result: result ?? null }), (error) => send({ id, error: String(error?.message || error) }));
  }

  function close(told = true) {
    clearTimeout(timer); timer = null;
    const was = socket; socket = null;
    try { was?.close(); } catch { /* already shut */ }
    if (told) { wanted = false; set('apart', 'The storyteller is not with you.'); }
  }
  function open(address) {
    close(false);
    set('joining', 'Looking for the storyteller…');
    let mine;
    try { mine = socket = new Socket(address); } catch { socket = null; set('apart', 'This browser would not open the way to the storyteller.'); return; }
    let joined = false;
    mine.addEventListener('open', () => {
      if (socket !== mine) return;
      joined = true; retries = 0;
      try { storage?.setItem(STORYTELLER_KEPT, code); } catch { /* a private window */ }
      set('paired', 'The storyteller is with you.');
      tell({ kind: 'joined' });
    });
    mine.addEventListener('message', (event) => { if (socket === mine) heard(event.data); });
    mine.addEventListener('close', (event) => {
      if (socket !== mine) return;
      socket = null;
      if (event.code === 4003) { wanted = false; try { storage?.removeItem(STORYTELLER_KEPT); } catch { /* nothing kept */ } set('apart', 'That is not the storyteller\'s code. Ask it for the code again.'); return; }
      if (event.code === 4008) { wanted = false; set('apart', 'Too many wrong codes have been tried. Wait a minute, then enter the storyteller\'s code again.'); return; }
      // One that was here and went quiet is looked for again a few times; one that never answered is not.
      if (wanted && joined && retries < 5) { retries++; set('joining', 'The storyteller went quiet. Looking again…'); timer = setTimeout(() => open(address), 1500 * retries); return; }
      wanted = false;
      set('apart', joined ? 'The storyteller has gone.' : 'No storyteller answered. Is it running in your agent app on this computer?');
    });
    mine.addEventListener('error', () => { });
  }
  // Join the storyteller whose code this is. False if it is no code.
  function pair(given) {
    const address = storytellerAddress(given);
    if (!address) { set('apart', 'A pairing code is five letters and a digit, as the storyteller gives it.'); return false; }
    code = String(given).trim().toUpperCase(); wanted = true; retries = 0;
    open(address);
    return true;
  }
  // The code of a storyteller joined earlier in this window, tried again after a reload.
  function resume() { let kept = null; try { kept = storage?.getItem(STORYTELLER_KEPT); } catch { kept = null; } return kept ? pair(kept) : false; }

  // The player speaks: to someone (their soul), or to the mate when no one is named.
  function speak(soul, words) {
    const text = String(words ?? '').trim().slice(0, STORYTELLER_SAID_MOST);
    if (!text) return false;
    const mate = game.mate?.() ?? null, to = soul ?? mate;
    show({ kind: 'mine', who: 'You', person: to?.id ?? null, text });
    return tell({ kind: 'spoke', to: soul && soul.id !== mate?.id ? 'person' : 'mate', person: to?.id ?? null, name: to?.name ?? null, text });
  }

  // The storyteller's place in a panel of the game (where its code is typed), and the words it puts on the screen.
  function mount(parent) {
    if (!documentRef || !parent || stateEl) return;
    const style = make('style'); style.id = 'storyteller-style'; style.textContent = STORYTELLER_STYLE; documentRef.head.append(style);
    const section = make('section'); section.id = 'storyteller';
    const form = make('form'), join = make('button', '', 'Join'), leave = make('button', '', 'Part'); leave.type = 'button';
    codeEl = make('input'); codeEl.id = 'storyteller-code'; codeEl.maxLength = 6; codeEl.placeholder = 'ABCDE0'; codeEl.autocomplete = 'off'; codeEl.spellcheck = false; codeEl.setAttribute('aria-label', 'The storyteller\'s pairing code');
    form.append(codeEl, join, leave);
    form.addEventListener('submit', (event) => { event.preventDefault(); pair(codeEl.value); });
    leave.addEventListener('click', () => { try { storage?.removeItem(STORYTELLER_KEPT); } catch { /* nothing kept */ } close(); });
    stateEl = make('p', '', said || 'The storyteller is not with you.'); stateEl.id = 'storyteller-state'; stateEl.setAttribute('role', 'status');
    section.append(make('h3', '', 'Storyteller'), make('p', '', 'A dungeon master, run by an AI agent on this computer, who sails with you as your first mate and plays everyone you meet. Ask it for its pairing code and type it here.'), form, stateEl);
    parent.append(section);
    saysEl = make('aside'); saysEl.id = 'storyteller-says'; saysEl.hidden = true; saysEl.setAttribute('aria-label', 'The first mate');
    barEl = make('button', 'mate-bar'); barEl.type = 'button'; barEl.addEventListener('click', () => setOpen(!unfolded));
    bodyEl = make('div', 'mate-body');
    listEl = make('ol'); listEl.setAttribute('aria-live', 'polite');
    topicsEl = make('div', 'mate-topics'); topicEls.add(topicsEl);
    speakEl = make('form'); speakEl.hidden = state !== 'paired';
    const words = make('input'), sayIt = make('button', '', 'Say'); words.maxLength = STORYTELLER_SAID_MOST; words.placeholder = 'Speak to your mate…'; words.setAttribute('aria-label', 'Speak to your first mate');
    speakEl.append(words, sayIt);
    speakEl.addEventListener('submit', (event) => { event.preventDefault(); if (speak(null, words.value)) words.value = ''; });
    bodyEl.append(listEl, topicsEl, speakEl); saysEl.append(barEl, bodyEl);
    documentRef.body.append(saysEl);
    let was = null; try { was = storage?.getItem(STORYTELLER_OPEN); } catch { was = null; }
    setOpen(was === '1'); renderTopics();
  }
  // In the card of someone asked after: what passes between you, a place to speak to them while a storyteller is by,
  // and on the mate's own card the questions the mate can answer alone. For js/folk-card.js.
  function card(soul, el) {
    if (!documentRef || !soul || !Number.isFinite(soul.id)) return;
    const paired = state === 'paired', mine = Boolean(counsel) && game.mate?.()?.id === soul.id;
    if (!paired && !mine) return;
    const log = make('ol', 'folk-talk-log');
    const add = (line) => { const item = make('li', line.kind === 'mine' ? 'mine' : ''); item.append(make('b', '', line.who + ': '), '“' + line.text + '”'); log.append(item); };
    for (const line of lines) if (line.person === soul.id && line.kind !== 'narrate') add(line);
    hearers.add((line) => { if (!log.isConnected) return false; if (line.person === soul.id && line.kind !== 'narrate') add(line); return true; });
    el.append(log);
    if (mine) { const topics = make('div', 'mate-topics'); topicEls.add(topics); el.append(topics); renderTopics(); }
    if (!paired) return;
    const form = make('form', 'folk-talk'), words = make('input'), sayIt = make('button', '', 'Say');
    words.maxLength = STORYTELLER_SAID_MOST; words.placeholder = `Speak to ${String(soul.name).split(' ')[0]}…`; words.setAttribute('aria-label', `Speak to ${soul.name}`);
    form.append(words, sayIt);
    form.addEventListener('submit', (event) => { event.preventDefault(); if (speak(soul, words.value)) words.value = ''; });
    el.append(form);
    tell({ kind: 'asked', person: soul.id, name: soul.name });
  }

  return { pair, resume, close, tell, speak, show, mount, card, ask, refresh: renderTopics, get topics() { try { return counsel ? follow ?? counsel.topics() ?? [] : []; } catch { return []; } }, get state() { return state; }, get said() { return said; }, get lines() { return lines.map((line) => ({ ...line })); } };
}
