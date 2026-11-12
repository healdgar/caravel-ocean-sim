// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Where the dungeon master's use is reported: Waterworld's own Worker serves this at /waterworld/api/dm/. Whoever
// reports sends their Caiioo session as the bearer; it is checked with Caiioo's relay (the one issuer of sessions),
// the account's number is taken from the relay's answer, and the session itself is neither kept nor logged. What is
// kept, under that number, is what mcp/dm-telemetry.mjs lets leave the player's machine, cleaned again here by the
// same shape: counts, timings and the game's figures, never what was said.
//   POST telemetry  {v, session, events: [...]}  ->  {taken}
//   GET  me                                      ->  the account's running sum
// It uses nothing but what a Worker and Node both have, so that the tests run the handler itself.
import { telemetryEvent } from './dm-telemetry.mjs';

export const DM_API = '/waterworld/api/dm/';
export const DM_RELAY = 'https://relay.caiioo.ai';
const BODY_MOST = 256 * 1024, EVENTS_MOST = 200, KEYS_MOST = 64;
// Sessions lately checked, by their digest: the relay is asked once in ten minutes for one that stands, and once
// in two for one that does not.
const known = new Map(), STANDS_MS = 600000, REFUSED_MS = 120000;

const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' } });
const digest = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Whose session the request carries: {account} when the relay says it stands, else {status} to refuse with.
async function whose(request, { relay, fetcher, clock }) {
  const bearer = /^Bearer (pf_([A-Za-z0-9_-]{16,4096})\.[A-Za-z0-9_-]{16,512})$/.exec(request.headers.get('authorization') || '');
  if (!bearer) return { status: 401 };
  // What a session says of itself is read first: one that is no session, or has ended, is not worth the relay's time.
  let claims = null;
  try { claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(bearer[2].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { claims = null; }
  if (!claims || typeof claims.sub !== 'string' || !(Number(claims.exp) > clock())) return { status: 401 };
  const key = await digest(bearer[1]), hit = known.get(key);
  if (hit && hit.until > clock()) return hit.account ? { account: hit.account } : { status: 401 };
  if (known.size > 2000) known.clear();
  let response;
  try { response = await fetcher(relay + '/api/auth/me', { headers: { authorization: 'Bearer ' + bearer[1], 'user-agent': 'waterworld-dm-stats' } }); } catch { return { status: 503 }; }
  if (response.status === 401) { known.set(key, { until: clock() + REFUSED_MS }); return { status: 401 }; }
  if (!response.ok) return { status: 503 };
  let id = null;
  try { id = (await response.json())?.user?.id; } catch { id = null; }
  if (typeof id !== 'string' || !id) return { status: 503 };
  const account = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : 'h-' + (await digest(id)).slice(0, 40);
  known.set(key, { account, until: clock() + STANDS_MS });
  return { account };
}

// Add a batch to an account's running sum.
export function dmTally(sum, events, now) {
  const bump = (table, key, by = 1) => { if (key in table || Object.keys(table).length < KEYS_MOST) table[key] = (table[key] ?? 0) + by; };
  for (const one of events) {
    if (one.k === 'session') { sum.sessions++; if (one.client) bump(sum.clients, one.client); }
    else if (one.k === 'tool') {
      sum.calls++; if (one.failed) sum.errors++;
      if (one.tool && (one.tool in sum.tools || Object.keys(sum.tools).length < KEYS_MOST)) { const t = sum.tools[one.tool] ??= { n: 0, failed: 0, ms: 0 }; t.n++; if (one.failed) t.failed++; t.ms += one.ms ?? 0; }
    } else if (one.k === 'played') { if (one.what) bump(sum.played, one.what, one.n ?? 1); }
    else if (one.k === 'game') sum.game = one;
    else if (one.k === 'lore') sum.lore = one;
    else if (one.k === 'end') { sum.seconds += one.seconds ?? 0; sum.briefs += one.briefs ?? 0; }
  }
  sum.last = now.toISOString();
  return sum;
}
const fresh = (account, now) => ({ account, first: now.toISOString(), last: now.toISOString(), sessions: 0, calls: 0, errors: 0, seconds: 0, briefs: 0, tools: {}, played: {}, clients: {}, game: null, lore: null });

/**
 * Answer a request under DM_API. `env.DM_STATS` (or, until it has a bucket of its own, `env.LANDFALL_CACHE`) is the
 * R2 bucket the statistics are kept in, under `dm/`. `relay`, `fetcher` and `clock` are for the tests.
 */
export async function handleDmApi(request, env, ctx, { relay = DM_RELAY, fetcher = (...args) => fetch(...args), clock = () => Date.now() } = {}) {
  const route = new URL(request.url).pathname.slice(DM_API.length), store = env?.DM_STATS || env?.LANDFALL_CACHE;
  if (!(route === 'telemetry' && request.method === 'POST') && !(route === 'me' && request.method === 'GET')) return answer(404, { error: 'No such thing here' });
  if (!store) return answer(503, { error: 'Statistics are not kept here yet' });
  const who = await whose(request, { relay, fetcher, clock });
  if (!who.account) return answer(who.status, { error: who.status === 401 ? 'Sign in with a Caiioo account' : 'Caiioo could not be asked just now' });
  const now = new Date(clock()), sumKey = `dm/accounts/${who.account}.json`, json = { httpMetadata: { contentType: 'application/json' } };
  const had = await store.get(sumKey);
  let sum = null;
  try { sum = had ? await had.json() : null; } catch { sum = null; }
  if (route === 'me') return answer(200, sum ?? fresh(who.account, now));
  if (Number(request.headers.get('content-length') || 0) > BODY_MOST) return answer(413, { error: 'Too much at once' });
  const raw = await request.text();
  if (raw.length > BODY_MOST) return answer(413, { error: 'Too much at once' });
  let body = null;
  try { body = JSON.parse(raw); } catch { return answer(400, { error: 'Not understood' }); }
  const events = (Array.isArray(body?.events) ? body.events : []).slice(0, EVENTS_MOST).map((one) => telemetryEvent(one?.k, one ?? {}, one?.at ?? now)).filter(Boolean);
  if (!events.length) return answer(200, { taken: 0 });
  const session = /^[A-Za-z0-9_-]{6,32}$/.test(String(body?.session ?? '')) ? body.session : 'none';
  const mark = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await store.put(`dm/events/${now.toISOString().slice(0, 10)}/${who.account}/${now.getTime()}-${mark}.json`, JSON.stringify({ account: who.account, session, received: now.toISOString(), events }), json);
  await store.put(sumKey, JSON.stringify(dmTally(sum ?? fresh(who.account, now), events, now)), json);
  return answer(200, { taken: events.length });
}
