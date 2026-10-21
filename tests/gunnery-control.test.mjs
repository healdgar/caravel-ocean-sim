// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createShipGunnery} from '../js/gunnery-control.js';
import {GUNNERY_ORDER_SECONDS} from '../js/gunnery-audio.js';
import {boatHydrodynamics} from '../js/boat.js';
function fixture(options={}){
 const boat={modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',surgeVelocity:0};
 boat.hydrodynamics=boatHydrodynamics(20,6);const events=[],orders=[];
 const guns=createShipGunnery(boat,{onEvent:e=>events.push(e),onOrder:id=>orders.push(id),...options});
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));return {boat,guns,events,orders};
}
function advance(guns,time){for(let t=0;t<time-1e-8;t+=.05)guns.update(Math.min(.05,time-t),[0,0,0]);}
test('gun drill needs attended stations; full readiness precedes a captain-ordered single discharge',()=>{
 const {boat,guns,events,orders}=fixture();boat.gunneryAttendance.clear();assert.equal(guns.prepare('port'),true);
 advance(guns,40);assert.equal(guns.summary('port').ready,0);assert.equal(guns.fire('port'),false);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));advance(guns,34);
 assert.equal(guns.summary('port').ready,2);assert.equal(events.filter(e=>e.type==='ready').length,1);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.fire('port'),true);
 advance(guns,GUNNERY_ORDER_SECONDS['fire-port']-.1);assert.equal(events.filter(e=>e.type==='shot').length,0);
 advance(guns,1);assert.equal(events.filter(e=>e.type==='shot').length,2);assert.deepEqual(orders,['prepare','fire-port']);
 advance(guns,40);assert.equal(events.filter(e=>e.type==='shot').length,2);assert.equal(guns.summary('port').spent,2);
 assert.ok(Number.isFinite(boat.rollVelocity));assert.ok(Math.abs(boat.rollVelocity)>0);
});
test('cease cancels ordered and queued guns without deleting airborne shot',()=>{
 const {guns,events}=fixture();guns.prepare('starboard');advance(guns,34);guns.fire('starboard');guns.cease();advance(guns,4);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('starboard').ready,2);
 guns.fire('starboard');advance(guns,GUNNERY_ORDER_SECONDS['fire-starboard']+.04);assert.equal(events.filter(e=>e.type==='shot').length,1);
 const live=guns.state.projectiles.length;guns.cease();advance(guns,.4);assert.equal(events.filter(e=>e.type==='shot').length,1);assert.equal(guns.state.projectiles.length,live);
});
test('selected battery and crew attendance interlock invalid, abandoned and braced firing orders',()=>{
 const {boat,guns,events}=fixture();assert.equal(guns.prepare('nonsense'),false);assert.equal(guns.fire('nonsense'),false);
 guns.prepare('port');advance(guns,34);assert.equal(guns.canFire('port'),true);
 boat.gunneryAttendance.clear();assert.equal(guns.fire('port'),false);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));guns.fire('port');boat.gunneryAttendance.clear();advance(guns,3);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('port').ready,2);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));guns.prepare('starboard');advance(guns,34);assert.equal(guns.fire('port'),false);
 assert.equal(guns.prepare('port'),true);boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));
 assert.equal(guns.canFire('port'),true);assert.equal(guns.fire('nonsense'),false);
});
test('standing down releases stations, preserves loaded guns and cancels a pending broadside',()=>{
 const {boat,guns,events}=fixture();guns.prepare('port');advance(guns,34);guns.fire('port');guns.standDown();advance(guns,4);
 assert.equal(boat.gunnerySide,null);assert.equal(guns.summary('port').ready,2);assert.equal(events.filter(e=>e.type==='shot').length,0);
 assert.equal(guns.canFire('port'),false);assert.equal(guns.prepare('port'),true);assert.equal(guns.canFire('port'),true);
 guns.standDown();guns.prepare('starboard');advance(guns,5);guns.standDown();assert.equal(guns.summary('starboard').loading,0);
 guns.prepare('starboard');assert.ok(guns.state.guns.filter(g=>g.side==='starboard').every(g=>g.stage==='swab'&&g.progress===0));
});

test('fresh gunport clearance is required at the order and again at each discharge',()=>{
 let held='Checking sea at gunports';const {guns,events}=fixture({muzzleBlock:()=>held});
 guns.prepare('port');advance(guns,34);assert.equal(guns.summary('port').ready,2);
 assert.equal(guns.fire('port'),false);assert.equal(guns.blockedReason('port'),held);
 held=null;assert.equal(guns.fire('port'),true);held='Gunports awash';advance(guns,3);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('port').ready,2);
 assert.equal(guns.state.projectiles.length,0);assert.equal(guns.blockedReason('port'),held);
 held=null;assert.equal(guns.fire('port'),true);advance(guns,3);assert.equal(events.filter(e=>e.type==='shot').length,2);
});
