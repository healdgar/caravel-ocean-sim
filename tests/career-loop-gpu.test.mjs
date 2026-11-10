// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The foundation of the career loop, played through the real game in a real page.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
    :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

const ready=page=>page.waitForFunction(()=>window.oceanStartup?.state==='ready',null,{timeout:180000});
async function open(context,path='/'){
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+path);await ready(page);
  return {page,errors};
}
const calloutButtons=page=>page.evaluate(()=>{const c=document.querySelector('.voyage-callout');return c&&!c.hidden?[...c.querySelectorAll('button')].map(b=>b.textContent):[];});
const choose=(page,label)=>page.locator('.voyage-callout button').filter({hasText:label}).first().click();
const sightSail=page=>page.evaluate(()=>document.getElementById('sight-sail-btn').click());
const framesPerSecondAlive=page=>page.evaluate(()=>new Promise(resolve=>{let frames=0;const start=performance.now();const tick=()=>{frames++;performance.now()-start<1000?requestAnimationFrame(tick):resolve(frames);};requestAnimationFrame(tick);}));

test('a captain who has stood with a native nation may give them the prize',{timeout:420000},async()=>{
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  try{
    // He arrives having gone over to the Taíno: armed their settlement, defended it, proclaimed their sovereignty.
    const {page,errors}=await open(context,'/?sovereignPolity=taino-greater-antilles');
    await sightSail(page);await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='sail');
    const captured=await page.evaluate(()=>{const db=window.oceanDockingBoarding,target=window.oceanFleet.vessels[1];return Boolean(db.capturePrizeVessel(target,'boarded-and-fought'));});
    assert.equal(captured,true);
    await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='prize-disposition',null,{timeout:10000});
    const buttons=await calloutButtons(page);
    assert.equal(buttons.length,4);
    assert.match(buttons.find(b=>b.includes('Indigenous')),/Gift Prize(?: & Cannon)? to Indigenous Allies \(\+\d+ d food, \+\d+ d water\)/);
    for(const kind of ['Fleet','Impress','Scuttle'])assert.ok(buttons.some(b=>b.includes(kind)),`${kind} is still offered`);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('a captured ship offers truthful prize choices and impressing her crew keeps the game running',{timeout:420000},async()=>{
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  try{
    const {page,errors}=await open(context);
    assert.equal(await page.locator('#career-prompt').count(),0,'nothing to continue on a first visit');
    await sightSail(page);await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='sail');
    // Surrendered and alongside: this test is about the prize, not the melee's outcome.
    const captured=await page.evaluate(()=>{const db=window.oceanDockingBoarding,target=window.oceanFleet.vessels[1];return Boolean(db.capturePrizeVessel(target,'boarded-and-fought'));});
    assert.equal(captured,true);
    await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='prize-disposition',null,{timeout:10000});
    const buttons=await calloutButtons(page);
    // Fleet, impress, scuttle. A captain who has met no native nation has none to give the prize to.
    assert.equal(buttons.length,3);
    assert.equal(buttons.some(b=>b.includes('Indigenous')),false,'no gift is offered before any contact');
    assert.match(buttons.find(b=>b.includes('Fleet')),/Add to Fleet as Allied Consort \(\+\d+ d food, \+\d+ d water\)/);
    assert.match(buttons.find(b=>b.includes('Impress')),/Impress \d+ Hands & Plunder 4 Cannon \(\+24 d food, \+18 d water\)/);
    assert.match(buttons.find(b=>b.includes('Scuttle')),/hull \+55%/);
    const before=await page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat;return {able:b.damage.crewCasualties.able,actors:window.oceanFleet.vessels[0].crew.state.crew.length,food:window.oceanVoyage.voyage.provisions.food};});
    await choose(page,'Impress');await page.waitForTimeout(1500);
    const afterwards=await page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat;return {able:b.damage.crewCasualties.able,actors:window.oceanFleet.vessels[0].crew.state.crew.length,food:window.oceanVoyage.voyage.provisions.food,firepower:b.plunderedFirepowerMultiplier};});
    assert.ok(afterwards.able>before.able,'pressed hands reach the muster');
    assert.equal(afterwards.actors,before.actors,'the animated company stays intact');
    assert.ok(afterwards.food>before.food+20,'the promised stores arrive');
    assert.equal(afterwards.firepower,1.25);
    assert.ok(await framesPerSecondAlive(page)>0);
    assert.deepEqual(errors,[],'no frame threw after impressing');
    // The plundered hulk does not come back as the next ship.
    await page.evaluate(()=>{const d=window.oceanFleet.vessels[1].boat.damage;d.sunk=true;d.settledWreck=true;d.hullIntegrity=.1;d.floodingTonnes=40;d.crewCasualties.killed=9;});
    await sightSail(page);await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='sail');
    const next=await page.evaluate(()=>{const b=window.oceanFleet.vessels[1].boat,d=b.damage;return {sunk:d.sunk,settled:d.settledWreck,hull:d.hullIntegrity,flood:d.floodingTonnes,killed:d.crewCasualties.killed,captured:b.captured,disarmed:b.disarmedPrize,order:window.oceanFleet.vessels[1].follower.captainOrder};});
    assert.deepEqual(next,{sunk:false,settled:false,hull:1,flood:0,killed:0,captured:false,disarmed:false,order:null});
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(()=>window.oceanFleet.vessels[1].boat.damage.sunk),false,'she does not founder on arrival');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('losing the ship takes you to the nearest port, and a saved voyage survives everything except your own choice',{timeout:600000},async()=>{
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  try{
    const {page,errors}=await open(context);
    await page.evaluate(()=>window.oceanVoyage.setWarp('watch'));
    await page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat;b.damage.crewCasualties.able=20;b.damage.sunk=true;});
    await page.waitForFunction(()=>window.oceanVoyage.voyage.interrupt?.type==='shipwreck',null,{timeout:15000});
    assert.deepEqual(await calloutButtons(page),['Take to the boats']);
    await page.evaluate(()=>window.oceanVoyage.setWarp('crossing'));
    assert.equal(await page.evaluate(()=>window.oceanVoyage.voyage.interrupt?.type),'shipwreck','warp cannot wave the wreck away');
    const logged=await page.evaluate(()=>window.oceanVoyage.voyage.log.length);
    await choose(page,'Take to the boats');
    await page.waitForURL(url=>url.searchParams.get('landfall')==='dock',{timeout:60000});await ready(page);
    const after=await page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat,v=window.oceanVoyage.voyage,save=JSON.parse(localStorage.getItem('waterworld.career.v1'));return {sunk:b.damage.sunk,hull:b.damage.hullIntegrity,able:b.damage.crewCasualties.able,food:v.provisions.food,water:v.provisions.water,passive:v.passive,log:v.log.map(l=>l.text),lost:save.career.shipsLost};});
    assert.equal(after.sunk,false);assert.equal(after.hull,.7);assert.equal(after.able,12);
    assert.ok(after.food<=14&&after.water<=14);assert.equal(after.passive,true);assert.equal(after.lost,1);
    assert.ok(after.log.length>logged);assert.ok(after.log.some(t=>/survivors reached/.test(t)),'the wreck is in the log');
    assert.deepEqual(errors,[]);
    await page.close();
    // A later visit asks first, and continuing restores the career.
    const second=await open(context);
    assert.match(await second.page.locator('#career-prompt .career-summary').textContent(),/Niña.*1 ship lost/);
    await second.page.locator('.career-continue').click();
    await second.page.waitForURL(url=>url.search.length>0,{timeout:60000});await ready(second.page);
    assert.equal(await second.page.locator('#career-prompt').count(),0);
    const resumed=await second.page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat,v=window.oceanVoyage.voyage;return {hull:b.damage.hullIntegrity,able:b.damage.crewCasualties.able,log:v.log.map(l=>l.text)};});
    assert.equal(resumed.hull,.7);assert.equal(resumed.able,12);assert.ok(resumed.log.some(t=>/survivors reached/.test(t)));
    assert.deepEqual(second.errors,[]);
    await second.page.close();
    // A scenario link in another tab cannot touch it.
    const scenario=await open(context,'/?region=havana&landfall=coast&boat=1');
    assert.equal(await scenario.page.locator('#career-prompt').count(),0);
    await sightSail(scenario.page);await scenario.page.waitForTimeout(6500);
    assert.equal(await scenario.page.evaluate(()=>JSON.parse(localStorage.getItem('waterworld.career.v1')).career.shipsLost),1);
    assert.ok(await scenario.page.evaluate(()=>JSON.parse(localStorage.getItem('waterworld.career.v1')).voyage.log.some(l=>/survivors reached/.test(l.text))));
    await scenario.page.close();
    // Only an explicit second click erases it.
    const third=await open(context);
    const erase=third.page.locator('.career-new');
    await erase.click();
    assert.equal(await erase.textContent(),'Erase saved voyage?');
    assert.notEqual(await third.page.evaluate(()=>localStorage.getItem('waterworld.career.v1')),null);
    await erase.click();
    assert.equal(await third.page.evaluate(()=>localStorage.getItem('waterworld.career.v1')),null);
    assert.equal(await third.page.locator('#career-prompt').count(),0);
    assert.deepEqual(third.errors,[]);
  }finally{await context.close();}
});

test('a trading voyage turns cloth into money across two real ports and ends in retirement',{timeout:420000},async()=>{
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  try{
    const stageUrl=async(page,id)=>page.evaluate(async id=>{const {coastalRegionStageURL}=await import('/js/landfall.js');return coastalRegionStageURL(location.origin+'/',id,'dock','clear',1550).toString();},id);
    const first=await open(context);
    const lisbon=await stageUrl(first.page,'lisbon');
    await first.page.goto(lisbon);await ready(first.page);
    const call=first.page.locator('#port-call');
    await call.waitFor({state:'visible',timeout:15000});
    assert.match(await call.textContent(),/Moor and go ashore/);
    assert.match(await call.getAttribute('aria-label'),/Lisbon/);
    await call.click();
    await first.page.waitForFunction(()=>document.getElementById('port-call').textContent.startsWith('Go ashore'),null,{timeout:30000});
    await call.click();
    await first.page.locator('#port-panel').waitFor({state:'visible'});
    assert.match(await first.page.locator('#port-panel-title').textContent(),/Lisbon/);
    assert.equal(await first.page.locator('[data-action="buy-sugar"]').count(),0,'Lisbon does not grow sugar');
    const purseBefore=await first.page.evaluate(()=>window.oceanCareerPort.purse);
    await first.page.locator('[data-action="buy-cloth"]').click();
    await first.page.locator('[data-action="buy-cloth"]').click();
    const bought=await first.page.evaluate(()=>({purse:window.oceanCareerPort.purse,cargo:window.oceanFleet.vessels[0].boat.cargoTonnes,held:window.oceanCareerPort.ledger.cargo.cloth}));
    assert.equal(bought.held,2);
    assert.equal(bought.cargo,2,'cargo really loads the hull');
    assert.ok(bought.purse<purseBefore);
    assert.match(await first.page.locator('.voyage-stores').textContent(),/pesos/);
    // The pilot takes her out to open water, with no land left to run onto.
    await first.page.locator('[data-action="put-to-sea"]').click();
    await first.page.locator('#port-panel').waitFor({state:'detached'});
    await first.page.waitForFunction(()=>window.oceanVoyage.voyage.log.some(entry=>/Dropped the pilot/.test(entry.text)),null,{timeout:30000});
    const atSea=await first.page.evaluate(()=>({here:window.oceanCareerPort.here,moored:window.oceanDockingBoarding.state.mooringPhase,purse:window.oceanCareerPort.purse,hull:window.oceanFleet.vessels[0].boat.damage.hullIntegrity}));
    assert.equal(atSea.here,null,'the harbor is behind her');
    assert.equal(atSea.moored,'clear');
    assert.equal(atSea.purse,bought.purse-12,'the pilot is paid');
    assert.equal(atSea.hull,1);
    // Crossing an ocean is the voyage's own subject. She fetches up off the far port.
    await first.page.evaluate(()=>{const v=window.oceanVoyage.voyage;v.dateMs+=40*86400000;v.true={...v.true,lat:23.26,lon:-82.35};v.dr={...v.dr,lat:23.26,lon:-82.35};});
    await first.page.waitForFunction(()=>document.getElementById('port-call').textContent==='Take a pilot in'&&!document.getElementById('port-call').hidden,null,{timeout:15000});
    await Promise.all([first.page.waitForNavigation({timeout:60000}),call.click()]);
    await ready(first.page);
    const resumed=await first.page.evaluate(()=>({held:window.oceanCareerPort.ledger.cargo.cloth,cargo:window.oceanFleet.vessels[0].boat.cargoTonnes}));
    assert.equal(resumed.held,2,'the cargo crossed in the save');
    assert.equal(resumed.cargo,2,'and still loads the hull');
    await call.waitFor({state:'visible',timeout:15000});
    await call.click();
    await first.page.waitForFunction(()=>document.getElementById('port-call').textContent.startsWith('Go ashore'),null,{timeout:30000});
    await call.click();
    await first.page.locator('[data-action="sellall-cloth"]').click();
    const sold=await first.page.evaluate(()=>({purse:window.oceanCareerPort.purse,cargo:window.oceanFleet.vessels[0].boat.cargoTonnes,ports:window.oceanCareerPort.ledger.portsVisited}));
    assert.ok(sold.purse>purseBefore,`${purseBefore} became ${sold.purse}`);
    assert.equal(sold.cargo,0);
    assert.deepEqual(sold.ports,['lisbon','havana']);
    assert.ok(await first.page.locator('[data-action="pay-wages"]').isEnabled(),'forty days of wages are owed');
    await first.page.locator('[data-action="pay-wages"]').click();
    // Damage, repaired in a real yard, on the real hull.
    await first.page.evaluate(()=>{const b=window.oceanFleet.vessels[0].boat;b.damage.hullIntegrity=.8;b.damage.hullDamageJoules=.2*b.damage.maxHullEnergy;window.oceanCareerPort.ledger.purse+=1000;});
    await first.page.locator('.port-close').click();await call.click();
    const dateBefore=await first.page.evaluate(()=>window.oceanVoyage.voyage.dateMs);
    await first.page.locator('[data-action="repair"]').click();
    const mended=await first.page.evaluate(()=>({hull:window.oceanFleet.vessels[0].boat.damage.hullIntegrity,date:window.oceanVoyage.voyage.dateMs}));
    assert.equal(mended.hull,1);
    assert.ok(mended.date>dateBefore,'the yard takes time');
    // A life ends here, and the next one starts clean.
    await first.page.locator('[data-action="retire"]').click();
    assert.equal(await first.page.locator('#career-prompt').count(),0,'the first click only asks');
    await first.page.locator('[data-action="retire"]').click();
    await first.page.locator('#career-prompt.career-ending').waitFor({state:'visible'});
    const ending=await first.page.locator('#career-prompt.career-ending').textContent();
    assert.match(ending,/Retired ashore at .*(Habana|Havana)/i);
    assert.match(ending,/Ports of call2/);
    assert.equal(await first.page.evaluate(()=>localStorage.getItem('waterworld.career.v1')),null,'the save is cleared');
    await first.page.locator('#career-prompt.career-ending button').click();
    await first.page.waitForLoadState('load');await ready(first.page);
    assert.equal(await first.page.locator('#career-prompt').count(),0,'nothing to continue');
    assert.equal(await first.page.evaluate(()=>window.oceanCareerPort.purse),purseBefore,'a new life starts with the starting purse');
    assert.deepEqual(first.errors,[]);
  }finally{await context.close();}
});
