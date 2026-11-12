// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Asking after someone seen in a town. Whoever is about a founded board is a soul of Castle and Commons' model
// (js/board-folk.js), and the model keeps a card of each: their roof, kin, household, living and learning. This is
// that card read into what they would say of themselves, and the small panel that shows it. What they say is put
// together from the model's own record of them, line by line; nothing is invented.

// The lines of a person's card that are a fact about them, by how each begins.
const FOLK_CARD_KEYS = Object.freeze(['Home', 'Wife', 'Husband', 'Mother', 'Father', 'Children', 'Betrothed to', 'Betrothed', 'Widow of', 'Widower of',
  'Household of', 'Household worth', 'Living', 'Personal status', 'Family', 'Office', 'Craft', 'Master', 'Lord', 'Guild', 'School', 'Tenure', 'Debt']);
const FOLK_CARD_ENDS = /^(Family tree|Household goods|Household property|Household members|Learning and skills)\b/;

// The model's card of a person (plain text: a line to a fact, then its tables, then their nature, learning and
// life) as facts by name, the people of their household, what they have learned, and their life as it is recorded.
export function folkCardFacts(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()), facts = {}, notes = [];
  let at = 1;
  for (; at < lines.length && !FOLK_CARD_ENDS.test(lines[at]); at++) {
    const line = lines[at];
    if (!line || line.startsWith('←') || line === 'Credit and coin') continue;
    const key = FOLK_CARD_KEYS.find((name) => line.startsWith(name + ' '));
    if (key) facts[key] = line.slice(key.length + 1).replace(/\s+([,;:])/g, '$1').trim(); else notes.push(line);
  }
  const table = (head) => {
    const from = lines.findIndex((line) => line.startsWith(head)), rows = [];
    for (let k = from + 2; from >= 0 && k < lines.length && lines[k].includes(' | '); k++) rows.push(lines[k].split(' | ').map((cell) => cell.trim()));
    return rows;
  };
  const after = (word) => lines.find((line, k) => k > at && line.startsWith(word + ' ') && line !== 'Learning and skills')?.slice(word.length + 1) ?? '';
  const lived = lines.indexOf('Life', at);
  return {
    title: lines[0] ?? '', facts, notes,
    household: table('Household members').map(([name, age, place]) => ({ name, age: Number(age), place })),
    skills: table('Learning and skills').map(([skill, ability]) => ({ skill, ability: (ability ?? '').split(' · ')[0] })),
    nature: after('Nature'), learning: after('Learning'),
    life: lived < 0 ? [] : lines.slice(lived + 1).filter(Boolean),
  };
}

const folkFirst = (name) => String(name ?? '').split(' ')[0];
const folkList = (names) => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);

// What they say of themselves when asked: who they are, where they live and with whom, how they live, and what they
// are about just now. `soul` is theirs (js/board-folk.js); `card` what folkCardFacts read; `doing` what their
// walker is at, if they are in sight.
export function folkSpeech(soul, card, doing = '') {
  const facts = card?.facts ?? {}, said = [], age = Math.floor(soul.age ?? NaN), child = age < 14;
  said.push(child ? `I'm ${folkFirst(soul.name)}. I am ${age}.` : `${soul.name}${soul.role ? `, ${soul.role}` : ''}.`);
  const born = /^Born (\w+) \d+, AD (\d+)/.exec(card?.life?.[0] ?? '');
  if (born && !child) said.push(`Born in the ${born[1].toLowerCase()} of ${born[2]}.`);
  // A house with a name is lived at; one with only a description ("hovel-built house") is lived in.
  const home = facts.Home ?? '', named = /^\p{Lu}/u.test(home);
  if (home) said.push(`${child ? 'We live' : 'I live'} ${named ? 'at ' + home.replace(/\s+in the (\w+) quarter$/, ', in the $1 quarter') : `in ${/^[aeiou]/i.test(home) ? 'an' : 'a'} ${home}`}.`);
  if (child) {
    const parents = [facts.Father && `my father ${folkFirst(facts.Father)}`, facts.Mother && `my mother ${folkFirst(facts.Mother)}`].filter(Boolean);
    if (parents.length) said.push(`With ${folkList(parents)}.`);
  } else {
    const spouse = facts.Wife ? `My wife is ${facts.Wife}` : facts.Husband ? `My husband is ${facts.Husband}` : facts['Widow of'] ? `I am the widow of ${facts['Widow of']}` : facts['Widower of'] ? `I buried my wife, ${facts['Widower of']}` : '';
    const children = facts.Children ? facts.Children.split(/\s*,\s*/).map(folkFirst) : [];
    if (spouse && children.length && (facts.Wife || facts.Husband)) said.push(`${spouse}, and we have ${folkList(children)}.`);
    else {
      if (spouse) said.push(spouse + '.');
      if (children.length) said.push(`I have ${folkList(children)}.`);
    }
    // Under whose roof, where it is not their own or their spouse's.
    const head = facts['Household of']?.split(';')[0].trim();
    if (head && head !== facts.Husband && head !== facts.Wife) said.push(head === facts.Father ? 'I keep under my father\'s roof.' : head === facts.Mother ? 'I keep under my mother\'s roof.' : `It is ${head}'s household.`);
    const living = /about ([\d,.]+) crowns? a year/.exec(facts.Living ?? '');
    if (living) said.push(Number(living[1].replace(/,/g, '')) < 6 ? `It is a thin living: ${living[1]} crowns in a year.` : `The work brings some ${living[1]} crowns in a year.`);
    if (facts['Personal status'] && !/^Free$/i.test(facts['Personal status'])) said.push(`I am ${facts['Personal status'].toLowerCase()}.`);
    const learned = (card?.skills ?? []).filter((s) => /^(skilled|master)/.test(s.ability)).map((s) => s.skill);
    if (learned.includes('letters')) said.push('I can read and write.');
  }
  if (doing && doing !== 'indoors') said.push(/^(walking|out )/.test(doing) ? `Just now I am ${doing}.` : `You find me ${doing}.`);
  return said.join(' ');
}

// The model's first line of a card ("Name — 29, husband · brewer · Lisboa") as a soul, for someone asked after by
// name who is not in sight.
export function folkSoulOfTitle(id, title) {
  const [name, rest = ''] = String(title).split(' — '), parts = rest.split(' · '), first = /^(\d+)(?:, (.*))?$/.exec(parts[0] ?? '');
  return { id, name: name.trim(), age: first ? Number(first[1]) : NaN, role: parts.length > 2 ? parts[1].trim() : null, planned: false, there: '' };
}

/**
 * The panel. `person(id)` answers the model's card of someone ({card, links}); `whereabouts(id)` what they are at if
 * they are in sight, or ''. `show(soul, doing)` opens it on them; kin named on the card can be asked after in turn.
 * `extra(soul, el)` may add to an opened card (the storyteller's place to speak to them, js/storyteller.js).
 */
export function createFolkCard({ person, whereabouts = () => '', documentRef = document, extra = null }) {
  const el = documentRef.createElement('aside');
  el.id = 'folk-card'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Townsperson');
  documentRef.body.append(el);
  const make = (tag, className, text) => { const node = documentRef.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  let asked = 0;
  const hide = () => { el.hidden = true; asked++; };
  async function show(soul, doing = '') {
    const mine = ++asked;
    el.replaceChildren();
    const close = make('button', 'folk-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.addEventListener('click', hide);
    const age = Number.isFinite(soul.age) ? `${Math.floor(soul.age)}` : '';
    const said = make('p', 'folk-said', '…');
    el.append(close, make('h2', '', soul.name), make('p', 'folk-what', [age, soul.role, doing].filter(Boolean).join(' · ')), said);
    el.hidden = false;
    const more = () => { try { extra?.(soul, el); } catch (fault) { console.error(fault); } };
    let answer;
    // Someone the model cannot answer for here (the mate, far from the port they were born in) can still be spoken to.
    try { answer = await person(soul.id); } catch (error) { if (mine === asked) { said.textContent = 'They have nothing to say just now.'; more(); } return; }
    if (mine !== asked) return;
    if (!answer?.card) { said.textContent = 'No one here knows them.'; return; }
    const card = folkCardFacts(answer.card);
    said.textContent = '“' + folkSpeech(soul, card, doing) + '”';
    const facts = make('dl', 'folk-facts');
    for (const [key, value] of Object.entries(card.facts)) facts.append(make('dt', '', key), make('dd', '', value));
    el.append(facts);
    if (card.household.length > 1) el.append(make('p', 'folk-house', 'Under one roof: ' + card.household.map((one) => `${one.name} (${one.age})`).join(', ') + '.'));
    if (card.nature) el.append(make('p', 'folk-house', 'By nature ' + card.nature + '.'));
    if (card.learning) el.append(make('p', 'folk-house', 'Learning: ' + card.learning + '.'));
    if (card.life.length) {
      const life = make('ul', 'folk-life');
      for (const line of card.life.slice(-12)) life.append(make('li', '', line));
      el.append(life);
    }
    // Anyone the card names can be asked after in turn.
    const kin = (answer.links ?? []).filter((link) => /^p\d+$/.test(link.code) && Number(link.code.slice(1)) !== soul.id), seen = new Set();
    if (kin.length) {
      const row = make('p', 'folk-kin', 'Ask after ');
      for (const link of kin) {
        if (seen.has(link.code)) continue; seen.add(link.code);
        const button = make('button', '', link.name); button.type = 'button';
        button.addEventListener('click', async () => {
          const id = Number(link.code.slice(1)), theirs = await person(id).catch(() => null);
          if (theirs?.card) show(folkSoulOfTitle(id, theirs.card.split('\n')[0]), whereabouts(id));
        });
        row.append(button);
      }
      el.append(row);
    }
    more();
  }
  documentRef.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !el.hidden) hide(); });
  return { element: el, show, hide, get open() { return !el.hidden; } };
}
