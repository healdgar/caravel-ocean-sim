// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the first mate can tell the captain unasked for by any storyteller: the questions that fit where the ship
// and the captain are just now, and the mate's answer to each, put together from what the game and the country's
// model already hold (the reckoning, the wind, the stores, the port, the talk of the town, who stands in sight, the
// mate's own life). Nothing here is invented, and nothing is asked of anyone: it is all read from `about`, which
// the game gathers (js/main.js):
//   mate     {name, model, role, sex, port, about: {born, home, spouse, children, head, nature, learning}}
//   now      the game as it stands (date, realm, where, ship, captain, voyage)
//   near     who is about the captain ashore ({place, inSight, atPosts, lastAskedAfter})
//   news     the realm's annals as they are told ({date, text, cat})
//   town     the model's own record of the port in sight, or null
//   market   what the port's merchants quote today ({name, buy, sell, offered, held, usual}), or null
import { compassPointName, formatLatitude, formatLongitude } from './voyage/compass.js';

const counselList = (names) => names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
const counselFirst = (name) => String(name ?? '').trim().split(' ')[0];
const counselArticle = (word) => (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;
// A count as a mate would say it: near enough.
export function counselSouls(n) {
  if (!(n > 0)) return 'no one';
  if (n < 100) return String(Math.round(n));
  const step = n < 1000 ? 50 : n < 10000 ? 100 : 1000;
  return 'some ' + (Math.round(n / step) * step).toLocaleString('en-US');
}
const wrap180 = (deg) => ((deg % 360) + 540) % 360 - 180;
// How she lies to the wind, by the angle between where it blows from and where she heads.
export function counselPointOfSail(windFrom, heading) {
  const off = Math.abs(wrap180(windFrom - heading));
  return off < 40 ? 'She is in irons, or near it: she will not lie so close.' : off < 62 ? 'She is close-hauled.' : off < 105 ? 'She has the wind on the beam.'
    : off < 155 ? 'She has it on the quarter: her best point.' : 'She runs before it.';
}

// The questions that fit the moment, most pressing first: no more than `most` of them.
export function mateTopics(about, most = 6) {
  const { mate = null, now = null, near = null, news = [], town = null, market = null } = about ?? {};
  const where = now?.where ?? {}, port = where.kind === 'port', topics = [];
  const add = (id, label) => topics.push({ id, label });
  const someone = near?.lastAskedAfter ?? near?.inSight?.[0] ?? near?.atPosts?.[0] ?? null;
  if (where.ashore && someone) add('who', near.lastAskedAfter ? `Who is ${counselFirst(someone.name)}?` : 'Who is that?');
  if (port) add('port', 'What is this place?');
  if (!port && now?.voyage) { add('where', 'Where are we?'); add('sail', 'How does she sail?'); }
  if (news?.length || now?.voyage?.log?.length) add('news', port ? 'What is the talk?' : 'What of late?');
  if (port && market?.length) add('trade', 'What sells here?');
  if (now?.realm) add('realm', 'Who rules here?');
  if (now?.ship && (now.ship.foodDays != null || now.captain?.coin != null)) add('stores', 'How are our stores?');
  if (mate?.model && mate.about) { add('self', 'Tell me of yourself'); if (mate.about.spouse || mate.about.children || mate.about.head) add('home', 'Who waits for you at home?'); }
  if (port && where.living && !mate?.model) add('sign', 'Who here would sign on as mate?');
  // The mate's own life gives way first when there is much to ask about the day.
  const order = ['who', 'port', 'where', 'sail', 'trade', 'news', 'sign', 'stores', 'realm', 'self', 'home'];
  return topics.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).slice(0, Math.max(1, most));
}

const SAY = {
  where({ now }) {
    const v = now.voyage, at = now.where?.reckoned ?? now.where, said = [];
    if (Number.isFinite(at?.lat) && Number.isFinite(at?.lon)) said.push(`By my reckoning we are in ${formatLatitude(at.lat)}, ${formatLongitude(at.lon)}, captain.`);
    else said.push('I have no reckoning to give you, captain.');
    if (v) {
      const out = Number.isFinite(v.daysOut) ? `${Math.max(0, Math.floor(v.daysOut))} ${Math.floor(v.daysOut) === 1 ? 'day' : 'days'} out${v.from ? ` of ${v.from}` : ''}` : '';
      const log = Number.isFinite(v.leagues) && v.leagues > 0 ? `${v.leagues} ${v.leagues === 1 ? 'league' : 'leagues'} on the log` : '';
      if (out || log) said.push(`${[out, log].filter(Boolean).join(', with ')}.`.replace(/^./, (c) => c.toUpperCase()));
      if (v.to) said.push(v.toGo && Number.isFinite(v.toGo.leagues) ? `${v.to} bears ${compassPointName(v.toGo.bearing)}, some ${Math.max(1, Math.round(v.toGo.leagues))} leagues off.` : `We are bound for ${v.to}.`);
      else said.push('You have named no port to make for.');
    }
    return said.join(' ');
  },
  sail({ now }) {
    const ship = now.ship ?? {}, said = [];
    if (Number.isFinite(ship.windFrom)) said.push(`The wind is ${ship.windWords ? ship.windWords + ' ' : ''}from the ${compassPointName(ship.windFrom)}, captain.`);
    if (Number.isFinite(ship.headingDeg)) said.push(`She heads ${compassPointName(ship.headingDeg)}${Number.isFinite(ship.compassCourse) ? `, steering ${compassPointName(ship.compassCourse)} by the compass` : ''}${Number.isFinite(ship.knots) ? `, and makes ${ship.knots < 0.3 ? 'no way' : (Math.round(ship.knots * 10) / 10) + ' knots'}` : ''}.`);
    if (Number.isFinite(ship.windFrom) && Number.isFinite(ship.headingDeg)) said.push(counselPointOfSail(ship.windFrom, ship.headingDeg));
    return said.join(' ') || 'I cannot tell how she lies, captain.';
  },
  stores({ now }) {
    const ship = now.ship ?? {}, captain = now.captain ?? {}, said = [];
    const food = ship.foodDays, water = ship.waterDays;
    if (Number.isFinite(food) && Number.isFinite(water)) {
      said.push(`We have food for ${Math.floor(food)} days and water for ${Math.floor(water)}${ship.hands ? `, with ${ship.hands} hands to feed` : ''}, captain.`);
      if (water < 10 || food < 10) said.push(water <= food ? 'The water is the worry: we must fill the casks soon.' : 'The bread is the worry: we must victual soon.');
    }
    if (Number.isFinite(captain.coin)) said.push(Math.round(captain.coin) === 1 ? 'There is a single coin in the chest.' : `There are ${Math.max(0, Math.round(captain.coin)).toLocaleString('en-US')} ${captain.currency ?? 'coins'} in the chest.`);
    const cargo = (captain.cargo ?? []).filter((one) => one.units > 0);
    said.push(cargo.length ? `In the hold: ${counselList(cargo.map((one) => `${one.units} tonnes of ${String(one.name ?? one.good).toLowerCase()}`))}.` : 'The hold is empty.');
    return said.join(' ');
  },
  port({ now, town }) {
    const name = town?.name ?? now.where?.name;
    if (!town) return name ? `This is ${name}, captain. I know no more of it than the chart does.` : 'I know nothing of this place, captain.';
    const said = [`${name}, captain${town.role === 'seat' && now.realm?.monarch ? `: the seat of ${now.realm.monarch}` : town.kind ? `: ${counselArticle(town.kind)}` : ''}.`];
    const held = [town.people ? `${counselSouls(town.people)} souls` : '', town.walls && town.walls !== 'none' ? `within ${town.walls} walls` : ''].filter(Boolean).join(' ');
    if (held) said.push(`${held.replace(/^./, (c) => c.toUpperCase())}${town.lord ? `, held by ${town.lord}` : ''}${town.garrison > 0 ? `, with ${counselSouls(town.garrison)} men under arms` : ''}.`);
    const trades = Object.entries(town.trades ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([trade]) => trade + 's');
    if (trades.length) said.push(`Most who work here are ${counselList(trades)}.`);
    if (town.tongue) said.push(`They speak ${town.tongue}.`);
    if (town.plague) said.push('There is pestilence in the town: I would not linger.');
    if (town.besieged) said.push('It lies under siege.');
    if (town.hunger > 0.2) said.push('There is hunger here.');
    if (town.unrest > 40) said.push('The streets are restless.'); else if (town.unrest < 15 && town.prosperity >= 50) said.push('It is a quiet town, and does well enough.');
    return said.join(' ');
  },
  news({ now, news }) {
    const talk = (news ?? []).filter((line) => line?.text), told = talk.filter((line) => line.cat !== 'trade').slice(-3);
    const lines = (told.length ? told : talk.slice(-3)).map((line) => line.text.replace(/\s+$/, '').replace(/([^.!?])$/, '$1.'));
    if (lines.length) return `The talk is this, captain. ${lines.join(' ')}`;
    const log = (now.voyage?.log ?? []).slice(-2).map((line) => String(line).replace(/([^.!?])$/, '$1.'));
    return log.length ? `Nothing but what is in the log, captain. ${log.join(' ')}` : 'I have heard nothing new, captain.';
  },
  realm({ now }) {
    const realm = now.realm;
    if (!realm) return 'I do not know who holds this coast, captain.';
    const said = [`${realm.monarch ?? 'No one I can name'} rules${realm.name ? ` ${realm.name}` : ''}${realm.places ? `: ${realm.places} towns and villages` : ''}${realm.people ? ` and ${counselSouls(realm.people)} souls` : ''}.`];
    if (Number.isFinite(realm.legitimacy)) said.push(realm.legitimacy >= 65 ? 'The crown\'s right is not questioned.' : realm.legitimacy >= 40 ? 'There are those who mutter at the crown\'s right.' : 'Few think the crown rightly held.');
    said.push(realm.war ? 'The realm is at war.' : 'The realm is at peace.');
    if (Array.isArray(realm.feuds) && realm.feuds.length) said.push(`The great houses feud: ${realm.feuds.length} ${realm.feuds.length === 1 ? 'quarrel' : 'quarrels'} that I know of.`);
    if (realm.plague) said.push('There is pestilence in the land.');
    if (realm.priceLevel > 1.15) said.push('Prices run high this year.'); else if (realm.priceLevel < 0.85) said.push('Prices are low this year.');
    return said.join(' ');
  },
  trade({ now, market }) {
    const coin = now.captain?.currency ?? 'coins', quotes = (market ?? []).filter((one) => one.usual > 0);
    if (!quotes.length) return 'I have seen no merchant\'s list here, captain.';
    const cheap = quotes.filter((one) => one.offered && one.buy / one.usual < 0.97).sort((a, b) => a.buy / a.usual - b.buy / b.usual).slice(0, 2);
    const dear = quotes.filter((one) => one.sell / one.usual > 1.03 && !cheap.includes(one)).sort((a, b) => b.sell / b.usual - a.sell / a.usual).slice(0, 2);
    const priced = (list, side) => counselList(list.map((one) => `${String(one.name).toLowerCase()} (${one[side]})`));
    const said = [];
    if (cheap.length) said.push(`${priced(cheap, 'buy').replace(/^./, (c) => c.toUpperCase())} ${cheap.length > 1 ? 'are' : 'is'} cheap here, captain, in ${coin} the tonne.`);
    if (dear.length) said.push(`They pay well for ${priced(dear, 'sell')}.`);
    for (const one of quotes.filter((q) => q.held > 0).slice(0, 3)) said.push(`Our ${String(one.name).toLowerCase()} would fetch ${one.sell}${one.sell / one.usual > 1.03 ? ': a good price' : one.sell / one.usual < 0.97 ? ': I would carry it on' : ''}.`);
    return said.join(' ') || 'Nothing here is priced out of the common, captain.';
  },
  who({ near, mate }) {
    const someone = near?.lastAskedAfter ? [...(near.inSight ?? []), ...(near.atPosts ?? [])].find((one) => one.id === near.lastAskedAfter.id) ?? near.lastAskedAfter : near?.inSight?.[0] ?? near?.atPosts?.[0];
    if (!someone) return 'I see no one I can name, captain.';
    const said = [`That is ${someone.name}${someone.role ? `, ${counselArticle(someone.role)}` : ''}${Number.isFinite(someone.age) && !someone.role ? `, ${someone.age}` : ''}${Number.isFinite(someone.age) && someone.role ? ` of ${someone.age}` : ''}.`];
    if (someone.doing && someone.doing !== 'indoors') said.push(`${someone.sex === 'f' ? 'She' : someone.sex === 'm' ? 'He' : 'They'} ${someone.sex ? 'is' : 'are'} ${someone.doing}.`);
    if (mate?.model && mate.port && mate.port === near?.place) said.push('One of my own town.');
    return said.join(' ');
  },
  self({ mate }) {
    const about = mate.about ?? {}, said = [`${mate.name}, captain${mate.role ? `: ${counselArticle(mate.role)}${mate.port ? ` of ${mate.port}` : ''} before I was your mate` : mate.port ? `, of ${mate.port}` : ''}.`];
    const born = /^Born (\w+) \d+, AD (\d+)/.exec(about.born ?? '');
    if (born) said.push(`I was born in the ${born[1].toLowerCase()} of ${born[2]}.`);
    if (about.home) said.push(`My house is ${about.home}.`);
    const nature = String(about.nature ?? '').split(/\s*,\s*/).filter(Boolean);
    if (nature.length) said.push(`They will tell you I am ${counselList(nature)}.`);
    if (about.learning) said.push(`For learning I have ${about.learning}.`);
    return said.join(' ');
  },
  home({ mate }) {
    const about = mate.about ?? {}, said = [], children = String(about.children ?? '').split(/\s*,\s*/).filter(Boolean).map(counselFirst);
    if (about.spouse) said.push(`${about.spouse}, my ${mate.sex === 'f' ? 'husband' : 'wife'}${children.length ? `, and our ${counselList(children)}` : ''}.`);
    else if (children.length) said.push(`My ${counselList(children)}.`);
    const head = String(about.head ?? '').split(';')[0].trim();
    if (head && head !== mate.name) said.push(`${head === about.spouse ? counselFirst(head) : head} keeps the household while I am at sea.`);
    else if (head && (about.spouse || children.length)) said.push('The household is mine, and they keep it for me.');
    return said.join(' ') || 'No one, captain. The ship is my house now.';
  },
};

// The mate's answer to one of the questions, in their own words. null for a question that is not one of these.
export function mateCounsel(id, about) {
  if (!Object.hasOwn(SAY, id)) return null;
  const whole = { mate: null, now: {}, near: null, news: [], town: null, market: null, ...about };
  whole.now ??= {};
  return SAY[id](whole);
}

// One who might sign on, as a line to choose them by, and as the mate tells of them.
export const mateCandidateLine = (one) => `${one.name}, ${one.age}${one.role ? `, ${one.role}` : ''}`;
export function mateCandidateAccount(one) {
  const said = [`${one.name}: ${one.role ? `${counselArticle(one.role)} of ${one.age}` : `${one.age}, of no trade`}${one.home ? `, of ${one.home}` : ''}.`];
  if (one.kin?.length) said.push(one.kin.map((line) => line.replace(/^(\w[\w ]*): /, (all, key) => key.toLowerCase() + ' ')).join('; ').replace(/^./, (c) => c.toUpperCase()) + '.');
  if (one.nature) said.push(`They say ${one.sex === 'f' ? 'she' : one.sex === 'm' ? 'he' : 'they'} ${one.sex ? 'is' : 'are'} ${counselList(one.nature.split(/\s*,\s*/).filter(Boolean))}.`);
  if (one.learning) said.push(`Learning: ${one.learning}.`);
  return said.join(' ');
}
// What is kept of a mate's own card for when they are far from the model that holds it.
export function mateAbout(card) {
  const facts = card?.facts ?? {};
  return { born: card?.life?.[0] ?? '', home: facts.Home ?? '', spouse: facts.Husband ?? facts.Wife ?? '', children: facts.Children ?? '', head: facts['Household of'] ?? '', nature: card?.nature ?? '', learning: card?.learning ?? '' };
}
