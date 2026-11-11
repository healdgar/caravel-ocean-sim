// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons' model run here in Node, for baking a port's board ahead of time and for the tests. It runs
// as the page runs it (js/board-worker.js): the whole program in a worker of its own, since the program replaces
// Math's functions and declares some thousands of names, and a thread's own scope runs it many times faster than a
// vm context does. The thread is kept by the model's own keeper (its SimulationWorkerHost), so everything the
// source's page may ask of its worker may be asked here: `request(type, payload)`.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { boardPrefix } from '../js/board-model.js';

const here = (name) => new URL(`../assets/board/${name}`, import.meta.url);
let program = null;
// The program's text, and its name: the hash of the model's own text (not of this game's hand on it, which only
// reads), under which a world is frozen and taken up again.
export const boardProgram = () => program ??= Promise.all([readFile(here('game.js'), 'utf8'), readFile(here('runtime.js'), 'utf8')])
  .then(([game, runtime]) => ({ text: game + '\n' + runtime, name: createHash('sha256').update(game).digest('hex') }));

// What a page gives the model that a Node thread does not; the model only ever asks for a frame to draw.
const SHIM = "for(const name of ['addEventListener','removeEventListener','requestAnimationFrame'])if(typeof globalThis[name]!=='function')globalThis[name]=()=>0;\n";
const PUMP = `
{
  const {parentPort}=require('node:worker_threads');
  let keeper=null;
  parentPort.on('message',async(data)=>{
    if(data&&data.protocol===1){(keeper??=BOARD_MODEL.serve((message,transfer)=>parentPort.postMessage(message,transfer))).receive(data);return;}
    const {id,hook,args}=data;
    try{
      const progress=hook==='found'?(text,fraction)=>parentPort.postMessage({id,progress:text,fraction}):undefined;
      const result=await BOARD_MODEL[hook](...(args||[]),...(progress?[progress]:[]));
      if(ArrayBuffer.isView(result))parentPort.postMessage({id,result},[result.buffer]);
      else parentPort.postMessage({id,result:JSON.parse(JSON.stringify(result??null))});
    }catch(error){parentPort.postMessage({id,error:String(error&&error.stack||error)});}
  });
}
`;

// Found the board a request asks for, or take up a frozen `world` (the bytes `freeze()` gave), and keep its model:
// `board` as founded or taken up; `live(days)` for the board so many days on; `freeze()` for the whole world as the
// model saves it; `request(type, payload)` for anything the model's own keeper answers (view, command, watch,
// advance, speed, pause, save, flush), with `on.view`, `on.clock`, `on.session`, `on.progress` and `on.fault` for
// what it sends unasked; `hook(name, ...args)` for anything else the runtime offers; `close()` to end it.
export async function openBoard(request, { onProgress = null, world = null } = {}) {
  const { text, name } = await boardProgram();
  const worker = new Worker(SHIM + boardPrefix(world ? { ...request, heights: null } : request, name) + text + PUMP, { eval: true, name: 'board' });
  const waiting = new Map(), asked = new Map(), on = { view: null, clock: null, session: null, progress: null, fault: null };
  let next = 1, sequence = 0;
  const idle = () => { if (waiting.size === 0 && asked.size === 0) worker.unref(); };
  const failAll = (error) => { for (const wait of [...waiting.values(), ...asked.values()]) wait.reject(error); waiting.clear(); asked.clear(); };
  const ask = (type, payload = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    worker.ref();
    asked.set(id, { resolve, reject });
    worker.postMessage({ protocol: 1, id, type, payload });
  });
  worker.on('message', (data) => {
    if (data && data.protocol === 1) {
      if (data.type) {
        on[data.type]?.(data.type === 'progress' || data.type === 'fault' ? data : data.value);
        // The keeper sends one display record at a time and waits to hear it was taken.
        if (data.type === 'view') ask('view-ack', { sequence: data.sequence }).catch(() => {});
        return;
      }
      const wait = asked.get(data.replyTo);
      if (!wait) return;
      asked.delete(data.replyTo); idle();
      if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.value);
      return;
    }
    const wait = waiting.get(data.id);
    if (!wait) return;
    if (data.progress !== undefined) { wait.onProgress?.(data.progress, data.fraction); return; }
    waiting.delete(data.id); idle();
    if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.result);
  });
  worker.on('error', failAll);
  worker.on('exit', (code) => failAll(new Error(`The board's model stopped (${code})`)));
  // Idle, the thread does not hold the process open; a call in flight does.
  worker.unref();
  const call = (hook, args, progress) => new Promise((resolve, reject) => {
    const id = next++;
    worker.ref();
    waiting.set(id, { resolve, reject, onProgress: progress });
    worker.postMessage({ id, hook, args });
  });
  try {
    const board = world ? await call('thaw', [world], null) : await call('found', [{ seed: request.seed, fate: request.fate, era: request.era }], onProgress);
    // The keeper takes the realm as it stands: nothing is founded twice.
    await ask('init', { seed: request.seed, fate: request.fate, era: request.era });
    return {
      board, program: name, on,
      live: (days) => call('live', [days], null),
      freeze: () => call('freeze', [], null),
      request: ask,
      hook: (hookName, ...args) => call(hookName, args, null),
      close: () => worker.terminate(),
    };
  } catch (error) { await worker.terminate(); throw error; }
}

// The board alone, as plain data, after so many days of the model's life.
export async function foundBoard(request, { days = 0, onProgress = null } = {}) {
  const open = await openBoard(request, { onProgress });
  try { return days > 0 ? await open.live(days) : open.board; } finally { await open.close(); }
}
