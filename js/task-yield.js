// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// A real browser task boundary lets input/paint run; microtasks alone do not.
export function yieldCooperativeTask(){
  const taskScheduler=globalThis.scheduler;
  if(typeof taskScheduler?.yield==='function')return taskScheduler.yield();
  return new Promise((resolve,reject)=>{
    if(typeof globalThis.MessageChannel!=='function'){setTimeout(resolve,0);return;}
    const channel=new MessageChannel(),close=()=>{channel.port1.close();channel.port2.close();};
    channel.port1.onmessage=()=>{close();resolve();};
    channel.port1.onmessageerror=()=>{close();reject(Error('Cooperative task message failed'));};
    try{channel.port2.postMessage(null);}catch(error){close();reject(error);}
  });
}
// Validators keep their existing small checked batches. Only yield when the
// work budget expires, not once per batch: nested timer fallbacks can otherwise
// add minutes of idle time on browsers without scheduler.yield.
export function createTaskYieldBudget({budgetMs=8,now=()=>performance.now(),yieldTask=yieldCooperativeTask}={}){
  let deadline=now()+budgetMs;
  return()=>{
    if(now()<deadline)return null;
    return Promise.resolve(yieldTask()).then(()=>{deadline=now()+budgetMs;});
  };
}
