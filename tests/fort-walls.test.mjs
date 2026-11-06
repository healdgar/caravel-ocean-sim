// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A fort's walls stand clear of everything in its port, and end at the edge of its bastions.
// These read the walls the geometry builder really emits, not only the plan it draws them from.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HISTORICAL_COLONIAL_PORTS,SPANISH_MAIN_1550_REGIONS,buildPortPrefabGeometry,generateProceduralCoastalPack,placeCoastalPort,resolveGlobalCoastalRegion,synthesizeCoastalTerrain} from '../js/coastal-world.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';
import {bastionBayIsEmbrasure,enclosurePlan,fortLocalToWorld,triangularFortPlan} from '../js/fort-plan.js';

const grid={size:257,biomeSize:64,albedoSize:64,vegetationCandidates:400};
const SURVEY_YEARS=[1550,1600,1610,1625,1640,1650,1665,1680,1700,1750];
const FORT='english_triangular_palisade_fort';
const WALL_PARTS=new Set(['triangular_palisade_curtains','fort_earthwork_plinth','palisade_stockade_posts']);
// Ports the colonial programme gives a fort. A port added later is found by the survey below.
const KNOWN_FORT_PORTS=['jamestown','quebec','bermuda','plymouth-colony','new-amsterdam','boston','cape-town','charleston','philadelphia'];

// A cheap first pass over every port and year finds which have walls at all, then those get whole packs.
function surveyWalledPorts(){
  const walled=[];
  for(const id of new Set([...Object.keys(SPANISH_MAIN_1550_REGIONS),...HISTORICAL_COLONIAL_PORTS.map(p=>p.id)])){
    for(const year of SURVEY_YEARS){
      let region;
      try{region=resolveGlobalCoastalRegion({id,year,...grid});}catch{continue;}
      const terrain=synthesizeCoastalTerrain(region);
      const port=placeCoastalPort(region,new Float32Array(terrain.heights??terrain));
      if(port.instances.some(i=>enclosurePlan(i)))walled.push({id,year});
    }
  }
  return walled;
}

const packs=new Map();
function packOf({id,year}){
  const key=`${id}@${year}`;
  if(!packs.has(key))packs.set(key,generateProceduralCoastalPack({id,year,...grid}));
  return packs.get(key);
}
let surveyed=null;
const walledPorts=()=>surveyed??=surveyWalledPorts();

function emittedPoints(inst,partKeys){
  const geo=buildPortPrefabGeometry({instances:[inst]}),points=[];
  const stride=geo.vertices.length/(Math.max(...geo.indices)+1);
  for(const group of geo.groups){
    if(!partKeys.has(group.partKey))continue;
    for(let k=group.firstIndex;k<group.firstIndex+group.indexCount;k++){
      const v=geo.indices[k]*stride;
      points.push([geo.vertices[v],geo.vertices[v+2]]);
    }
  }
  return points;
}
function inFootprint([x,z],inst,pad=0){
  const c=Math.cos(inst.yaw),s=Math.sin(inst.yaw),dx=x-inst.x,dz=z-inst.z;
  return Math.abs(dx*c-dz*s)<inst.width/2+pad&&Math.abs(dx*s+dz*c)<inst.length/2+pad;
}
function worldOutline(inst){
  return enclosurePlan(inst).outline.map(([lx,lz])=>{const p=fortLocalToWorld(inst,lx,lz);return [p.x,p.z];});
}
function inOutline([x,z],outline){
  let inside=false;
  for(let i=0,j=outline.length-1;i<outline.length;j=i++){
    const [xi,zi]=outline[i],[xj,zj]=outline[j];
    if((zi>z)!==(zj>z)&&x<(xj-xi)*(z-zi)/(zj-zi)+xi)inside=!inside;
  }
  return inside;
}
function footprintCorners(inst){
  const c=Math.cos(inst.yaw),s=Math.sin(inst.yaw),hw=inst.width/2,hl=inst.length/2;
  return [[-hw,-hl],[hw,-hl],[hw,hl],[-hw,hl],[0,0]].map(([lx,lz])=>[inst.x+lx*c+lz*s,inst.z-lx*s+lz*c]);
}
// How far a footprint's nearest point stands from a disc's centre.
function footprintToPoint(inst,x,z){
  const c=Math.cos(inst.yaw),s=Math.sin(inst.yaw),dx=x-inst.x,dz=z-inst.z;
  return Math.hypot(Math.max(0,Math.abs(dx*c-dz*s)-inst.width/2),Math.max(0,Math.abs(dx*s+dz*c)-inst.length/2));
}
function segmentsCross(a,b,c,d){
  const side=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
  return side(a,b,c)*side(a,b,d)<0&&side(c,d,a)*side(c,d,b)<0;
}

test('the survey finds every port known to have a fort',{timeout:300000},()=>{
  const found=new Set(walledPorts().map(p=>p.id));
  for(const id of KNOWN_FORT_PORTS)assert.ok(found.has(id),`${id} has walls in some year`);
});

test('no footprint crosses a wall, in any port or year with one',{timeout:600000},()=>{
  let walls=0;
  for(const spec of walledPorts()){
    const {port}=packOf(spec),label=`${spec.id} ${spec.year}`;
    for(const wall of port.instances.filter(i=>enclosurePlan(i))){
      walls++;
      const points=emittedPoints(wall,WALL_PARTS),outline=worldOutline(wall);
      assert.ok(points.length>100,`${label} emits ${wall.prefabId} walls`);
      for(const other of port.instances){
        if(other===wall||enclosurePlan(other))continue;
        const through=points.find(p=>inFootprint(p,other));
        assert.equal(through,undefined,`${label}: ${wall.prefabId} runs through ${other.prefabId} "${other.label}"`);
        const sides=new Set(footprintCorners(other).map(p=>inOutline(p,outline)));
        assert.equal(sides.size,1,`${label}: ${other.prefabId} "${other.label}" straddles ${wall.prefabId}`);
      }
    }
  }
  assert.ok(walls>=80,`the survey covered ${walls} walled enclosures`);
});

test('a port with two forts keeps them apart',{timeout:600000},()=>{
  let pairs=0;
  const lineOf=inst=>inst.trace?inst.trace.outline.map(([lx,lz])=>{const p=fortLocalToWorld(inst,lx,lz);return [p.x,p.z];}):worldOutline(inst);
  for(const spec of walledPorts()){
    const forts=packOf(spec).port.instances.filter(i=>enclosurePlan(i)||i.trace);
    for(const a of forts)for(const b of forts){
      if(a===b)continue;
      pairs++;
      const outline=lineOf(b);
      assert.ok(!lineOf(a).some(p=>inOutline(p,outline)),`${spec.id} ${spec.year}: one fort stands inside another`);
    }
  }
  assert.ok(pairs>0,'some port has two forts');
});

test('curtains end at a bastion and its platform stays clear, whatever stands nearby',{timeout:600000},()=>{
  let platforms=0;
  for(const spec of walledPorts()){
    const {port}=packOf(spec),label=`${spec.id} ${spec.year}`;
    for(const fort of port.instances.filter(i=>i.prefabId===FORT)){
      const plan=enclosurePlan(fort),radius=plan.bastionRadius;
      const walls=emittedPoints(fort,WALL_PARTS);
      const drums=emittedPoints(fort,new Set(['corner_bulwark_bastions']));
      for(const [bx,bz] of plan.bastions){
        const {x,z}=fortLocalToWorld(fort,bx,bz);
        platforms++;
        // The parapet's own inner face stands 0.2 m inside the radius.
        const across=walls.find(p=>Math.hypot(p[0]-x,p[1]-z)<radius-0.2);
        assert.equal(across,undefined,`${label}: a curtain runs across a bastion's platform`);
        assert.ok(drums.some(p=>Math.abs(Math.hypot(p[0]-x,p[1]-z)-radius)<0.5),`${label}: the plan's bastion is where the builder draws one`);
        for(const other of port.instances){
          if(other===fort||enclosurePlan(other))continue;
          assert.ok(footprintToPoint(other,x,z)>radius,`${label}: ${other.prefabId} stands on a bastion`);
        }
      }
      for(const p of drums)assert.ok(plan.bastions.some(([bx,bz])=>{const c=fortLocalToWorld(fort,bx,bz);return Math.hypot(p[0]-c.x,p[1]-c.z)<radius+0.6;}),`${label}: bastion geometry strays from its plan`);
    }
  }
  assert.ok(platforms>=150,`the survey covered ${platforms} bastions`);
});

test('a fort still holds its settlement, on dry ground, clear of its guardhouse',{timeout:600000},()=>{
  for(const spec of walledPorts()){
    const {port,heights,region}=packOf(spec),label=`${spec.id} ${spec.year}`;
    const [first]=port.instances.filter(i=>i.prefabId===FORT);
    if(!first)continue;
    const outline=worldOutline(first),plan=enclosurePlan(first),keep=plan.guardhouse;
    const inside=port.instances.filter(i=>i!==first&&!enclosurePlan(i)&&inOutline([i.x,i.z],outline));
    assert.ok(inside.length>=5,`${label}: only ${inside.length} houses inside the fort`);
    for(const house of inside){
      assert.match(house.prefabId,/english_(half_timber_hall|timber_cottage)/,`${label}: ${house.prefabId} is inside the fort`);
      for(const [x,z] of footprintCorners(house)){
        assert.ok(terrainSurfaceSample(heights,x,z,region)>=0,`${label}: ${house.prefabId} has a corner in the water`);
      }
      const g=fortLocalToWorld(first,keep.x,keep.z);
      assert.ok(footprintToPoint(house,g.x,g.z)>Math.hypot(keep.halfWidth,keep.halfLength),`${label}: ${house.prefabId} is on the guardhouse`);
    }
    for(const [x,z] of outline)assert.ok(terrainSurfaceSample(heights,x,z,region)>=0,`${label}: a bastion stands in the water`);
  }
});

test('ways go round a wall and through its gate, and every door is still reached',{timeout:600000},()=>{
  for(const spec of walledPorts()){
    const {port}=packOf(spec),label=`${spec.id} ${spec.year}`;
    if(!port.streets)continue;
    assert.equal(port.streets.stats.stranded,0,`${label}: a door has no way to it`);
    for(const wall of port.instances.filter(i=>enclosurePlan(i))){
      const plan=enclosurePlan(wall);
      const spans=plan.wallSpans.map(([a,b])=>[a,b].map(([lx,lz])=>{const p=fortLocalToWorld(wall,lx,lz);return [p.x,p.z];}));
      // Smoothing a way may graze the post at either side of a gate, and no further.
      const gateEdges=plan.gateEdges?plan.gateEdges.map(([lx,lz])=>{const p=fortLocalToWorld(wall,lx,lz);return [p.x,p.z];}):[];
      for(const way of port.streets.ways){
        const pts=way.points;
        for(let k=1;k<pts.length;k++)for(const [a,b] of spans){
          if(!segmentsCross(pts[k-1],pts[k],a,b))continue;
          const atGate=gateEdges.some(([x,z])=>Math.hypot(pts[k][0]-x,pts[k][1]-z)<3);
          assert.ok(atGate,`${label}: a ${way.road?'road':'way'} crosses ${wall.prefabId} at ${pts[k][0].toFixed(0)},${pts[k][1].toFixed(0)}`);
        }
      }
    }
  }
});

test('the plan holds however the coast runs',{timeout:300000},()=>{
  for(let shoreBearing=0;shoreBearing<360;shoreBearing+=30){
    for(const year of [1625,1665]){
      const {port}=generateProceduralCoastalPack({id:'jamestown',year,shoreBearing,...grid}),label=`bearing ${shoreBearing} year ${year}`;
      const forts=port.instances.filter(i=>i.prefabId===FORT);
      assert.ok(forts.length>=1,`${label} has a fort`);
      for(const fort of forts){
        const points=emittedPoints(fort,WALL_PARTS),outline=worldOutline(fort);
        for(const other of port.instances){
          if(other===fort||enclosurePlan(other))continue;
          assert.equal(points.find(p=>inFootprint(p,other)),undefined,`${label}: a wall runs through ${other.prefabId}`);
          assert.equal(new Set(footprintCorners(other).map(p=>inOutline(p,outline))).size,1,`${label}: ${other.prefabId} straddles a wall`);
        }
      }
      const inside=port.instances.filter(i=>!enclosurePlan(i)&&inOutline([i.x,i.z],worldOutline(forts[0])));
      assert.ok(inside.length>=5,`${label}: ${inside.length} houses inside`);
    }
  }
});

test('a gun opening never falls where a curtain joins a bastion',()=>{
  const plan=triangularFortPlan(118,90),bays=24,angleOf=bay=>(bay+.5)/bays*Math.PI*2;
  plan.bastions.forEach(([bx,bz],bastion)=>{
    let openings=0;
    for(let bay=0;bay<bays;bay++){
      if(!bastionBayIsEmbrasure(plan,bastion,bay,bays))continue;
      openings++;
      plan.bastions.forEach(([ox,oz],other)=>{
        if(other===bastion)return;
        const turn=Math.atan2(oz-bz,ox-bx)-angleOf(bay);
        assert.ok(Math.abs(Math.atan2(Math.sin(turn),Math.cos(turn)))>Math.PI/bays,`bastion ${bastion} bay ${bay} opens onto a curtain`);
      });
    }
    assert.ok(openings>=2,`bastion ${bastion} keeps openings for its guns`);
  });
});
