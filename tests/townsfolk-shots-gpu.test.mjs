// The compute pass on its own, on the real GPU, with a clock and shots of the test's choosing: one straight street
// 200 m long along x, 96 people strung out along it, and nothing else. See townsfolk-under-fire-gpu for the real town.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {createTownShots} from '../js/town-shots.js';
import {TOWN_ABOUT,TOWN_AFRAID,TOWN_DOWN,TOWN_FALLING,TOWN_RUN_SPEEDS,TOWN_SHOT_LIMIT,TOWN_SHOT_WORDS} from '../js/wgsl/townsfolk.js';

let browser,server,page;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
  page=await browser.newPage();
  await page.route('**/__townsfolk',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto(`http://127.0.0.1:${server.address().port}/__townsfolk`);
  await page.evaluate(setUp);
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const PEOPLE=96,LENGTH=200,STEP=1.25,WALK_SPEED=1.25,INDOORS=10,HALF_WIDTH=1.5;

// Runs in the page. `town(options)` builds a crowd, and `run(town,seconds,shots)` is one frame at that time.
async function setUp(){
  const {TOWNSFOLK_WALK,TOWNSFOLK_RENDER,TOWNSFOLK_SHADOW,TOWNSFOLK_BUCKETS:BUCKETS,TOWNSFOLK_SHADOW_BUCKET:SHADE,TOWN_FATE_WORDS,TOWN_SHOT_WORDS:SW,TOWN_SHOT_LIMIT:SL}=await import('/js/wgsl/townsfolk.js');
  const device=await(await navigator.gpu.requestAdapter()).requestDevice(),B=GPUBufferUsage,errors=[];
  device.onuncapturederror=e=>errors.push(e.error.message);
  const module=device.createShaderModule({code:TOWNSFOLK_WALK});
  const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
  if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));
  const renderMod=device.createShaderModule({code:TOWNSFOLK_RENDER});
  const badRender=(await renderMod.getCompilationInfo()).messages.filter(m=>m.type==='error');
  if(badRender.length)throw Error(badRender.map(m=>m.message).join('\n'));
  const badShadow=(await device.createShaderModule({code:TOWNSFOLK_SHADOW}).getCompilationInfo()).messages.filter(m=>m.type==='error');
  if(badShadow.length)throw Error(badShadow.map(m=>m.message).join('\n'));
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
  const made=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST|B.COPY_SRC});device.queue.writeBuffer(b,0,data);return b;};
  const LOOKS=48;
  window.town=({people,length,step,flags,side,halfWidth,speed,indoors,sun=1})=>{
    const samples=[];
    const count=Math.round(length/step)+1;
    for(let k=0;k<count;k++)samples.push(k*step,0,0,halfWidth);
    const walkers=new ArrayBuffer(people.length*48),w=new Uint32Array(walkers),f=new Float32Array(walkers),leg=length/speed+indoors;
    people.forEach((along,i)=>{
      const at=i*12;
      w[at]=0;w[at+1]=count;
      // Out along the street from its start at the time given, with no pause.
      f[at+2]=along.m/speed/(2*leg)-(along.at??0)/(2*leg);
      f[at+3]=speed;f[at+4]=side;f[at+5]=0;f[at+6]=0;f[at+7]=indoors;f[at+8]=length;f[at+9]=0;
      w[at+10]=i%LOOKS;w[at+11]=(i>=LOOKS?1:0)|flags;
    });
    const span=people.length;
    const clips=new Uint32Array(28),calendar=new Float32Array(clips.buffer);
    // idle 0+10, walk 10+10, run 20+10, cower 30+5, face 35+6, back 41+6, the same for both.
    for(const m of [0,1])clips.set([0,10,10,10,20,10,30,5,35,6,41,6],m*12);
    clips[24]=span;clips[25]=LOOKS;
    const frame=device.createBuffer({size:512,usage:B.UNIFORM|B.COPY_DST}),frameData=new Float32Array(128);
    // A diagonal "projection" with everything in view, close enough for the nearest detail.
    frameData[0]=frameData[5]=frameData[10]=1/4000;frameData[15]=1;
    frameData[25]=1;frameData[30]=1;frameData[33]=sun;frameData[37]=1000;
    const parts={
      frame,walkers:made(new Uint8Array(walkers),B.STORAGE),route:made(new Float32Array(samples),B.STORAGE),
      bodies:device.createBuffer({size:BUCKETS*span*32,usage:B.STORAGE|B.COPY_SRC}),
      draws:made(new Uint32Array(BUCKETS*5),B.STORAGE),
      crowd:made(clips,B.UNIFORM),shots:device.createBuffer({size:(4+SL*SW)*4,usage:B.UNIFORM|B.COPY_DST}),
      fates:device.createBuffer({size:people.length*TOWN_FATE_WORDS*4,usage:B.STORAGE|B.COPY_SRC}),
    };
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:['frame','walkers','route','bodies','draws','crowd','shots','fates'].map((name,binding)=>({binding,resource:{buffer:parts[name]}}))});
    return {parts,group,frameData,clips,calendar,people:people.length,span};
  };
  // `hours` is the game's date as the pass is told it, and stays as it was last given.
  window.run=async(t,seconds,shots=[],{wantBodies=true,hours}={})=>{
    t.frameData[19]=seconds;device.queue.writeBuffer(t.parts.frame,0,t.frameData);
    device.queue.writeBuffer(t.parts.draws,0,new Uint32Array(BUCKETS*5));
    if(hours!==undefined){t.calendar[26]=hours;device.queue.writeBuffer(t.parts.crowd,0,t.clips);}
    const words=new Uint32Array(4+SL*SW),floats=new Float32Array(words.buffer);
    words[0]=shots.length;
    shots.forEach((s,i)=>floats.set([...s.start,s.strike??0,...s.end,s.blast??0,s.reach??1,s.seed??(i+1)],4+i*SW));
    device.queue.writeBuffer(t.parts.shots,0,words);
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);pass.setBindGroup(0,t.group);pass.dispatchWorkgroups(Math.ceil(t.people/64));pass.end();
    const copy=(buffer)=>{const read=device.createBuffer({size:buffer.size,usage:B.COPY_DST|B.MAP_READ});encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);return read;};
    const fateRead=copy(t.parts.fates),bodyRead=wantBodies?copy(t.parts.bodies):null,drawRead=wantBodies?copy(t.parts.draws):null;
    device.queue.submit([encoder.finish()]);
    const take=async(read)=>{await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();return bytes;};
    const fateBytes=await take(fateRead),fateWords=new Uint32Array(fateBytes),fateFloats=new Float32Array(fateBytes);
    const fates=[];
    for(let i=0;i<t.people;i++){const a=i*TOWN_FATE_WORDS;fates.push({mode:fateWords[a],since:fateFloats[a+1],until:fateFloats[a+2],runFor:fateFloats[a+3],along:fateFloats[a+4],going:fateFloats[a+5],lane:fateFloats[a+6],clock:fateFloats[a+8],how:fateWords[a+11]});}
    const out={fates,bodies:[],shadows:[]};
    if(wantBodies){
      const bytes=await take(bodyRead),draws=new Uint32Array(await take(drawRead)),bw=new Uint32Array(bytes),bf=new Float32Array(bytes);
      // Those drawn, a run for each model at each level of detail, and then a run for each model of who casts a shadow.
      for(let bucket=0;bucket<BUCKETS;bucket++)for(let slot=0;slot<draws[bucket*5+1];slot++){
        const a=(bucket*t.span+slot)*8,who=bw[a+7];
        (bucket<SHADE?out.bodies:out.shadows).push({who,tier:bucket%4,x:bf[a],y:bf[a+1],z:bf[a+2],heading:bf[a+3],frameA:bw[a+4],frameB:bw[a+5],blend:bf[a+6]});
      }
    }
    return out;
  };
  window.townErrors=errors;
}

// `who` in a body is its look, which here is simply the person's index.
const street=(people,more={})=>({people,length:LENGTH,step:STEP,flags:6,side:.8,halfWidth:HALF_WIDTH,speed:WALK_SPEED,indoors:INDOORS,...more});
const strung=at=>Array.from({length:PEOPLE},(_,i)=>({m:(i+.5)*LENGTH/PEOPLE,at}));
const inPage=(fn,arg)=>page.evaluate(fn,arg);

test('with no shots the pass writes nothing and people are where the time alone puts them',async()=>{
  const {stayedZero,positions,errors}=await inPage(async spec=>{
    const t=town(spec);let stayedZero=true,positions=null;
    for(const seconds of [5,20,70,300]){
      const frame=await run(t,seconds);
      stayedZero&&=frame.fates.every(f=>f.mode===0&&f.since===0&&f.clock===0&&f.along===0);
      positions=frame.bodies;
    }
    return {stayedZero,positions,errors:[...townErrors]};
  },street(strung(0)));
  assert.deepEqual(errors,[]);
  assert.ok(stayedZero,'no one has a fate until something happens to them');
  // At 300 s each has gone that far: out, a while at the end of the way, and back.
  const walking=LENGTH/WALK_SPEED,leg=walking+INDOORS;
  assert.equal(positions.length,PEOPLE);
  for(const body of positions){
    const turn=(300+(body.who+.5)*LENGTH/PEOPLE/WALK_SPEED)%(2*leg);
    const expected=turn<leg?Math.min(LENGTH,turn*WALK_SPEED):Math.max(0,LENGTH-(turn-leg)*WALK_SPEED);
    assert.ok(Math.abs(body.x-expected)<.01,`${body.who} is at ${body.x}, and should be at ${expected}`);
    assert.ok(Math.abs(Math.abs(body.z)-HALF_WIDTH*.8)<1e-3,JSON.stringify(body));
  }
});

test('a ball that passes through someone brings them down where they were, and they stay down',async()=>{
  const {people,frames,errors}=await inPage(async spec=>{
    const t=town(spec),frames=[];
    await run(t,10);
    const before=await run(t,11);
    const onStreet=before.bodies.find(b=>b.who===48);
    // Across the street through whoever this is, at knee height.
    const shot={start:[onStreet.x,.8,onStreet.z-30],end:[onStreet.x,.8,onStreet.z+30],strike:.4,reach:0.01};
    frames.push(await run(t,11.02,[shot]));
    const hit=frames[0].fates.map((f,i)=>f.mode===2?i:-1).filter(i=>i>=0);
    for(const seconds of [11.5,12.6,13,40,120,300,599.9])frames.push(await run(t,seconds));
    // The frame clock runs round.
    frames.push(await run(t,.1));frames.push(await run(t,20));
    return {people:{hit,onStreet},frames:frames.map(f=>({fates:f.fates,bodies:f.bodies})),errors:[...townErrors]};
  },street(strung(0)));
  assert.deepEqual(errors,[]);
  assert.equal(people.hit.length,1,`one person is in the way: ${people.hit}`);
  const hit=people.hit[0];
  assert.equal(hit,48);
  const modes=frames.map(f=>f.fates[hit].mode);
  assert.equal(modes[0],TOWN_FALLING);
  assert.equal(modes[1],TOWN_FALLING,'still on the way down half a second later');
  assert.deepEqual(modes.slice(2),modes.slice(2).map(()=>TOWN_DOWN),'down, and never up again');
  const stamps=frames.slice(2).map(f=>f.fates[hit]);
  assert.ok(stamps.every(f=>f.since===stamps[0].since&&f.along===stamps[0].along),'nothing is written once they lie still');
  const findHit=f=>f.bodies.filter(b=>b.who===hit);
  const flying=findHit(frames[1]);
  assert.equal(flying.length,1,'body is in flight while falling');
  assert.ok(flying[0].z>people.onStreet.z+0.5,`thrown forward along the shot path from ${people.onStreet.z} to ${flying[0].z}`);
  assert.ok(Math.floor(flying[0].blend)>0,`damage/injury bits encoded in blend (${flying[0].blend})`);
  const landed=findHit(frames[2])[0];
  assert.ok(landed.z>people.onStreet.z+1.0,`thrown well past where they stood (${landed.z} > ${people.onStreet.z})`);
  const bodyOf=f=>f.bodies.filter(b=>b.who===hit&&Math.hypot(b.x-landed.x,b.z-landed.z)<.05);
  for(const frame of frames.slice(2)){
    const lying=bodyOf(frame);
    assert.equal(lying.length,1,'in the very place they landed after being thrown');
    assert.ok(Math.floor(lying[0].blend)>0,'retains wound/scorch/limb-severance damage while down');
  }
  // The last frame of a fall, whichever way they went, still after the clock has gone round.
  const last=bodyOf(frames.at(-1))[0];
  assert.ok(last.frameA===40||last.frameA===46,`resting at clip frame ${last.frameA}`);
  assert.equal(last.frameA,last.frameB);
  assert.ok(frames[1].fates.filter((_,i)=>i!==hit).every(f=>f.mode===TOWN_ABOUT),'and nobody else');
});

test('a shot too low, too high or stopped short by a wall strikes nobody',async()=>{
  const {hits,errors}=await inPage(async spec=>{
    const t=town(spec),hits=[],first=(await run(t,10)).bodies[0],x=first.x,z=first.z;
    // Over their head; the near half of a line that a wall ended; ending short along the street; then one that connects.
    for(const shot of [
      {start:[x,3,z-30],end:[x,3,z+30],strike:.4,reach:.01},
      {start:[x,1,z-30],end:[x,1,z-2],strike:.4,reach:.01},
      {start:[x-40,1,z],end:[x-5,1,z],strike:.4,reach:.01},
      {start:[x,1.7,z-30],end:[x,1.7,z+30],strike:.4,reach:.01},
    ]){
      const seen=await run(t,10.02,[shot],{wantBodies:false});
      hits.push(seen.fates.filter(f=>f.mode>=2).length);
    }
    return {hits,errors:[...townErrors]};
  },street([{m:100}]));
  assert.deepEqual(errors,[]);
  assert.deepEqual(hits,[0,0,0,1]);
});

test('people near a landing run from it, distance decides who, and everyone settles again without a jump',async()=>{
  const AT=100,REACH=40;
  const {track,errors}=await inPage(async ({spec,AT,REACH})=>{
    const t=town(spec),shot={start:[AT,0,0],end:[AT,0,0],reach:REACH,blast:0,seed:9};
    const track=[await run(t,5,[shot])];
    for(let seconds=5.1;seconds<70;seconds+=.1)track.push(await run(t,seconds));
    return {track:track.map(f=>({fates:f.fates,bodies:f.bodies.map(b=>[b.who,b.x,b.z,b.frameA])})),errors:[...townErrors]};
  },{spec:street(strung(0)),AT,REACH});
  assert.deepEqual(errors,[]);
  const start=track[0].fates;
  // Person i of the string: where they were when it fell.
  const placeOf=i=>(i+.5)*LENGTH/PEOPLE+5*WALK_SPEED;
  const near=[],edge=[],beyond=[];
  start.forEach((f,i)=>{const d=Math.abs(placeOf(i)-AT);(d<REACH*.55?near:d<REACH?edge:d>REACH+.5?beyond:[]).push({f,i,d});});
  assert.ok(near.length>10&&beyond.length>20,`${near.length} near, ${beyond.length} beyond`);
  assert.ok(beyond.every(({f})=>f.mode===TOWN_ABOUT),'nobody beyond its reach does anything');
  assert.ok(near.every(({f})=>f.mode===TOWN_AFRAID),'everybody near reacts');
  const reacted=edge.filter(({f})=>f.mode===TOWN_AFRAID);
  assert.ok(reacted.length>0&&reacted.length<edge.length,`${reacted.length} of ${edge.length} react near the edge`);

  const runners=near.filter(({f})=>f.runFor>0),cowering=near.filter(({f})=>f.how===1);
  assert.ok(runners.length>cowering.length&&cowering.length>0,`${runners.length} run and ${cowering.length} cower`);
  for(const {f,i} of runners)assert.equal(f.going,placeOf(i)>AT?1:-1,`${i}, at ${placeOf(i)}, runs away from it and not at it`);
  assert.ok(start.every(f=>f.mode<=TOWN_AFRAID),'a landing with no blast strikes no one');
  // Closer means further: those nearest run for longer.
  const by=runners.toSorted((a,b)=>a.d-b.d);
  assert.ok(by[0].f.runFor>by.at(-1).f.runFor,'running time falls off with distance');

  // Each body's path: by look and model, the same index the people were given.
  const paths=new Map();
  track.forEach((frame,n)=>{for(const [who,x,z] of frame.bodies){const key=who;(paths.get(key)??paths.set(key,[]).get(key)).push({n,x,z});}});
  let longest=0;
  const fastest=TOWN_RUN_SPEEDS[1]*.1+2*HALF_WIDTH*.8*.2+WALK_SPEED*.1+.01;
  for(const [who,path] of paths){
    for(let k=1;k<path.length;k++){
      // Turning round at the end of a way in the open has always crossed it at a stroke.
      if(path[k].n!==path[k-1].n+1||[path[k].x,path[k-1].x].some(x=>x<=0||x>=LENGTH))continue;
      const step=Math.hypot(path[k].x-path[k-1].x,path[k].z-path[k-1].z);
      longest=Math.max(longest,step);
      assert.ok(step<=fastest,`${who} moved ${step.toFixed(2)} m in a tenth of a second at frame ${path[k].n}`);
    }
    for(const {x,z} of path){
      assert.ok(x>=0&&x<=LENGTH,`${who} off the end of the way at ${x}`);
      assert.ok(Math.abs(z)<=HALF_WIDTH*.8+1e-3,`${who} off the side of the way at ${z}`);
    }
  }
  assert.ok(longest>TOWN_RUN_SPEEDS[0]*.1,'someone ran');
  // Runners really do get further from it, and the clip they use says so.
  const afterThree=track[30];
  for(const {i} of runners){
    const was=paths.get(i).find(p=>p.n===0),now=paths.get(i).find(p=>p.n===30);
    assert.ok(Math.abs(now.x-AT)>Math.abs(was.x-AT)+5,`${i} went from ${was.x} to ${now.x}`);
  }
  assert.ok(afterThree.bodies.some(([,,,frame])=>frame>=20&&frame<30),'running clip in use');
  assert.ok(afterThree.bodies.some(([,,,frame])=>frame>=30&&frame<35),'cowering clip in use');
  // Over it, all of them.
  assert.ok(track.at(-1).fates.every(f=>f.mode===TOWN_ABOUT),'all back about their day within a minute');
  assert.ok(track.at(-1).bodies.every(([,,,frame])=>frame<20),'walking or standing, no one running or cowering');
});

test('fear lasts as long across the turn of the frame clock as at any other time',async()=>{
  const {during,after,errors}=await inPage(async spec=>{
    const t=town(spec),shot={start:[100,0,0],end:[100,0,0],reach:40,seed:5};
    const during=[];
    await run(t,595,[shot]);
    for(const seconds of [596,599,1,5])during.push((await run(t,seconds)).fates.filter(f=>f.mode===1).length);
    for(let seconds=10;seconds<70;seconds+=5)await run(t,seconds);
    const after=(await run(t,70)).fates.filter(f=>f.mode===1).length;
    return {during,after,errors:[...townErrors]};
  },street(strung(0).map(p=>({...p,at:595}))));
  assert.deepEqual(errors,[]);
  assert.ok(during[0]>10,`${during[0]} frightened`);
  assert.ok(during[3]>during[0]*.5,`${during[3]} of them still are, 10 s on, past the turn of the clock`);
  assert.equal(after,0,'and it passes');
});

test('someone who runs to a closed door stays in till it is over, and comes out again',async()=>{
  const {seen,errors}=await inPage(async spec=>{
    const t=town(spec),seen=[];
    await run(t,4);
    // Everyone is near the far end, and it falls behind them.
    seen.push(await run(t,5,[{start:[175,0,0],end:[175,0,0],reach:40,seed:3}]));
    for(const seconds of [8,12,20,30,40,50,60,70,80,90,100])seen.push(await run(t,seconds));
    return {seen:seen.map(f=>({modes:f.fates.map(x=>x.mode),runners:f.fates.map(x=>x.runFor),bodies:f.bodies.map(b=>b.who)})),errors:[...townErrors]};
  },street(Array.from({length:12},(_,i)=>({m:186+i*.5,at:4})),{flags:0}));
  assert.deepEqual(errors,[]);
  const ran=seen[0].runners.map((r,i)=>r>0?i:-1).filter(i=>i>=0);
  assert.ok(ran.length>3,`${ran.length} ran`);
  assert.ok(seen[2].bodies.every(who=>!ran.includes(who)),'through the door and out of sight');
  assert.ok(seen.at(-1).modes.every(mode=>mode===TOWN_ABOUT));
  assert.ok(ran.some(who=>seen.slice(3).some(f=>f.bodies.includes(who))),'out again on their way back');
});

test('those struck lie where they fell at night, when the rest have gone home, and each lies a day by the calendar',async()=>{
  // The frame clock never leaves its ten minutes, as in the game. Only the date the pass is told moves on.
  const seen=await inPage(async spec=>{
    const t=town(spec),lying=frame=>frame.bodies.filter(b=>b.frameA>=35).map(b=>b.who).sort((a,b)=>a-b);
    const through=b=>[{start:[b.x,1,b.z-30],end:[b.x,1,b.z+30],strike:.4,reach:.01}];
    const first=(await run(t,10,[],{hours:100})).bodies[0];
    await run(t,10.02,through(first));
    const byDay=(await run(t,20)).bodies.length;
    t.frameData[33]=-1;
    const byNight=lying(await run(t,30));
    // The frame clock comes round to before the moment he fell, and an hour has gone by.
    const roundTheClock=lying(await run(t,5,[],{hours:101}));
    // Twenty hours after the first, a second falls well away from him.
    const second=(await run(t,40,[],{hours:120})).bodies.find(b=>b.frameA<35&&Math.abs(b.x-first.x)>20);
    await run(t,40.02,through(second));
    const at123=lying(await run(t,50,[],{hours:123}));
    const day=await run(t,60,[],{hours:124.5});
    const at143=lying(await run(t,70,[],{hours:143}));
    const later=await run(t,80,[],{hours:144.5});
    return {first:first.who,second:second.who,byDay,byNight,roundTheClock,at123,at124:lying(day),firstFate:day.fates[first.who],secondFate:day.fates[second.who],at143,at144:lying(later),lastFate:later.fates[second.who],errors:[...townErrors]};
  },street(strung(0)));
  assert.deepEqual(seen.errors,[]);
  assert.equal(seen.byDay,PEOPLE);
  assert.deepEqual(seen.byNight,[seen.first],'one person was struck, and lies there after dark');
  assert.deepEqual(seen.roundTheClock,[seen.first],'the turn of the frame clock raises no one');
  const both=[seen.first,seen.second].sort((a,b)=>a-b);
  assert.deepEqual(seen.at123,both,'a day less an hour after the first fell, both lie there');
  assert.deepEqual(seen.at124,[seen.second],'a day after, the first is gone and the second, who fell later, is not');
  assert.deepEqual({mode:seen.firstFate.mode,since:seen.firstFate.since,clock:seen.firstFate.clock,how:seen.firstFate.how},{mode:TOWN_ABOUT,since:0,clock:0,how:0},'and the first is about again with nothing left of it');
  assert.equal(seen.secondFate.mode,TOWN_DOWN);
  assert.equal(seen.secondFate.clock,120,'each keeps the hour they fell');
  assert.deepEqual(seen.at143,[seen.second]);
  assert.deepEqual(seen.at144,[],'the second lies his own day too');
  assert.equal(seen.lastFate.mode,TOWN_ABOUT);
});

test('everyone drawn casts a shadow, and so does someone just out of sight, who is not drawn',async()=>{
  // The view is forty metres wide here, about the middle of the street.
  const {bodies,shadows,errors}=await inPage(async spec=>{
    const t=town(spec);
    t.frameData[0]=1/20;t.frameData[16]=100;
    return {...await run(t,5),errors:[...townErrors]};
  },street(strung(0)));
  assert.deepEqual(errors,[]);
  const drawn=new Set(bodies.map(b=>b.who)),cast=new Map(shadows.map(b=>[b.who,b]));
  assert.ok(drawn.size>10&&drawn.size<PEOPLE/2,`${drawn.size} drawn`);
  assert.equal(shadows.length,cast.size,'no one casts two');
  for(const body of bodies){
    assert.ok(Math.abs(body.x-100)<20+1.3+.01,`${body.who} at ${body.x} is drawn only if in view`);
    assert.deepEqual({...cast.get(body.who),tier:0},{...body,tier:0},'and casts a shadow from the same place in the same pose');
  }
  const unseen=shadows.filter(b=>!drawn.has(b.who));
  assert.ok(unseen.length>=8,`${unseen.length} cast a shadow from out of sight`);
  for(const body of unseen)assert.ok(Math.abs(body.x-100)>20&&Math.abs(body.x-100)<=38.01,`${body.who} at ${body.x} is beside the view and near it`);
  assert.equal(cast.size,[...Array(PEOPLE).keys()].filter(i=>Math.abs((i+.5)*LENGTH/PEOPLE+5*WALK_SPEED-100)<=38).length,'and no one further off is kept at all');
});

test('the list JavaScript sends says where shot went and nothing about anyone',()=>{
  const log=createTownShots({window:{x:0,z:0,span:400}}),words=new Uint32Array(4+TOWN_SHOT_LIMIT*TOWN_SHOT_WORDS),floats=new Float32Array(words.buffer);
  assert.equal(log.collect(words,floats),0,'nothing flying, nothing sent');
  const ball={velocity:[400,0,0],mass:11,radius:.075};
  // Fixed steps of one frame join up, and a frame's line stops where the ball did.
  log.note([0,5,0],[3,5,0],null,ball);
  log.note([3,5,0],[6,5,0],null,ball);
  assert.equal(log.collect(words,floats),1);
  assert.deepEqual([...floats.subarray(4,7)],[0,5,0]);
  assert.deepEqual([...floats.subarray(8,11)],[6,5,0]);
  assert.ok(floats[7]>.35&&floats[7]<.5,'it strikes those it touches');
  log.note([6,5,0],[9,5,0],{fraction:.5,kind:'terrain'},ball);
  assert.equal(log.collect(words,floats),2,'where it landed, and the last of its line');
  const landing=4,line=4+TOWN_SHOT_WORDS;
  assert.deepEqual([...floats.subarray(landing,landing+3)],[7.5,5,0]);
  assert.deepEqual([...floats.subarray(line+4,line+7)],[7.5,5,0]);
  assert.ok(floats[landing+7]>2&&floats[landing+7]<=5,`blast ${floats[landing+7]}`);
  assert.ok(floats[landing+8]>25&&floats[landing+8]<=60,`reach ${floats[landing+8]}`);
  // Far from the town it is none of the town's business, and a spent ball rolls off.
  log.note([5000,5,0],[5003,5,0],null,ball);
  assert.equal(log.collect(words,floats),0);
  log.note([0,1,0],[1,1,0],null,{velocity:[3,0,0],mass:11,radius:.075});
  assert.equal(log.collect(words,floats),1);
  assert.equal(floats[7],0);
  // More balls than room: the list holds what it can.
  for(let i=0;i<TOWN_SHOT_LIMIT+40;i++)log.note([i,5,0],[i+1,5,0],null,{...ball});
  assert.equal(log.collect(words,floats),TOWN_SHOT_LIMIT);
  // What a hit building lets go comes down in one place, unless nothing is falling.
  const building={x:0,y:0,z:0,damageState:{fracture:{brokenCount:0,flying:new Set(),fracture:{shards:[{localMin:[1,1,1],localMax:[3,3,3]}],toWorld:(x,y,z)=>[x,y,z],groundAt:()=>0}}}};
  log.note([0,1,0],[1,1,0],{fraction:1,kind:'building',building},ball);
  log.collect(words,floats);
  const state=building.damageState.fracture;
  state.brokenCount=9;
  assert.equal(log.collect(words,floats),0,'a saved ruin coming back is not rubble falling');
  state.brokenCount=20;state.flying.add(0);
  assert.equal(log.collect(words,floats),1);
  assert.deepEqual([...floats.subarray(4,7)],[2,0,2]);
  assert.ok(floats[11]>3&&floats[11]<=12,`rubble reaches ${floats[11]}`);
  building.damageState.magazineExploded=true;
  assert.equal(log.collect(words,floats),1);
  assert.ok(floats[12]>100,'a magazine going up reaches a long way');
  assert.equal(log.collect(words,floats),0,'and only goes up once');
});
