import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readGLB,gltfAccessor,gltfSlerp,loadCrewGLB} from '../js/gltf.js';
import {createDeckhand,stepDeckhand,createCompany,stepCompany,issueCaptainOrder,CREW_ROSTER} from '../js/crew.js';
import {hullDeck,hullHalfWidth,vesselDeck,HULL_VERTICAL_SCALE,tillerPoint} from '../js/hull.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {selectCrewLOD} from '../js/crew-lod.js';
import {advanceSails,sailingState} from '../js/sailing.js';
import {createShareLink} from '../js/sharing.js';
const bytes=fs.readFileSync(new URL('../assets/crew/sailor.glb',import.meta.url));
const model=loadCrewGLB(bytes);
const boat={length:12,beam:3.6,roll:0,rollVelocity:0};
function positions(palette,mesh=model){
  const f=new Float32Array(mesh.vertices.buffer),u=new Uint16Array(mesh.vertices.buffer),out=new Float32Array(mesh.vertexCount*3);
  for(let i=0;i<mesh.vertexCount;i++)for(let k=0;k<4;k++){
    const b=u[i*30+18+k]*16,w=f[i*15+11+k];
    for(let axis=0;axis<3;axis++)out[i*3+axis]+=w*(palette[b+axis]*f[i*15]+palette[b+4+axis]*f[i*15+1]+palette[b+8+axis]*f[i*15+2]+palette[b+12+axis]);
  }
  return out;
}
test('sailor GLB is self-contained, bounded and has the required clips',()=>{
  assert.ok(bytes.length<1_100_000);assert.equal(model.animator.joints.length,65);
  assert.ok(model.indices.length/3<16000);assert.deepEqual([...model.animator.clips.keys()],['Idle','Walk','Brace']);
  const rest=positions(model.animator.sample(null,0)),f=new Float32Array(model.vertices.buffer);
  for(let i=0;i<model.vertexCount;i++)for(let k=0;k<3;k++)assert.ok(Math.abs(rest[i*3+k]-f[i*15+k])<1e-5,'inverse binds preserve the authored rest geometry');
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
  assert.equal(female.animator.joints.length,65);assert.notEqual(female.vertexCount,model.vertexCount);
  assert.ok(female.indices.length/3<24000);
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
      for(let j=0;j<k;j++)assert.ok(Math.hypot(...Array.from(s.position).map((v,n)=>v-c.crew[j].position[n]))>.50,'bodies remain separated');
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
    const s=c.crew.find(s=>s.role==='Helmsman'),p=tillerPoint(b);
    assert.ok(Math.abs(s.position[0]-p[0])<1e-6);
    assert.ok(Math.abs(s.position[2]+.32-p[2])<1e-6);
    assert.ok(s.position[1]+1.8<vesselDeck(s.z)*HULL_VERTICAL_SCALE);
    a.sample('Idle',s.time);poseCrewWork(a,s,b);
    for(const [side,sign] of [['l',1],['r',-1]]){
      const hand=a.world[a.names.indexOf('hand_'+side)].subarray(12,15);
      const world=Array.from(hand).map((v,i)=>v*s.scale[i]+s.position[i]);
      const target=tillerPoint(b,sign*.09);target[0]+=sign*.035;
      assert.ok(Math.hypot(...world.map((v,i)=>v-target[i]))<.05,'hands reach the actual tiller');
    }
  }
});
test('crew LODs build progressive index tiers over the shared skinned vertex buffer',()=>{
  assert.equal(model.lods?.length,3);
  const [near,mid,far]=model.lods;
  assert.equal(near.id,'near');assert.equal(mid.id,'mid');assert.equal(far.id,'far');
  assert.equal(near.triangles,model.indices.length/3);
  assert.ok(mid.triangles<near.triangles*.5&&mid.triangles>near.triangles*.15,`mid tier triangles: ${mid.triangles}`);
  assert.ok(far.triangles<mid.triangles*.6&&far.triangles>=200,`far tier triangles: ${far.triangles}`);
  for(const tier of model.lods)for(const idx of tier.indices)assert.ok(idx>=0&&idx<model.vertexCount);
  assert.deepEqual(selectCrewLOD({x:0,z:0,enabled:true},{x:200,y:10,z:200}),{mainTier:0,shadowTier:1,distance:0});
  assert.equal(selectCrewLOD({x:0,z:0,enabled:false},{x:10,y:2,z:10}).mainTier,0);
  assert.equal(selectCrewLOD({x:0,z:0,enabled:false},{x:45,y:2,z:0}).mainTier,1);
  assert.equal(selectCrewLOD({x:0,z:0,enabled:false},{x:120,y:2,z:0}).mainTier,2);
});
