// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons' model on the page: the whole program in a worker of its own, so founding a coast (a minute
// or more) and living its days never take the frame's thread. The worker's script is three texts end to end: the
// words that say what to found (boardPrefix), the model's program and this game's hand on it (assets/board), and a
// small pump that answers messages. Nothing of the model is cut: every hook the runtime offers can be called here.
import { boardPrefix } from './board-model.js';

export const BOARD_PROGRAM_ASSETS = Object.freeze({ game: 'assets/board/game.js', runtime: 'assets/board/runtime.js' });

// A worker has no frames of its own; the model asks for one only to draw, which it never does here.
const BOARD_WORKER_SHIM = "if(typeof requestAnimationFrame==='undefined')globalThis.requestAnimationFrame=()=>0;\n";
const BOARD_WORKER_PUMP = `
self.onmessage=async(event)=>{
  const {id,hook,args}=event.data;
  try{
    const progress=hook==='found'?(text,fraction)=>self.postMessage({id,progress:text,fraction}):undefined;
    const result=await BOARD_MODEL[hook](...(args||[]),...(progress?[progress]:[]));
    self.postMessage({id,result});
  }catch(error){self.postMessage({id,error:String(error&&error.stack||error)});}
};
self.postMessage({ready:true,version:BOARD_MODEL.VERSION});
`;

let boardProgramText = null;
// The model's program, fetched once however many coasts are founded.
export function loadBoardProgram(fetchImpl = fetch) {
  return boardProgramText ??= Promise.all(Object.values(BOARD_PROGRAM_ASSETS).map((url) => fetchImpl(url).then((response) => {
    if (!response.ok) throw new Error(`The board's program could not be fetched: ${url} ${response.status}`);
    return response.text();
  }))).then(([game, runtime]) => game + '\n' + runtime).catch((error) => { boardProgramText = null; throw error; });
}

// Open a model for a request. `founded` resolves to the board as plain data; `call(hook, ...args)` to whatever a
// hook of the runtime answers (live, board, souls...); `close()` ends the worker. `onProgress(text, fraction)` hears
// the founding as it goes.
export async function openBoardWorker(request, { onProgress = null, fetchImpl = fetch } = {}) {
  const program = await loadBoardProgram(fetchImpl);
  const url = URL.createObjectURL(new Blob([BOARD_WORKER_SHIM, boardPrefix(request), program, BOARD_WORKER_PUMP], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'board' });
  const waiting = new Map();
  let next = 1, fail = null;
  const ready = new Promise((resolve, reject) => {
    fail = reject;
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.ready) { resolve(data.version); return; }
      const wait = waiting.get(data.id);
      if (!wait) return;
      if (data.progress !== undefined) { wait.onProgress?.(data.progress, data.fraction); return; }
      waiting.delete(data.id);
      if (data.error) wait.reject(new Error(data.error)); else wait.resolve(data.result);
    };
    worker.onerror = (event) => {
      const error = new Error(`The board's model failed: ${event.message || 'unknown error'}`);
      reject(error);
      for (const wait of waiting.values()) wait.reject(error);
      waiting.clear();
    };
  });
  const call = (hook, args, progress) => ready.then(() => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject, onProgress: progress });
    worker.postMessage({ id, hook, args });
  }));
  const founded = call('found', [{ seed: request.seed, fate: request.fate, era: request.era }], onProgress);
  founded.catch(() => {});
  return {
    founded,
    call: (hook, ...args) => call(hook, args, null),
    close() { worker.terminate(); URL.revokeObjectURL(url); fail?.(new Error('closed')); for (const wait of waiting.values()) wait.reject(new Error('closed')); waiting.clear(); },
  };
}
