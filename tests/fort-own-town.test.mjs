import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPortGunnery} from '../js/gunnery-control.js';

const FORT={id:'fort',prefabId:'bastion_trace_fortress',x:0,z:0,y:2,baseY:2,yaw:0,width:40,depth:40,height:7,damageState:null,magazine:null};
const CHURCH={id:'church',prefabId:'casa_de_contratacion',x:0,z:-60,y:2,baseY:2,yaw:0,width:30,depth:20,height:16,damageState:null,magazine:null};
const SHIP={id:'ship',x:0,z:-400,heave:0,length:50,beam:14,heading:0,roll:0,pitch:0};

function volley(instances,ship=SHIP){
  const copies=instances.map(b=>({...b}));
  const port={center:{x:0,z:0},instances:copies};
  const events=[];
  const guns=createPortGunnery(port,{autoReturnFire:false,getTerrain:()=>({ports:[port]}),onEvent:e=>events.push(e)});
  for(const b of guns.batteries)b.fireAtTarget(ship);
  for(let s=0;s<60;s++)guns.update(.05,[0,0,0]);
  const struck=copies.filter(b=>(b.damageState?.hits??0)>0).map(b=>b.id);
  return {
    shots:events.filter(e=>e.type==='shot').length,
    held:events.filter(e=>e.type==='blocked'&&e.reason==='obstructed').length,
    struck,
  };
}

test('a fort fires over open water',()=>{
  const {shots,struck}=volley([FORT]);
  assert.ok(shots>=3,`${shots} shots`);
  assert.deepEqual(struck,[]);
});

test('a gun holds its fire rather than shoot through its own town',()=>{
  const {shots,held,struck}=volley([FORT,CHURCH]);
  assert.ok(held>=1,'the guns behind the church hold');
  assert.equal(shots,0,'and none of them fires into it');
  assert.deepEqual(struck,[],'so the town takes no harm from its own guns');
});

test('a gun on the far side of its own fort holds too',()=>{
  // The gun on the west wall, with the mark across the fort to the east.
  const {held,struck}=volley([FORT],{...SHIP,x:400,z:-10});
  assert.ok(held>=1,'the west wall gun holds');
  assert.deepEqual(struck,[]);
});
