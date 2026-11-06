import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FREE_CANNON_INTERVAL_S,createFreeCannon} from '../js/free-cannon.js';
import {createBuildingGunDefinitions,createPortGunnery} from '../js/gunnery-control.js';
import {createGunneryState} from '../js/gunnery-state.js';
import {createNavalBattleGunDefinitions} from '../js/gunnery-models.js';
import {boatHydrodynamics} from '../js/boat.js';
import {createPortDamageStore} from '../js/port-damage.js';

const HOUSE={id:'house',prefabId:'casa_de_contratacion',x:0,z:-100,y:0,baseY:0,yaw:0,width:30,depth:20,height:12,damageState:null};
const VIEW={eye:[0,8,0],forward:[0,0,-1],wind:[0,0,0]};

function hold(seconds,firing=true){
  const house={...HOUSE},events=[];
  const port={center:{x:0,z:0},instances:[house]};
  const cannon=createFreeCannon({getTerrain:()=>({ports:[port]}),onEvent:e=>events.push(e)});
  for(let t=0;t<seconds;t+=1/60)cannon.update(1/60,{...VIEW,firing});
  return {house,cannon,shots:events.filter(e=>e.type==='shot'),hits:events.filter(e=>e.type==='impact'&&e.kind==='building')};
}

test('it fires once a second at most, however long the key is held',()=>{
  assert.equal(FREE_CANNON_INTERVAL_S,1);
  const {shots}=hold(4.5);
  assert.equal(shots.length,5);
  for(let i=1;i<shots.length;i++)assert.ok(shots[i].time-shots[i-1].time>=.99,`gap ${shots[i].time-shots[i-1].time}`);
});

test('it is a 24-pounder like any other: same ball, same muzzle velocity, same flight',()=>{
  const free=createFreeCannon().state.guns[0];
  const boat={id:'v',modelId:'victory',length:56,beam:15,x:0,z:0,heave:0,heading:0,roll:0,pitch:0,sailFore:1,sailMain:1,sailMizzen:1,cargoTonnes:0};
  boat.hydrodynamics=boatHydrodynamics(56,15,30,0,'victory');
  const real=[
    ...createGunneryState(createNavalBattleGunDefinitions(boat)).guns.filter(g=>g.calibre===24),
    ...createGunneryState(createBuildingGunDefinitions({prefabId:'stone_sea_bastion',width:28,length:34,height:11.5})).guns.filter(g=>g.calibre===24),
  ];
  assert.ok(real.length>10,`${real.length} real 24-pounders to compare`);
  for(const gun of real)for(const key of ['mass','diameter','muzzleSpeed','speedVariation','dispersion','dragCoefficient'])
    assert.equal(free[key],gun[key],`${key} on ${gun.id}`);
  assert.equal(free.muzzleSpeed,470);
  const {shots}=hold(1.5);
  for(const shot of shots)assert.ok(Math.abs(shot.muzzleSpeed-470)<=470*free.speedVariation+1e-9,`${shot.muzzleSpeed} m/s`);
});

test('it stays silent unless told to fire',()=>{
  assert.equal(hold(3,false).shots.length,0);
});

test('its balls fly where the camera looks and do real damage',()=>{
  const {house,hits}=hold(3);
  assert.ok(hits.length>=2,`${hits.length} hits`);
  assert.equal(hits[0].building.id,'house');
  assert.ok(hits[0].damageReport,'the impact is resolved against the building');
  assert.ok(house.damageState.hits>=2);
});

test('no fort answers it by firing on a ship, nor on arrival at a port saved battered',()=>{
  const fort={id:'fort',prefabId:'bastion_trace_fortress',x:0,z:-100,y:2,baseY:2,yaw:0,width:40,depth:40,height:7,damageState:null,magazine:null};
  const ship={id:'ship',x:150,z:-100,heave:0,length:30,beam:8,heading:0,roll:0,pitch:0};
  const port={center:{x:0,z:0},instances:[fort]};
  const guns=createPortGunnery(port,{getVessels:()=>[ship],getTerrain:()=>({ports:[port]})});
  const aimed=[];
  for(const b of guns.batteries){const fire=b.fireAtTarget;b.fireAtTarget=(t,o)=>{aimed.push(t.id);return fire(t,o);};}
  const cannon=createFreeCannon({getVessels:()=>[ship],getTerrain:()=>({ports:[port]})});
  for(let t=0;t<12;t+=1/30){cannon.update(1/30,{...VIEW,firing:true});guns.update(1/30);}
  assert.ok(fort.damageState.hits>0,'the shells land');
  assert.deepEqual(aimed,[],'and the fort holds its fire');

  const store=createPortDamageStore();
  store.capture(port);
  const home={...fort,damageState:null,gunnery:null};
  const again={center:{x:0,z:0},instances:[home]};
  assert.equal(store.restore(again),1);
  assert.ok(home.damageState.hits>0);
  const held=createPortGunnery(again,{getVessels:()=>[ship],getTerrain:()=>({ports:[again]})});
  const fired=[];
  for(const b of held.batteries){const fire=b.fireAtTarget;b.fireAtTarget=(t,o)=>{fired.push(t.id);return fire(t,o);};}
  for(let t=0;t<12;t+=.5)held.update(.5);
  assert.deepEqual(fired,[],'old wounds alone start no fight');
});
