// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The player's Caiioo account, as the dungeon master holds it. Caiioo's relay is the one issuer of its sessions,
// and it signs a program like this one in by its "link this device" flow: this program makes a key pair and starts
// a link; the player opens Caiioo's own approval page in their browser, approves for their account, and is shown a
// six-digit code; they type the code into this program's own page on this machine (never into the chat), and the
// relay then gives this program a session of that account, which it checks with the relay from then on.
//
// What is kept is one file, readable by the player alone: the session, and the account's number, name and tier.
// The session is sent to two places only: the relay, and Waterworld's own statistics endpoint (which checks it
// with the relay and keeps none of it). It is never given to the agent, never logged, never put in a URL.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CAIIOO_RELAY = 'https://relay.caiioo.ai';
// The name this program starts a link under. The relay shows it to the approver and must know it.
export const CAIIOO_CLIENT = 'waterworld';
// A session is checked with the relay this often; with the relay out of reach, the last check is trusted this long.
export const ACCOUNT_CHECK_MS = 30 * 60 * 1000, ACCOUNT_GRACE_MS = 24 * 3600 * 1000;
// A session this near its end is renewed.
const RENEW_WITHIN_MS = 2 * 24 * 3600 * 1000;

// Where sessions may be sent: the relay itself, or a stand-in on this machine (for tests). Anything else is refused,
// so that no setting can send a player's session to a stranger.
export function trustedBase(wanted, real) {
  if (!wanted) return real;
  let url; try { url = new URL(wanted); } catch { throw new Error(`"${wanted}" is not an address`); }
  if (url.origin === new URL(real).origin) return real;
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin + url.pathname.replace(/\/+$/, '');
  throw new Error(`A Caiioo session is sent only to ${new URL(real).host} (or to this machine, for tests): not to ${url.host}`);
}

// What a session says of itself (read, not checked: only the relay can check it): whose it is and when it ends.
export function sessionClaims(token) {
  const match = /^pf_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(String(token ?? ''));
  if (!match) return null;
  try { const claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); return claims && typeof claims === 'object' ? claims : null; } catch { return null; }
}
const masked = (email) => { const m = /^(.)[^@]*(@.+)$/.exec(String(email ?? '')); return m ? `${m[1]}***${m[2]}` : ''; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAccount({
  relay = trustedBase(process.env.WATERWORLD_DM_RELAY, CAIIOO_RELAY),
  file = process.env.WATERWORLD_DM_ACCOUNT_FILE || path.join(os.homedir(), '.config', 'waterworld-dm', 'account.json'),
  fetcher = (...args) => fetch(...args), clock = () => Date.now(), agent = 'waterworld-dm',
} = {}) {
  let held = null;     // { token, user: { id, name, tier }, verifiedAt }
  let link = null;     // a sign-in under way
  let polling = Promise.resolve();
  let checkedHere = false;   // this run of the program has itself had the relay's word on the session
  const read = () => { try { const kept = JSON.parse(fs.readFileSync(file, 'utf8')); return kept && typeof kept.token === 'string' ? kept : null; } catch { return null; } };
  const keep = () => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(held, null, 1) + '\n', { mode: 0o600 }); try { fs.chmodSync(file, 0o600); } catch { /* a system without modes */ } };
  const forget = () => { held = null; try { fs.rmSync(file, { force: true }); } catch { /* nothing to forget */ } };
  const call = async (pathname, { method = 'GET', body, bearer } = {}) => {
    const response = await fetcher(relay + pathname, { method, headers: { 'user-agent': agent, ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let data = null; try { data = await response.json(); } catch { data = null; }
    return { status: response.status, data: data ?? {} };
  };
  // Only what is needed of what the relay says of an account: its number, a name to show, its tier.
  const person = (user = {}, tier) => ({ id: String(user.id ?? ''), name: String(user.name || masked(user.email) || 'a Caiioo account').slice(0, 80), tier: String(tier || user.tier || '').slice(0, 24) });

  // Renew a session that is near its end (or past it: the relay allows a while).
  async function renew() {
    const { status, data } = await call('/api/auth/refresh', { method: 'POST', body: { token: held.token } });
    if (status === 200 && typeof data.token === 'string') { held = { token: data.token, user: person(data.user ?? held.user, held.user?.tier), verifiedAt: clock() }; keep(); return true; }
    return false;
  }
  // Check the session with the relay. True when it stands; false when the relay says it does not (it is then
  // forgotten). Throws when the relay cannot be reached.
  async function check() {
    const claims = sessionClaims(held.token);
    if (!claims) { forget(); return false; }
    if (Number.isFinite(claims.exp) && claims.exp - clock() < RENEW_WITHIN_MS && !(await renew()) && claims.exp <= clock()) { forget(); return false; }
    let answer = await call('/api/auth/me', { bearer: held.token });
    if (answer.status === 401 && (await renew())) answer = await call('/api/auth/me', { bearer: held.token });
    if (answer.status === 401) { forget(); return false; }
    if (answer.status !== 200 || !answer.data?.user?.id) throw new Error(`Caiioo answered ${answer.status}`);
    held = { token: held.token, user: person(answer.data.user, answer.data.effective_tier), verifiedAt: clock() }; keep(); checkedHere = true;
    return true;
  }

  const NOT_SIGNED_IN = 'No Caiioo account is signed in. Call sign_in and give the player the link it answers with: they approve in Caiioo and type the code Caiioo shows them into that page (never into this chat).';
  // The account, checked: throws, with what to do, when there is none.
  async function need() {
    held ??= read();
    if (!held) throw new Error(NOT_SIGNED_IN);
    if (checkedHere && held.verifiedAt && clock() - held.verifiedAt < ACCOUNT_CHECK_MS && held.user?.id) return held.user;
    let stands;
    try { stands = await check(); }
    catch (error) {
      if (held?.verifiedAt && clock() - held.verifiedAt < ACCOUNT_GRACE_MS && held.user?.id) return held.user;
      throw new Error(`Caiioo could not be reached to check the account (${error?.message || error}). Try again when this computer is online.`);
    }
    if (!stands) throw new Error('The Caiioo session has ended or was withdrawn. ' + NOT_SIGNED_IN);
    return held.user;
  }

  // Begin a sign-in: a key pair that stays in this program, and a link the relay will hold for ten minutes.
  async function begin() {
    if (link && link.expiresAt > clock() && !link.done) return link.view();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }), began = clock();
    let answer;
    try { answer = await call('/api/auth/link/start', { method: 'POST', body: { client: CAIIOO_CLIENT, devicePublicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } } }); }
    catch (error) { throw new Error(`Caiioo could not be reached to begin signing in (${error?.message || error}).`); }
    if (answer.status === 400 && /unknown client/i.test(String(answer.data.error))) throw new Error(`Caiioo does not yet admit this program: its relay's list of clients that may link has no "${CAIIOO_CLIENT}". Until it has, nobody can sign in here.`);
    if (answer.status !== 200 || !answer.data.linkId) throw new Error(`Caiioo would not begin a sign-in (${answer.status}${answer.data.error ? ': ' + answer.data.error : ''}).`);
    const { linkId, pollSecret, expiresIn, interval, approvalPath, serverTime } = answer.data;
    const one = link = {
      linkId, pollSecret, privateKey, interval: Math.max(0, Number(interval) || 5) * 1000, skew: (Number(serverTime) || began) - began, expiresAt: began + (Number(expiresIn) || 600) * 1000,
      approve: relay + String(approvalPath || `/link?l=${encodeURIComponent(linkId)}`), state: 'pending', said: '', last: 0, done: false,
      view() { return { state: one.state, approve: one.approve, said: one.said, expiresIn: Math.max(0, Math.round((one.expiresAt - clock()) / 1000)) }; },
    };
    return link.view();
  }
  // Ask the relay how the link stands, with the code once the player has typed it. One poll at a time, and no
  // sooner after the last than the relay allows.
  function poll(code) {
    const run = async () => {
      const one = link;
      if (!one || one.done) return one ? one.view() : { state: 'none', said: 'No sign-in is under way: call sign_in.' };
      if (one.expiresAt <= clock()) { one.done = true; one.state = 'expired'; one.said = 'That sign-in ran out of time. Begin again.'; return one.view(); }
      const wait = one.last + one.interval - clock(); if (wait > 0) await sleep(wait);
      const ts = clock() + one.skew, signature = crypto.sign('sha256', Buffer.from(`caiioo-device-link-poll\n${one.linkId}\n${ts}`), { key: one.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      let answer;
      try { answer = await call('/api/auth/link/poll', { method: 'POST', body: { linkId: one.linkId, pollSecret: one.pollSecret, ts, signature, ...(code ? { code: String(code) } : {}) } }); }
      catch (error) { one.said = `Caiioo could not be reached (${error?.message || error}). Try again.`; return one.view(); }
      one.last = clock();
      const { status, data } = answer;
      if (status === 429) { one.said = 'Too soon: try again in a few seconds.'; return one.view(); }
      if (status !== 200) { one.done = true; one.state = 'failed'; one.said = `Caiioo refused the sign-in (${status}${data.error ? ': ' + data.error : ''}). Begin again.`; return one.view(); }
      if (data.status === 'approved' && typeof data.token === 'string') {
        held = { token: data.token, user: person(data.user), verifiedAt: clock() }; keep(); checkedHere = true;
        one.done = true; one.state = 'approved'; one.said = `Signed in as ${held.user.name}.`; one.privateKey = null; one.pollSecret = '';
      } else if (data.status === 'denied') { one.done = true; one.state = 'denied'; one.said = 'The sign-in was refused in Caiioo, or its code was mistyped too often. Begin again.'; }
      else if (data.status === 'awaiting_code') { one.state = 'awaiting_code'; one.said = data.codeError ? `That is not the code Caiioo showed${Number.isFinite(data.attemptsLeft) ? ` (${data.attemptsLeft} tries left)` : ''}.` : 'Approved in Caiioo: now type the six-digit code it showed.'; }
      else { one.state = 'pending'; one.said = code ? 'Not approved yet: open Caiioo from the first step and approve, then send the code again.' : 'Waiting for approval in Caiioo.'; }
      return one.view();
    };
    const next = polling.then(run, run); polling = next.catch(() => { });
    return next;
  }
  // Sign out: the relay withdraws the session (which unpairs this program), and the file is removed.
  async function signOut() {
    held ??= read();
    if (!held) return { signedIn: false };
    try { await call('/api/auth/logout', { method: 'POST', bearer: held.token, body: {} }); } catch { /* out of reach: the session is forgotten here all the same */ }
    forget(); link = null; checkedHere = false;
    return { signedIn: false };
  }
  // Who is signed in, for showing: never the session itself.
  function who() {
    held ??= read();
    return held?.user?.id ? { signedIn: true, account: held.user.id, name: held.user.name, tier: held.user.tier || undefined, checked: held.verifiedAt ? new Date(held.verifiedAt).toISOString() : undefined } : { signedIn: false };
  }
  return { need, begin, poll, signOut, who, get link() { return link ? link.view() : null; }, bearer: () => (held ??= read())?.token ?? null, relay };
}

// The page this program serves on this machine for the one step that must not pass through the chat: the code.
export function signInPage({ key, approve, name = '' }) {
  const safe = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Waterworld storyteller: sign in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b2430;background:#f4efe6}h1{font-size:1.3rem}ol{padding-left:1.2rem}li{margin:.9rem 0}a.go,button{font:inherit;padding:.5rem .9rem;border-radius:.4rem;border:1px solid #1b2430;background:#1b2430;color:#f4efe6;text-decoration:none;cursor:pointer}input{font:1.4rem ui-monospace,monospace;letter-spacing:.3rem;width:9rem;padding:.3rem .5rem;border:1px solid #1b2430;border-radius:.4rem}#said{min-height:1.5rem;font-weight:600}small{color:#55606e}@media(prefers-color-scheme:dark){body{background:#12171d;color:#e8e2d6}a.go,button{background:#e8e2d6;color:#12171d;border-color:#e8e2d6}input{background:#12171d;color:#e8e2d6;border-color:#e8e2d6}small{color:#9aa5b1}}</style></head><body>
<h1>Sign in to Caiioo for Waterworld's storyteller</h1>
${name ? `<p id="said">Signed in as ${safe(name)}. You can close this tab.</p>` : `<ol><li>Approve this program for your account in Caiioo. It opens in a new tab and shows you a six-digit code.<br><br><a class="go" href="${safe(approve)}" target="_blank" rel="noopener noreferrer">Open Caiioo to approve</a></li>
<li>Type that code here.<br><br><form id="f"><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-label="The six-digit code"> <button>Sign in</button></form></li></ol>
<p id="said" role="status"></p><small>The code goes from this page to the storyteller program on this computer and from there to Caiioo. It is never shown to the AI, and nobody should ask you for it anywhere else.</small>
<script>const said=document.getElementById('said');document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();said.textContent='Asking Caiioo…';try{const r=await fetch('/sign-in/code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({k:${JSON.stringify(String(key))},code:document.getElementById('code').value.trim()})});const a=await r.json();said.textContent=a.said||a.error||'';if(a.state==='approved'){document.querySelector('ol').remove();said.textContent+=' You can close this tab and go back to the storyteller.';}}catch{said.textContent='The storyteller program did not answer: is it still running?';}});</script>`}
</body></html>`;
}
