// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLateenPoses,lateenClothPoint,lateenRopePoint,runningRiggingLines,RIG_LINES,RIG_SEGMENTS,ropeParameter} from '../js/lateen.js';
import {createSailGeometry,updateSailGeometry} from '../js/sail-aerodynamics.js';
import {standingRopePoint} from '../js/rigging.js';
import {segmentTriangleDistance} from '../scripts/rig-clearance.mjs';

const boat={length:20,beam:6};
function mixedPoses(){
  const poses=createLateenPoses([1,1,1],1);
  poses.forEach(p=>Object.assign(p,{opening:0,pressure:0,fill:1}));
  poses[1].side=-1;return poses;
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const forePoints=g=>g.panels.slice(0,g.indices.length).map(p=>[...p.point]);

test('canvas supports read each owning mast pose and keep standalone preview compatibility',()=>{
  const poses=mixedPoses(),reads=[0,0,0];
  for(let m=0;m<3;m++){
    const side=poses[m].side;
    Object.defineProperty(poses[m],'side',{get(){reads[m]++;return side;},enumerable:true});
  }
  lateenClothPoint(0,0,.7,poses[0],0,0,true,poses);
  assert.ok(reads[1]>0&&reads[2]>0,'neighbouring support ropes use their owning mast, not the current sail pose');
  for(const side of[-1,1])for(const pressure of[-1,0,1]){
    const common=createLateenPoses([1,1,1],side);
    common.forEach(p=>Object.assign(p,{opening:.6,pressure,fill:.7}));
    for(let m=0;m<3;m++)for(const[u,v]of[[0,.7],[.2,.4],[.5,.2]]){
      assert.deepEqual(lateenClothPoint(m,u,v,common[m],.3,7),
        lateenClothPoint(m,u,v,common[m],.3,7,true,common));
    }
  }
});

test('changing a neighbouring runner changes supported cloth without moving its sewn luff or sheet endpoint off the cloth',()=>{
  const poses=mixedPoses(),before=[];
  for(let v=.1;v<1;v+=.05)before.push(lateenClothPoint(0,0,v,poses[0],0,0,true,poses));
  poses[1].side=1;let movement=0,index=0;
  for(let v=.1;v<1;v+=.05){
    const point=lateenClothPoint(0,0,v,poses[0],0,0,true,poses);
    movement=Math.max(movement,Math.hypot(...point.map((x,k)=>x-before[index][k])));index++;
  }
  assert.ok(movement>1e-6,'mainmast runners can support the neighbouring fore canvas');
  for(let m=0;m<3;m++)for(let i=0;i<=26;i++){
    assert.deepEqual(lateenClothPoint(m,i/26,0,poses[m],0,0,true,poses),
      lateenClothPoint(m,i/26,0,poses[m],0,0,false,poses),'sewn luff is unchanged by contact');
  }
  for(const line of runningRiggingLines().filter(l=>l.kind==='sheet')){
    assert.deepEqual(lateenRopePoint(line,0,poses,0,0),
      lateenClothPoint(line.mast,0,1,poses[line.mast],0,0,true,poses));
    assert.deepEqual(lateenRopePoint(line,1,poses,0,0),line.b);
  }
});

test('cached aerodynamic cloth refreshes when another mast side or dip changes its supports',()=>{
  for(const change of[p=>p.dip=.12,p=>p.side=1]){
    const poses=mixedPoses(),cached=createSailGeometry();
    updateSailGeometry(cached,boat,poses);const before=forePoints(cached);
    change(poses[1]);updateSailGeometry(cached,boat,poses);
    const fresh=createSailGeometry();updateSailGeometry(fresh,boat,poses);
    let foreMovement=0;
    for(let i=0;i<cached.panels.length;i++){
      const a=cached.panels[i],b=fresh.panels[i];
      for(let k=0;k<3;k++){near(a.point[k],b.point[k]);near(a.normal[k],b.normal[k]);}
      near(a.area,b.area);near(a.aspect,b.aspect);
      if(i<before.length)foreMovement=Math.max(foreMovement,Math.hypot(...a.point.map((x,k)=>x-before[i][k])));
    }
    assert.ok(foreMovement>1e-6,'unchanged fore trim must still follow the moving mainmast support');
  }
});

test('mixed retained yards keep mizzen canvas clear of every mainmast stay segment',()=>{
  const failures=[],resolution=26,d=1/resolution;
  for(const sides of[[-1,1,-1],[1,-1,1]])for(const pressure of[-1,0]){
    const poses=createLateenPoses([1,1,1]);
    poses.forEach((p,m)=>Object.assign(p,{side:sides[m],opening:.3,fill:1,pressure}));
    const segments=RIG_LINES.filter(l=>l.kind==='stay'&&l.mast===1&&l.side===sides[2]).flatMap(line=>
      Array.from({length:RIG_SEGMENTS},(_,index)=>({
        line,index,a:standingRopePoint(line,ropeParameter(line,index),poses[line.mast]),
        b:standingRopePoint(line,ropeParameter(line,index+1),poses[line.mast]),
      })));
    let closest={gap:Infinity};
    const check=uv=>{
      const triangle=uv.map(([u,v])=>lateenClothPoint(2,u,v,poses[2],0,14,true,poses));
      for(const {line,index,a,b}of segments){
        const gap=segmentTriangleDistance(...triangle,a,b)-line.r;
        if(gap<closest.gap)closest={gap,uv,triangle,stay:{segment:index,foot:line.a,a,b,r:line.r}};
      }
    };
    for(let i=0;i<resolution;i++)for(let j=0;j<resolution-i;j++){
      const u=i/resolution,v=j/resolution;
      check([[u,v],[u+d,v],[u,v+d]]);
      if(i+j<resolution-1)check([[u+d,v],[u+d,v+d],[u,v+d]]);
    }
    if(closest.gap<.003-1e-5)failures.push({sides,pressure,...closest});
  }
  assert.deepEqual(failures,[],'physical mainmast-stay/mizzen clearance; diagnostic UVs identify the contact neighbourhood');
});
