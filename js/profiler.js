// Timestamp queries are optional. Detailed mode adds compute pass boundaries;
// normal rendering retains its single compute pass and samples only frame time.
export const GPU_PASS_NAMES = [
  'Waves + effects', 'Sky + clouds', 'Reflections', 'Solid shadows', 'Canvas shadows',
  'Ocean + sky', 'Water reflection filter', 'Ship + spray',
  ...Array.from({length:8},(_,i)=>`Bloom down ${i}`),
  ...Array.from({length:7},(_,i)=>`Bloom up ${i+1}`), 'Composite',
];

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
  let collecting=false,pending=false,frame=0,pendingFrame=0,totalMs=0,sampleCount=0,reading=Promise.resolve(),error='';
  function snapshot() {
    const sorted=samples.map(s=>s.totalMs).sort((a,b)=>a-b);
    return {supported,detailed,error,totalMs,sampleCount,latest:{...latest},smoothed:{...smoothed},
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
        const elapsed=Number(values[count-1]-values[0])/1e6;
        let bloomStart=null,bloomEnd=0n;
        for(let i=0;i<names.length;i++){
          const ms=pendingUsed[i]?Number(values[i*2+1]-values[i*2])/1e6:0;
          latest[names[i]]=ms;
          smoothed[names[i]]=sampleCount?smoothed[names[i]]*.8+ms*.2:ms;
          if(pendingUsed[i]&&names[i].startsWith('Bloom ')){
            const start=values[i*2],end=values[i*2+1];
            if(bloomStart===null||start<bloomStart)bloomStart=start;
            if(end>bloomEnd)bloomEnd=end;
          }
        }
        // Tile GPUs can start vertex work before preceding fragments finish.
        // Bloom is its enclosing time span, never a sum of overlapping passes.
        latest.Bloom=bloomStart===null?0:Number(bloomEnd-bloomStart)/1e6;
        smoothed.Bloom=sampleCount?smoothed.Bloom*.8+latest.Bloom*.2:latest.Bloom;
        staging.unmap();
        if(Number.isFinite(elapsed)&&elapsed>=0){
          totalMs=sampleCount?totalMs*.8+elapsed*.2:elapsed;sampleCount++;
          if(detailed&&pendingFrame>=120){
            samples.push({frame:pendingFrame,totalMs:elapsed,passes:{...latest}});
            if(samples.length>512)samples.shift();
          }
        }
      }).catch(e=>{error=String(e.message||e);}).finally(()=>{pending=false;});
      return reading;
    },
    settled(){return reading;},
    text(){
      if(!supported)return 'GPU pass timing unavailable: timestamp-query unsupported.';
      if(error)return `GPU pass timing unavailable: ${error}`;
      const lines=[`GPU frame span  ${totalMs.toFixed(2)} ms`, 'Pass spans (overlap; not additive):'];
      for(const name of GPU_PASS_NAMES.filter(n=>!n.startsWith('Bloom '))){
        if(name==='Composite'){
          lines.push(`Bloom                   ${(smoothed.Bloom||0).toFixed(2)} ms`);
        }
        lines.push(`${name.padEnd(23)} ${(smoothed[name]||0).toFixed(2)} ms`);
      }
      lines.push('Sampled every 8 frames; rounded GPU timestamps.', 'Profiling adds pass boundaries; compare like-for-like.');
      return lines.join('\n');
    },
    destroy(){query?.destroy();resolve?.destroy();staging?.destroy();},
  };
}
