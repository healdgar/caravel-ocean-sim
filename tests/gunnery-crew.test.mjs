import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCompany,stepCompany} from '../js/crew.js';
import {crewGunneryTool,crewGunStation} from '../js/crew-work.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {buildGunneryToolVertices} from '../js/gunnery-tools.js';
import {createGunDefinitions,gunMuzzlePose} from '../js/gunnery-models.js';
import {createGunneryState,prepareGunnery,fireGunnery,stepGunnery,gunnerySummary} from '../js/gunnery-state.js';
import {getShipModel} from '../js/ship-models.js';
import {loadCrewGLB} from '../js/gltf.js';
import {modelDeckWidth} from '../js/hull.js';

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
    assert.ok(closest>.50,'human bodies remain separated: '+closest);assert.ok(maxMove<.10,'no station teleport: '+maxMove);
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
