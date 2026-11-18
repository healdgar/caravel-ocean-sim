import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPortGunnery} from '../js/gunnery-control.js';
import {portWorkBuildings} from '../js/fort-plan.js';

// A fort as its board records it (js/old-world-board.js standWorkOf): 40 m square, its deck 5 m up, three guns on its
// north wall looking out to sea (-z) and two on its south wall looking inland.
const BORE={axis:1.07,muzzle:1.74,breech:1.26,calibre:12};
const gun=(x,z,nz,piece)=>({x,y:7,z,nx:0,nz,wall:0,on:0,piece});
const FORT={kind:'fort',form:'bastioned',name:'Fort',x:0,y:2,z:0,turn:0,w:40,d:40,outline:[[-20,-20],[20,-20],[20,20],[-20,20]],
  guns:[gun(-10,-19,-1,1),gun(0,-19,-1,2),gun(10,-19,-1,3),gun(-6,19,1,4),gun(6,19,1,5)],salients:[],gate:null,types:[0,6],bore:BORE};
const CHURCH={id:'church',prefabId:'casa_de_contratacion',x:0,z:-60,y:2,baseY:2,yaw:0,width:30,depth:20,height:16,damageState:null,magazine:null};
const SHIP={id:'ship',x:0,z:-400,heave:0,length:50,beam:14,heading:0,roll:0,pitch:0};

function volley(instances,ship=SHIP){
  const copies=instances.map(b=>({...b}));
  const port={center:{x:0,z:0},instances:copies,works:[FORT]};
  const events=[];
  const guns=createPortGunnery(port,{autoReturnFire:false,getTerrain:()=>({ports:[port]}),onEvent:e=>events.push(e)});
  for(const b of guns.batteries)b.fireAtTarget(ship);
  for(let s=0;s<60;s++)guns.update(.05,[0,0,0]);
  const struck=[...copies,...portWorkBuildings(port)].filter(b=>(b.damageState?.hits??0)>0).map(b=>b.id);
  return {
    shots:events.filter(e=>e.type==='shot').length,
    held:events.filter(e=>e.type==='blocked'&&e.reason==='obstructed').length,
    struck,
  };
}

test('a fort fires over open water',()=>{
  const {shots,struck}=volley([]);
  assert.ok(shots>=3,`${shots} shots`);
  assert.deepEqual(struck,[]);
});

test('a gun holds its fire rather than shoot through its own town',()=>{
  const {shots,held,struck}=volley([CHURCH]);
  assert.ok(held>=1,'the guns behind the church hold');
  assert.equal(shots,0,'and none of them fires into it');
  assert.deepEqual(struck,[],'so the town takes no harm from its own guns');
});

test('a gun whose wall does not face the mark is not laid on it',()=>{
  // Due east of the fort: neither wall's arc reaches it.
  const {shots,held,struck}=volley([],{...SHIP,x:400,z:-10});
  assert.equal(shots,0);
  assert.equal(held,0,'no gun is asked to fire across its own fort');
  assert.deepEqual(struck,[]);
});

test('a fort never strikes itself, firing out over its own works',()=>{
  const {shots,struck}=volley([],{...SHIP,x:150,z:-400});
  assert.ok(shots>=1,`${shots} shots`);
  assert.deepEqual(struck,[]);
});
