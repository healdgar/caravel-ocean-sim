// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CAREER_SAVE_KEY,CAREER_SESSION_KEY,createCareerStore,parseCareerSave,createCareerSave,nearestFoundedPort,applyShipwreckRecovery,careerGreatCircleKm,SHIPWRECK_PROVISION_DAYS,SHIPWRECK_REPLACEMENT_HULL} from '../js/career-save.js';
import {careerSaveSummary} from '../js/career-ui.js';
import {HISTORICAL_COLONIAL_PORTS} from '../js/coastal-world.js';
import {createVoyage,serializeVoyage,restoreVoyage} from '../js/voyage/passage.js';

function memory(initial={}){
  const map=new Map(Object.entries(initial));
  return {map,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>{map.set(k,String(v));},removeItem:k=>{map.delete(k);}};
}
const voyageJson=(extra={})=>JSON.stringify({version:1,true:{lat:1,lon:2},dr:{lat:1,lon:2},shipName:'Niña',dateMs:Date.UTC(1550,2,24),dayAtSea:3,...extra});

test('a tab that does not own the save can never overwrite it',()=>{
  const storage=memory(),first=createCareerStore({storage,session:memory()});
  first.claim();first.voyageStorage.setItem('k',voyageJson({dayAtSea:41}));
  assert.equal(first.read().voyage.dayAtSea,41);
  const scenario=createCareerStore({storage,session:memory()});
  assert.equal(scenario.owned(),false);assert.equal(scenario.has(),true);
  scenario.voyageStorage.setItem('k',voyageJson({dayAtSea:1}));
  assert.equal(scenario.write({voyage:{dayAtSea:2}}),false);
  scenario.voyageStorage.removeItem('k');
  assert.equal(first.read().voyage.dayAtSea,41,'the shared link changed nothing');
  scenario.claim();scenario.voyageStorage.setItem('k',voyageJson({dayAtSea:42}));
  assert.equal(first.read().voyage.dayAtSea,42,'owning it by choice allows saving');
});

test('one record holds voyage, vessel, world and career, and each write keeps the rest',()=>{
  const storage=memory(),store=createCareerStore({storage,session:memory(),now:()=>1234,getSnapshot:()=>({vessel:{colors:'france'},sovereignty:{allegiance:'crown'},url:'http://x/?a=1'})});
  store.claim();store.write({career:{shipsLost:2}});
  store.voyageStorage.setItem('k',voyageJson());
  assert.deepEqual([...storage.map.keys()],[CAREER_SAVE_KEY],'nothing else is written');
  const save=store.read();
  assert.equal(save.version,1);assert.equal(save.era,'new-world');assert.equal(save.savedAtMs,1234);
  assert.equal(save.vessel.colors,'france');assert.equal(save.sovereignty.allegiance,'crown');assert.equal(save.url,'http://x/?a=1');
  assert.equal(save.career.shipsLost,2,'a voyage autosave keeps the career');
  assert.equal(JSON.parse(store.voyageStorage.getItem('k')).shipName,'Niña');
  store.clear();assert.equal(store.has(),false);assert.equal(store.voyageStorage.getItem('k'),null);
});

test('the controller save path round-trips a real voyage',()=>{
  const store=createCareerStore({storage:memory(),session:memory()});store.claim();
  const voyage=createVoyage({lat:38.7,lon:-9.1,departureName:'Lisboa',modelId:'nina',shipName:'Niña'});
  voyage.dayAtSea=12;voyage.keepSaved=true;
  store.voyageStorage.setItem('ignored',serializeVoyage(voyage));
  const back=restoreVoyage(store.voyageStorage.getItem('ignored'));
  assert.equal(back.dayAtSea,12);assert.equal(back.keepSaved,true);assert.equal(back.tier,'deck');
});

test('corrupt, foreign or blocked storage reads as no save and never throws',()=>{
  assert.equal(parseCareerSave('{oops'),null);assert.equal(parseCareerSave('{"version":99}'),null);assert.equal(parseCareerSave(null),null);
  const blocked={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
  const store=createCareerStore({storage:blocked,session:blocked});
  assert.equal(store.read(),null);assert.equal(store.has(),false);assert.equal(store.owned(),false);
  store.claim();store.clear();assert.equal(store.write({}),false);
  const none=createCareerStore();assert.equal(none.has(),false);assert.equal(none.owned(),false);
  const quota=createCareerStore({storage:{...memory(),setItem(){throw new Error('quota');}},session:memory()});
  quota.claim();assert.equal(quota.write({voyage:{}}),false);
  assert.equal(parseCareerSave(createCareerSave()).career.shipsLost,0);
  const session=memory({[CAREER_SESSION_KEY]:'1'});
  assert.equal(createCareerStore({session}).owned(),true);
});

test('survivors make for the nearest port that exists yet',()=>{
  const ports=[{id:'old',name:'Old',latitude:10,longitude:-60,foundedYear:1500},{id:'new',name:'New',latitude:10,longitude:-61,foundedYear:1600},{id:'far',name:'Far',latitude:40,longitude:-10}];
  assert.equal(nearestFoundedPort(ports,10,-61,1550).id,'old','a port not yet founded cannot shelter anyone');
  assert.equal(nearestFoundedPort(ports,10,-61,1650).id,'new');
  assert.equal(nearestFoundedPort(ports,39,-9,1550).id,'far','a port with no founding date always exists');
  assert.equal(nearestFoundedPort([],0,0,1550),null);
  assert.equal(nearestFoundedPort(HISTORICAL_COLONIAL_PORTS,18,-70,1550).id,'santo-domingo');
  assert.ok(Math.abs(careerGreatCircleKm(0,0,0,1)-111.2)<.2);
  assert.equal(careerGreatCircleKm(5,5,5,5),0);
});

test('a shipwreck costs the ship and the hold, but the voyage and its log go on',()=>{
  const voyage=createVoyage({lat:15,lon:-40,departureName:'Lisboa',modelId:'nina',shipName:'Niña',crew:24});
  voyage.provisions.food=50;voyage.provisions.water=3;voyage.morale=.9;voyage.dayAtSea=33;voyage.destination={lat:1,lon:1};voyage.arrived=true;voyage.interrupt={type:'shipwreck'};
  const logged=voyage.log.length,port={id:'santo-domingo',name:'Santo Domingo',latitude:18.47,longitude:-69.88};
  const damage={crewCasualties:{total:24,able:15,wounded:5,killed:4}};
  const next=applyShipwreckRecovery({career:{shipsLost:1},vessel:{colors:'france',cargoTonnes:40}},{voyage,damage,shipName:'Niña',port});
  assert.equal(next.career.shipsLost,2);
  assert.equal(next.voyage.true.lat,18.47);assert.equal(next.voyage.dr.lon,-69.88,'she is really there, whatever the reckoning said');
  assert.equal(next.voyage.provisions.food,SHIPWRECK_PROVISION_DAYS,'a full hold is lost');
  assert.equal(next.voyage.provisions.water,3,'short stores are not topped up');
  assert.ok(next.voyage.morale<.9);assert.equal(next.voyage.dayAtSea,33);
  assert.equal(next.voyage.destination,null);assert.equal(next.voyage.arrived,false);assert.equal(next.voyage.interrupt,null);
  assert.equal(next.voyage.passive,true,'she starts moored, not under way');assert.equal(next.voyage.keepSaved,true);
  assert.equal(next.voyage.log.length,logged+1);assert.match(next.voyage.log.at(-1).text,/12 survivors reached Santo Domingo/);
  assert.equal(next.vessel.cargoTonnes,0);assert.equal(next.vessel.colors,'france');
  assert.equal(next.vessel.damage.hullIntegrity,SHIPWRECK_REPLACEMENT_HULL);
  assert.deepEqual(next.vessel.damage.crewCasualties,{total:24,able:12,wounded:0,killed:12});
  assert.equal(next.vessel.damage.sunk,undefined,'the replacement ship is afloat');
  const noCrew=applyShipwreckRecovery({},{voyage:null,damage:{crewCasualties:{total:24,able:0,wounded:0,killed:24}},port});
  assert.equal(noCrew.vessel.damage.crewCasualties.able,4,'a minimum crew always makes it, or play could not continue');
  assert.equal(noCrew.career.shipsLost,1);
});

test('the continue prompt summarizes a save in the voyage’s own terms',()=>{
  const save={voyage:{shipName:'Niña',dateMs:Date.UTC(1550,2,24),dayAtSea:12},career:{shipsLost:2}};
  assert.match(careerSaveSummary(save),/^Niña · .*1550 · day 12 · 2 ships lost$/);
  assert.doesNotMatch(careerSaveSummary({...save,career:{shipsLost:0}}),/lost/);
  assert.equal(careerSaveSummary({}),'');
});
