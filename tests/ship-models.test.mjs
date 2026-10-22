import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SHIP_MODELS,getShipModel,requirePlayableShipModel,resolveShipNode} from '../js/ship-models.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {mastPoint,RIG_MASTS,climbingPoint,workingTacklePoint} from '../js/rigging.js';
import {SAIL_PLAN,lateenYardPoint,lateenClothPoint} from '../js/lateen.js';
import {anchorCathead,tillerPoint,HULL_VERTICAL_SCALE} from '../js/hull.js';
import {createCompany,CREW_ROSTER} from '../js/crew.js';
const ids=['fore','main','mizzen'];
const boat=()=>({modelId:'nina',length:20,beam:6,rudder:0});
const near=(a,b)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<1e-11,`${a} != ${b}`);};

test('model definitions separate playable reconstructions from reference measurements',()=>{
  assert.ok(Object.isFrozen(SHIP_MODELS)&&Object.isFrozen(getShipModel().nodes));
  assert.deepEqual(getShipModel().runtime,{length:20,beam:6});
  assert.deepEqual(getShipModel().rig.sails.map(s=>s.kind),['lateen','lateen','lateen']);
  for(const id of ['pinta','santa-maria']){
    const model=getShipModel(id);assert.equal(model.status,'ready');
    assert.equal(model.geometry,'additional-procedural-v1');assert.ok(model.runtime.length>20);
    assert.deepEqual(model.rig.sails.slice(0,3).map(s=>s.kind),['square','square','lateen']);
    assert.equal(requirePlayableShipModel(id),model);
    assert.ok(resolveShipNode({...boat(),modelId:id},'helm.grip').every(Number.isFinite));
  }
  const nina=getShipModel().referenceMeasurements[0],santa=getShipModel('santa-maria');
  assert.equal(nina.subject,'modern-replica');assert.equal(nina.tonnage.kind,'tonnage-unspecified');assert.equal(nina.tonnage.unit,null);
  assert.ok(!('mass' in nina.tonnage),'unspecified tonnage cannot become a physical mass');
  assert.equal(santa.referenceMeasurements[0].dimensions.find(d=>d.value===3.49).kind,'hull-depth-not-draft');
  assert.equal(santa.rig.sails.length,5,'multiple sails may share a mast/control group');
  assert.equal(santa.rig.fittings[0].node,'lookout.fore');
  assert.equal(santa.nodes['lookout.fore'].parent,'hull','model-owned absolute design frame');
  assert.match(santa.rig.fittings[0].provenance,/user-requested/i);
});

test('static structure points use the same catheads, masts and nonuniform scale as the ship',()=>{
  for(const [length,beam]of [[20,6],[24,7.2],[16,4.5]]){
    const b={...boat(),length,beam},scale=[beam/3.6,HULL_VERTICAL_SCALE,length/12];
    for(const side of [-1,1])for(const key of ['root','tip','fairlead']){
      const expected=anchorCathead(side)[key],id=`anchor.${side<0?'port':'starboard'}.${key}`;
      near(resolveShipNode(b,id,{space:'design'}),expected);
      near(resolveShipNode(b,id),expected.map((v,i)=>v*scale[i]));
    }
    for(const [i,id]of ids.entries())near(resolveShipNode(b,`mast.${id}.head`,{space:'design'}),mastPoint(i,RIG_MASTS[i].height));
  }
  assert.throws(()=>resolveShipNode(boat(),'missing'),/Unknown.*node/);
  assert.throws(()=>resolveShipNode(boat(),'hull',{space:'screen'}),/coordinate space/);
  assert.throws(()=>resolveShipNode({...boat(),length:Infinity},'hull'),/finite positive/);
});

test('animated nodes and their children follow the actual cloth, yard, runner and tiller',()=>{
  const b=boat();
  for(const side of [-1,-.3,0,.5,1])for(const deployed of [0,.4,1]){
    b.sailState={rig:ids.map((_,i)=>({side,opening:.3+i*.17,dip:.6,fill:.8,deployed,pressure:-1}))};
    for(const [i,id]of ids.entries()){
      const pose=b.sailState.rig[i],options={space:'design',time:1.7,wind:9};
      near(resolveShipNode(b,`sail.${id}.clew`,options),lateenClothPoint(i,0,1,pose,1.7,9));
      near(resolveShipNode(b,`yard.${id}.peak`,options),lateenYardPoint(i,SAIL_PLAN[i].corners[0],pose));
      near(resolveShipNode(b,`sail.${id}`,options),resolveShipNode(b,`yard.${id}`,options));
      near(resolveShipNode(b,`mast.${id}.runner`,{...options,side:-1,step:8.2}),climbingPoint(i,-1,8.2,pose));
      near(resolveShipNode(b,`rig.${id}.fall`,{...options,height:2.4}),workingTacklePoint(i,2.4));
    }
  }
  for(const rudder of [-35,0,35])for(const along of [-.09,0,.09]){
    b.rudder=rudder;near(resolveShipNode(b,'helm.grip',{along}),tillerPoint(b,along));
  }
  const out=new Float64Array(3);assert.equal(resolveShipNode(b,'helm.grip',{out}),out);
});

test('crew identities reuse model-owned stations without sharing live route or pose state',()=>{
  const a=createCompany(),b=createCompany();
  assert.equal(a.modelId,'nina');assert.equal(a.crew.length,12);
  for(const p of CREW_ROSTER){
    assert.equal(p.x,NINA_DESIGN.crewStations[p.id].x);assert.equal(p.z,NINA_DESIGN.crewStations[p.id].z);
    const x=a.crew.find(s=>s.id===p.id),y=b.crew.find(s=>s.id===p.id);
    assert.notEqual(x.route,y.route);assert.notEqual(x.route,NINA_DESIGN.crewStations[p.id].route);
  }
  for(const id of ['pinta','santa-maria']){
    const company=createCompany(undefined,id);assert.equal(company.modelId,id);assert.equal(company.crew.length,12);
    assert.notEqual(company.crew[0].route,getShipModel(id).crewStations[company.crew[0].id].route);
  }
  assert.throws(()=>createCompany(undefined,'unknown-ship'),/Unknown/);
});
