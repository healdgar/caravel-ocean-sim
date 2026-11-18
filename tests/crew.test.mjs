import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readGLB,gltfAccessor,gltfSlerp,loadCrewGLB} from '../js/gltf.js';
import {
  createDeckhand,stepDeckhand,createCompany,stepCompany,issueCaptainOrder,CREW_ROSTER,
  createIndigenousCrewModels,isCaptainActor,loadGroomPackGLB,attachColonialGroomModel,colonialGroomMask,
  suppressCrownHairUnderHat,packCrewMoistureAndDressU32,unpackCrewMoistureAndDressU32,reconcileColonialGroomAndComp,
  COLONIAL_HAIR_CROPPED,COLONIAL_HAIR_WAVY,COLONIAL_BEARD_POINTED,COLONIAL_BEARD_MARINER,COLONIAL_BEARD_TERCIO,
  COLONIAL_CAPTAIN_BUN,COLONIAL_FEMALE_BUN,COLONIAL_FEMALE_COIF,COLONIAL_FEMALE_WAVY,
} from '../js/crew.js';
import {DRESS_MASK_SCALE} from '../js/indigenous-dress.js';
import {hullDeck,hullHalfWidth,vesselDeck,HULL_VERTICAL_SCALE,tillerPoint} from '../js/hull.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {crewCompanyDistance,crewLensZoom} from '../js/crew-pose-cadence.js';
import {advanceSails,sailingState} from '../js/sailing.js';
import {createShareLink} from '../js/sharing.js';
import {crewHelmStand,crewHelmHands} from '../js/crew-work.js';
import {CREW_JOINT_COUNT,CREW_JOINT_NAMES,CREW_SLOT} from '../js/crew-skeleton.js';
const bytes=fs.readFileSync(new URL('../assets/crew/sailor.glb',import.meta.url));
const model=loadCrewGLB(bytes);
const boat={length:12,beam:3.6,roll:0,rollVelocity:0};
const skinNames=mesh=>mesh.animator.joints.map(node=>mesh.animator.names[node]);
function positions(palette,mesh=model){
  const f=new Float32Array(mesh.vertices.buffer),u=new Uint16Array(mesh.vertices.buffer),out=new Float32Array(mesh.vertexCount*3);
  for(let i=0;i<mesh.vertexCount;i++)for(let k=0;k<4;k++){
    const b=u[i*30+18+k]*16,w=f[i*15+11+k];
    for(let axis=0;axis<3;axis++)out[i*3+axis]+=w*(palette[b+axis]*f[i*15]+palette[b+4+axis]*f[i*15+1]+palette[b+8+axis]*f[i*15+2]+palette[b+12+axis]);
  }
  return out;
}
test('sailor GLB is self-contained, bounded and has the required clips',()=>{
  assert.ok(bytes.length<1_800_000);assert.equal(model.animator.joints.length,CREW_JOINT_COUNT);assert.deepEqual(skinNames(model),CREW_JOINT_NAMES,'the skin is the crew skeleton, in its order');
  assert.ok(model.indices.length/3<28000&&model.indices.length/3>=20000);assert.deepEqual([...model.animator.clips.keys()],['Idle','Walk','Brace']);
  const rest=positions(model.animator.sample(null,0)),f=new Float32Array(model.vertices.buffer);
  for(let i=0;i<model.vertexCount;i++)for(let k=0;k<3;k++)assert.ok(Math.abs(rest[i*3+k]-f[i*15+k])<1e-5,'inverse binds preserve the authored rest geometry');
});
test('the generated bodies say what each point wears, and are drawn whole',()=>{
  const groomPack=loadGroomPackGLB(fs.readFileSync(new URL('../assets/crew/groom-pack.glb',import.meta.url)));
  for(const [body,variant] of [
    [model,'male'],
    [loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url))),'female'],
    [loadCrewGLB(fs.readFileSync(new URL('../assets/crew/soldier-1550.glb',import.meta.url))),'soldier'],
  ]){
    const f=new Float32Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*15),seen=new Set();
    for(let i=0;i<body.vertexCount;i++){
      assert.ok(f[i*15+6]>=0&&f[i*15+6]<2,'red stays clear of the numbers that name optional pieces');
      seen.add(Math.floor(f[i*15+8]*.5));
    }
    assert.deepEqual([...seen].sort(),[0,1,2,3,4],'paint, shirt, trousers, skin and brow hair on bald base body');
    assert.equal(body.lods,undefined,'no ladder of decimated levels: the continuum is the only simplification');

    const groomed=attachColonialGroomModel(body,groomPack,variant);
    assert.ok(groomed.vertexCount>body.vertexCount,`${variant} gains 3D hair/beard geometry`);
    assert.ok(groomed.indices.length>body.indices.length,'and draws every triangle of it');
    assert.equal(groomed.lods,undefined);
  }
});
test('Indigenous men are built on the classic body, whose garments can be re-sculpted',()=>{
  const classic=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-classic.glb',import.meta.url))),female=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));
  const classicFemale=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female-classic.glb',import.meta.url)));
  const male=loadCrewGLB(bytes);male.indigenousBase=classic;female.indigenousBase=classicFemale;
  const [indigenous,indigenousFemale]=createIndigenousCrewModels([male,female]);
  assert.ok(indigenousFemale.vertexCount>classicFemale.vertexCount);
  assert.ok(indigenous.vertexCount>classic.vertexCount,'classic vertices, and its accessories');
  assert.ok(indigenous.indices.length/3===classic.indices.length/3+indigenous.accessoryTriangleCount,'drawn whole, accessories and all');
});
test('retargeted clips remain human-sized, grounded and loop without a jump',()=>{
  for(const [name,clip] of model.animator.clips){
    let minY=Infinity,maxY=-Infinity,motion=0;const first=positions(model.animator.sample(name,0));
    for(let t=0;t<clip.duration;t+=.1){
      const pos=positions(model.animator.sample(name,t));
      for(let i=0;i<pos.length;i++){assert.ok(Number.isFinite(pos[i])&&Math.abs(pos[i])<2.1);motion=Math.max(motion,Math.abs(pos[i]-first[i]));if(i%3===1){minY=Math.min(minY,pos[i]);maxY=Math.max(maxY,pos[i]);}}
    }
    assert.ok(minY>-.03&&minY<.05,`${name}: feet stay near the deck`);
    assert.ok(maxY>(name==='Brace'?.9:1.6)&&maxY<1.9);assert.ok(motion>.003);
    const end=positions(model.animator.sample(name,clip.duration-1e-5));
    for(let i=0;i<first.length;i++)assert.ok(Math.abs(first[i]-end[i])<.001);
  }
  assert.ok(model.animator.sample('Idle',1,'Walk',1,.5).every(Number.isFinite));
  const before=model.animator.palette.slice();model.animator.blend('Brace',1,0);assert.deepEqual(model.animator.palette,before);
  const braced=model.animator.blend('Brace',1,1).slice();assert.deepEqual(braced,model.animator.sample('Brace',1));
});
test('GLB rejects truncation, out-of-bounds accessors and unsupported data',()=>{
  assert.throws(()=>readGLB(bytes.subarray(0,bytes.length-4)),/header/);
  const a=readGLB(bytes);a.json.accessors[0].count=2_000_000;assert.throws(()=>gltfAccessor(a,0),/exceeds/);
  a.json.accessors[0].sparse={count:1};assert.throws(()=>gltfAccessor(a,0),/Unsupported/);
  const q=new Float32Array(4);gltfSlerp(q,[0,0,0,1],[0,0,0,-1],.5);assert.deepEqual(Array.from(q),[0,0,0,1]);
});
test('deck route respects hull clearance, dimensions and render-rate independence',()=>{
  const final=[];
  for(const fps of [30,60,120]){
    const s=createDeckhand();let low=Infinity,high=-Infinity;
    for(let i=0;i<fps*60;i++){
      stepDeckhand(s,boat,1/fps);low=Math.min(low,s.z);high=Math.max(high,s.z);
      assert.ok(s.z>=-2.20001&&s.z<=.10001);assert.ok(Math.abs(s.x)+.32<hullHalfWidth(s.z,hullDeck(s.z)));
      assert.ok(Math.abs(s.position[1]-hullDeck(s.z)*HULL_VERTICAL_SCALE-.028)<1e-6);assert.ok(s.transform.every(Number.isFinite));
    }
    assert.ok(low<-2.19&&high>.09);final.push(s.z);
  }
  assert.ok(Math.max(...final)-Math.min(...final)<.18);
  const resized=createDeckhand();stepDeckhand(resized,{...boat,length:24,beam:7.2},.1);assert.equal(resized.transform[0],Math.fround(.95));
  assert.ok(Math.abs(resized.position[0]+1.9)<1e-6);stepDeckhand(resized,{...boat,beam:1},.1);assert.equal(resized.visible,false);
});
test('orders and rough-weather interruption stop movement; invalid policies fall back locally',()=>{
  const s=createDeckhand(),startZ=s.z;
  // Observe the actual walking phase; a faster sailor may already have reached
  // the endpoint and begun its idle wait at an arbitrary three-second sample.
  for(let i=0;i<60&&s.walk<=.9;i++)stepDeckhand(s,boat,.1);
  assert.ok(s.walk>.9&&Math.abs(s.z-startZ)>.1,'real travel reaches the walking blend before the stop order');s.order='standby';s.decisionIn=0;const z=s.z;
  for(let i=0;i<20;i++)stepDeckhand(s,boat,.1);assert.equal(s.z,z);assert.ok(s.walk<.001);
  s.order='patrol';s.policy=()=> 'teleport';stepDeckhand(s,{...boat,roll:.5},.1);assert.equal(s.intent,'brace');assert.equal(s.z,z);
  for(let i=0;i<20;i++)stepDeckhand(s,{...boat,roll:.5},.1);assert.ok(s.brace>.99);
  for(let i=0;i<30;i++)stepDeckhand(s,boat,.1);assert.equal(s.intent,'patrol');assert.ok(s.brace<.001);
  const url=new URL(createShareLink('https://example.com/',{}, {...boat,crew:false},'boat'));assert.equal(url.searchParams.get('crew'),'0');
});
test('female asset has a distinct mesh, compatible rig and grounded animation',()=>{
  const female=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));
  assert.equal(female.animator.joints.length,CREW_JOINT_COUNT);assert.deepEqual(skinNames(female),CREW_JOINT_NAMES);assert.notEqual(female.vertexCount,model.vertexCount);
  assert.ok(female.indices.length/3<32000&&female.indices.length/3>=22000);
  const rest=positions(female.animator.sample(null,0),female),f=new Float32Array(female.vertices.buffer);
  for(let i=0;i<female.vertexCount;i++)for(let k=0;k<3;k++)assert.ok(Math.abs(rest[i*3+k]-f[i*15+k])<1e-5);
  for(const [name,clip] of female.animator.clips){
    let min=Infinity,max=-Infinity;
    for(let t=0;t<clip.duration;t+=.13){const p=positions(female.animator.sample(name,t),female);for(let i=0;i<p.length;i++){
      assert.ok(Number.isFinite(p[i])&&Math.abs(p[i])<2.1);
      if(i%3===1){min=Math.min(min,p[i]);max=Math.max(max,p[i]);}
    }}
    assert.ok(min>-.05&&min<.08,`${name} feet: ${min}`);assert.ok(max>(name==='Brace'?.85:1.55)&&max<1.95,`${name} height: ${max}`);
  }
});
test('twelve named crew, evenly split, keep separate clear stations on every deck',()=>{
  assert.equal(CREW_ROSTER.length,12);assert.equal(new Set(CREW_ROSTER.map(s=>s.id)).size,12);
  assert.equal(CREW_ROSTER.filter(s=>s.sex==='female').length,6);
  for(const dimensions of [[20,6],[12,3.6],[10.5,3.2],[24,7.2]]){
    const b={...boat,length:dimensions[0],beam:dimensions[1]},company=createCompany();
    for(let i=0;i<600;i++){
      stepCompany(company,b,1/60,2);
      for(const [j,s] of company.crew.entries()){
        assert.ok(s.visible);if(s.role!=='Helmsman')assert.ok(s.z>=s.route[0]-1e-5&&s.z<=s.route[1]+1e-5);
        assert.ok(Math.abs(s.position[1]-(s.role==='Helmsman'?hullDeck(s.z):vesselDeck(s.z))*HULL_VERTICAL_SCALE-.028)<1e-6);
        assert.ok(Math.abs(s.position[0])+.3<hullHalfWidth(s.z,vesselDeck(s.z))*b.beam/3.6);
        // Main deck excludes the companionway, mainmast and hatch grating.
        if(s.z>-3.9&&s.z<2.7){assert.ok(!(s.x>.35&&s.z>1.1));assert.ok(Math.hypot(s.x,s.z+.1)>.55);assert.ok(s.z> -2.3);}
        for(let k=0;k<j;k++){const p=company.crew[k].position;assert.ok(Math.hypot(s.position[0]-p[0],s.position[1]-p[1],s.position[2]-p[2])>.64,`${s.id} overlaps ${company.crew[k].id}`);}
      }
    }
  }
});
test('captain orders change actual sails gradually, can be replaced, and survive hidden crew',()=>{
  const b={...boat,length:20,beam:6,sailFore:1,sailMain:1,sailMizzen:1,propulsion:'manual'},c=createCompany();sailingState(b);stepCompany(c,b,0,8);
  assert.equal(issueCaptainOrder(c,b,'teleport'),false);assert.equal(c.revision,0);
  assert.equal(issueCaptainOrder(c,b,'furl'),true);assert.equal(b.propulsion,'sail');
  advanceSails(b,.1,8,0);stepCompany(c,b,.1,8);assert.equal(sailingState(b).set[0],1,'canvas waits for its crew');assert.ok(c.pending);
  b.crew=false;issueCaptainOrder(c,b,'weather');
  for(let i=0;i<1200;i++){advanceSails(b,.1,8,0);stepCompany(c,b,.1,8);}
  assert.deepEqual(Array.from(sailingState(b).set),[.2,.2,0]);assert.equal(c.pending,false);
  assert.ok(c.crew.every(s=>s.observation.captainOrder==='weather'&&s.observation.orderRevision===c.revision));
  assert.ok(c.crew.every(s=>s.intent==='standby'));stepCompany(c,{...b,roll:.5},.1,8);assert.ok(c.crew.every(s=>s.intent==='brace'));
  issueCaptainOrder(c,b,'full');b.sailFore=.4;stepCompany(c,b,.1,8);assert.equal(c.order,'watch');assert.equal(b.sailFore,.4,'old order must not overwrite manual changes');
});

test('crew climb real runners, operate sails and hatch, hold in danger, and return without teleporting',()=>{
  const b={length:20,beam:6,roll:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1},c=createCompany();
  stepCompany(c,b,0,8);sailingState(b);issueCaptainOrder(c,b,'weather');
  const female=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));
  const a=female.animator;let climbing=0,working=0,gripError=0;
  for(let i=0;i<1200;i++){
    const before=c.crew.map(s=>Array.from(s.position));
    advanceSails(b,.1,8,0);stepCompany(c,b,.1,8);
    for(const [k,s] of c.crew.entries()){
      const travel=Math.hypot(...Array.from(s.position).map((v,j)=>v-before[k][j]));
      assert.ok(travel<.18,`${s.id} must traverse paths continuously: ${travel}`);
      assert.ok(s.transform.every(Number.isFinite));
      if(s.job?.stage==='ascending')climbing++;
      if(s.job?.stage==='working')working++;
      if(s.job?.rung>0 && i%9===0){
        a.sample('Idle',s.time);poseCrewWork(a,s,b);assert.ok(a.palette.every(Number.isFinite));
        for(const [name,target] of Object.entries(s.grips)){
          const p=a.world[a.names.indexOf(name)].subarray(12,15);
          gripError=Math.max(gripError,Math.hypot(...Array.from(p).map((v,j)=>v-target[j])));
        }
        assert.ok(Math.abs(s.position[0])>.52,'climber clears the mast');
      }
      // Half a metre between two bodies, except while one of them has his shoulders round to brush past the other in a
      // tight place: then .38, which is two torsos depth to depth.
      for(let j=0;j<k;j++){
        const o=c.crew[j],apart=Math.hypot(...Array.from(s.position).map((v,n)=>v-o.position[n])),turned=Math.abs(s.shoulderTurn??0)>.02||Math.abs(o.shoulderTurn??0)>.02;
        assert.ok(apart>(turned?.38:.50),`bodies remain separated: ${s.id} and ${o.id} ${apart.toFixed(3)} m apart at step ${i}, shoulders ${turned?'turned':'square'}`);
      }
    }
    if(i===100){const sailor=c.crew.find(s=>s.job?.stage==='ascending'),position=Array.from(sailor.position),rung=sailor.job.rung;
      stepCompany(c,{...b,roll:.6},.1,8);assert.equal(sailor.job.rung,rung);assert.deepEqual(Array.from(sailor.position),position);assert.equal(sailor.intent,'brace');}
  }
  assert.ok(climbing>100&&working>100);assert.ok(gripError<.08,`hands/boots stay at their runner rope: ${gripError}`);
  assert.equal(b.hatchesClosed,1);assert.deepEqual(Array.from(sailingState(b).set),[.2,.2,0]);
  assert.ok(c.crew.every(s=>!s.job),'workers finish and return to stations');
});
test('lookout ascends on watch; superseding orders bring her down; hidden crew keep doing work',()=>{
  const b={length:20,beam:6,crew:false},c=createCompany();
  for(let i=0;i<500;i++)stepCompany(c,b,.1,6);
  const lookout=c.crew.find(s=>s.role==='Lookout');assert.ok(lookout.position[1]>6);
  issueCaptainOrder(c,b,'furl');
  for(let i=0;i<1200;i++){advanceSails(b,.1,6,0);stepCompany(c,b,.1,6);}
  assert.ok(!lookout.job);assert.ok(lookout.position[1]<2);
});


test('helmsman follows the direct tiller below the quarterdeck at full port and starboard',()=>{
  const c=createCompany(),b={length:20,beam:6},a=model.animator;
  for(const rudder of [-35,-10,0,10,35]){
    b.rudder=rudder;stepCompany(c,b,0,0);
    const s=c.crew.find(s=>s.role==='Helmsman'),p=tillerPoint(b),stand=crewHelmStand(b);
    // Beside the handle's end, to port of the bar, and facing forward along it.
    assert.ok(Math.abs(s.position[0]-stand.x)<1e-6);
    assert.ok(Math.abs(s.position[2]-stand.z)<1e-6);
    assert.ok(Math.hypot(s.position[0]-p[0],s.position[2]-p[2])<.5,'stands at the tiller');
    assert.ok(s.position[0]<p[0],'clear of the bar, to port');
    if(Math.abs(rudder)<=10)assert.ok(Math.cos(s.yaw)<-.8,'facing forward, not back at the rudder');
    assert.ok(s.position[1]+1.8<vesselDeck(s.z)*HULL_VERTICAL_SCALE);
    a.sample('Idle',s.time);poseCrewWork(a,s,b);
    const hands=crewHelmHands(b),pivot=[...tillerPoint(b,1.73*20/12)];
    for(const [i,side] of ['l','r'].entries()){
      const hand=a.world[a.names.indexOf('hand_'+side)].subarray(12,15);
      const world=[0,1,2].map(c=>s.transform[c]*hand[0]+s.transform[c+4]*hand[1]+s.transform[c+8]*hand[2]+s.transform[c+12]);
      assert.ok(Math.hypot(...world.map((v,k)=>v-hands[i][k]))<.05,'hands reach their grips');
      // And those grips are on the bar itself: the wrist rides just over it.
      const axis=[pivot[0]-p[0],pivot[2]-p[2]],t=Math.max(0,((world[0]-p[0])*axis[0]+(world[2]-p[2])*axis[1])/(axis[0]**2+axis[1]**2));
      assert.ok(Math.hypot(world[0]-p[0]-axis[0]*t,world[2]-p[2]-axis[1]*t)<.14,'over the tiller in plan');
      assert.ok(Math.abs(world[1]-p[1]-.13)<.06,'just above it');
    }
  }
});
test('a crew file carries no ladder of levels, and a company is seen as far as its nearest person',()=>{
  // No ladder of decimated levels: the continuum is the only simplification, and the only way people are drawn.
  assert.equal(model.lods,undefined);
  for(const idx of model.indices)assert.ok(idx>=0&&idx<model.vertexCount);
  assert.equal(crewCompanyDistance({x:0,z:0,enabled:true},{x:200,y:10,z:200}),0,'aboard, the company is here');
  assert.equal(crewCompanyDistance({x:0,z:0,enabled:false},null),0,'and without a camera');
  assert.ok(Math.abs(crewCompanyDistance({x:0,z:0,enabled:false},{x:45,y:0,z:0})-45)<1e-9);
  const swimmer={visible:true,overboard:{x:40,y:0,z:0,gone:false}};
  assert.ok(Math.abs(crewCompanyDistance({x:0,z:0,enabled:false,crewCompany:{crew:[swimmer]}},{x:45,y:0,z:0})-5)<1e-9,'a man overboard is nearer than his ship');
  assert.ok(Math.abs(crewCompanyDistance({x:0,z:0,enabled:false,crewCompany:{crew:[{...swimmer,overboard:{...swimmer.overboard,gone:true}}]}},{x:45,y:0,z:0})-45)<1e-9,'one out of sight is nobody');
  // A spyglass brings a far crew as near as the ordinary view would at a fifth of the range.
  const lens=12.5*Math.PI/180;
  assert.ok(Math.abs(crewLensZoom({fovY:lens})-Math.tan(29*Math.PI/180)/Math.tan(lens/2))<1e-9);
  assert.equal(crewLensZoom({}),1);
});
test('crew animation mixer, sea-legs balance, 30-joint finger grip, gaze tracking, inertializer, and 11-body XPBD ragdoll operate smoothly',async ()=>{
  const {applyCrewRealism,stepArticulatedRagdoll,poseCrewFingers,resolveLookoutTarget}=await import('../js/crew-physics.js');
  const {crewGunneryTool}=await import('../js/crew-work.js');
  const rollingBoat={length:20,beam:6,roll:0.42,rollVelocity:0.75,pitch:0.08,pitchVelocity:0.25,heaveVelocity:0.6,surgeAcceleration:1.2,lookoutSighting:{kind:'whale',x:45,y:1.2,z:-85}};
  const company=createCompany();
  for(let i=0;i<15;i++)stepCompany(company,rollingBoat,1/30,8);
  const sailor=company.crew.find(s=>s.role!=='Helmsman');
  assert.ok(sailor.phys,'sailor initializes 2nd-order sea-legs physics state');
  assert.ok(Math.abs(sailor.phys.spineLeanX)>0.02||Math.abs(sailor.phys.spineLeanZ)>0.02,'sea-legs pendulum leans spine against ship roll');
  assert.ok(sailor.phys.armSpread>0.1,'lurching roll spreads arms for balance');

  // Verify 30-joint finger curl & spring inertializer across state transitions
  const a=model.animator;
  a.sample('Idle',sailor.time,'Walk',sailor.walkTime,sailor.walk);
  poseCrewWork(a,sailor,rollingBoat);
  applyCrewRealism(a,sailor,rollingBoat,1/60);
  const index2Node=a.nodeIndex('index_02_r');
  const idleFingerQ=a.pose[index2Node].r.slice();

  // Verify crow's nest lookout crouches in basket, grips rim with left hand, raises spyglass with right hand, and tracks whale sighting
  const lookout=company.crew.find(s=>s.role==='Lookout')??sailor;
  a.sample('Idle',lookout.time);
  const standingPelvisY=a.world[a.nodeIndex('pelvis')][13];
  lookout.job={kind:'lookout',mast:0,side:1,stage:'working',rung:12,lookoutAtStation:true,elapsed:1.5};
  lookout.intent='work';
  for(let i=0;i<10;i++)stepCompany(company,rollingBoat,1/30,8);
  a.sample('Idle',lookout.time);
  poseCrewWork(a,lookout,rollingBoat);
  applyCrewRealism(a,lookout,rollingBoat,1/30);
  const crouchedPelvisY=a.world[a.nodeIndex('pelvis')][13];
  assert.ok(crouchedPelvisY<standingPelvisY-0.12,`lookout crouches down inside crow's nest basket (standing=${standingPelvisY.toFixed(2)}, crouched=${crouchedPelvisY.toFixed(2)})`);
  assert.ok(lookout.grips?.hand_l&&lookout.grips?.hand_r,'lookout has basket-rim and spyglass hand grips');
  const spyglassTool=crewGunneryTool(lookout,rollingBoat);
  assert.equal(spyglassTool?.kind,'spyglass','lookout in crow\'s nest emits 3D brass spyglass tool');
  assert.equal(resolveLookoutTarget(lookout,rollingBoat).kind,'whale','lookout tracks active whale sighting');
  lookout.job=null;

  // Transition to hauling job and verify inertializer + cylindrical rope grip curl
  sailor.job={kind:'haul',mast:1,stage:'working',rung:0,elapsed:0.2};
  a.sample('Idle',sailor.time);
  poseCrewWork(a,sailor,rollingBoat);
  // Immediately after transition (dt=0.01), inertializer blends from outgoing pose
  applyCrewRealism(a,sailor,rollingBoat,0.01);
  assert.equal(sailor._mixer.actionKey,'job:haul:working');
  assert.ok(sailor._mixer.transitionAge<sailor._mixer.transitionDuration,'inertializer is actively crossfading transition');

  // After transition settles, verify finger joints curl into cylindrical grip
  for(let i=0;i<20;i++)applyCrewRealism(a,sailor,rollingBoat,0.02);
  poseCrewFingers(a,sailor,0.9,0.9);
  const gripFingerQ=a.pose[index2Node].r.slice();
  const qDiff=Math.hypot(...gripFingerQ.map((v,i)=>v-idleFingerQ[i]));
  assert.ok(qDiff>0.12,`finger joints articulate into grip curl (delta=${qDiff.toFixed(3)})`);

  // Knockdown / fallen casualty triggers 11-body XPBD articulated ragdoll colliding with deck, obstacles & bulwarks
  sailor.job=null;
  sailor.knockdownTimer=1.2;
  sailor.knockbackVx=1.8;
  sailor.knockbackVz=-1.1;
  for(let i=0;i<15;i++)stepCompany(company,rollingBoat,1/30,8);
  assert.ok(sailor.ragdoll?.active,'knocked-down sailor activates 11-body XPBD ragdoll');
  assert.equal(sailor.ragdoll.pos.length,33,'ragdoll simulates 11 3D articulated particles');
  for(let i=0;i<11;i++){
    assert.ok(Number.isFinite(sailor.ragdoll.pos[i*3])&&Number.isFinite(sailor.ragdoll.pos[i*3+1]),`ragdoll body ${i} is finite`);
  }
  a.sample('Idle',sailor.time);
  poseCrewWork(a,sailor,rollingBoat);
  applyCrewRealism(a,sailor,rollingBoat,1/30);
  assert.ok(a.palette.every(Number.isFinite),'ragdoll-posed crew-skeleton skinning palette is finite');
});

test('crew and soldiers working at mast halyard falls and hatches always face their work with forward arms and elbows',async ()=>{
  const {applyCrewRealism}=await import('../js/crew-physics.js');
  const {requirePlayableShipModel}=await import('../js/ship-models.js');
  const a=model.animator;
  for(const id of ['nina','pinta','santa-maria','victory']){
    const m=requirePlayableShipModel(id);
    const b={modelId:id,...m.runtime,roll:0,pitch:0,rudder:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1,crew:true,propulsion:'sail'};
    const c=createCompany(undefined,id);
    sailingState(b);
    stepCompany(c,b,0,8);
    assert.equal(issueCaptainOrder(c,b,'weather'),true);
    const checkedHaul=new Set();
    let checkedHatch=false;
    for(let tick=0;tick<1500;tick++){
      advanceSails(b,.1,8,0);
      stepCompany(c,b,.1,8);
      for(const s of c.crew){
        if(s.job?.stage==='working'&&s.job.elapsed>0.25&&(s.job.kind==='haul'||s.job.kind==='hatch')){
          a.sample('Idle',s.time);
          poseCrewWork(a,s,b);
          applyCrewRealism(a,s,b,1/30);
          const shL=a.world[a.nodeIndex('upperarm_l')].subarray(12,15);
          const shR=a.world[a.nodeIndex('upperarm_r')].subarray(12,15);
          const elL=a.world[a.nodeIndex('lowerarm_l')].subarray(12,15);
          const elR=a.world[a.nodeIndex('lowerarm_r')].subarray(12,15);
          const haL=a.world[a.nodeIndex('hand_l')].subarray(12,15);
          const haR=a.world[a.nodeIndex('hand_r')].subarray(12,15);
          assert.ok(s.grips?.hand_l?.[2]>0.08&&s.grips?.hand_r?.[2]>0.08,`${id} ${s.id} (${s.job.kind}) grips must be in front of chest: L=${s.grips?.hand_l?.[2]} R=${s.grips?.hand_r?.[2]}`);
          assert.ok(haL[2]>0.08&&haR[2]>0.08&&haL[2]>shL[2]+0.12&&haR[2]>shR[2]+0.12,`${id} ${s.id} (${s.job.kind}) posed hands must be in front of torso: L=${haL[2]} R=${haR[2]}`);
          assert.ok(elL[2]>shL[2]+0.05&&elR[2]>shR[2]+0.05,`${id} ${s.id} (${s.job.kind}) elbows must stay in front of shoulders: L=${elL[2]} (sh=${shL[2]}) R=${elR[2]} (sh=${shR[2]})`);
          if(s.job.kind==='haul')checkedHaul.add(s.job.mast);
          if(s.job.kind==='hatch')checkedHatch=true;
        }
      }
      if(checkedHaul.size===3&&checkedHatch)break;
    }
    assert.deepEqual([...checkedHaul].sort(),[0,1,2],`${id} verified forward arm IK on all three mast halyards`);
    assert.ok(checkedHatch,`${id} verified forward arm IK on hatch work`);
  }
});



test('sailors far from the eye keep a pose longer',async()=>{
  const {crewPoseInterval,fortPoseStride,crewApparentDistance}=await import('../js/crew-pose-cadence.js');
  assert.equal(crewPoseInterval(5),1,'anyone close is posed every frame');
  assert.ok(crewPoseInterval(60)>crewPoseInterval(20));
  assert.equal(fortPoseStride(10),1,'a garrison close by is sampled every frame');
  assert.ok(fortPoseStride(200)>fortPoseStride(50)&&fortPoseStride(50)>1);
  assert.equal(crewApparentDistance([1,1,1],{x:0,z:0},null),0,'without a camera everyone counts as close');
  const boat={x:100,z:0,heading:0,heave:0};
  assert.ok(Math.abs(crewApparentDistance([0,0,0],boat,{x:100,y:0,z:30})-30)<1e-9);
  assert.ok(Math.abs(crewApparentDistance([0,0,30],boat,{x:100,y:0,z:30}))<1e-9,'her local z runs aft along world z at heading zero');
  assert.ok(crewApparentDistance([0,0,0],boat,{x:100,y:0,z:30,fovY:.1})<30/3,'a narrow lens brings them closer');
});

test('no sailor is drawn by a shader that cuts fragments',async()=>{
  const cadence=await import('../js/crew-pose-cadence.js');
  assert.equal(cadence.crewNeedsCutShader,undefined,'people are drawn opaque through the one continuum');
});

test('far sailors pose from baked clips unless their own pose still matters',async()=>{
  const {crewClipOnly}=await import('../js/crew-pose-cadence.js');
  assert.equal(crewClipOnly(49,{}),false);
  assert.equal(crewClipOnly(50,{}),true);
  assert.equal(crewClipOnly(90,{seatedPose:{}}),false);
  assert.equal(crewClipOnly(90,{pendingWounds:[{}]}),false);
  assert.equal(crewClipOnly(90,{pendingWounds:[]}),true);
  assert.equal(crewClipOnly(90,{knockdownTimer:.5}),false);
  assert.equal(crewClipOnly(90,{casualtyState:'fallen'}),false);
  // Wounds he carries are in his own pose only: a baked clip would give him his arm back.
  assert.equal(crewClipOnly(90,{crewInjuries:[{kind:'severed',bone:'lowerarm_l'}]}),false);
  assert.equal(crewClipOnly(90,{stuckArrows:[{}]}),false);
  assert.equal(crewClipOnly(90,{crewInjuries:null,stuckArrows:[]}),true);
});

test('a body that has come to rest is solved twice more and then left until it is disturbed',async()=>{
  const {crewPoseDue,crewPoseSolved,crewBodyAtRest}=await import('../js/crew-pose-cadence.js');
  const body={casualtyState:'fallen',visible:true,poseAge:9,ragdoll:{active:true,settled:false}};
  assert.equal(crewPoseDue(body,false,false,3),true,'still tumbling');
  crewPoseSolved(body);
  body.ragdoll.settled=true;
  assert.equal(crewBodyAtRest(body),true);
  for(let i=0;i<2;i++){assert.equal(crewPoseDue(body,false,false,3),true);crewPoseSolved(body);}
  assert.equal(crewPoseDue(body,false,false,3),false,'both shown poses are now the resting one');
  assert.equal(crewPoseDue(body,false,true,1),true,'a new wound still shows at once');
  body.ragdoll.settled=false;
  assert.equal(crewPoseDue(body,false,false,3),true,'and so does whatever woke it');
  crewPoseSolved(body);
  assert.equal(body.posedAtRest,0);
  // Standing hands, and anyone posed by clips, are untouched by any of this.
  assert.equal(crewPoseDue({visible:true,poseAge:3},false,false,3),true);
  assert.equal(crewPoseDue({visible:true,poseAge:2},false,false,3),false);
  assert.equal(crewPoseDue({visible:false,poseAge:9},false,false,3),false);
  assert.equal(crewPoseDue({visible:true,poseAge:9},true,true,1),false);
});

test('a garrison is solved on its stride, except what has just changed or is still falling',async()=>{
  const {fortPoseDue,crewPoseSolved}=await import('../js/crew-pose-cadence.js');
  const sentry={_poseReady:false,walk:1};
  assert.equal(fortPoseDue(sentry,false,false,false),false,'a walking sentry waits for the stride');
  assert.equal(fortPoseDue(sentry,true,false,false),true);
  assert.equal(fortPoseDue(sentry,false,false,true),true,'the frame he sets off is solved at once');
  assert.equal(fortPoseDue(sentry,false,true,false),true,'and so is everyone at a new port');
  assert.equal(fortPoseDue({pendingWounds:[{}]},false,false,false),true);
  assert.equal(fortPoseDue({casualtyState:'fallen',ragdoll:{active:true,settled:false}},false,false,false),true,'a body still tumbling is solved every frame');
  assert.equal(fortPoseDue({knockdownTimer:.4},false,false,false),true);
  assert.equal(fortPoseDue({garrisonFall:{to:0,speed:1}},false,false,false),true);
  const body={casualtyState:'fallen',ragdoll:{active:true,settled:true}};
  assert.equal(fortPoseDue(body,true,false,false),true,'once as it lies');
  crewPoseSolved(body);
  assert.equal(fortPoseDue(body,true,false,false),false,'and then not again, stride or no');
  assert.equal(fortPoseDue(body,false,true,false),true,'until its slot is another port\'s');
});

test('only the captain\'s painted body looks its texture up, and only where it is drawn',async()=>{
  const {CREW_RENDER,crewRenderWGSL,CREW_CLOTH_SHEEN}=await import('../js/wgsl/crew.js');
  const entry=CREW_RENDER.slice(CREW_RENDER.indexOf('fn crewFS'));
  assert.doesNotMatch(CREW_RENDER,/textureSampleBias\(captainTex/,'no lookup that every sailor\'s fragment pays for');
  assert.match(entry,/if\(v\.color\.b<-1\.0\)\{base=textureSampleGrad\(captainTex,/,'the lookup sits behind the painted-vertex test');
  assert.ok(entry.indexOf('dpdx(')<entry.indexOf('if(v.color.b<-1.0)'),'and its footprint is measured before the branch, where derivatives are defined');
  // The cloth's sheen is the one term a hull lacks, and it can be taken away to compare the rest.
  assert.ok(CREW_CLOTH_SHEEN>0&&CREW_CLOTH_SHEEN<.1);
  assert.notEqual(crewRenderWGSL(0),CREW_RENDER);
  assert.equal(crewRenderWGSL(CREW_CLOTH_SHEEN),CREW_RENDER);
});

test('a captain\'s body is told from a hand\'s, and a woman in it keeps its face and loses its beard',async()=>{
  const {crewBodyKind}=await import('../js/crew.js');
  const {CREW_SKIN,CREW_RENDER}=await import('../js/wgsl/crew.js');
  // A body of its batch's own sex is a hand; the captain rides in the batch of his or her sex on another mesh.
  assert.deepEqual([crewBodyKind({sex:'male'},true),crewBodyKind({sex:'female'},true),crewBodyKind({sex:'male'},false),crewBodyKind({sex:'female'},false)],[0,1,0,2]);
  assert.match(CREW_SKIN,/crewMorph\(v\.position,v\.normal,actor\.face,select\(0\.0,1\.0,actor\.skin\.w>\.5&&actor\.skin\.w<1\.5\)\)/,'only a woman\'s own body takes the woman\'s face');
  // The captain's own colours come from the actor the vertex stage already reads: nothing more is uploaded for them.
  const entry=CREW_RENDER.slice(CREW_RENDER.indexOf('fn crewFS'));
  assert.match(entry,/let own=actors\[v\.actor\];base=captainOwnColours\(base,v\.bodyPos,v\.skin,own\.skin,own\.hair\.rgb,own\.shirt\.rgb\);/);
  assert.ok(entry.indexOf('captainOwnColours(')>entry.indexOf('if(v.color.b<-1.0)'),'and only the painted body pays for them');
});

test('baked clips store every frame in order and wrap time without a jump',async()=>{
  const {bakeCrewClips,crewClipFrame}=await import('../js/crew-clip-pose.js');
  const joints=CREW_JOINT_COUNT*16,sampled=[];
  const animator={
    clips:new Map([['Idle',{duration:2}],['Walk',{duration:1}]]),
    palette:new Float32Array(joints),
    sample(name,seconds){sampled.push([name,seconds]);this.palette.fill((name==='Walk'?100:0)+seconds);},
  };
  const {palettes,clips}=bakeCrewClips(animator,10);
  assert.deepEqual(clips.map(({name,frames,first})=>[name,frames,first]),[['Idle',20,0],['Walk',10,20]]);
  assert.equal(palettes.length,30*joints);
  assert.equal(sampled.length,30);
  assert.ok(Math.abs(palettes[5*joints]-.5)<1e-6,'Idle frame 5 is half a second in');
  assert.ok(Math.abs(palettes[(20+3)*joints+7]-100.3)<1e-3,'Walk frame 3 follows Idle');
  assert.equal(crewClipFrame(clips[1],0),0);
  assert.ok(Math.abs(crewClipFrame(clips[1],.25)-2.5)<1e-9);
  assert.ok(Math.abs(crewClipFrame(clips[1],1.25)-2.5)<1e-9,'a clip repeats');
  assert.ok(Math.abs(crewClipFrame(clips[1],-.25)-7.5)<1e-9,'time before the start wraps backwards');
  assert.ok(crewClipFrame(clips[0],1.9999)<clips[0].frames);
});

test('a whole man in the water is posed from a baked loop, and only one with a wound to show is solved for',async()=>{
  const {crewAfloatClip,crewBakedPose,crewPoseDue}=await import('../js/crew-pose-cadence.js');
  const swimmer={casualtyState:'fallen',overboard:{inWater:true,alive:true},posedOnce:true,poseAge:99,visible:true};
  assert.equal(crewAfloatClip(swimmer),'Swim');
  assert.equal(crewBakedPose(3,swimmer),'Swim','however near he is');
  assert.equal(crewPoseDue(swimmer,Boolean(crewBakedPose(3,swimmer)),false,1),false,'so nothing is solved for him');
  assert.equal(crewAfloatClip({...swimmer,overboard:{inWater:true,alive:false}}),'Float','a drowned man floats');
  assert.equal(crewAfloatClip({...swimmer,overboard:{inWater:false,alive:true}}),null,'in the air he is still a falling body');
  assert.equal(crewAfloatClip({...swimmer,overboard:{inWater:true,alive:false,gone:true}}),null,'and one out of sight is nobody');
  assert.equal(crewAfloatClip({...swimmer,crewInjuries:[{kind:'severed',bone:'hand_l'}]}),null,'a lost hand is in his own pose');
  assert.equal(crewAfloatClip({...swimmer,stuckArrows:[{}]}),null);
  assert.equal(crewAfloatClip({...swimmer,pendingWounds:[{}]}),null,'a hit shows at once');
  assert.equal(crewBakedPose(80,{casualtyState:'able'}),'walk');
  assert.equal(crewBakedPose(10,{casualtyState:'able'}),null);
});

test('the swimming and floating loops are the pose a swimmer is solved with, baked, and each closes on itself',async()=>{
  const {bakeCrewClips,crewClipFrame,CREW_SOLVED_LOOPS,CREW_CLIP_MODES}=await import('../js/crew-clip-pose.js');
  const {crewAfloatSeconds,CREW_AFLOAT_RATE}=await import('../js/crew-pose.js');
  const a=model.animator,J=CREW_JOINT_COUNT*16;
  const {palettes,clips}=bakeCrewClips(a,30,CREW_SOLVED_LOOPS);
  // The order the shader's layout reads them in.
  assert.deepEqual(clips.map(c=>c.name),['Idle','Walk','Swim','Float']);
  assert.deepEqual([CREW_CLIP_MODES.Swim,CREW_CLIP_MODES.Float],[2,3]);
  assert.equal(palettes.length,clips.reduce((n,c)=>n+c.frames,0)*J);
  // Where a palette puts a joint: the palette maps the bind pose, so it is applied to the joint's place at rest.
  a.sample(null,0);
  const rest=new Map(['pelvis','head','hand_l','hand_r','foot_l','foot_r','calf_r'].map(name=>[name,[...a.world[a.nodeIndex(name)].slice(12,15)]]));
  const place=(palette,name)=>{const at=a.joints.indexOf(a.nodeIndex(name))*16,[x,y,z]=rest.get(name);
    return [0,1,2].map(k=>palette[at+k]*x+palette[at+4+k]*y+palette[at+8+k]*z+palette[at+12+k]);};
  const far=(p,q)=>Math.hypot(...p.map((v,i)=>v-q[i]));
  for(const clip of clips.slice(2)){
    const loop=CREW_SOLVED_LOOPS.find(l=>l.name===clip.name),frame=f=>palettes.slice((clip.first+f)*J,(clip.first+f+1)*J);
    assert.ok(clip.frames>=20&&clip.frames<=80,`${clip.name} is a few dozen frames, not thousands: ${clip.frames}`);
    loop.pose(a,loop.duration);const end=a.palette.slice(),first=frame(0);
    let worst=0;for(let i=0;i<J;i++)worst=Math.max(worst,Math.abs(end[i]-first[i]));
    assert.ok(worst<1e-4,`${clip.name} ends where it began: ${worst}`);
    // Between one frame and the next, around the join as anywhere, a hand moves a few centimetres at most.
    let step=0;for(let f=0;f<clip.frames;f++)step=Math.max(step,far(place(frame(f),'hand_l'),place(frame((f+1)%clip.frames),'hand_l')));
    assert.ok(step<0.09,`${clip.name} has no jump in it: ${step}`);
  }
  // What a wounded swimmer is solved with, at the instant of one baked frame, is that frame.
  const swim=clips[2],at=11,seconds=at/swim.frames*swim.duration,crewIndex=4;
  const s={casualtyState:'fallen',overboard:{inWater:true,alive:true},crewIndex,time:seconds-crewIndex*1.37/CREW_AFLOAT_RATE,position:[0,0,0],scale:[1,1,1],yaw:0};
  assert.ok(Math.abs(crewAfloatSeconds(s)-seconds)<1e-9);
  assert.ok(Math.abs(crewClipFrame(swim,crewAfloatSeconds(s))-at)<1e-6);
  a.sample('Idle',0);poseCrewWork(a,s,boat);const solved=a.palette.slice(),baked=palettes.slice((swim.first+at)*J,(swim.first+at+1)*J);
  for(const name of ['pelvis','head','hand_l','hand_r','foot_l','foot_r','calf_r'])assert.ok(far(place(solved,name),place(baked,name))<1e-4,`${name} is where the solved pose has it`);
  // And he moves: a stroke is not a statue.
  assert.ok(far(place(palettes.slice(swim.first*J,(swim.first+1)*J),'hand_l'),place(palettes.slice((swim.first+Math.round(swim.frames/4))*J,(swim.first+Math.round(swim.frames/4)+1)*J),'hand_l'))>0.08);
});

test('captain GLB carries its embedded high-resolution texture, UV sentinels, crew-skeleton rig and decimated LODs',async()=>{
  const {loadGroomPackGLB,attachColonialGroomModel}=await import('../js/crew.js');
  const captainBytes=fs.readFileSync(new URL('../assets/crew/captain.glb',import.meta.url));
  assert.ok(captainBytes.length<3_000_000);
  const captain=loadCrewGLB(captainBytes);
  assert.equal(captain.animator.joints.length,CREW_JOINT_COUNT);assert.deepEqual(skinNames(captain),CREW_JOINT_NAMES);
  assert.deepEqual([...captain.animator.clips.keys()],['Idle','Walk','Brace']);
  assert.ok(captain.image instanceof Uint8Array && captain.image.byteLength>100_000,'embedded texture bytes present');
  assert.equal(captain.mime,'image/jpeg');
  assert.equal(captain.image[0],0xff);assert.equal(captain.image[1],0xd8,'valid JPEG header');
  assert.ok(captain.indices.length/3<=19500&&captain.indices.length/3>=18000,'base mesh preserves un-decimated high-res geometry');
  assert.equal(captain.lods,undefined,'the continuum is its only simplification');
  const f=new Float32Array(captain.vertices.buffer,captain.vertices.byteOffset,captain.vertexCount*15);
  let skinVerts=0,clothVerts=0,uvSeamCrossTris=0;
  for(let i=0;i<captain.vertexCount;i++){
    const u=f[i*15+6],v=f[i*15+7],b=f[i*15+8];
    assert.ok(u>=0&&u<=1&&v>=0&&v<=1,'UV stored in color.rg');
    assert.ok(b<-1.0,'negative blue sentinel routes fragment shader to captain texture');
    if(b<-10.5)skinVerts++;else clothVerts++;
  }
  const idx0=captain.indices;
  for(let t=0;t<idx0.length;t+=3){
    const a=idx0[t],b=idx0[t+1],c=idx0[t+2];
    const dAB=Math.hypot(f[a*15+6]-f[b*15+6],f[a*15+7]-f[b*15+7]);
    const dBC=Math.hypot(f[b*15+6]-f[c*15+6],f[b*15+7]-f[c*15+7]);
    const dCA=Math.hypot(f[c*15+6]-f[a*15+6],f[c*15+7]-f[a*15+7]);
    if(Math.max(dAB,dBC,dCA)>0.08)uvSeamCrossTris++;
  }
  assert.equal(uvSeamCrossTris,0,'zero cross-island UV seam triangles on the captain mesh');
  assert.ok(skinVerts>500&&clothVerts>5000,'both skin and garment vertices tagged on textured captain');
  const company=createCompany();
  assert.equal(company.crew.filter(isCaptainActor).length,1,'exactly one captain in company');
  assert.equal(company.crew.find(isCaptainActor).role,'Captain');

  // Verify 3D beards align flush on philtrum/jaw and transfer smooth neck_01 skin weights across sailor, captain & soldier
  const groomPack=loadGroomPackGLB(fs.readFileSync(new URL('../assets/crew/groom-pack.glb',import.meta.url)));
  const soldier=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/soldier-1550.glb',import.meta.url)));
  for(const [label,baseBody,variant,expectedPhilZ] of [['sailor',model,'male',0.094],['captain',captain,'captain',0.082],['soldier',soldier,'soldier',0.113]]){
    const baseN=baseBody.vertexCount;
    const groomed=attachColonialGroomModel(baseBody,groomPack,variant);
    const gf=new Float32Array(groomed.vertices.buffer,groomed.vertices.byteOffset,groomed.vertexCount*15);
    const gu=new Uint16Array(groomed.vertices.buffer,groomed.vertices.byteOffset,groomed.vertexCount*30);
    for(const [pieceNum,pieceName] of [[8,'pointed'],[9,'mariner'],[10,'tercio']]){
      if(variant==='captain'&&pieceNum===10)continue;
      let moustMaxZ=-9,moustMinY=9,moustMaxY=-9,neckWeightSum=0,cnt=0;
      for(let i=baseN;i<groomed.vertexCount;i++){
        if(Math.floor(gf[i*15+6]*0.5)!==pieceNum)continue;
        cnt++;
        if(gu[i*30+19]>0)neckWeightSum+=gf[i*15+12];
        const x=gf[i*15],y=gf[i*15+1],z=gf[i*15+2];
        if(Math.abs(x)<0.018&&y>1.564){
          moustMaxZ=Math.max(moustMaxZ,z);
          moustMinY=Math.min(moustMinY,y);
          moustMaxY=Math.max(moustMaxY,y);
        }
      }
      assert.ok(cnt>=650,`${label} ${pieceName} preserves high-res sculpted beard (${cnt} verts)`);
      assert.ok(moustMinY>=1.565&&moustMaxY<=1.602,`${label} ${pieceName} moustache sits cleanly on philtrum (${moustMinY.toFixed(3)}..${moustMaxY.toFixed(3)})`);
      assert.ok(moustMaxZ>=expectedPhilZ+0.006&&moustMaxZ<=expectedPhilZ+0.018,`${label} ${pieceName} moustache depth flush to lips (${moustMaxZ.toFixed(4)} vs ${expectedPhilZ})`);
      assert.ok(neckWeightSum/cnt>=0.08,`${label} ${pieceName} transfers smooth jaw/neck skin weights (${(neckWeightSum/cnt).toFixed(3)})`);
    }
  }
});

test('regenerated 1550 male, female and soldier rigs keep anatomical leg ratios, compact hands, level gaze and bald scalps',()=>{
  const female=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));
  const soldier=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/soldier-1550.glb',import.meta.url)));
  const jointPos=(anim,name)=>{const m=anim.world[anim.nodeIndex(name)];return [m[12],m[13],m[14]];};
  const dist=(p,q)=>Math.hypot(p[0]-q[0],p[1]-q[1],p[2]-q[2]);

  for(const [label,body,crownMinY] of [['male',model,1.60],['female',female,1.54],['soldier-1550',soldier,1.60]]){
    const a=body.animator;
    a.sample(null,0);
    const thighL=dist(jointPos(a,'thigh_l'),jointPos(a,'calf_l'));
    const calfL=dist(jointPos(a,'calf_l'),jointPos(a,'foot_l'));
    const ratio=thighL/calfL;
    assert.ok(ratio>0.94&&ratio<1.15,`${label} anatomical leg ratio (${ratio.toFixed(3)})`);
    const handChain=dist(jointPos(a,'hand_l'),jointPos(a,'middle_01_l'))+
      dist(jointPos(a,'middle_01_l'),jointPos(a,'middle_02_l'))+
      dist(jointPos(a,'middle_02_l'),jointPos(a,'middle_03_l'));
    assert.ok(handChain<0.22,`${label} hand chain: ${handChain.toFixed(3)} m`);
    const f=new Float32Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*15);
    const u=new Uint32Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*15);
    for(const clip of ['Idle','Walk']){
      a.sample(clip,0);
      let noseY=0,noseZ=-9,occY=0,occZ=9;
      for(let i=0;i<body.vertexCount;i++){
        const o=i*15;if(f[o+1]<crownMinY-0.12)continue;
        const j0=u[o+9]&255,M=a.palette.subarray(j0*16,j0*16+16);
        const y=M[1]*f[o]+M[5]*f[o+1]+M[9]*f[o+2]+M[13],z=M[2]*f[o]+M[6]*f[o+1]+M[10]*f[o+2]+M[14];
        if(z>noseZ){noseZ=z;noseY=y;}
        if(z<occZ&&f[o+1]>crownMinY-0.06){occZ=z;occY=y;}
      }
      assert.ok(Math.abs(noseY-occY)<0.12,`${label} ${clip} level head pitch (${(noseY-occY).toFixed(3)} m)`);
    }
  }

  for(const [label,body,crownMinY,minSkin,maxHalfX] of [['male',model,1.60,100,0.106],['female',female,1.54,100,0.106],['soldier-1550',soldier,1.60,45,0.112]]){
    const f=new Float32Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*15);
    let crownSkin=0,browHair=0,maxHeadHalfX=0;
    for(let i=0;i<body.vertexCount;i++){
      const x=f[i*15],y=f[i*15+1],z=f[i*15+2],slot=Math.floor(f[i*15+8]*0.5);
      if(y>crownMinY){
        maxHeadHalfX=Math.max(maxHeadHalfX,Math.abs(x));
        if(slot===3&&z<0.04)crownSkin++;
      }
      if(slot===4){
        browHair++;
        assert.ok(z>0.02&&y>1.46,`${label} base HAIR vertices are front eyebrows only, no tricorn wings or ponytail (${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)})`);
      }
    }
    assert.ok(crownSkin>=minSkin,`${label} bald scalp dome has ${crownSkin} SKIN vertices`);
    assert.ok(browHair>=1&&browHair<=220,`${label} preserves ${browHair} eyebrow HAIR vertices`);
    assert.ok(maxHeadHalfX<maxHalfX,`${label} bald head width free of tricorn hair wings: ${maxHeadHalfX.toFixed(3)} m`);
  }
});

test('1550 colonial groom pack covers sailors, captains, soldiers and villagers with bit-exact float32 masks',()=>{
  const groomPack=loadGroomPackGLB(fs.readFileSync(new URL('../assets/crew/groom-pack.glb',import.meta.url)));
  assert.deepEqual(Object.keys(groomPack.pieces).sort(),[
    'beard_1550_full_mariner','beard_1550_pointed','beard_1550_tercio_strap',
    'hair_1550_coif_cap','hair_1550_cropped','hair_1550_female_bun','hair_1550_wavy',
    'hair_algonquian_roach','hair_indigenous_long','hair_indigenous_plaits',
  ]);
  for(const [name,piece] of Object.entries(groomPack.pieces)){
    assert.ok(piece.nearIndices.length>=3&&piece.nearIndices.length%3===0,`${name} has its whole mesh`);
    for(const i of piece.nearIndices)assert.ok(i<piece.vertexCount,`${name} indexes its own vertices`);
    assert.equal(piece.midIndices,undefined,`${name} carries no tier ladder`);
  }

  const maleLooks=Array.from({length:64},(_,i)=>colonialGroomMask('male',i));
  const soldierLooks=Array.from({length:64},(_,i)=>colonialGroomMask('male',i,{isSoldier:true}));
  const femaleLooks=Array.from({length:64},(_,i)=>colonialGroomMask('female',i));
  const captainLooks=Array.from({length:16},(_,i)=>colonialGroomMask('male',i,{isCaptain:true}));

  const hairBits=COLONIAL_HAIR_CROPPED|COLONIAL_HAIR_WAVY;
  const beardBits=COLONIAL_BEARD_POINTED|COLONIAL_BEARD_MARINER|COLONIAL_BEARD_TERCIO;
  assert.ok(maleLooks.some(m=>m===0),'includes bald clean-shaven men');
  assert.ok(maleLooks.some(m=>(m&hairBits)===0&&(m&beardBits)!==0),'includes bald bearded men');
  assert.ok(maleLooks.some(m=>(m&COLONIAL_HAIR_CROPPED)!==0&&(m&COLONIAL_BEARD_MARINER)!==0),'includes cropped hair + mariner beard');
  assert.ok(maleLooks.some(m=>(m&COLONIAL_HAIR_WAVY)!==0&&(m&COLONIAL_BEARD_POINTED)!==0),'includes wavy hair + pointed 1550 beard');
  assert.ok(soldierLooks.some(m=>(m&COLONIAL_BEARD_TERCIO)!==0),'includes tercio strap beard on soldiers');
  assert.ok(femaleLooks.some(m=>(m&COLONIAL_FEMALE_COIF)!==0),'includes 1550 linen coif bonnet on women');
  assert.ok(femaleLooks.some(m=>(m&COLONIAL_FEMALE_BUN)!==0),'includes 1550 braided bun on women');
  assert.ok(femaleLooks.some(m=>(m&COLONIAL_FEMALE_WAVY)!==0),'includes wavy hair on women');
  assert.ok(captainLooks.every(m=>(m&beardBits)!==0),'captains wear 1550 facial hair');
  assert.ok(captainLooks.some(m=>(m&COLONIAL_CAPTAIN_BUN)!==0)||captainLooks.some(m=>(m&hairBits)!==0));
  assert.equal(suppressCrownHairUnderHat(COLONIAL_HAIR_WAVY|COLONIAL_BEARD_POINTED,2,'male'),COLONIAL_BEARD_POINTED,'male hat suppresses crown hair while preserving pointed beard');
  assert.equal(suppressCrownHairUnderHat(COLONIAL_FEMALE_WAVY,1,'female'),0,'female hat suppresses loose crown hair');

  for(const mask of new Set([...maleLooks,...soldierLooks,...femaleLooks,...captainLooks,1,3,31,262143])){
    for(const crewOffset of [0,42,1599,9722,15347]){
      const alignOffset=crewOffset&~31;
      for(const crewIdx of [0,5,11,120]){
        const localBase=(crewOffset-alignOffset)+crewIdx*4;
        const u32=new Uint32Array([packCrewMoistureAndDressU32(localBase,mask)]);
        const f32=new Float32Array(u32.buffer);
        assert.ok(Number.isFinite(f32[0])&&f32[0]<-1.0,`finite negative float for localBase=${localBase}, mask=${mask}`);
        const got=unpackCrewMoistureAndDressU32(new Uint32Array(f32.buffer)[0]);
        assert.equal(got.localMoistureBase,localBase);
        assert.equal(got.dress,mask,`exact 18-bit dress preserved at crewOffset=${crewOffset}`);
      }
    }
  }
});

test('modular 3D character components pack 15-bit masks losslessly in f32, keep shadow LODs compact and use zero discard',async()=>{
  const {
    attachCrewComponents,
    packCrewCompMask,
    unpackCrewCompMask,
    packCrewFaceW,
    crewComponentMaskForActor,
    townComponentMaskForLook,
  }=await import('../js/crew-components.js');
  const {CREW_WGSL}=await import('../js/wgsl/crew.js');
  const {CREW_CONTINUUM_MATERIAL}=await import('../js/wgsl/crew-continuum.js');
  const {INLAND_WATER_WGSL}=await import('../js/wgsl/inland-water.js');
  const {HERD_CONTINUUM_MATERIAL_SPEC}=await import('../js/wgsl/herds.js');
  const {continuumModuleWGSL}=await import('../js/wgsl/continuum-cut.js');
  const HERDS_VIEW=continuumModuleWGSL({pass:'view',material:HERD_CONTINUUM_MATERIAL_SPEC});
  // Every person (the crew, the townsfolk, garrisons and deck hands) is drawn through the one continuum's view of the
  // crew's material.
  const PEOPLE_VIEW=continuumModuleWGSL({pass:'view',material:CREW_CONTINUUM_MATERIAL});

  for(const [name,src] of [['crew',CREW_WGSL],['people',PEOPLE_VIEW],['inland-water',INLAND_WATER_WGSL],['herds',HERDS_VIEW]]){
    assert.equal(/\bdiscard\b/.test(src),false,`${name} opaque WGSL contains zero discard`);
  }

  // Exhaustive spot-check + full bitfield round-trip in IEEE-754 Float32.
  const f32=new Float32Array(1);
  for(const mask of [1,7,63,511,4095,16383,21845,32767]){
    for(const eyeOpen of [0.78,0.91,1.04]){
      f32[0]=packCrewFaceW(eyeOpen,mask,false);
      const raw=-f32[0];
      const decodedMask=Math.floor(raw*0.5)>>>0;
      const decodedEye=raw-decodedMask*2.0;
      assert.equal(decodedMask,mask,`f32 exact mask ${mask}`);
      assert.ok(Math.abs(decodedEye-eyeOpen)<0.01,`f32 eyeOpen preserved (${decodedEye} vs ${eyeOpen})`);
    }
  }
  assert.ok(packCrewFaceW(0.92,12345,true)>2.5,'Indigenous actors keep positive >1.5 sentinel untouched');
  const spec={hair:4,hat:3,beard:2,garment:4,build:3,accent:2};
  assert.deepEqual(unpackCrewCompMask(packCrewCompMask(spec)),spec);

  const maleCopy=loadCrewGLB(bytes);
  const femaleCopy=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));
  attachCrewComponents(maleCopy,'male');
  attachCrewComponents(femaleCopy,'female');
  assert.ok(maleCopy.vertexCount>maleCopy.baseVertexCount+2000);
  assert.ok(femaleCopy.vertexCount>femaleCopy.baseVertexCount+1900);
  assert.ok(maleCopy.indices.length/3>maleCopy.baseTriangleCount+3500);
  assert.equal(maleCopy.lods,undefined);
  // Every component rides joints of the crew skeleton that the body itself is skinned to: hips, spine, neck, head and legs.
  const componentJoints=new Set(['pelvis','spine_01','spine_02','spine_03','neck_01','head','thigh_l','calf_l','thigh_r','calf_r'].map(name=>CREW_SLOT[name]));
  for(const body of [maleCopy,femaleCopy]){
    const f=new Float32Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*15),u=new Uint16Array(body.vertices.buffer,body.vertices.byteOffset,body.vertexCount*30);
    const strays=[];
    for(let v=body.baseVertexCount;v<body.vertexCount;v++)for(let k=0;k<4;k++)if(f[v*15+11+k]>0&&!componentJoints.has(u[v*30+18+k]))strays.push([v,u[v*30+18+k]]);
    assert.deepEqual(strays,[],'component vertices ride only the hips, spine, neck, head and legs');
  }

  // Component variety & anatomical constraints across named crew, garrison, and townsfolk.
  const company=createCompany();
  const seenCrewMasks=new Set();
  for(const [idx,s] of company.crew.entries()){
    if(isCaptainActor(s))continue;
    const m=crewComponentMaskForActor(s,idx);
    seenCrewMasks.add(m);
    const u=unpackCrewCompMask(m);
    if(s.sex==='female')assert.equal(u.beard,0,`female sailor ${s.id} has zero facial hair`);
    const groomHairBits=s.sex==='female'
      ?(COLONIAL_FEMALE_BUN|COLONIAL_FEMALE_COIF|COLONIAL_FEMALE_WAVY)
      :(COLONIAL_HAIR_CROPPED|COLONIAL_HAIR_WAVY|COLONIAL_CAPTAIN_BUN);
    const hasGroomHair=(s.dress&groomHairBits)!==0;
    const hat=(s.compMask>>>3)&7;
    assert.equal(s.compMask&7,0,`${s.id} avoids legacy blob hair over 3D base head`);
    assert.equal((s.compMask>>>8)&7,0,`${s.id} avoids legacy torso vest/apron clipping`);
    if(s.id!=='duarte'&&s.id!=='afonso'&&hat===0&&(idx%7!==3)){
      assert.equal(hasGroomHair,true,`${s.id} wears sculpted 3D groom-pack hair`);
    }
  }
  assert.ok(seenCrewMasks.size>=10,`distinct named crew component masks: ${seenCrewMasks.size}`);
  let morions=0,saiaSkirts=0;
  for(let i=0;i<40;i++){
    if(unpackCrewCompMask(crewComponentMaskForActor({id:`watch-${i}`,sex:'male',garrison:true},i,{garrison:true})).hat===4)morions++;
    const femTown=unpackCrewCompMask(townComponentMaskForLook(1,i));
    assert.equal(femTown.beard,0);
    if(femTown.garment===3)saiaSkirts++;
  }
  assert.ok(morions>=12,`garrison soldiers wear morions (${morions}/40)`);
  assert.ok(saiaSkirts>=10,`female townsfolk wear pleated saia overskirts (${saiaSkirts}/40)`);
});
