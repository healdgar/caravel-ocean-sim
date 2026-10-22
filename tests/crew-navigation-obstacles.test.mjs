import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {crewNavigationObstacles,crewNavigationClear,crewNavigationSegmentClear,crewNavigationRoute,CREW_NAVIGATION_BODY} from '../js/crew-navigation.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {createGunDefinitions,createGunRecoilMap,updateGunRecoilVertices,gunMuzzlePose} from '../js/gunnery-models.js';
import {createGunneryState,prepareGunnery,stepGunnery,gunnerySummary,fireGunnery} from '../js/gunnery-state.js';
import {createCompany,stepCompany} from '../js/crew.js';
import {crewGunneryTool,crewGunStation,stepCrewWork,victoryCrewRoute} from '../js/crew-work.js';
import {getShipModel,SHIP_MODELS} from '../js/ship-models.js';
import {vesselVerticalScale,modelDeck} from '../js/hull.js';
import {loadCrewGLB} from '../js/gltf.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {VICTORY_MASTS,victoryStairFlights,victoryChainwale} from '../js/models/victory.js';

const navGunModels=['nina','victory','pinta','santa-maria'],navAssets=createShipAssetCache();
const navBoat=id=>{const model=getShipModel(id);return {modelId:id,model,...model.runtime,roll:0,pitch:0,rollVelocity:0,heading:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1,crew:false};};
const navScale=boat=>[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12];
const navPhysical=(p,boat)=>p.map((v,i)=>v*navScale(boat)[i]);
const navContains=(p,o,e=3e-6)=>p.every((v,i)=>v>=o.min[i]-e&&v<=o.max[i]+e);
const navDistance=(a,b)=>Math.hypot(...Array.from(a,(v,i)=>v-b[i]));
const navTransform=(m,p)=>[0,1,2].map(i=>m[i]*p[0]+m[i+4]*p[1]+m[i+8]*p[2]+m[i+12]);
function navGroupPoints(asset,group,boat,vertices=asset.vertices){
  return Array.from({length:group.vertexCount},(_,i)=>navPhysical(Array.from(vertices.subarray(asset.indices[group.firstVertex+i]*9,asset.indices[group.firstVertex+i]*9+3)),boat));
}

// Independent continuous envelope oracle: interval intersections are assembled
// per axis. Every route edge is checked, including long edges between samples.
function navSweptStandingBody(a,b,o,radius=.30,height=1.70){
  const spans=[];
  for(let i=0;i<3;i++){
    const low=o.min[i]-(i===1?height:radius)+1e-6,high=o.max[i]+(i===1?0:radius)-1e-6,d=b[i]-a[i];
    if(Math.abs(d)<1e-12){if(a[i]<=low||a[i]>=high)return false;spans.push([-Infinity,Infinity]);}
    else{const ends=[(low-a[i])/d,(high-a[i])/d].sort((x,y)=>x-y);spans.push(ends);}
  }
  return Math.max(0,...spans.map(s=>s[0]))<Math.min(1,...spans.map(s=>s[1]));
}

const navSub=(a,b)=>a.map((v,i)=>v-b[i]),navDot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),navCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const navTriangle=p=>({p,min:[0,1,2].map(i=>Math.min(...p.map(v=>v[i]))),max:[0,1,2].map(i=>Math.max(...p.map(v=>v[i])))});
function navEdgeCutsTriangle(a,b,t){
  const direction=navSub(b,a),edge=navSub(t[1],t[0]),other=navSub(t[2],t[0]),h=navCross(direction,other),det=navDot(edge,h);
  if(Math.abs(det)<1e-11)return false;
  const s=navSub(a,t[0]),u=navDot(s,h)/det;if(u<1e-7||u>1-1e-7)return false;
  const q=navCross(s,edge),v=navDot(direction,q)/det;if(v<1e-7||u+v>1-1e-7)return false;
  const fraction=navDot(other,q)/det;return fraction>1e-6&&fraction<1-1e-6;
}
function navTriangleCuts(a,b){
  if(a.min.some((v,i)=>v>b.max[i]||a.max[i]<b.min[i]))return false;
  return [0,1,2].some(i=>navEdgeCutsTriangle(a.p[i],a.p[(i+1)%3],b.p)||navEdgeCutsTriangle(b.p[i],b.p[(i+1)%3],a.p));
}
// Independent vertical ray against an actual indexed triangle. Navigation's
// analytic support cannot qualify itself when a rendered board is absent,
// curves away, or slopes across a discontinuous deck height.
function navSurfaceHeight(triangle,x,z){
  const [a,b,c]=triangle,ux=b[0]-a[0],uz=b[2]-a[2],vx=c[0]-a[0],vz=c[2]-a[2],det=ux*vz-uz*vx;
  if(Math.abs(det)<1e-12)return null;
  const dx=x-a[0],dz=z-a[2],u=(dx*vz-dz*vx)/det,v=(ux*dz-uz*dx)/det;
  if(u< -1e-7||v< -1e-7||u+v>1+1e-7)return null;
  return a[1]+u*(b[1]-a[1])+v*(c[1]-a[1]);
}
function navTopTriangles(asset,group,boat){
  const tops=[];
  for(let at=group.firstVertex;at<group.firstVertex+group.vertexCount;at+=3){
    const records=Array.from({length:3},(_,i)=>asset.vertices.subarray(asset.indices[at+i]*9,asset.indices[at+i]*9+9));
    if(records.every(v=>v[4]>.99999))tops.push(records.map(v=>navPhysical(Array.from(v.subarray(0,3)),boat)));
  }
  return tops;
}
function navSkin(mesh,s){
  const f=new Float32Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/4),u=new Uint16Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/2),palette=mesh.animator.palette,points=[];
  for(let index=0;index<mesh.vertexCount;index++){
    const p=[0,0,0];for(let k=0;k<4;k++){
      const at=u[index*30+18+k]*16,w=f[index*15+11+k];
      for(let c=0;c<3;c++)p[c]+=w*(palette[at+c]*f[index*15]+palette[at+4+c]*f[index*15+1]+palette[at+8+c]*f[index*15+2]+palette[at+12+c]);
    }
    points.push(navTransform(s.transform,p));
  }
  return points;
}
function navNonWorkingArmTriangles(mesh){
  const f=new Float32Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/4),u=new Uint16Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/2),a=mesh.animator;
  const arm=index=>{let influence=0;for(let k=0;k<4;k++)if(/^(?:lowerarm|hand|thumb|index|middle|ring|pinky|finger)/i.test(a.names[a.joints[u[index*30+18+k]]]))influence+=f[index*15+11+k];return influence>.25;};
  const triangles=[];for(let i=0;i<mesh.indices.length;i+=3){const ids=Array.from(mesh.indices.subarray(i,i+3));if(!ids.some(arm))triangles.push(ids);}return triangles;
}

function navAssertPosedGunBody(mesh,s,boat,asset,posed,bodyIndices,details){
  const a=mesh.animator,stage=s.job.gun.stage;a.sample('Idle',s.time,'Walk',s.walkTime,s.walk);poseCrewWork(a,s,boat);
  assert.ok(a.palette.every(Number.isFinite));const skin=navSkin(mesh,s),tool=crewGunneryTool(s,boat);let grips=0;
  assert.equal(s.gunContacts?.feet.length,2,'actual gun pose supplies two measured planted boots');
  for(const [name,target]of Object.entries(s.grips??{})){
    const actual=a.world[a.names.indexOf(name)].subarray(12,15);assert.ok(navDistance(actual,target)<.12,JSON.stringify({...details,name,gap:navDistance(actual,target)}));grips++;
  }
  if(stage==='ready')assert.equal(tool,null,'ready sailors keep their hands and loading tools clear');
  for(const side of ['l','r']){
    const boot=a.footContacts[side].vertices.map(i=>skin[i]),gaps=boot.map(p=>p[1]-modelDeck(boat,p[2]/(boat.length/12))*vesselVerticalScale(boat));
    assert.ok(Math.min(...gaps)>=-.008,JSON.stringify({...details,side,reason:'actual boot penetrates deck',gap:Math.min(...gaps)}));
    assert.ok(Math.min(...gaps)<=.025,JSON.stringify({...details,side,reason:'working boot has no actual planted sole',gap:Math.min(...gaps)}));
  }
  const body=bodyIndices.map(indices=>navTriangle(indices.map(i=>skin[i]))),near=navTriangle(skin);
  for(const gun of boat.gunnery.guns.filter(g=>g.weatherDeck)){
    const points=navGroupPoints(asset,asset.groups.find(g=>g.id===gun.meshGroup),boat,posed),bounds=navTriangle(points);
    if(near.min.some((v,i)=>v>bounds.max[i]||near.max[i]<bounds.min[i]))continue;
    const triangles=[];for(let i=0;i<points.length;i+=3)triangles.push(navTriangle(points.slice(i,i+3)));
    for(const triangle of body){
      if(triangle.min.some((v,i)=>v>bounds.max[i]||triangle.max[i]<bounds.min[i]))continue;
      for(const cannon of triangles)assert.equal(navTriangleCuts(triangle,cannon),false,JSON.stringify({...details,gun:gun.id,reason:'actual skinned torso/head/legs/boots cut rendered gun'}));
    }
  }
  return grips;
}

test('independent mesh oracle detects real triangle penetration without treating empty gun-group bounds as solid',()=>{
  const a=navTriangle([[0,0,0],[1,0,0],[0,1,0]]),b=navTriangle([[.2,.2,-1],[.2,.2,1],[.8,.2,1]]),far=navTriangle([[2,2,-1],[2,2,1],[3,2,1]]);
  assert.equal(navTriangleCuts(a,b),true);assert.equal(navTriangleCuts(a,far),false);
  assert.equal(navSweptStandingBody([-1,0,0],[1,0,0],{min:[-.1,.2,-.1],max:[.1,.4,.1]}),true);
  assert.equal(navSweptStandingBody([-1,2,0],[1,2,0],{min:[-.1,.2,-.1],max:[.1,.4,.1]}),false);
  const ramp=[[0,2,0],[2,4,0],[0,2,2]];
  assert.equal(navSurfaceHeight(ramp,.5,.5),2.5);assert.equal(navSurfaceHeight(ramp,1.5,1.5),null);
  assert.equal(navSurfaceHeight([[0,0,0],[0,1,0],[0,0,1]],0,.5),null,'vertical faces do not provide horizontal footing');
});

test('fixed and full-recoil reservations enclose actual rendered gun vertices at nominal and resized hull scales',()=>{
  let observed=0;
  for(const id of navGunModels)for(const size of [1,.65,1.3]){
    const boat=navBoat(id);boat.length*=size;boat.beam*=size;
    const asset=navAssets.get(id),rest=asset.vertices.slice(),obstacles=crewNavigationObstacles(boat),map=createGunRecoilMap(asset),posed=asset.vertices.slice(),guns=createGunDefinitions(id);
    assert.ok(Object.isFrozen(obstacles));assert.equal(new Set(obstacles.map(o=>o.id)).size,obstacles.length);
    for(const o of obstacles){assert.ok(Object.isFrozen(o)&&Object.isFrozen(o.min)&&Object.isFrozen(o.max));assert.ok([...o.min,...o.max].every(Number.isFinite));assert.ok(o.min.every((v,i)=>v<=o.max[i]));}
    for(const gun of guns){
      const group=asset.groups.find(g=>g.id===gun.meshGroup),records=obstacles.filter(o=>o.gunId===gun.id);assert.ok(group&&records.length,id+' actual gun is represented');
      assert.ok(records.some(o=>o.reservation==='full-recoil'));
      for(const offset of [0,.5,1]){
        const offsets=guns.map(g=>g.id===gun.id?g.recoilLength*offset:0);updateGunRecoilVertices(map,posed,offsets,boat);
        for(const p of navGroupPoints(asset,group,boat,posed)){
          assert.ok(records.some(o=>navContains(p,o)),JSON.stringify({id,size,gun:gun.id,offset,p,reason:'rendered gun lies outside collision reservation'}));observed++;
        }
      }
    }
    assert.deepEqual(asset.vertices,rest,'navigation and recoil inspection retain immutable shared model vertices');
  }
  assert.ok(observed>100000,'the gate inspects real indexed component vertices, not only source attachment centres');
});

test('legacy fixed hatch, bitts and waist-boat reservations include their actual rendered surfaces',()=>{
  const groups={nina:['hatch.frame','hatch.cover','deck.fore.bitts'],victory:['hatch.main','boat.waist.0','boat.waist.1'],pinta:['hatch.coaming','hatch.main'],'santa-maria':['hatch.coaming','hatch.main']};
  for(const [id,names]of Object.entries(groups)){
    const boat=navBoat(id),asset=navAssets.get(id),fixed=crewNavigationObstacles(boat).filter(o=>o.reservation==='fixed'&&o.gunId===undefined);
    for(const name of names){const group=asset.groups.find(g=>g.id===name);assert.ok(group,id+' '+name+' exists');
      for(const p of navGroupPoints(asset,group,boat))assert.ok(fixed.some(o=>navContains(p,o)),JSON.stringify({id,name,p,reason:'real equipment escaped navigation envelope'}));
    }
  }
});

test('continuous route checks reject crossing mast or gun space even when both endpoints are clear',()=>{
  const boat=navBoat('nina'),obstacles=crewNavigationObstacles(boat),mast=obstacles.find(o=>o.kind==='mast'&&o.id==='mast.1'),y=modelDeck(boat,0)*vesselVerticalScale(boat),z=(mast.min[2]+mast.max[2])*.5;
  const a=[mast.min[0]-.7,y,z],b=[mast.max[0]+.7,y,z],scale=navScale(boat),design=p=>p.map((v,i)=>v/scale[i]);
  assert.equal(CREW_NAVIGATION_BODY.radius,.30);assert.equal(CREW_NAVIGATION_BODY.height,1.70);
  assert.equal(crewNavigationClear(a,boat),true);assert.equal(crewNavigationClear(b,boat),true);
  assert.equal(crewNavigationSegmentClear(a,b,boat),false,'endpoint-only collision checks miss the mast in between');
  assert.equal(crewNavigationSegmentClear(a,b,boat,{radius:0,height:.1}),false,'callers cannot shrink sailors to bypass equipment');
  const route=crewNavigationRoute([design(a),design(b)],boat);assert.ok(route?.length>2,'an unobstructed deck has a real detour');
  assert.deepEqual(route[0],design(a));assert.deepEqual(route.at(-1),design(b));
  for(let i=1;i<route.length;i++)for(const o of obstacles)assert.equal(navSweptStandingBody(navPhysical(route[i-1],boat),navPhysical(route[i],boat),o),false,'full standing body clears '+o.id);
  const unknown={...boat,modelId:'nonexistent'};assert.equal(crewNavigationObstacles(unknown),null);assert.equal(crewNavigationRoute([design(a),design(b)],unknown),null);
});

test('segment clearance fails closed for malformed or non-finite physical endpoints',()=>{
  const boat=navBoat('nina'),good=[-1,modelDeck(boat,0)*vesselVerticalScale(boat),0];
  const invalid=[null,undefined,[],[0,0],[0,0,0,0],[NaN,0,0],[0,Infinity,0],[0,0,-Infinity],['0',0,0],[[0],0,0],Array(3),'012',0];
  for(const bad of invalid){
    assert.equal(crewNavigationSegmentClear(bad,good,boat),false,'invalid start must fail closed');
    assert.equal(crewNavigationSegmentClear(good,bad,boat),false,'invalid destination must fail closed');
    assert.equal(crewNavigationClear(bad,boat),false,'invalid stationary body must fail closed');
  }
});

test('Victory rig access rests on real hull-connected channel tops and rejects unsupported standing footprints',()=>{
  const asset=navAssets.get('victory'),hullGroup=asset.groups.find(g=>g.id==='hull.planking');assert.ok(hullGroup);
  let supported=0,connections=0;
  for(const size of [.65,1,1.3]){
    const boat=navBoat('victory');boat.length*=size;boat.beam*=size;
    const scale=navScale(boat),obstacles=crewNavigationObstacles(boat),hullPoints=navGroupPoints(asset,hullGroup,boat),hullTriangles=[];
    for(let i=0;i<hullPoints.length;i+=3)hullTriangles.push(navTriangle(hullPoints.slice(i,i+3)));
    for(const [mast,m]of VICTORY_MASTS.entries())for(const side of [-1,1]){
      const group=asset.groups.find(g=>g.id==='chainwale.'+m.id+'.'+side);assert.ok(group,'actual side channel exists');
      const tops=navTopTriangles(asset,group,boat);assert.ok(tops.length>=24,'channel has actual indexed top surfaces');
      const vertices=tops.flat(),zs=[...new Set(vertices.map(p=>p[2]))].sort((a,b)=>a-b),z0=zs[0],z1=zs.at(-1),radius=CREW_NAVIGATION_BODY.radius;
      // Derive the contact edge from rendered vertices, then intersect actual
      // hull triangles in the transverse plane. Source coordinates alone do
      // not prove that a separate channel is joined to the hull skin.
      for(const z of zs){
        const row=vertices.filter(p=>Math.abs(p[2]-z)<1e-7),inner=row.reduce((a,b)=>side*a[0]<side*b[0]?a:b),outer=row.reduce((a,b)=>side*a[0]>side*b[0]?a:b),thickness=victoryChainwale(mast,side,z/scale[2]).thickness*scale[1];
        let joined=false;
        for(const drop of [0,.25,.5,.75,1]){
          const y=inner[1]-drop*thickness;
          const skins=hullTriangles.filter(t=>side*(side<0?t.max[0]:t.min[0])>0&&y>=t.min[1]-1e-7&&y<=t.max[1]+1e-7&&z>=t.min[2]-1e-7&&z<=t.max[2]+1e-7).map(t=>navSurfaceHeight(t.p.map(p=>[p[1],side*p[0],p[2]]),y,z)).filter(Number.isFinite);
          if(skins.some(x=>side*inner[0]<=x+.002&&side*outer[0]>=x-.002)){joined=true;break;}
        }
        assert.ok(joined,JSON.stringify({mast:m.id,side,size,z,inner,outer,reason:'rendered channel slab is disconnected from actual hull triangles'}));connections++;
      }
      let safeEntries=0;
      for(let sample=1;sample<48;sample++){
        const z=z0+(z1-z0)*sample/48,channel=victoryChainwale(mast,side,z/scale[2]),outer=side*channel.outer*scale[0],x=side*(outer-radius-.02),y=channel.y*scale[1],p=[x,y,z],rigAccess={point:p,radius:1.25,mast,side};
        const options={rigAccess};
        if(!crewNavigationClear(p,boat,options))continue;
        safeEntries++;supported++;
        for(const o of obstacles)assert.equal(navSweptStandingBody(p,p,o),false,'rig access retains '+o.id+' clearance');
        for(let edge=0;edge<16;edge++){
          const angle=edge*Math.PI/8,q=[x+Math.cos(angle)*radius,y,z+Math.sin(angle)*radius],heights=tops.map(t=>navSurfaceHeight(t,q[0],q[2])).filter(Number.isFinite);
          assert.ok(heights.some(h=>Math.abs(h-y)<=.05),JSON.stringify({mast:m.id,side,size,p,q,heights,reason:'accepted standing footprint lacks actual channel-top support'}));
        }
        const outboard=[side*(outer-radius+.01),y,z];
        assert.equal(crewNavigationClear(outboard,boat,options),false,'body may not overhang the rendered outer edge');
        assert.equal(crewNavigationClear(outboard,boat,{rigAccess,radius:0,height:.1}),false,'requesting a shrunken body cannot authorize an edge overhang');
        for(const height of [-.051,.051])assert.equal(crewNavigationClear([x,y+height,z],boat,options),false,'a runner access point is not a sphere of support above or below its board');
        for(const end of [z0+radius-.01,z1-radius+.01]){
          const c=victoryChainwale(mast,side,end/scale[2]),endPoint=[side*(side*c.outer*scale[0]-radius-.02),c.y*scale[1],end];
          assert.equal(crewNavigationClear(endPoint,boat,{rigAccess:{...rigAccess,point:endPoint}}),false,'body may not overhang either rendered channel end');
        }
      }
      if(mast<2)assert.ok(safeEntries>0,JSON.stringify({mast:m.id,side,size,reason:'fore and main runner channels retain real usable standing entries'}));
    }
  }
  assert.ok(supported>30&&connections>100,'the gate covers both sides, three scales and actual mesh support');
});

test('every Victory stair joins its real seven-tread mesh and route while a full standing body clears gun recoil',()=>{
  const boat=navBoat('victory'),asset=navAssets.get('victory'),flights=victoryStairFlights(),guns=crewNavigationObstacles(boat).filter(o=>o.kind==='gun');
  assert.ok(Object.isFrozen(flights));assert.equal(flights.length,6,'paired fore, quarter and poop flights');
  for(const f of flights){
    assert.ok(Object.isFrozen(f));assert.equal(f.treads,7);assert.equal(f.width,.21,'the repair preserves the actual tread width');
    const group=asset.groups.find(g=>g.id===f.meshGroup);assert.ok(group,f.id+' real mesh group exists');
    const tops=[];
    for(let raw=group.firstVertex;raw<group.firstVertex+group.vertexCount;raw+=3){
      const records=Array.from({length:3},(_,i)=>asset.vertices.subarray(asset.indices[raw+i]*9,asset.indices[raw+i]*9+9));
      if(records.every(v=>v[6]===0&&v[4]>.99999))tops.push(records.map(v=>Array.from(v.subarray(0,3))));
    }
    assert.equal(tops.length,f.treads*2,f.id+' contains seven actual rectangular tread top surfaces');
    const low=f.y0<f.y1?{z:f.z0,y:f.y0}:{z:f.z1,y:f.y1},high=f.y0<f.y1?{z:f.z1,y:f.y1}:{z:f.z0,y:f.y0};
    for(let i=0;i<f.treads;i++){
      const z=low.z+(high.z-low.z)*(i+.5)/f.treads,y=low.y+(high.y-low.y)*(i+1)/f.treads,triangles=tops.filter(t=>Math.abs(t.reduce((sum,p)=>sum+p[2],0)/3-z)<.04&&t.every(p=>Math.abs(p[1]-y)<3e-6));
      assert.equal(triangles.length,2,f.id+' real tread '+i+' uses the shared flight height/run');
      const points=triangles.flat(),xs=points.map(p=>p[0]),zs=points.map(p=>p[2]);
      assert.ok(Math.abs(Math.min(...xs)-(f.x-f.width/2))<3e-6&&Math.abs(Math.max(...xs)-(f.x+f.width/2))<3e-6,'physical tread is centred under its route');
      assert.ok(Math.abs((Math.min(...zs)+Math.max(...zs))*.5-z)<3e-6,'physical tread follows the actual flight run');
    }
    const a=[f.x,f.y0,f.z0],b=[f.x,f.y1,f.z1],route=victoryCrewRoute({x:f.x,z:f.z0},b,boat);
    for(const landing of [a,b])assert.ok(route.some(p=>navDistance(p,landing)<1e-8),f.id+' route reaches the exact model-owned landing');
    for(const p of route.filter(p=>p[2]>f.z0+1e-8&&p[2]<f.z1-1e-8))assert.ok(Math.abs(p[0]-f.x)<1e-8,'route stays over its actual stair treads');
    for(const o of guns)assert.equal(navSweptStandingBody(navPhysical(a,boat),navPhysical(b,boat),o),false,JSON.stringify({flight:f.id,obstacle:o.id,a,b,reason:'authored stair intersects gun recoil reservation'}));
  }
});

test('all nine model companies retain real independent postings while legacy watch sweeps clear fixed equipment',()=>{
  const ids=Object.values(SHIP_MODELS).filter(m=>m.status==='ready').map(m=>m.id);assert.equal(ids.length,9);
  for(const id of ids){
    const boat=navBoat(id),company=createCompany(undefined,id);stepCompany(company,boat,0,3);
    assert.equal(company.crew.length,Object.keys(getShipModel(id).crewStations).length,id+' complete authored visible watch');
    assert.ok(company.crew.every(s=>s.transform.every(Number.isFinite)));
    if(!navGunModels.includes(id)){assert.equal(crewNavigationObstacles(boat).filter(o=>o.kind==='gun').length,0);continue;}
    const obstacles=crewNavigationObstacles(boat);
    for(let tick=0;tick<200;tick++){
      const before=company.crew.map(s=>Array.from(s.position));stepCompany(company,boat,.1,3);
      for(const [i,s]of company.crew.entries()){
        if(s.job?.rung>0||s.role==='Helmsman')continue;
        const p=Array.from(s.position);p[1]-=.028;const prior=before[i];prior[1]-=.028;
        for(const o of obstacles)assert.equal(navSweptStandingBody(prior,p,o),false,JSON.stringify({id,tick,sailor:s.id,job:s.job?.stage,obstacle:o.id,prior,p}));
      }
    }
  }
});

test('actual gun teams retain physical routes, body clearance and reachable tools through loading, runout and recoil',()=>{
  const meshes=Object.fromEntries(['male','female'].map(sex=>[sex,loadCrewGLB(readFileSync(new URL('../assets/crew/'+(sex==='female'?'sailor-female.glb':'sailor.glb'),import.meta.url)))])),bodyIndices=Object.fromEntries(Object.entries(meshes).map(([sex,mesh])=>[sex,navNonWorkingArmTriangles(mesh)]));
  let bodySnapshots=0,gripSamples=0;
  for(const id of navGunModels)for(const side of ['port','starboard']){
    const boat=navBoat(id),company=createCompany(undefined,id),asset=navAssets.get(id),rest=asset.vertices.slice(),posed=asset.vertices.slice(),map=createGunRecoilMap(asset),seen=new Set();
    stepCompany(company,boat,0,8);boat.gunnery=createGunneryState(createGunDefinitions(id));boat.gunnerySide=side;prepareGunnery(boat.gunnery,side);
    const environment={muzzle:g=>gunMuzzlePose(g,boat),gunAttended:g=>!g.visibleCrew||boat.gunneryAttendance?.has(g.id)},obstacles=crewNavigationObstacles(boat);
    for(let tick=0;tick<2400;tick++){
      const previous=company.crew.map(s=>Array.from(s.position));stepCompany(company,boat,.1,8);
      updateGunRecoilVertices(map,posed,boat.gunnery.guns,boat);
      for(const [index,s]of company.crew.entries()){
        assert.ok(navDistance(previous[index],s.position)<=.14002,id+' no work-stage teleport');
        if(s.job?.kind!=='gunnery')continue;
        if(['approach','return'].includes(s.job.stage)){
          const a=previous[index].slice(),b=Array.from(s.position);a[1]-=.028;b[1]-=.028;
          for(const o of obstacles)assert.equal(navSweptStandingBody(a,b,o),false,JSON.stringify({id,side,tick,sailor:s.id,stage:s.job.stage,obstacle:o.id,a,b}));
          continue;
        }
        if(s.job.stage!=='working')continue;
        const stage=s.job.gun.stage,key=[s.job.gun.id,s.job.gunRole,stage].join(':');
        if(seen.has(key)||(!['ready','recoil','spent'].includes(stage)&&((s.job.gun.progress??0)<.3||(s.job.gun.progress??0)>.7)))continue;
        seen.add(key);gripSamples+=navAssertPosedGunBody(meshes[s.sex],s,boat,asset,posed,bodyIndices[s.sex],{id,side,sailor:s.id,stage,role:s.job.gunRole});
        bodySnapshots++;
      }
      stepGunnery(boat.gunnery,.1,environment);
      if(gunnerySummary(boat.gunnery,side).ready===gunnerySummary(boat.gunnery,side).total&&tick>300)break;
    }
    const summary=gunnerySummary(boat.gunnery,side);assert.equal(summary.ready,summary.total,id+' '+side+' finishes the actual drill');
    for(const stage of ['swab','load','ram','runout','prime','ready'])assert.ok([...seen].some(key=>key.endsWith(':'+stage)),id+' actual body sampled during '+stage);
    fireGunnery(boat.gunnery,side);
    let returned=0,finished=false;
    for(let tick=0;tick<2400;tick++){
      const before=company.crew.map(s=>Array.from(s.position)),jobs=company.crew.map(s=>s.job&&({kind:s.job.kind,stage:s.job.stage}));
      stepCompany(company,boat,.1,8);stepGunnery(boat.gunnery,.1,environment);
      for(const [i,s]of company.crew.entries()){
        assert.ok(navDistance(before[i],s.position)<=.14002,id+' real recoil/return cannot teleport a worker');
        if(jobs[i]?.kind!=='gunnery')continue;
        if(jobs[i].stage==='return'||s.job?.stage==='return'){
          const a=before[i].slice(),b=Array.from(s.position);a[1]-=.028;b[1]-=.028;
          for(const o of obstacles)assert.equal(navSweptStandingBody(a,b,o),false,JSON.stringify({id,side,tick,sailor:s.id,reason:'actual issued gun return edge crosses equipment',obstacle:o.id,a,b}));
        }
        if(!s.job){
          returned++;const home=navPhysical([s.home[0],modelDeck(boat,s.home[1]),s.home[1]],boat);home[1]+=.028;
          assert.ok(navDistance(Array.from(s.position),home)<.03,id+' actual gun worker reaches its physical home');
        }
      }
      if(!company.crew.some(s=>s.job?.kind==='gunnery')){finished=true;break;}
    }
    assert.ok(finished&&returned>0,id+' crews clear recoil then return without a route deadlock');
    assert.deepEqual(asset.vertices,rest,'posed inspection never changes shared ship assets');
  }
  assert.ok(bodySnapshots>100&&gripSamples>100,'real male/female poses are measured across drill phases');
});

test('isolated actual working gun targets keep both imported bodies grounded, clear and within real limb reach',()=>{
  const meshes=Object.fromEntries(['male','female'].map(sex=>[sex,loadCrewGLB(readFileSync(new URL('../assets/crew/'+(sex==='female'?'sailor-female.glb':'sailor.glb'),import.meta.url)))])),bodyIndices=Object.fromEntries(Object.entries(meshes).map(([sex,mesh])=>[sex,navNonWorkingArmTriangles(mesh)]));
  let snapshots=0,grips=0;
  for(const id of navGunModels){
    const boat=navBoat(id),company=createCompany(undefined,id),asset=navAssets.get(id),posed=asset.vertices.slice(),map=createGunRecoilMap(asset),immutable=asset.vertices.slice();
    stepCompany(company,boat,0,8);boat.gunnery=createGunneryState(createGunDefinitions(id));
    // Every Victory weather-deck mounting, including carronades; the three
    // swivel outfits retain both sides and their distinct fore/aft mountings.
    for(const gun of boat.gunnery.guns.filter(g=>g.weatherDeck))for(const sex of ['male','female'])for(const role of ['loader','tackle'])for(const stage of ['swab','load','ram','runout','prime','ready'])for(const progress of stage==='ready'?[1]:[.125,.5,.875]){
      gun.stage=stage;gun.progress=progress;gun.offset=stage==='prime'||stage==='ready'?0:stage==='runout'?gun.recoilLength*(1-progress):gun.recoilLength;
      const target=crewGunStation(gun,role,boat),template=company.crew.find(s=>s.sex===sex);
      assert.ok(template,id+' contains the actual '+sex+' body type');
      // Isolate the real production pose from route availability. Its station,
      // orientation and transform still come from the actual work executor;
      // this fixture never claims that a blocked route has been completed.
      const s={...template,x:target[0],z:target[2],time:0,walk:0,walkTime:0,work:1,intent:'work',decisionIn:1,
        observation:{...template.observation,hazard:false},position:Float32Array.from(navPhysical(target,boat)),rotation:new Float32Array(4),transform:new Float32Array(16),scale:template.scale.slice(),
        job:{kind:'gunnery',stage:'working',gun,gunRole:role,position:target.slice(),path:[target.slice()],cursor:0,elapsed:0,rung:0,revision:company.revision}};
      s.position[1]+=.028;assert.equal(stepCrewWork(s,company,boat,0),true);assert.equal(s.job.stage,'working','the isolated station is the production phase target');
      updateGunRecoilVertices(map,posed,boat.gunnery.guns,boat);
      grips+=navAssertPosedGunBody(meshes[sex],s,boat,asset,posed,bodyIndices[sex],{id,gun:gun.id,sex,role,stage,progress,isolated:true});
      const a=meshes[sex].animator;for(let i=0;i<a.pose.length;i++)assert.deepEqual(a.pose[i].s,a.rest[i].s,'gun reach cannot stretch actual bone scales');
      snapshots++;
    }
    assert.deepEqual(asset.vertices,immutable,'isolated pose qualification preserves immutable ship geometry');
  }
  assert.ok(snapshots>=1000&&grips>snapshots*2,'both real bodies are measured at positive/zero/negative tool-stroke extremes');
});
