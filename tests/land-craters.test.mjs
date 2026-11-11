import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLandCraterLedger,landCraterReach,landCraterSize} from '../js/land-craters.js';
import {applyTerrainImpactDamage} from '../js/gunnery-control.js';
import {createPortDamageStore} from '../js/port-damage.js';
import {LAND_CRATER_TEXELS,LAND_CRATER_CELLS,LAND_CRATER_GUTTER} from '../js/wgsl/land-craters.js';
import {GUNNERY_BUILD} from '../js/wgsl/gunnery.js';

const STRIKE_J=.5*10.9*450*450;

test('a 24-pounder at 450 m/s digs a pit: not a decal, not a bomb hole',()=>{
  const {radius,depth,rim}=landCraterSize(STRIKE_J);
  assert.ok(radius>=1&&radius<=1.5,`${radius} m from middle to rim`);
  assert.ok(depth>=.45&&depth<=.7,`${depth} m deep`);
  assert.ok(rim>=.12&&rim<=.25,`a rim ${rim} m high`);
  // About a cubic metre of ground, which a few per cent of the ball's energy lifts a couple of metres.
  const volume=Math.PI*.5*radius*radius*depth;
  assert.ok(volume>.8&&volume<2,`${volume} m3`);
  assert.ok(volume*1600*9.81*2<STRIKE_J*.1,'lifting it takes a small share of what the ball brought');
  assert.ok(landCraterSize(STRIKE_J/8).radius<radius*.6,'a small gun digs far less');
});

test('a hit on the ground is a crater where it landed, not a dent in the 16 m land mesh',()=>{
  const terrain={height:()=>12,groundSample:()=>12};
  const report=applyTerrainImpactDamage(terrain,{surfacePosition:[10,12,-20],velocity:[-400,-30,-200],mass:10.9,energy:STRIKE_J,normal:[0,1,0]});
  assert.deepEqual(terrain.pendingLandBakes??[],[],'nothing asks to move mesh vertices');
  assert.equal(terrain.pendingCraters.length,1);
  const hit=terrain.pendingCraters[0];
  assert.deepEqual([hit.x,hit.z,hit.energyJ],[10,-20,STRIKE_J]);
  assert.ok(report.craterRadius>=1&&report.craterRadius<=1.5,`reported ${report.craterRadius}`);
  assert.equal(report.craterCount,1);
  assert.equal(terrain.height(10,-20),12,'shot, walkers and hulls keep the height they had');
});

test('repeated hits on one spot deepen and widen one crater; hits elsewhere make another',()=>{
  const ledger=createLandCraterLedger();
  const first=ledger.strike({x:100,z:200,energyJ:STRIKE_J,velocity:[-400,-30,0]});
  const {radius:r1,depth:d1}=landCraterSize(first.energyJ);
  for(let i=0;i<7;i++)assert.equal(ledger.strike({x:100+i*.1,z:200-i*.1,energyJ:STRIKE_J,velocity:[-400,-30,0]}),first,'lands in the same pit');
  const {radius:r8,depth:d8}=landCraterSize(first.energyJ);
  assert.equal(ledger.records.length,1);
  assert.ok(Math.abs(r8/r1-2)<.01,`eight hits double it: ${r1} to ${r8}`);
  assert.ok(Math.abs(d8/d1-2)<.01,`${d1} to ${d8}`);
  assert.ok(Math.hypot(first.x-100.3,first.z-199.7)<.35,'its middle has moved toward the hits');
  ledger.strike({x:110,z:200,energyJ:STRIKE_J,velocity:[-400,-30,0]});
  assert.equal(ledger.records.length,2,'ten metres off is another crater');
  assert.ok(ledger.covers(100,200)&&!ledger.covers(104.5,206),'grass stays out of a pit and grows outside it');
  assert.ok(landCraterSize(1e12).radius<=6.5,'even so a crater has a limit');
});

test('a flat shot and a plunging one are told apart, and a flat one reaches further along its way',()=>{
  const ledger=createLandCraterLedger();
  const flat=ledger.strike({x:0,z:0,energyJ:STRIKE_J,velocity:[-440,-10,0]}),steep=ledger.strike({x:50,z:0,energyJ:STRIKE_J,velocity:[-100,-430,0]});
  assert.ok(flat.grazing>.9&&steep.grazing<.3,`${flat.grazing} ${steep.grazing}`);
  assert.ok(flat.hx<-.99,'its heading is saved with it');
  assert.ok(landCraterReach(flat)>landCraterReach(steep));
});

test('craters are saved in few numbers and come back the same, on a coast laid out anywhere',()=>{
  const origin={x:300,z:-6000},ledger=createLandCraterLedger(null,origin);
  ledger.strike({x:110.5,z:-6118.1,energyJ:STRIKE_J*3,velocity:[-300,-200,-100],sand:.4});
  ledger.strike({x:150,z:-6050,energyJ:STRIKE_J,velocity:[100,-100,-300]});
  const saved=ledger.snapshot();
  assert.equal(saved.length,12);
  assert.ok(saved[2]>saved[8],'largest first');
  const moved={x:-900,z:40},back=createLandCraterLedger(JSON.parse(JSON.stringify(saved)),moved);
  assert.equal(back.records.length,2);
  const [a]=ledger.records,[b]=back.records;
  assert.ok(Math.abs(b.x-moved.x-(a.x-origin.x))<.06&&Math.abs(b.z-moved.z-(a.z-origin.z))<.06,'in the same place on its coast');
  assert.ok(Math.abs(b.energyJ-a.energyJ)<1000);
  assert.ok(Math.abs(b.grazing-a.grazing)<.01&&Math.abs(b.sand-a.sand)<.01);
  assert.ok(Math.hypot(b.hx-a.hx,b.hz-a.hz)<.02);
  assert.deepEqual(back.snapshot(),saved,'and saved again they are the same numbers');
  assert.deepEqual(createLandCraterLedger().snapshot(),undefined,'no craters, nothing saved');
});

test('the save and the share link carry the ground, and neither grows out of hand',()=>{
  const store=createPortDamageStore(),ledger=createLandCraterLedger(store.openGround('lisbon'));
  assert.equal(store.snapshot(),undefined,'nothing yet');
  assert.equal(store.forLink(null),undefined);
  for(let i=0;i<200;i++)ledger.strike({x:i*30-3000,z:-6000+i*7,energyJ:STRIKE_J+i*1000,velocity:[-300,-200,-100]});
  store.setGround('lisbon',ledger.snapshot());
  const career=JSON.parse(JSON.stringify(store.snapshot()));
  assert.ok(JSON.stringify(career).length/200<45,`${JSON.stringify(career).length/200} characters a crater in the save`);
  const again=createPortDamageStore(career).openGround('lisbon');
  assert.equal(again.length,200*6);
  assert.equal(createPortDamageStore(career).openGround('havana'),null,'another coast has none of them');
  const link=store.forLink(null),kept=link['@ground'].lisbon;
  assert.equal(kept.length,60*6,'a share link keeps the largest sixty');
  assert.equal(kept[2],ledger.snapshot()[2]);
  assert.ok(JSON.stringify(link).length<3000,`${JSON.stringify(link).length} characters in the link`);
  // Buildings are not disturbed by their neighbour in the record.
  assert.equal(createPortDamageStore(career).restore({regionId:'lisbon',instances:[]}),0);
});

test('tiles have the texels their compute shader is written for',()=>{
  assert.equal(LAND_CRATER_TEXELS,LAND_CRATER_CELLS+1+2*LAND_CRATER_GUTTER);
  assert.equal(LAND_CRATER_TEXELS%9,0,'dispatched in workgroups of 9 by 9');
});

test('new per-frame work stays off the CPU: crater tiles are written only when something changes',()=>{
  const source=readFileSync(new URL('../js/land-craters.js',import.meta.url),'utf8');
  const draw=source.slice(source.indexOf('    draw(pass, section'),source.indexOf('    // What the tiles hold'));
  assert.ok(draw.length>0&&!/writeBuffer|writeTexture|submit|createBuffer/.test(draw),'drawing writes nothing');
  const follow=source.slice(source.indexOf('    follow(camera)'),source.indexOf('    draw(pass, section'));
  assert.match(follow,/if \(!overflow\) return;/,'and following the camera is nothing at all unless the tiles have run out');
  const effects=readFileSync(new URL('../js/gunnery-effects.js',import.meta.url),'utf8');
  // Smoke volumes are laid out on the GPU from guns and fires alone: the stages that build them are never handed a strike.
  assert.doesNotMatch(effects,/writeBuffer\(volumeBuffer/,'no smoke volume is built or sent from JavaScript');
  assert.doesNotMatch(GUNNERY_BUILD({shots:1,banks:1,fires:1}),/[cC]ontact/,'thrown earth and dust add no smoke volume');
  assert.match(effects,/get smoke\(\)\{return !!\(shots\.length\|\|banks\.length\);\}/,'and a strike alone keeps no smoke pass running');
});
