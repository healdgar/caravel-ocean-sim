import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSailGeometry,updateSailGeometry,sailCoefficients,sailPanelForce} from '../js/sail-aerodynamics.js';
import {createLateenPoses,lateenClothPoint} from '../js/lateen.js';
import {sailForces,sailingState,advanceSails,windAtHeight} from '../js/sailing.js';
import {boatHydrodynamics} from '../js/boat.js';
import {HULL_VERTICAL_SCALE} from '../js/hull.js';
const boat=()=>({heading:0,length:20,beam:6,sailFore:1,sailMain:1,sailMizzen:1});
const close=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);

test('sail incidence is continuous through stall and normal reversal cannot change the force',()=>{
  const f=new Float64Array(3),g=new Float64Array(3),c={};let last;
  for(let i=-1800;i<=1800;i++){
    const a=i*Math.PI/1800,w=[Math.sin(a)*8,0,Math.cos(a)*8];
    sailPanelForce(f,c,1,0,0,...w,10,2);sailPanelForce(g,c,-1,0,0,...w,10,2);
    for(let k=0;k<3;k++){assert.ok(Number.isFinite(f[k]));close(f[k],g[k]);}
    assert.ok(f[0]*w[0]+f[2]*w[2]>=-1e-9,'force along relative airflow is dissipative drag');
    if(last)assert.ok(Math.hypot(...f.map((x,k)=>x-last[k]))<10,'no artificial heading or stall discontinuity');
    last=[...f];
  }
  sailCoefficients(c,Math.PI/2,2);assert.ok(Math.abs(c.lift)<1e-12&&c.drag>1);
  sailPanelForce(f,c,1,0,0,0,0,8,10,2);close(f[0],0);assert.ok(f[2]>0,'edge-on cloth retains skin drag');
  sailPanelForce(f,c,1,0,0,8,0,0,0,2);assert.deepEqual([...f],[0,0,0]);
});

test('aerodynamic geometry uses the visible cloth transform, scales and actual exposed canvas',()=>{
  const b=boat(),g=createSailGeometry(),poses=createLateenPoses([1,.5,0]);
  for(const pressure of [-1,0,1])for(const side of [-1,1]){
    poses.forEach(p=>Object.assign(p,{pressure,side,fill:.8,opening:.6}));
    updateSailGeometry(g,b,poses);
    for(let m=0;m<3;m++)for(let j=0;j<g.indices.length;j++){
      const panel=g.panels[m*g.indices.length+j],points=g.indices[j].map(index=>{
        const p=lateenClothPoint(m,...g.samples[index],poses[m],0,0);return [p[0]*b.beam/3.6,p[1]*HULL_VERTICAL_SCALE,p[2]*b.length/12];
      });
      for(let axis=0;axis<3;axis++)close(panel.point[axis],points.reduce((sum,p)=>sum+p[axis],0)/3);
      close(Math.hypot(...panel.normal),1);assert.ok(panel.area>=0&&Number.isFinite(panel.aspect));
      if(m===2)assert.equal(panel.area,0,'furled bundle is not exposed aerodynamic area');
    }
  }
  const area=g.panels.slice(0,g.indices.length).reduce((s,p)=>s+p.area,0);b.length*=1.2;updateSailGeometry(g,b,poses);
  assert.ok(g.panels.slice(0,g.indices.length).reduce((s,p)=>s+p.area,0)>area,'resizing the hull invalidates cached geometry');
});

test('forces depend on actual cloth, not requested trim; force queries do not advance canvas',()=>{
  const b=boat(),s=sailingState(b);s.rig.forEach(p=>Object.assign(p,{opening:.7,fill:.8,pressure:1}));
  const first={...sailForces(b,10,Math.PI,1)},poses=s.rig.map(p=>({...p}));
  s.lateenYaw=-2;s.squareYaw=2;s.lateenTarget=-2;s.squareTarget=2;
  const second=sailForces(b,10,Math.PI,1);
  for(const key of ['forward','side','rollMoment','pitchMoment','area'])close(second[key],first[key]);
  assert.deepEqual(s.rig,poses,'repeated queries only update load diagnostics');
  s.rig.forEach(p=>p.opening=0);const changed=sailForces(b,10,Math.PI,1);
  assert.ok(Math.abs(changed.forward-first.forward)>first.forward*.05,'real sheet movement changes incidence');
  const fill=s.rig[0].fill;advanceSails(b,.1,10,Math.PI);assert.notEqual(s.rig[0].fill,fill);
});

test('still air dissipates translation, roll and pitch energy for arbitrary attitudes',()=>{
  let seed=127;const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<300;i++){
    const b={...boat(),heading:rand()*360,roll:(rand()-.5)*1.2,pitch:(rand()-.5)*.4,rollVelocity:rand()-.5,pitchVelocity:rand()-.5,hydrodynamics:boatHydrodynamics(20,6)};
    sailingState(b).rig.forEach(p=>Object.assign(p,{side:rand()<.5?-1:1,opening:rand()*1.15,fill:rand(),pressure:rand()*2-1,deployed:rand()}));
    const speed=rand()*10-5,side=rand()*4-2,f=sailForces(b,0,rand()*6.28,speed,side);
    const power=f.forward*speed+f.side*side+f.rollMoment*b.rollVelocity+f.pitchMoment*b.pitchVelocity;
    assert.ok(Number.isFinite(power)&&power<=1e-8,`still-air power ${power}`);
  }
});

test('the same sail patch at greater height sees greater pressure; force scales with area and wind squared',()=>{
  const force=(speed,area)=>{const f=new Float64Array(3);sailPanelForce(f,{},.8,0,.6,-speed,0,0,area,2);return Math.hypot(...f);};
  const q=force(8,10);close(force(16,10)/q,4);close(force(8,5)/q,.5);
  assert.ok(force(windAtHeight(10,12),10)>force(windAtHeight(10,3),10));
});

test('loaded sheet geometry can draw or back; a requested reach never manufactures drive',()=>{
  const b=boat(),s=sailingState(b);s.rig.forEach(p=>Object.assign(p,{side:-1,opening:.6,fill:1,pressure:1}));
  const drawing=sailForces(b,8,Math.PI,0).forward;assert.ok(drawing>1000);
  // The current retained-yard bad-tack pose holds its clew windward. Its
  // backwards force is a rig limitation, not permission for a trim power bonus.
  s.rig.forEach(p=>Object.assign(p,{side:1,pressure:-1}));
  assert.ok(sailForces(b,8,Math.PI,0).forward<0,'backed visible cloth applies a backing force');
});

test('coarse cloth loads stay close to a finer surface integration',()=>{
  for(const pressure of [-1,1])for(const opening of [.3,.6,1.15]){
    const totals=[6,12].map(resolution=>{
      const g=createSailGeometry(resolution),poses=createLateenPoses([1,1,1]);
      poses.forEach(p=>Object.assign(p,{fill:1,opening,pressure}));updateSailGeometry(g,boat(),poses);
      const sum=[0,0,0];for(const p of g.panels){sailPanelForce(g.force,g.coefficients,...p.normal,-8,0,0,p.area,p.aspect);for(let k=0;k<3;k++)sum[k]+=g.force[k];}return sum;
    });
    const error=Math.hypot(...totals[0].map((x,k)=>x-totals[1][k]));
    assert.ok(error<Math.hypot(...totals[1])*.08,`coarse integration error at ${pressure}/${opening}`);
  }
});
