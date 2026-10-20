import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VICTORY_DESIGN as D,VICTORY_SAILS,VICTORY_STANDING_LINES,victorySailPoint} from '../js/models/victory.js';
import {victoryClothPoint,victoryPose,victoryYardPoint} from '../js/victory-motion.js';
import {sailForces,sailingState,advanceSails} from '../js/sailing.js';
import {boatHydrodynamics,stepBoatSurge,boatForwardSpeed} from '../js/boat.js';
import {createFollower,steerFollower} from '../js/follower.js';

const vessel=extra=>({modelId:'victory',propulsion:'sail',heading:0,speed:6,
  length:D.runtime.length,beam:D.runtime.beam,sailFore:1,sailMain:1,sailMizzen:1,...extra});
const windAt=angle=>(angle+90)*Math.PI/180;
function trimmed(boat,wind=10,angle=90,velocity=0){
  let s=sailForces(boat,wind,windAt(angle),velocity);
  s.squareYaw=s.squareTarget;s.lateenYaw=s.lateenTarget;
  for(const p of s.rig)p.fill=1;
  return {...sailForces(boat,wind,windAt(angle),velocity)};
}
function advance(boat,seconds,wind=10,angle=90,dt=1/30,slope=0){
  for(let i=0;i<Math.round(seconds/dt);i++)stepBoatSurge(boat,slope,dt,wind,windAt(angle));
  return boat;
}
test('Victory loading uses its own hull, service manifest and waterline rather than builders tonnage as mass',()=>{
  const hydro=boatHydrodynamics(D.runtime.length,D.runtime.beam,60,0,'victory');
  const little=boatHydrodynamics(20,6,60,0,'nina');
  assert.equal(hydro.crewMass,820*80);
  assert.ok(hydro.mass>little.mass*20);
  assert.ok(Math.abs(hydro.sinkage)<1e-5,'standard manifest floats at the authored service datum');
  assert.ok(Math.abs(hydro.draft-8.8)<1e-5);
  assert.ok(hydro.rollInertia>little.rollInertia*100);
  const loaded=boatHydrodynamics(D.runtime.length,D.runtime.beam,90,40,'victory');
  assert.ok(loaded.mass>hydro.mass&&loaded.sinkage>hydro.sinkage&&loaded.freeboard<hydro.freeboard);
});
test('Victory force geometry contains the actual square and fore-and-aft surfaces, with independent mast controls',()=>{
  const b=vessel(),s=trimmed(b);
  assert.ok(s.geometry.victory);
  assert.equal(s.geometry.surfaces.length,VICTORY_SAILS.length);
  assert.equal(s.geometry.groups.length,3);
  for(const surface of s.geometry.surfaces)assert.equal(surface.sail,VICTORY_SAILS[surface.sail.id-1]);
  const keys=['sailFore','sailMain','sailMizzen'],areas=[];
  for(const key of keys){
    const each=vessel({sailFore:0,sailMain:0,sailMizzen:0,[key]:1}),force=trimmed(each);
    assert.ok(force.area>100&&force.forward>0);areas.push(force.area);
    force.geometry.groups.forEach((panels,i)=>assert.ok(i===keys.indexOf(key)?panels.some(p=>p.area>0):panels.every(p=>p.area===0)));
  }
  assert.ok(Math.abs(areas.reduce((a,b)=>a+b,0)-s.area)<1e-7);
});
test('Victory needs wind and exposed canvas; reefing changes forces and doubled wind gives quadratic pressure',()=>{
  assert.equal(trimmed(vessel(),0).forward,0);
  assert.equal(trimmed(vessel({sailFore:0,sailMain:0,sailMizzen:0})).forward,0);
  const full=trimmed(vessel()),double=trimmed(vessel(),20),reef=trimmed(vessel({sailFore:.5,sailMain:.5,sailMizzen:.5}));
  assert.ok(full.forward>0&&full.area>2000);
  assert.ok(Math.abs(double.forward/full.forward-4)<1e-9);
  assert.ok(reef.area/full.area>.45&&reef.area/full.area<.55);
  assert.ok(reef.forward>0&&reef.forward<full.forward*.7);
  const head=trimmed(vessel(),10,0),run=trimmed(vessel(),10,180);
  assert.ok(head.forward<0,'wind ahead can drive sternway; there is no tacking engine');
  assert.ok(run.forward>full.forward*1.1,'square canvas exposes different incidence on a run');
  const other=trimmed(vessel(),10,-90);
  assert.ok(Math.abs(other.forward-full.forward)/full.forward<.005);
  assert.ok(other.side>0&&full.side<0);
});
test('Victory sails take time to furl, and a sailing speed setting supplies no motor thrust',()=>{
  const b=vessel(),state=sailingState(b);
  b.sailFore=b.sailMain=b.sailMizzen=0;
  advanceSails(b,1,10,windAt(90));
  assert.ok(state.set.every(v=>v>0&&v<1));
  advance(b,6);assert.ok(state.set.every(v=>v===0));
  const noWind=vessel({speed:30});advance(noWind,10,0);
  assert.equal(boatForwardSpeed(noWind),0,'requested manual speed must not propel a wind-driven first-rate');
  // Even a transient tack mismatch must never start the caravel's lateen-yard
  // transfer state machine on square spars, which only brace about their mast.
  const backed=vessel({x:0,z:0,heading:100,surgeVelocity:-.3}),rig=sailingState(backed);
  Object.assign(rig,{apparentAngle:Math.PI/2,apparentSpeed:10,tack:1});rig.rig.forEach(p=>p.side=1);
  const pilot=Object.assign(createFollower(),{recovering:true,recoveryTack:1,tackAge:50});
  steerFollower(pilot,backed,{...backed,x:500,z:0},.1,10,Math.PI/2);
  assert.equal(rig.maneuver,undefined,'square-rig recovery braces yards without a lateen transfer');
});
test('Victory coasts with inertia, responds to wave slope and accelerates less under extra mass',()=>{
  const bare=vessel({sailFore:0,sailMain:0,sailMizzen:0,surgeVelocity:4});
  advance(bare,10,0);assert.ok(bare.surgeVelocity>0&&bare.surgeVelocity<4);
  const uphill=vessel({sailFore:0,sailMain:0,sailMizzen:0,surgeVelocity:2}),downhill={...uphill};
  stepBoatSurge(uphill,.05,.1,0,0);stepBoatSurge(downhill,-.05,.1,0,0);
  assert.ok(uphill.surgeVelocity<2&&downhill.surgeVelocity>2);
  const light=vessel(),heavy=vessel({cargoTonnes:40});trimmed(light);trimmed(heavy);
  stepBoatSurge(light,0,.1,10,windAt(90));stepBoatSurge(heavy,0,.1,10,windAt(90));
  assert.ok(light.surgeVelocity>heavy.surgeVelocity&&heavy.surgeVelocity>0);
});
test('Victory sailing remains finite and consistent across frame rates and a strong-wind turn',()=>{
  const results=[1/10,1/30,1/120].map(dt=>{
    const b=vessel();advance(b,10,10,180,dt);advance(b,5,20,90,dt);return b;
  });
  for(const b of results){
    for(const key of ['surgeVelocity','leewayVelocity','roll','pitch','rollVelocity','pitchVelocity'])assert.ok(Number.isFinite(b[key]),key);
    assert.ok(Math.abs(b.surgeVelocity-results[2].surgeVelocity)<.025);
    assert.ok(Math.abs(b.roll-results[2].roll)<.003);
    assert.ok(Math.abs(b.pitch-results[2].pitch)<.003);
  }
});
test('actual rendered Victory cloth triangles remain separate from standing rigging through tacks and reefing',()=>{
  const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
  function intersects(line,A,B,C){
    for(let k=0;k<3;k++)if(Math.max(A[k],B[k],C[k])<Math.min(line.a[k],line.b[k])||Math.min(A[k],B[k],C[k])>Math.max(line.a[k],line.b[k]))return false;
    const dir=sub(line.b,line.a),e=sub(B,A),f=sub(C,A),p=cross(dir,f),det=dot(e,p);if(Math.abs(det)<1e-10)return false;
    const t=sub(line.a,A),u=dot(t,p)/det;if(u<1e-5||u>1-1e-5)return false;
    const q=cross(t,e),v=dot(dir,q)/det;if(v<1e-5||u+v>1-1e-5)return false;
    const d=dot(f,q)/det;return d>1e-5&&d<1-1e-5;
  }
  let triangles=0;
  for(const set of [1,.5,.08])for(const angle of [-150,-90,-60,0,60,90,150,180])for(const fill of [0,1]){
    const boat=vessel({sailFore:set,sailMain:set,sailMizzen:set}),state=trimmed(boat,10,angle);
    for(const p of state.rig)p.fill=fill;
    for(const s of VICTORY_SAILS){
      const n=s.corners.length===3?15:18,triangular=s.corners.length===3,pose=victoryPose(s,state),cache=new Map();
      function point(i,j){const key=i+','+j;if(!cache.has(key))cache.set(key,victoryClothPoint(s.id,i/n,j/n,pose,1.25,10));return cache.get(key);}
      for(let i=0;i<n;i++)for(let j=0;j<(triangular?n-i:n);j++){
        const faces=triangular?[[point(i,j),point(i+1,j),point(i,j+1)]]:[[point(i,j),point(i+1,j),point(i+1,j+1)],[point(i,j),point(i+1,j+1),point(i,j+1)]];
        if(triangular&&j<n-i-1)faces.push([point(i+1,j),point(i+1,j+1),point(i,j+1)]);
        for(const face of faces){triangles++;for(const line of VICTORY_STANDING_LINES)assert.equal(intersects(line,...face),false,`${s.name} crosses ${line.id}; wind ${angle}, canvas ${set}, fill ${fill}`);}
      }
    }
  }
  assert.ok(triangles>250_000);
});
test('Victory sail heads stay sewn to their yards through bracing, backing and reefing',()=>{
  const scale=[D.runtime.beam/3.6,D.frame.verticalScale,D.frame.verticalScale];
  for(const sail of VICTORY_SAILS)for(const deployed of [0,.2,1])for(const yaw of [-.4,0,.4])for(const pressure of [-1,1])for(let i=0;i<=36;i++){
    const u=i/36,pose={yaw,deployed,fill:1,pressure},cloth=victoryClothPoint(sail.id,u,0,pose,3.2,12),yard=victoryYardPoint(sail.id,victorySailPoint(sail.id,u,0),pose);
    assert.ok(Math.hypot(...cloth.map((p,k)=>(p-yard[k])*scale[k]))<.001,`${sail.name} head at ${u} separates from its yard`);
  }
});
