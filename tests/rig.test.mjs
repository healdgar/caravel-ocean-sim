import assert from 'node:assert/strict';
import {test} from 'node:test';
import {advanceSails,sailingState,sailForces} from '../js/sailing.js';
import {SAIL_PLAN,requestYardTransfer,lateenYardPoint,lateenClothPoint,lateenRopePoint,runningRiggingLines} from '../js/lateen.js';
import {standingRiggingLines,standingRopePoint} from '../js/rigging.js';
import {createCompany,stepCompany,issueCaptainOrder} from '../js/crew.js';
import {segmentTriangleDistance,segmentDistance,rigClearance} from '../scripts/rig-clearance.mjs';
import {vesselDeck,deckHalfWidth} from '../js/hull.js';
const boat=()=>({length:20,beam:6,heading:0,sailFore:1,sailMain:1,sailMizzen:1});

test('clearance checks detect physical penetration, parallel proximity and fully separated ropes',()=>{
  const tri=[[0,0,0],[2,0,0],[0,2,0]];
  assert.equal(segmentTriangleDistance(...tri,[.5,.5,-1],[.5,.5,1]),0);
  assert.equal(segmentTriangleDistance(...tri,[.2,.2,.04],[.7,.2,.04]),.04);
  assert.ok(segmentTriangleDistance(...tri,[3,3,0],[4,4,0])>2);
  assert.equal(segmentDistance([0,0,0],[1,0,0],[.5,-1,0],[.5,1,0]),0);
  const lines=[{a:[.2,.2,.01],b:[.7,.2,.01],r:.02,name:'rope',kind:'shroud',mast:1}];
  assert.ok(Object.keys(rigClearance([{points:tri,mast:0}],lines).failures).length,'surface clearance includes rope thickness');
});

test('lateen transfer gathers first, preserves yard length, passes outside the mast and sets each yard independently',()=>{
  const b=boat();advanceSails(b,.1,8,0);const s=sailingState(b);
  for(let i=0;i<80;i++)advanceSails(b,.1,8,0);
  const original=s.rig[0].side;
  for(let i=0;i<4;i++)advanceSails(b,.1,8,Math.PI);
  assert.equal(s.maneuver,undefined,'brief wind shifts do not trigger a transfer');
  for(let i=0;i<10;i++)advanceSails(b,.1,8,0);
  b.crewRigRate=[0,0,0];for(let i=0;i<80;i++)advanceSails(b,.1,8,Math.PI);
  assert.equal(s.maneuver,undefined,'even sustained reversal does not transfer yards automatically');
  assert.ok(requestYardTransfer(s));assert.equal(requestYardTransfer(s),false,'do not restart a transfer');
  assert.equal(s.maneuver.stage,'gather');assert.ok(s.rig.every(p=>p.dip===0&&p.side===original));
  b.crewRigRate=[1,1,1];const stages=new Set(),transferred=new Set();let previous=s.rig.map((p,i)=>lateenYardPoint(i,SAIL_PLAN[i].pivot,p));
  for(let j=0;j<1000&&s.maneuver;j++){
    advanceSails(b,.1,8,Math.PI);sailForces(b,8,Math.PI,0);
    stages.add(s.maneuver?.stage??'done');
    assert.ok(s.rig.filter(p=>p.dip>0).length<=1,'yards are handled separately');
    if(s.rig.some(p=>p.dip>0))assert.ok(s.rig.every(p=>p.deployed===0),'no yard passes through deployed neighbouring sails');
    for(let i=0;i<3;i++){
      const p=s.rig[i],plan=SAIL_PLAN[i],a=lateenYardPoint(i,plan.corners[0],p),c=lateenYardPoint(i,plan.corners[1],p);
      assert.ok(Math.abs(Math.hypot(...a.map((v,k)=>v-c[k]))-Math.hypot(...plan.corners[0].map((v,k)=>v-plan.corners[1][k])))<1e-10);
      const centre=lateenYardPoint(i,plan.pivot,p);assert.ok(Math.hypot(centre[0],centre[2]-plan.pivot[2])>.33);
      assert.ok(Math.hypot(...centre.map((v,k)=>v-previous[i][k]))<.05,'yard handling stays continuous');previous[i]=centre;
      for(let k=0;k<=24;k++){
        const point=a.map((v,n)=>v+(c[n]-v)*k/24);
        if(Math.abs(point[0])<deckHalfWidth(point[2]))assert.ok(point[1]-.07>vesselDeck(point[2]),'yard clears the raised quarterdeck');
      }
      const halyard=runningRiggingLines().find(l=>l.kind==='halyard'&&l.mast===i);
      assert.ok(lateenYardPoint(i,halyard.b,p)[1]<halyard.a[1],'sling stays below its supporting masthead block');
      if(p.side===-original)transferred.add(i);
    }
  }
  assert.equal(s.maneuver,null);assert.equal(transferred.size,3);
  assert.ok(['align','raise','pass','lower','sheet','set','done'].every(stage=>stages.has(stage)));
  assert.ok(s.rig.every(p=>p.deployed===1&&p.dip===0&&p.side===-original));
});

test('working sheets swap sides while deck leads stay fixed and leeward runners ease',()=>{
  const b=boat(),s=sailingState(b),running=runningRiggingLines(),standing=standingRiggingLines();
  for(const side of [-1,1]){
    s.rig.forEach(p=>Object.assign(p,{side,opening:.6,fill:1,deployed:1}));
    for(const line of running.filter(l=>l.kind==='sheet')){
      assert.deepEqual(lateenRopePoint(line,1,s.rig),line.b);
      assert.deepEqual(lateenRopePoint(line,0,s.rig),lateenClothPoint(line.mast,0,1,s.rig[line.mast]));
    }
    for(const line of standing.filter(l=>l.kind==='runner')){
      const point=standingRopePoint(line,.5,s.rig[line.mast]),taut=line.a.map((v,i)=>(v+line.b[i])*.5);
      if(line.side===side)assert.ok(Math.abs(point[0])<Math.abs(taut[0])*.5);
      else assert.ok(Math.hypot(...point.map((v,i)=>v-taut[i]))<1e-12);
    }
  }
});

test('deck hands execute an ordered yard transfer and finish without abandoning captain orders',()=>{
  const b=boat(),c=createCompany();
  for(let i=0;i<100;i++){advanceSails(b,.1,8,0);stepCompany(c,b,.1,8);}
  advanceSails(b,.1,8,Math.PI);assert.ok(issueCaptainOrder(c,b,'transfer'));
  let handled=false;
  for(let i=0;i<2400;i++){
    advanceSails(b,.1,8,Math.PI);stepCompany(c,b,.1,8);
    const s=sailingState(b);
    if(!handled&&s.maneuver?.stage==='pass'){handled=true;issueCaptainOrder(c,b,'reduced');}
    if(s.rig.some(p=>p.dip>0))assert.ok(c.crew.every(person=>!(person.job?.rung>0)),'runners are not eased under a climber');
  }
  assert.ok(handled);assert.equal(b.sailState.maneuver,null);assert.ok(b.sailState.rig.every(p=>p.side===-1&&p.deployed===.5));
  assert.equal(c.pending,false);assert.ok(c.crew.every(s=>!s.job));
});

// Rapid sign changes near headwind used to repeatedly gather and move yards.
test('routine tacks and oscillating in irons retain yards and exposed canvas',()=>{
  const b=boat();advanceSails(b,.1,8,0);const s=sailingState(b),side=s.rig.map(p=>p.side);
  for(let i=0;i<1200;i++){
    const wind=i<600?Math.PI:Math.PI/2+.02*Math.sin(i*.12);
    advanceSails(b,.1,8,wind);sailForces(b,8,wind,0);
    assert.equal(s.maneuver,undefined);assert.deepEqual(s.rig.map(p=>p.side),side);
    assert.ok(s.rig.every(p=>p.deployed===1&&p.dip===0));
    if(i===500)assert.ok(s.rig.every(p=>p.pressure<-.99),'bad tack reverses canvas loading without moving the yards');
    if(i>600)assert.equal(requestYardTransfer(s),false,'transfer unavailable in irons');
  }
});
