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
    assert.equal(buttons.length,4);
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
