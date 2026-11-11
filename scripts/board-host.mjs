// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons' model run here in Node, for baking a port's board ahead of time and for the tests. It runs
// as the page runs it (js/board-worker.js): the whole program in a worker of its own, since the program replaces
// Math's functions and declares some thousands of names, and a thread's own scope runs it many times faster than a
// vm context does.
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { boardPrefix } from '../js/board-model.js';

const here = (name) => new URL(`../assets/board/${name}`, import.meta.url);
let program = null;
const boardProgram = () => program ??= Promise.all([readFile(here('game.js'), 'utf8'), readFile(here('runtime.js'), 'utf8')]).then(([game, runtime]) => game + '\n' + runtime);

// What a page gives the model that a Node thread does not; the model only ever asks for a frame to draw.
const SHIM = "for(const name of ['addEventListener','removeEventListener','requestAnimationFrame'])if(typeof globalThis[name]!=='function')globalThis[name]=()=>0;\n";
const PUMP = `
{
  const {parentPort}=require('node:worker_threads');
  parentPort.on('message',async({id,hook,args})=>{
    try{
      const progress=hook==='found'?(text,fraction)=>parentPort.postMessage({id,progress:text,fraction}):undefined;
      const result=await BOARD_MODEL[hook](...(args||[]),...(progress?[progress]:[]));
      parentPort.postMessage({id,result:JSON.parse(JSON.stringify(result??null))});
    }catch(error){parentPort.postMessage({id,error:String(error&&error.stack||error)});}
  });
}
`;

// Found the board a request asks for and keep its model: `board` as founded, `live(days)` for the board so many
// days on, `hook(name, ...args)` for anything else the runtime offers, `close()` to end it.
export async function openBoard(request, { onProgress = null } = {}) {
  const worker = new Worker(SHIM + boardPrefix(request) + await boardProgram() + PUMP, { eval: true, name: 'board' });
  const waiting = new Map();
  let next = 1;
  const failAll = (error) => { for (const wait of waiting.values()) wait.reject(error); waiting.clear(); };
  worker.on('message', (data) => {
    const wait = waiting.get(data.id);
    if (!wait) return;
    if (data.progress !== undefined) { wait.onProgress?.(data.progress, data.fraction); return; }
    waiting.delete(data.id);
    if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.result);
  });
  worker.on('error', failAll);
  worker.on('exit', (code) => failAll(new Error(`The board's model stopped (${code})`)));
  // Idle, the thread does not hold the process open; a call in flight does.
  worker.unref();
  const call = (hook, args, progress) => new Promise((resolve, reject) => {
    const id = next++;
    worker.ref();
    const done = (settle) => (value) => { if (waiting.size === 0) worker.unref(); settle(value); };
    waiting.set(id, { resolve: done(resolve), reject: done(reject), onProgress: progress });
    worker.postMessage({ id, hook, args });
  });
  try {
    const board = await call('found', [{ seed: request.seed, fate: request.fate, era: request.era }], onProgress);
    return {
      board,
      live: (days) => call('live', [days], null),
      hook: (name, ...args) => call(name, args, null),
      close: () => worker.terminate(),
    };
  } catch (error) { await worker.terminate(); throw error; }
}

// The board alone, as plain data, after so many days of the model's life.
export async function foundBoard(request, { days = 0, onProgress = null } = {}) {
  const open = await openBoard(request, { onProgress });
  try { return days > 0 ? await open.live(days) : open.board; } finally { await open.close(); }
}
