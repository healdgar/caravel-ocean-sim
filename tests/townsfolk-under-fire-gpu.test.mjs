// The free camera's cannon, firing on the real Lisbon. People are read back from the GPU here in the test alone.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {TOWN_ABOUT,TOWN_AFRAID,TOWN_DOWN,TOWN_FALLING} from '../js/wgsl/townsfolk.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const instrument=()=>{
  const createBuffer=GPUDevice.prototype.createBuffer;
  window.town={};window.townCreated=[];
  GPUDevice.prototype.createBuffer=function(d){
    const part=/^townsfolk (draws|bodies|fates)$/.exec(d.label||'')?.[1];
    const b=createBuffer.call(this,part?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);
    if(part)town[part]=b;
    if(/^townsfolk /.test(d.label||''))townCreated.push(d.label);
    return b;
  };
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...a){return window.townDevice=await request.apply(this,a);};
  // Every list of shots sent to the GPU, as it is sent.
  window.townShots=[];window.townShotWrites=0;
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,offset,data,...rest){
    if(b.label==='townsfolk shots'){
      townShotWrites++;
      const words=new Uint32Array(data.buffer,data.byteOffset),floats=new Float32Array(data.buffer,data.byteOffset);
      for(let i=0;i<words[0];i++){const a=4+i*12;townShots.push({start:[...floats.subarray(a,a+3)],strike:floats[a+3],end:[...floats.subarray(a+4,a+7)],blast:floats[a+7],reach:floats[a+8]});}
    }
    if(b.label==='townsfolk crowd'&&data.byteLength>=48)window.townClips=[...new Uint32Array(data.buffer,data.byteOffset,12)];
    // The date the pass is told, in hours, moved on by as much as the test asks: whatever clock the game gives it.
    if(b.label==='townsfolk crowd'&&data.byteLength>=112&&window.townHoursOn){
      data=new Uint32Array(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength));
      new Float32Array(data.buffer)[26]+=townHoursOn;
    }
    return write.call(this,b,offset,data,...rest);
  };
  const pull=async buffer=>{
    const read=townDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=townDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);townDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();return bytes;
  };
  window.readFates=async()=>{
    const bytes=await pull(town.fates),w=new Uint32Array(bytes),f=new Float32Array(bytes),fates=[];
    for(let i=0;i<w.length/12;i++){const a=i*12;fates.push({i,mode:w[a],until:f[a+2],runFor:f[a+3],along:f[a+4],going:f[a+5],how:w[a+11]});}
    return fates;
  };
  window.readBodies=async()=>{
    await new Promise(requestAnimationFrame);
    // A run of bodies for each of the draws listed: eight of those drawn, and then those who cast a shadow.
    const span=town.bodies.size/(town.draws.size/20)/32,[bytes,drawBytes]=await Promise.all([pull(town.bodies),pull(town.draws)]),w=new Uint32Array(bytes),f=new Float32Array(bytes),draws=new Uint32Array(drawBytes),out=[];
    for(let b=0;b<8;b++)for(let s=0;s<draws[b*5+1];s++){const a=(b*span+s)*8;out.push({x:f[a],y:f[a+1],z:f[a+2],frame:w[a+4]});}
    return out;
  };
  // Where a person's fate says they were on their way, for reckoning distances without asking the GPU anything more.
  window.placeOnWay=(person,metres)=>{
    const {samples,walkers}=oceanProps.port.streets,words=new Uint32Array(walkers.buffer,walkers.byteOffset,walkers.length);
    const k=words[person*12]+Math.min(Math.round(metres/1.25),words[person*12+1]-1);
    return [samples[k*4],samples[k*4+1],samples[k*4+2]];
  };
  // The cannon as the free camera fires it, from where the test says and at whom the GPU says is there.
  window.fireAtSomeone=async eye=>{
    const bodies=(await readBodies()).filter(b=>b.frame<townClips[4]);
    if(!bodies.length)return null;
    bodies.sort((p,q)=>Math.hypot(p.x-eye[0],p.z-eye[2])-Math.hypot(q.x-eye[0],q.z-eye[2]));
    const b=bodies[Math.floor(Math.random()*Math.min(5,bodies.length))],aim=[b.x-eye[0],b.y+1.8-eye[1],b.z-eye[2]],length=Math.hypot(...aim);
    oceanFreeCannon.update(1/60,{firing:true,eye,forward:aim.map(v=>v/length),wind:[0,0,0]});
    return b;
  };
};
async function open(query,{size=[960,540]}={}){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:size[0],h:size[1],polygons:'fixed',view:'free',prow:'0',sunElev:50,clouds:0,...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:size[0],height:size[1]}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  return {page,errors};
}
// Where the most people's ways run, from the town's own layout.
const busiestStreet=page=>page.evaluate(()=>{
  const {samples,walkers,people}=oceanProps.port.streets,words=new Uint32Array(walkers.buffer,walkers.byteOffset,walkers.length),cells=new Map();
  for(let p=0;p<people;p++)for(let k=0;k<words[p*12+1];k+=4){
    const at=(words[p*12]+k)*4,key=Math.round(samples[at]/8)+','+Math.round(samples[at+2]/8),cell=cells.get(key)??{n:0,x:0,y:0,z:0};
    cell.n++;cell.x+=samples[at];cell.y+=samples[at+1];cell.z+=samples[at+2];cells.set(key,cell);
  }
  const best=[...cells.values()].sort((a,b)=>b.n-a.n)[0];
  return {x:best.x/best.n,y:best.y/best.n,z:best.z/best.n};
});
const viewOf=(spot)=>{
  const eye=[spot.x+22,spot.y+24,spot.z+22],yaw=Math.atan2(spot.x-eye[0],-(spot.z-eye[2]))*180/Math.PI,pitch=Math.atan2(spot.y-eye[1],Math.hypot(22,22))*180/Math.PI;
  return {eye,cam:[...eye,yaw,pitch].join(','),fov:50};
};

let street=null,link=null;
test('a ball among people strikes those it reaches and frightens those near, and they settle, and the struck stay down',{timeout:400000},async()=>{
  let {page,errors}=await open({cam:'5,70,-5760,0,-14'});
  await page.waitForFunction(()=>window.oceanProps?.port?.streets?.people>0,null,{timeout:60000,polling:200});
  street=await busiestStreet(page);
  await page.close();
  const {eye,cam,fov}=viewOf(street);
  ({page,errors}=await open({cam,fov}));
  try{
    await page.waitForFunction(()=>window.town?.bodies&&window.townClips,null,{timeout:60000,polling:200});
    await page.waitForFunction(async()=>(await readBodies()).length>=8,null,{timeout:60000,polling:500});
    // Shot flying far out over the sea is nothing to anyone here. All the time any flew, it used to empty the town.
    const distant=await page.evaluate(async spot=>{
      const before=(await readBodies()).length,eye=[spot.x+3000,60,spot.z];
      for(let round=0;round<11;round++){
        oceanFreeCannon.update(1/60,{firing:true,eye,forward:[.97,.243,0],wind:[0,0,0]});
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      return {before,after:(await readBodies()).length,flying:oceanFreeCannon.state.projectiles.length,writes:townShotWrites};
    },street);
    assert.ok(distant.flying>0,'shot is in the air');
    assert.ok(distant.after>=2&&distant.after>=distant.before*.3,`${distant.after} in view after 11 s of distant fire, from ${distant.before}`);
    assert.equal(distant.writes,0,'and none of it is near enough to tell the people about');
    // Nothing fired, nothing sent, nothing kept.
    const quiet=await page.evaluate(async()=>{const before=townShotWrites;for(let i=0;i<30;i++)await new Promise(requestAnimationFrame);return {writes:townShotWrites-before,fates:await readFates()};});
    assert.equal(quiet.writes,0,'no list while nothing flies');
    assert.ok(quiet.fates.every(f=>f.mode===TOWN_ABOUT));
    const people=quiet.fates.length;

    // Keep firing until someone is down, some run and some cower. A shot may meet a roof on its way, or find an empty stretch.
    let fates=[],struck=[];
    const seenEverything=()=>struck.length&&fates.some(f=>f.mode===TOWN_AFRAID&&f.runFor>0)&&fates.some(f=>f.mode===TOWN_AFRAID&&f.how===1);
    for(let round=0;round<16&&!seenEverything();round++){
      await page.evaluate(eye=>fireAtSomeone(eye),eye);
      await page.waitForTimeout(1100);
      fates=await page.evaluate(()=>readFates());
      struck=fates.filter(f=>f.mode===TOWN_FALLING||f.mode===TOWN_DOWN);
    }
    assert.ok(struck.length>=1,'firing at people brings them down');

    const {shots,placed,during}=await page.evaluate(async afraid=>({shots:townShots,placed:afraid.map(f=>placeOnWay(f.i,f.along)),during:await readBodies()}),fates.filter(f=>f.mode===TOWN_AFRAID));
    const clips=await page.evaluate(()=>townClips),[runFirst,cowerFirst,fallFirst]=[clips[4],clips[6],clips[8]];
    const afraid=fates.filter(f=>f.mode===TOWN_AFRAID);
    assert.ok(afraid.length>=3,`${afraid.length} frightened`);
    assert.ok(afraid.some(f=>f.runFor>0),'some run');
    assert.ok(afraid.some(f=>f.how===1),'some get down where they are');
    assert.ok(during.some(b=>b.frame>=fallFirst),'bodies in view lying or going down');
    assert.ok(during.some(b=>b.frame>=runFirst&&b.frame<cowerFirst)||during.some(b=>b.frame>=cowerFirst&&b.frame<fallFirst),'bodies in view running or crouched');
    // Not the whole town, and no one further from anything that happened than its reach.
    const about=fates.filter(f=>f.mode===TOWN_ABOUT).length;
    assert.ok(about>people*.4,`${about} of ${people} carry on as if nothing has happened`);
    const reachOf=([x,,z])=>Math.min(...shots.map(s=>{
      const dx=s.end[0]-s.start[0],dz=s.end[2]-s.start[2],flat=dx*dx+dz*dz,t=flat>1e-6?Math.max(0,Math.min(1,((x-s.start[0])*dx+(z-s.start[2])*dz)/flat)):0;
      return Math.hypot(s.start[0]+dx*t-x,s.start[2]+dz*t-z)-s.reach;
    }));
    const out=placed.map(reachOf).filter(beyond=>beyond>4);
    assert.deepEqual(out,[],'each who reacted was in reach of what they reacted to, give or take the width of their way');

    // Sampled while it settles: nobody who runs stands in the sea or deep in a building.
    const solid=await page.evaluate(()=>oceanProps.port.instances.filter(i=>!['timber_mole_pier','stone_quay_seawall','stone_arch_bridge','indigenous_palisade_ring','english_triangular_palisade_fort'].includes(i.prefabId)).map(i=>({x:i.x,z:i.z,yaw:i.yaw??0,w:i.width,l:i.length,id:i.prefabId})));
    const inside=({x,z})=>solid.find(i=>{const dx=x-i.x,dz=z-i.z,c=Math.cos(i.yaw),s=Math.sin(i.yaw),lx=dx*c-dz*s,lz=dx*s+dz*c;return Math.abs(lx)<i.w/2-3&&Math.abs(lz)<i.l/2-3;});
    let runnersSeen=0;
    for(let second=0;second<40;second++){
      const bodies=await page.evaluate(()=>readBodies());
      for(const body of bodies.filter(b=>b.frame>=runFirst&&b.frame<cowerFirst)){
        runnersSeen++;
        assert.ok(body.y>.2,`a runner is in the sea at ${JSON.stringify(body)}`);
        const within=inside(body);
        assert.ok(!within,`a runner is inside ${within?.id} at ${JSON.stringify(body)}`);
      }
      await page.waitForTimeout(1000);
    }
    assert.ok(runnersSeen>=2,`saw ${runnersSeen} running`);

    // All over within a minute of the last shot. The struck are as they were, where they were.
    const last=await page.evaluate(async()=>{const writes=townShotWrites;for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);return {fates:await readFates(),bodies:await readBodies(),writes:townShotWrites-writes};});
    assert.equal(last.writes,0,'nothing is sent once nothing flies');
    assert.ok(last.fates.every(f=>f.mode!==TOWN_AFRAID),`still frightened: ${last.fates.filter(f=>f.mode===TOWN_AFRAID).length}`);
    for(const was of struck){
      assert.equal(last.fates[was.i].mode,TOWN_DOWN);
      assert.equal(last.fates[was.i].along,was.along,'they have not moved');
    }
    assert.ok(last.bodies.some(b=>b.frame>=fallFirst),'and still in view');
    assert.ok(last.bodies.some(b=>b.frame<runFirst),'with the rest walking again');

    // Going out of reach of the town and back raises no one. Its people are laid out afresh, with the same record.
    const returned=await page.evaluate(async()=>{
      const terrain=oceanFleet.terrain,ports=Object.getOwnPropertyDescriptor(terrain,'ports'),frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      const watched=oceanProps.port,bodiesBefore=town.bodies;
      Object.defineProperty(terrain,'ports',{configurable:true,get:()=>[]});
      await frames(100);
      const gone=!watched.townsfolkWatch;
      Object.defineProperty(terrain,'ports',ports);
      await frames(100);
      return {gone,back:Boolean(watched.townsfolkWatch),relaid:town.bodies!==bodiesBefore,records:townCreated.filter(label=>label==='townsfolk fates').length,fates:await readFates()};
    });
    assert.ok(returned.gone&&returned.back&&returned.relaid,JSON.stringify({...returned,fates:undefined}));
    assert.equal(returned.records,1,'one record of them, kept');
    for(const was of struck)assert.equal(returned.fates[was.i].mode,TOWN_DOWN,'still down');

    // Coming back a day and an hour later by the calendar, they are gone from where they lay.
    const dayOn=await page.evaluate(async()=>{
      const terrain=oceanFleet.terrain,ports=Object.getOwnPropertyDescriptor(terrain,'ports'),frames=async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
      Object.defineProperty(terrain,'ports',{configurable:true,get:()=>[]});
      await frames(100);
      window.townHoursOn=25;
      Object.defineProperty(terrain,'ports',ports);
      await frames(100);
      return {records:townCreated.filter(label=>label==='townsfolk fates').length,fates:await readFates()};
    });
    assert.equal(dayOn.records,1,'the same record of them');
    for(const was of struck)assert.equal(dayOn.fates[was.i].mode,TOWN_ABOUT,'a day on, no longer lying there');

    // A building hit often enough comes down, and the people get word of it from where it falls.
    const fell=await page.evaluate(async({eye,spot})=>{
      const port=oceanProps.port,target=[...port.instances].filter(i=>!/pier|quay|bridge/.test(i.prefabId)).sort((a,b)=>Math.hypot(a.x-spot.x,a.z-spot.z)-Math.hypot(b.x-spot.x,b.z-spot.z))[0];
      const from=[target.x+(eye[0]-target.x)*.7,eye[1],target.z+(eye[2]-target.z)*.7];
      townShots.length=0;
      for(let round=0;round<40;round++){
        const aim=[target.x-from[0],(target.baseY??target.y??spot.y)+Math.min(4,(target.height??8)*.4)-from[1],target.z-from[2]],n=Math.hypot(...aim);
        oceanFreeCannon.update(1/60,{firing:true,eye:from,forward:aim.map(v=>v/n),wind:[0,0,0]});
        await new Promise(resolve=>setTimeout(resolve,1100));
        if(townShots.some(s=>s.strike===0&&s.blast>=3&&s.reach>=28))return {hits:target.damageState?.hits,broken:target.damageState?.fracture?.brokenCount,shots:townShots.filter(s=>s.strike===0&&s.blast>=3)};
      }
      return {hits:target.damageState?.hits,broken:target.damageState?.fracture?.brokenCount,shots:[]};
    },{eye,spot:street});
    assert.ok(fell.shots.length>=1,`nothing came down in ${JSON.stringify(fell)}`);
    assert.deepEqual(errors,[]);

    link=await page.evaluate(async()=>{const {encodeGameStateParam}=await import('/js/sharing.js');return encodeGameStateParam({v:1,portDamage:oceanFleet.portDamage.forLink(oceanFleet.terrain.port)});});
  }finally{await page.close();}
});

test('after a reload the ruins are there and the people are all on their feet, and it frightens no one',{timeout:300000},async t=>{
  if(!link)return t.skip('needs the shots of the test before it');
  const {cam,fov}=viewOf(street);
  const {page,errors}=await open({cam,fov,state:link});
  try{
    await page.waitForFunction(()=>window.town?.fates&&window.townClips,null,{timeout:60000,polling:200});
    await page.waitForFunction(()=>oceanProps.port?.instances?.some(b=>b.damageState?.fracture?.brokenCount>0),null,{timeout:120000,polling:500});
    await page.waitForTimeout(3000);
    const seen=await page.evaluate(async()=>({fates:await readFates(),shots:townShots.length,hit:oceanProps.port.instances.filter(b=>b.damageState?.hits>0).length,bodies:(await readBodies()).length}));
    assert.ok(seen.hit>=1,'the damage came back');
    assert.ok(seen.fates.every(f=>f.mode===TOWN_ABOUT),'nobody is carried over');
    assert.equal(seen.shots,0,'a ruin coming back is not rubble falling');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('a page with no town has no one to fire on and pays for nothing',{timeout:300000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${base}?w=320&h=240&polygons=fixed&view=free`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
    await page.keyboard.down('f');
    await page.waitForFunction(()=>window.oceanFreeCannon.state.guns[0].roundsFired>=1,null,{timeout:60000,polling:100});
    await page.keyboard.up('f');
    const seen=await page.evaluate(()=>({created:townCreated,writes:townShotWrites}));
    assert.deepEqual(seen.created.filter(label=>label!=='townsfolk ship stand-in'),[],'no buffer for people who are not there');
    assert.equal(seen.writes,0);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
