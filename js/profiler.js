// Timestamp queries are optional. Detailed mode adds compute pass boundaries;
// normal rendering retains its single compute pass and samples only frame time.
export const GPU_PASS_NAMES = [
  'Waves + effects', 'Sky + clouds', 'Reflections', 'Solid shadows', 'Canvas shadows', 'Companion Solid shadows', 'Companion Canvas shadows',
  'Submerged geometry', 'Ocean + sky', 'Water reflection filter', 'Ship + spray', 'Underwater medium',
  ...Array.from({length:8},(_,i)=>`Bloom down ${i}`),
  ...Array.from({length:7},(_,i)=>`Bloom up ${i+1}`), 'Composite',
];

// Passes may begin before the first encoded compute pass starts. Preserve the
// endpoint interval separately; only min(start)..max(end) encloses all samples.
export function decodeGPUTimestamps(values,names,used) {
  let first=null,last=null,bloomFirst=null,bloomLast=null;
  const passes={};
  for(let i=0;i<names.length;i++){
    const name=names[i];passes[name]=0;
    if(!used[i])continue; // Unwritten slots may contain a previous frame's data.
    const start=values[i*2],end=values[i*2+1];
    if(end<start)return null;
    passes[name]=Number(end-start)/1e6;
    if(first===null||start<first)first=start;
    if(last===null||end>last)last=end;
    if(name.startsWith('Bloom ')){
      if(bloomFirst===null||start<bloomFirst)bloomFirst=start;
      if(bloomLast===null||end>bloomLast)bloomLast=end;
    }
  }
  if(first===null)return null;
  passes.Bloom=bloomFirst===null?0:Number(bloomLast-bloomFirst)/1e6;
  return {windowMs:Number(last-first)/1e6,passes};
}

export function createGPUProfiler(device, requested=false) {
  const supported=device.features.has('timestamp-query'), detailed=requested && supported;
  const names=detailed?GPU_PASS_NAMES:['Frame'], count=names.length*2, bytes=count*8;
  const query=supported?device.createQuerySet({type:'timestamp',count}):null;
  const resolve=supported?device.createBuffer({label:'timing resolve',size:bytes,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}):null;
  const staging=supported?device.createBuffer({label:'timing read',size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}):null;
  const descriptors=names.map((_,i)=>({querySet:query,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1}));
  const first={querySet:query,beginningOfPassWriteIndex:0},last={querySet:query,endOfPassWriteIndex:1};
  const used=new Uint8Array(names.length), pendingUsed=new Uint8Array(names.length);
  const latest={},smoothed={},samples=[];
  let collecting=false,pending=false,frame=0,pendingFrame=0,totalMs=0,sampleCount=0,droppedSamples=0,reading=Promise.resolve(),error='';
  function snapshot() {
    const sorted=samples.map(s=>s.totalMs).sort((a,b)=>a-b);
    return {version:2,metric:detailed?'sampled GPU window':'compute-to-composite endpoints',supported,detailed,error,totalMs,sampleCount,droppedSamples,latest:{...latest},smoothed:{...smoothed},
      medianMs:sorted.length?sorted[Math.floor(sorted.length/2)]:null,
      p95Ms:sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]:null,
      samples:samples.map(s=>({...s,passes:{...s.passes}}))};
  }
  return {
    supported,detailed,get totalMs(){return totalMs;},snapshot,
    beginFrame(index){frame=index;collecting=supported&&!pending&&!error&&(index&7)===0;used.fill(0);},
    writes(name){
      if(!collecting)return undefined;
      if(!detailed){used[0]=1;return name==='Waves + effects'?first:name==='Composite'?last:undefined;}
      const i=names.indexOf(name);
      if(i<0)throw new Error(`Unknown GPU timing pass: ${name}`);
      used[i]=1;return descriptors[i];
    },
    resolve(encoder){
      if(!collecting)return false;
      encoder.resolveQuerySet(query,0,count,resolve,0);
      encoder.copyBufferToBuffer(resolve,0,staging,0,bytes);
      pendingUsed.set(used);pendingFrame=frame;pending=true;collecting=false;return true;
    },
    read(){
      if(!pending)return reading;
      reading=staging.mapAsync(GPUMapMode.READ).then(()=>{
        const values=new BigUint64Array(staging.getMappedRange());
        const decoded=decodeGPUTimestamps(values,names,pendingUsed);
        staging.unmap();
        if(!decoded){droppedSamples++;return;}
        for(const [name,ms] of Object.entries(decoded.passes)){
          latest[name]=ms;smoothed[name]=sampleCount?smoothed[name]*.8+ms*.2:ms;
        }
        const elapsed=decoded.windowMs;
        totalMs=sampleCount?totalMs*.8+elapsed*.2:elapsed;sampleCount++;
        if(detailed&&pendingFrame>=120){
          samples.push({frame:pendingFrame,totalMs:elapsed,passes:{...latest}});
          if(samples.length>512)samples.shift();
        }
      }).catch(e=>{error=String(e.message||e);}).finally(()=>{pending=false;});
      return reading;
    },
    settled(){return reading;},
    text(){
      if(!supported)return 'GPU pass timing unavailable: timestamp-query unsupported.';
      if(error)return `GPU pass timing unavailable: ${error}`;
      const lines=[`GPU ${detailed?'sampled window':'endpoints'}  ${totalMs.toFixed(2)} ms`, 'Smoothed pass spans (overlap; not additive):'];
      for(const name of GPU_PASS_NAMES.filter(n=>!n.startsWith('Bloom '))){
        if(name==='Composite'){
          lines.push(`Bloom                   ${(smoothed.Bloom||0).toFixed(2)} ms`);
        }
        lines.push(`${name.padEnd(23)} ${(smoothed[name]||0).toFixed(2)} ms`);
      }
      lines.push('GPU windows include waits; they are not FPS.', 'Sampled every 8 frames; rounded GPU timestamps.', 'Profiling adds pass boundaries; compare like-for-like.');
      if(droppedSamples)lines.push(`Discarded invalid timestamp samples: ${droppedSamples}`);
      return lines.join('\n');
    },
    destroy(){query?.destroy();resolve?.destroy();staging?.destroy();},
  };
}
