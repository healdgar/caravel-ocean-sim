// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons' model on the page: the whole program in a worker of its own, so founding a coast (a minute
// or more) and living its days never take the frame's thread. The worker's script is three texts end to end: the
// words that say what to found (boardPrefix), the model's program and this game's hand on it (assets/board), and a
// small pump that answers messages. Nothing of the model is cut. The thread is kept by the model's own keeper (its
// SimulationWorkerHost), so everything the source's page may ask of its worker may be asked here by the same
// names: `request('view', {kind})` for its display record, inspector, panels, people and overlays,
// `request('command', ...)` for all a player may order, `request('advance', {days})` for its days.
import { boardPrefix } from './board-model.js';

export const BOARD_PROGRAM_ASSETS = Object.freeze({ game: 'assets/board/game.js', runtime: 'assets/board/runtime.js' });

// A worker has no frames of its own; the model asks for one only to draw, which it never does here.
const BOARD_WORKER_SHIM = "if(typeof requestAnimationFrame==='undefined')globalThis.requestAnimationFrame=()=>0;\n";
const BOARD_WORKER_PUMP = `
{
  const keeper=BOARD_MODEL.serve((message,transfer)=>self.postMessage(message,transfer));
  self.onmessage=async(event)=>{
    const data=event.data;
    if(data&&data.protocol===1){keeper.receive(data);return;}
    const {id,hook,args}=data;
    try{
      const result=await BOARD_MODEL[hook](...(args||[]));
      if(ArrayBuffer.isView(result))self.postMessage({id,result},[result.buffer]);else self.postMessage({id,result});
    }catch(error){self.postMessage({id,error:String(error&&error.stack||error)});}
  };
  self.postMessage({ready:true,version:BOARD_MODEL.VERSION});
}
`;

let boardProgramLoad = null;
// The model's program, fetched once however many coasts are founded, and its name: the hash of the model's own
// text, under which a world is frozen and taken up again.
export function loadBoardProgram(fetchImpl = fetch) {
  return boardProgramLoad ??= Promise.all(Object.values(BOARD_PROGRAM_ASSETS).map((url) => fetchImpl(url).then((response) => {
    if (!response.ok) throw new Error(`The board's program could not be fetched: ${url} ${response.status}`);
    return response.text();
  }))).then(async ([game, runtime]) => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(game)));
    return { text: game + '\n' + runtime, name: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') };
  }).catch((error) => { boardProgramLoad = null; throw error; });
}

// Open a model for a request: found its realm, or take up a frozen `world` (the model's own save, as bytes).
// `ready` resolves to the model's own summary once the realm stands; `request(type, payload)` asks its keeper
// anything (view, command, watch, advance, speed, pause, save, flush); `on.view`, `on.clock`, `on.session`,
// `on.progress` and `on.fault` hear what it sends unasked; `hook(name, ...args)` calls this game's hand on it
// (board, live, freeze); `close()` ends the worker.
export async function openBoardWorker(request, { world = null, fetchImpl = fetch } = {}) {
  const program = await loadBoardProgram(fetchImpl);
  const url = URL.createObjectURL(new Blob([BOARD_WORKER_SHIM, boardPrefix(world ? { ...request, heights: null } : request, program.name), program.text, BOARD_WORKER_PUMP], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'board' });
  const waiting = new Map(), asked = new Map(), on = { view: null, clock: null, session: null, progress: null, fault: null };
  let next = 1, sequence = 0, closed = false;
  const failAll = (error) => { for (const wait of [...waiting.values(), ...asked.values()]) wait.reject(error); waiting.clear(); asked.clear(); };
  const up = new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.ready) { resolve(data.version); return; }
      if (data.protocol === 1) {
        if (data.type) {
          try { on[data.type]?.(data.type === 'progress' || data.type === 'fault' ? data : data.value); } catch (error) { console.error(error); }
          // The keeper sends one display record at a time and waits to hear it was taken.
          if (data.type === 'view' && !closed) ask('view-ack', { sequence: data.sequence }).catch(() => {});
          return;
        }
        const wait = asked.get(data.replyTo);
        if (!wait) return;
        asked.delete(data.replyTo);
        if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.value);
        return;
      }
      const wait = waiting.get(data.id);
      if (!wait) return;
      waiting.delete(data.id);
      if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.result);
    };
    worker.onerror = (event) => {
      const error = new Error(`The board's model failed: ${event.message || 'unknown error'}`);
      reject(error); failAll(error);
    };
  });
  up.catch(() => {});
  // Requests go in the order they are made: the keeper refuses a sequence out of step.
  function ask(type, payload = {}, transfer = []) {
    if (closed) return Promise.reject(new Error('closed'));
    const id = ++sequence;
    return new Promise((resolve, reject) => { asked.set(id, { resolve, reject }); worker.postMessage({ protocol: 1, id, type, payload }, transfer); });
  }
  const call = (hook, args) => up.then(() => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, hook, args });
  }));
  const ready = up.then(() => {
    const bytes = world ? (world instanceof Uint8Array ? world : new Uint8Array(world)) : null;
    return ask('init', { seed: request.seed, fate: request.fate, era: request.era, ...(bytes ? { world: bytes } : {}) }, bytes ? [bytes.buffer] : []);
  });
  ready.catch(() => {});
  return {
    ready, on, program: program.name,
    request: (type, payload) => ready.then(() => ask(type, payload)),
    hook: (name, ...args) => ready.then(() => call(name, args)),
    close() { closed = true; worker.terminate(); URL.revokeObjectURL(url); failAll(new Error('closed')); },
  };
}
