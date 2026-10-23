// Timestamp queries are optional. Detailed mode adds compute pass boundaries;
// normal rendering retains its single compute pass and samples only frame time.
export const GPU_PASS_NAMES = [
  'Waves + effects', 'Sky + clouds', 'Reflections', 'Solid shadows', 'Canvas shadows', 'Companion Solid shadows', 'Companion Canvas shadows',
  ...Array.from({length:8},(_,i)=>['escort-'+(i+1)+' Solid shadows','escort-'+(i+1)+' Canvas shadows']).flat(),
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
  const supported=device.features.has('timestamp-query'), modes=new Map();
  let detailed=!!requested&&supported,epoch=0,active=null,pendingCapture=null;
  // Allocate detailed resources only when opened. Closing restores the original
  // endpoint-only schedule used by automatic resolution, without pass splits.
  function timingMode(detail){
    if(modes.has(detail))return modes.get(detail);
    const names=detail?GPU_PASS_NAMES:['Frame'],count=names.length*2,bytes=count*8;
    const query=device.createQuerySet({type:'timestamp',count});
    const resolve=device.createBuffer({label:'timing resolve',size:bytes,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
    const staging=device.createBuffer({label:'timing read',size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const descriptors=names.map((_,i)=>({querySet:query,beginningOfPassWriteIndex:i*2,endOfPassWriteIndex:i*2+1}));
    const mode={detail,names,count,bytes,query,resolve,staging,descriptors,used:new Uint8Array(names.length),
      first:{querySet:query,beginningOfPassWriteIndex:0},last:{querySet:query,endOfPassWriteIndex:1}};
    modes.set(detail,mode);return mode;
  }
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
    supported,get detailed(){return detailed;},get totalMs(){return totalMs;},snapshot,
    setDetailed(value){
      const next=!!value&&supported;if(next===detailed)return detailed;
      detailed=next;epoch++;collecting=false;active=null;totalMs=0;sampleCount=0;droppedSamples=0;samples.length=0;
      for(const key of Object.keys(latest))delete latest[key];for(const key of Object.keys(smoothed))delete smoothed[key];
      return detailed;
    },
    beginFrame(index){frame=index;collecting=supported&&!pending&&!error&&(index&7)===0;active=collecting?timingMode(detailed):null;active?.used.fill(0);},
    writes(name){
      if(!collecting)return undefined;
      if(!active.detail){active.used[0]=1;return name==='Waves + effects'?active.first:name==='Composite'?active.last:undefined;}
      const i=active.names.indexOf(name);
      if(i<0)throw new Error(`Unknown GPU timing pass: ${name}`);
      active.used[i]=1;return active.descriptors[i];
    },
    resolve(encoder){
      if(!collecting)return false;
      encoder.resolveQuerySet(active.query,0,active.count,active.resolve,0);
      encoder.copyBufferToBuffer(active.resolve,0,active.staging,0,active.bytes);
      pendingCapture={mode:active,used:active.used.slice(),epoch};pendingFrame=frame;pending=true;collecting=false;return true;
    },
    read(){
      if(!pending)return reading;
      const capture=pendingCapture,mode=capture.mode;
      reading=mode.staging.mapAsync(GPUMapMode.READ).then(()=>{
        const values=new BigUint64Array(mode.staging.getMappedRange());
        const decoded=decodeGPUTimestamps(values,mode.names,capture.used);
        mode.staging.unmap();
        if(capture.epoch!==epoch)return; // A hidden/reopened panel must not mix timing modes.
        if(!decoded){droppedSamples++;return;}
        for(const [name,ms] of Object.entries(decoded.passes)){
          latest[name]=ms;smoothed[name]=sampleCount?smoothed[name]*.8+ms*.2:ms;
        }
        const elapsed=decoded.windowMs;
        totalMs=sampleCount?totalMs*.8+elapsed*.2:elapsed;sampleCount++;
        if(mode.detail&&pendingFrame>=120){
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
      if(!detailed)return `GPU endpoints  ${totalMs.toFixed(2)} ms\nDetailed pass timing is off.`;
      const lines=[`GPU ${detailed?'sampled window':'endpoints'}  ${totalMs.toFixed(2)} ms`, 'Smoothed pass spans (overlap; not additive):'];
      for(const name of GPU_PASS_NAMES.filter(n=>!n.startsWith('Bloom '))){
        if((name.startsWith('escort-')||name.startsWith('Companion '))&&!(name in latest&&latest[name]>0))continue;
        if(name==='Composite'){
          lines.push(`Bloom window (waits)    ${(smoothed.Bloom||0).toFixed(2)} ms`);
        }
        lines.push(`${name.padEnd(23)} ${(smoothed[name]||0).toFixed(2)} ms`);
      }
      lines.push('GPU windows include waits; they are not FPS.', 'Bloom window is not the cost of bloom alone.', 'Sampled every 8 frames; rounded GPU timestamps.', 'Profiling adds pass boundaries; compare like-for-like.');
      if(droppedSamples)lines.push(`Discarded invalid timestamp samples: ${droppedSamples}`);
      return lines.join('\n');
    },
    destroy(){for(const mode of modes.values()){mode.query.destroy();mode.resolve.destroy();mode.staging.destroy();}},
  };
}
