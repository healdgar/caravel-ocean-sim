import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCompany,stepCompany} from '../js/crew.js';
import {advanceSails,sailingState,sailCanvasTarget} from '../js/sailing.js';
import {crewGunneryTool,crewGunStation,manGunStationsImmediate} from '../js/crew-work.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {buildGunneryToolVertices} from '../js/gunnery-tools.js';
import {createGunDefinitions,gunMuzzlePose} from '../js/gunnery-models.js';
import {createGunneryState,prepareGunnery,fireGunnery,stepGunnery,gunnerySummary} from '../js/gunnery-state.js';
import {getShipModel} from '../js/ship-models.js';
import {loadCrewGLB} from '../js/gltf.js';
import {modelDeckWidth} from '../js/hull.js';
import {crewMotionPolicy} from '../js/crew-motion.js';

function drillFixture(id,side='port'){
  const boat={modelId:id,...getShipModel(id).runtime,roll:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1},company=createCompany(undefined,id);
  stepCompany(company,boat,0,8);boat.gunnery=createGunneryState(createGunDefinitions(boat));boat.gunnerySide=side;prepareGunnery(boat.gunnery,side);
  const environment={muzzle:g=>gunMuzzlePose(g,boat),gunAttended:g=>!g.visibleCrew||boat.gunneryAttendance?.has(g.id)};
  return {boat,company,environment,step(inspect){stepCompany(company,boat,.1,8);inspect?.();return stepGunnery(boat.gunnery,.1,environment);}};
}
const gunneryCrewDistance=(a,b)=>Math.hypot(...Array.from(a,(v,i)=>v-b[i]));

test('both ships walk real gun teams to either battery, complete the drill, then await the captain',()=>{
  for(const id of['nina','victory'])for(const side of['port','starboard']){
    const {boat,company,step}=drillFixture(id,side);let closest=Infinity,maxMove=0;
    assert.equal(boat.gunneryAttendance?.size??0,0);
    for(let i=0;i<2400;i++){
      const previous=company.crew.map(s=>s.position.slice());step();
      for(const[j,s]of company.crew.entries()){
        maxMove=Math.max(maxMove,gunneryCrewDistance(s.position,previous[j]));
        for(let k=0;k<j;k++)closest=Math.min(closest,gunneryCrewDistance(s.position,company.crew[k].position));
      }
    }
    const summary=gunnerySummary(boat.gunnery,side),expected=id==='victory'?4:2;
    assert.equal(summary.ready,summary.total,id+' '+side+' must finish without a route deadlock');
    assert.equal(boat.gunneryAttendance.size,expected);
    assert.equal(company.crew.filter(s=>s.job?.kind==='gunnery').length,expected*2);
    // 40a4ed0 cleared the full-watch deadlock by letting a gun team pass at .38 m.
    assert.ok(closest>.38,'human bodies remain separated: '+closest);
    const pace=crewMotionPolicy(boat,{purpose:'work'}).speedMetresPerSecond;
    assert.ok(pace<=1.75,'work pace has a physical human cap');assert.ok(maxMove<=pace*.1+2e-5,'no station teleport: '+maxMove);
    assert.ok(company.crew.filter(s=>['ines','pedro'].includes(s.id)).every(s=>s.job?.kind!=='gunnery'));
    assert.equal(boat.gunnery.projectiles.length,0,'ready never fires without an explicit order');
    for(const s of company.crew.filter(s=>s.job?.kind==='gunnery')){
      const station=crewGunStation(s.job.gun,s.job.gunRole,boat);
      assert.ok(Math.abs(station[0])+.30/(boat.beam/3.6)<modelDeckWidth(boat,station[2]));
      assert.equal(crewGunneryTool(s,boat),null,'ready workers stand clear, with no rammer in the bore');
    }
    boat.roll=.55;step();assert.equal(boat.gunneryAttendance.size,0,'dangerous roll withdraws attendance');
    boat.roll=0;for(let i=0;i<20;i++)step();assert.equal(boat.gunneryAttendance.size,expected);
    assert.equal(fireGunnery(boat.gunnery,side),summary.total);
    let shots=0;for(let i=0;i<100;i++)shots+=step().filter(e=>e.type==='shot').length;
    assert.equal(shots,summary.total);
  }
});

test('gun loaders reach shared visible bore/chamber tools and stages produce finite bounded geometry',()=>{
  const actors=Object.fromEntries([['male','sailor.glb'],['female','sailor-female.glb']].map(([sex,p])=>[sex,loadCrewGLB(fs.readFileSync(new URL('../assets/crew/'+p,import.meta.url))).animator]));
  for(const id of['nina','victory']){
    const {boat,company,step}=drillFixture(id),seen=new Set();let maximum=0,rendered=0;
    const vertices=new Float32Array(4096*8);
    for(let i=0;i<1500;i++){
      step(()=>{if(i%3)return;
      for(const s of company.crew.filter(s=>s.job?.kind==='gunnery'&&s.job.stage==='working')){
        const tool=crewGunneryTool(s,boat);if(!tool)continue;
        seen.add(s.job.gun.stage+':'+s.job.gunRole);
        const a=actors[s.sex];a.sample('Idle',s.time);poseCrewWork(a,s,boat);assert.ok(a.palette.every(Number.isFinite));
        for(const[name,target]of Object.entries(s.grips??{}))maximum=Math.max(maximum,gunneryCrewDistance(a.world[a.names.indexOf(name)].subarray(12,15),target));
        if(tool.kind==='sponge'||tool.kind==='rammer'){
          const midpoint=tool.a.map((v,j)=>(v+tool.b[j])*.5),pose=gunMuzzlePose(s.job.gun,{...boat,heading:0,pitch:0,roll:0,x:0,z:0,heave:0});
          assert.ok(gunneryCrewDistance(midpoint,pose.position)<.2,'shaft actually intersects the bore');
        }
      }
      const count=buildGunneryToolVertices(company,boat,vertices);rendered=Math.max(rendered,count);
      assert.ok(count<=4096&&count%3===0&&vertices.subarray(0,count*8).every(Number.isFinite));
      });
    }
    assert.ok(rendered>100,'real rammer/chamber and tackle geometry is emitted');
    assert.ok(maximum<.12,id+' actual hand grip error: '+maximum);
    for(const stage of['swab','load','ram','runout','prime'])assert.ok([...seen].some(key=>key.startsWith(stage+':')),stage+' must have an actual work pose');
  }
});

test('an aloft lookout descends before joining the gun drill and crew rendering never gates loading',()=>{
  const {boat,company}=drillFixture('victory');boat.gunnerySide=undefined;
  const lookout=company.crew.find(s=>s.id==='maria');
  // Use the existing job executor to get a real person aloft, not a forced pose.
  company.workTime=15;
  for(let i=0;i<1600&&!(lookout.job?.rung>3);i++)stepCompany(company,boat,.1,8);
  assert.ok(lookout.job?.rung>3);
  const before=lookout.position.slice(),rung=lookout.job.rung;boat.gunnerySide='port';boat.crew=false;
  stepCompany(company,boat,.1,8);
  assert.equal(lookout.job.kind,'lookout');assert.equal(lookout.job.stage,'descending');
  assert.ok(lookout.job.rung<rung&&gunneryCrewDistance(before,lookout.position)<.08,'aloft hand descends continuously');
  for(let i=0;i<2400;i++){stepCompany(company,boat,.1,8);stepGunnery(boat.gunnery,.1,{muzzle:g=>gunMuzzlePose(g,boat),gunAttended:g=>!g.visibleCrew||boat.gunneryAttendance.has(g.id)});}
  assert.equal(gunnerySummary(boat.gunnery,'port').ready,52);
});

const gunHands=company=>company.crew.filter(s=>s.job?.kind==='gunnery'&&!['return','waiting-return'].includes(s.job.stage));
// A manned battery on a working rig: canvas answers the crew as it does in the game.
function mannedBattery(id='nina',expected=2){
  const fixture=drillFixture(id),{boat}=fixture,step=fixture.step;
  boat.heading=0;boat.surgeVelocity=0;boat.leewayVelocity=0;
  fixture.step=inspect=>{advanceSails(boat,.1,8,90);return step(inspect);};
  for(let i=0;i<2400&&gunnerySummary(boat.gunnery,'port').loading;i++)fixture.step();
  assert.equal(boat.gunneryAttendance.size,expected,'the battery is manned before the test changes anything');
  return fixture;
}

test('sail hands leave the guns only for canvas that needs them, then return and the battery recovers',()=>{
  const {boat,company,step}=mannedBattery();
  const atSheet=()=>company.crew.filter(s=>s.job?.kind==='haul'&&s.job.mast===0);
  assert.equal(atSheet().length,0);assert.equal(boat.sailHoldReason??null,null);
  boat.sailFore=.5;let moved=false,noted=false;
  for(let i=0;i<1200&&Math.abs(sailingState(boat).set[0]-sailCanvasTarget(boat,0))>.008;i++){
    step();
    moved||=atSheet().some(s=>s.job.stage==='working');
    noted||=Boolean(boat.sailHoldReason);
  }
  assert.ok(moved,'the fore hand reaches the sheet with the guns still manned');
  assert.ok(noted,'the wait for canvas is explained while the hand is on the way');
  assert.ok(Math.abs(sailingState(boat).set[0]-sailCanvasTarget(boat,0))<.01,'canvas answered the order during gunnery');
  for(let i=0;i<600&&boat.gunneryAttendance.size<2;i++)step();
  assert.equal(boat.gunneryAttendance.size,2,'guns are fully manned once more');
  assert.equal(gunHands(company).length,4);
  for(let i=0;i<20;i++)step();
  assert.equal(boat.sailHoldReason,null,'nothing is held once the canvas settles');
});

test('hands short at the guns because of canvas work are reported as such',()=>{
  const {boat,company,step}=mannedBattery();
  const sailIds=new Set(['beatriz','catarina','duarte','joao','isabel']);
  // Eight able hands still warrant two gun teams, but only three are free of the rig.
  for(const s of company.crew.filter(s=>!['ines','pedro'].includes(s.id)&&!sailIds.has(s.id)).slice(3))s.casualtyState='fallen';
  boat.sailFore=.2;boat.sailMain=.2;boat.sailMizzen=.2;
  let note=null;
  for(let i=0;i<600&&!note;i++){step();note=boat.gunneryCrewNote;}
  assert.ok(company.crew.some(s=>s.job?.kind==='haul'),'canvas work is under way');
  assert.equal(note,'Hands at the sheets · guns wait for crew');
  for(let i=0;i<1200&&Math.abs(sailingState(boat).set[0]-sailCanvasTarget(boat,0))>.008;i++)step();
  for(let i=0;i<600&&boat.gunneryCrewNote;i++)step();
  assert.equal(boat.gunneryCrewNote,null,'the note clears once sail hands are free again');
});

test('canvas carried away by a hit aloft pulls nobody off a loaded gun',()=>{
  const {boat,company,step}=mannedBattery();
  for(let i=0;i<20;i++)step();
  const crewed=new Set(gunHands(company).map(s=>s.id));
  boat.damage={mastIntegrity:{fore:.6,main:1,mizzen:1},mastState:{fore:0,main:0,mizzen:0}};
  for(let i=0;i<40;i++){
    step();
    assert.deepEqual(new Set(gunHands(company).map(s=>s.id)),crewed,'gun teams stay on station');
    assert.equal(boat.gunneryAttendance.size,2);
  }
  assert.ok(Math.abs(sailingState(boat).set[0]-sailCanvasTarget(boat,0))<.01,'the canvas came down by itself');
});

test('a dismounted gun releases its team, which takes the next mounted gun',()=>{
  const {boat,company,step}=mannedBattery('victory',4);
  const portWeather=boat.gunnery.guns.filter(g=>g.weatherDeck&&g.side==='port');
  const lost=portWeather[0],spare=portWeather[4];
  assert.ok(spare,'the quarterdeck has a spare weather gun');assert.equal(spare.visibleCrew,false);
  lost.dismounted=true;step();
  assert.equal(lost.visibleCrew,false);assert.equal(spare.visibleCrew,true,'the fourth team slot moves to a mounted gun');
  prepareGunnery(boat.gunnery,'port');
  for(let i=0;i<1600&&!boat.gunneryAttendance.has(spare.id);i++)step();
  assert.ok(boat.gunneryAttendance.has(spare.id),'the spare gun is physically manned');
  assert.ok(!gunHands(company).some(s=>s.job.gun===lost),'nobody stays at the wreck');
  assert.equal(gunnerySummary(boat.gunnery,'port').dismounted,1);
});

test('a gun no hand can reach goes to unseen crew rather than staying silent',()=>{
  // z=-3 ends inside a fixture, so no route exists. z=60 ends off the deck, so the
  // route exists but its hand never arrives.
  for(const[z,seconds]of[[-3,8],[60,60]]){
    const {boat,company,step}=drillFixture('nina');
    const gun=boat.gunnery.guns.find(g=>g.weatherDeck&&g.side==='port');
    gun.centre=null;gun.muzzleDesign=[gun.muzzleDesign[0],gun.muzzleDesign[1],z];
    for(let i=0;i<seconds*10&&gun.visibleCrew;i++)step();
    assert.equal(gun.visibleCrew,false,'z='+z+' hands the gun over within '+seconds+' s');
    assert.ok(company.gunAbstractCrew.has(gun.id));
    step();
    assert.ok(!gunHands(company).some(s=>s.job.gun===gun),'nobody is left standing at the unreachable gun');
    for(let i=0;i<1600&&gun.stage!=='ready';i++)step();
    assert.equal(gun.stage,'ready','the gun still completes its drill');
    boat.gunnerySide='starboard';step();
    assert.equal(company.gunAbstractCrew.size,0,'changing battery retries the route');
  }
});

test('crew cannot be pulled from the sheets by immediate manning, and their guns wait visibly',()=>{
  const {boat,company,step}=drillFixture('nina');
  boat.heading=0;boat.surgeVelocity=0;boat.leewayVelocity=0;
  boat.sailFore=.2;
  for(let i=0;i<3;i++)step();
  const fore=company.crew.find(s=>s.id==='duarte');
  assert.equal(fore.job?.kind,'haul');
  assert.equal(manGunStationsImmediate(company,boat),true);
  assert.equal(fore.job.kind,'haul','the fore hand stays on the sheet');
  assert.equal(boat.gunneryAttendance.size,2,'other hands fill both guns at once');
  assert.ok(company.crew.filter(s=>s.job?.kind==='gunnery').every(s=>s.id!=='duarte'&&s.id!=='beatriz'));
});
