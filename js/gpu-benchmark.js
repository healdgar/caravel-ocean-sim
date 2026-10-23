// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// An opt-in diagnostic: drain preceding work, then measure only this stage.
// Normal rendering never waits for these fences or allocates these resources.
export function isolatedGPUStageMilliseconds(values,repetitions){
  if(!values.length||values.length%2||!Number.isInteger(repetitions)||repetitions<1)throw new Error('Invalid isolated GPU capture');
  let first=values[0],last=values[1];
  for(let i=0;i<values.length;i+=2){
    if(values[i+1]<values[i])throw new Error('Reversed isolated GPU timestamps');
    if(values[i]<first)first=values[i];if(values[i+1]>last)last=values[i+1];
  }
  return Number(last-first)/1e6/repetitions;
}

export async function measureIsolatedGPUStage({device,encode,passCount,width,height,repetitions=4,sampleCount=3}){
  if(!device.features.has('timestamp-query'))throw new Error('GPU timestamps are unavailable on this browser');
  if(!Number.isInteger(passCount)||passCount<1||passCount>128)throw new Error('Invalid isolated GPU pass count');
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>16||!Number.isInteger(sampleCount)||sampleCount<1||sampleCount>9)throw new Error('Invalid isolated GPU batch count');
  const count=passCount*2,bytes=count*8;
  const query=device.createQuerySet({label:'isolated stage timestamps',type:'timestamp',count});
  const resolve=device.createBuffer({label:'isolated stage resolve',size:bytes,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
  const read=device.createBuffer({label:'isolated stage read',size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const begin=Array.from({length:passCount},(_,i)=>({querySet:query,beginningOfPassWriteIndex:i*2}));
  const end=Array.from({length:passCount},(_,i)=>({querySet:query,endOfPassWriteIndex:i*2+1}));
  const both=Array.from({length:passCount},(_,i)=>({...begin[i],...end[i]}));
  const writes=Array.from({length:repetitions},(_,r)=>i=>repetitions===1?both[i]:r===0?begin[i]:r===repetitions-1?end[i]:undefined);
  const samples=[];
  try{
    for(let sample=0;sample<sampleCount;sample++){
      await device.queue.onSubmittedWorkDone();
      const encoder=device.createCommandEncoder({label:'isolated stage measurement'});
      for(let r=0;r<repetitions;r++)encode(encoder,writes[r]);
      encoder.resolveQuerySet(query,0,count,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,bytes);
      device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      try{samples.push(isolatedGPUStageMilliseconds(new BigUint64Array(read.getMappedRange()),repetitions));}finally{read.unmap();}
    }
    const sorted=samples.slice().sort((a,b)=>a-b);
    return {milliseconds:sorted[Math.floor(sorted.length/2)],samples,repetitions,passCount,width,height,scope:'isolated GPU stage; preceding work drained'};
  }finally{read.destroy();resolve.destroy();query.destroy();}
}
