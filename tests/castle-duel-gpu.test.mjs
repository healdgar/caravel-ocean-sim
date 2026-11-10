// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The Two Castles duel in the real page: it is reached from the debug panel only, the normal game
// waits while it runs, and stopping it leaves the camera, the sky, the ships, the port and the
// career save as they were found.
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

const CAREER_KEY='waterworld.career.v1';
function instrument(){
  window.gpuErrors=[];window.fractureUploads=0;
  const write=GPUQueue.prototype.writeBuffer;
  // A building cut into pieces uploads its pieces once: the count says how many buildings stand as ruins on the GPU.
  GPUQueue.prototype.writeBuffer=function(buffer,...rest){if(/fracture vertices/.test(buffer.label||''))window.fractureUploads++;return write.call(this,buffer,...rest);};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
}
async function open(path){
  const context=await browser.newContext({viewport:{width:640,height:400}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(instrument);
  await page.goto(origin+path);
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
  assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
  const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
  return {context,page,errors,frames};
}
// Everything the duel is to leave as it found it, read in one go.
const sceneReader=()=>{
  window.readScene=()=>{
    const cam=oceanFleet.camera,orbit=oceanFleet.orbit;
    return {
      camera:[...document.querySelectorAll('#camera-panel button[aria-pressed="true"]')].map(button=>button.textContent),
      cam:{yaw:cam.yaw,pitch:cam.pitch,fovY:cam.fovY},
      orbit:{yaw:orbit.yaw,elevation:orbit.elevation,distance:orbit.distance},
      sky:oceanAstronomy.clock.mode,skyTime:oceanAstronomy.clock.epochMs+oceanAstronomy.clock.elapsedSeconds*1000,
      sunElev:document.querySelector('#sea-sunElev').value,sunAzim:document.querySelector('#sea-sunAzim').value,
      vessels:oceanFleet.vessels.map(({boat})=>[boat.x,boat.z,boat.heading,boat.heave,boat.pitch,boat.roll,boat.surgeVelocity,boat.showProw,boat.eyeSide]),
      voyage:[oceanVoyage.voyage?.dateMs,oceanVoyage.voyage?.true?.lat,oceanVoyage.voyage?.true?.lon,oceanVoyage.voyage?.log?.length],
      port:oceanFleet.terrain?.port?.name??null,
      duelClass:document.body.classList.contains('castle-duel-active'),
    };
  };
};

test('the duel is a debug side game: entered from the debug panel, it borrows the scene and gives it back',{timeout:900000},async()=>{
  const {context,page,errors,frames}=await open('/?region=lisbon&view=ship&ship=nina&clouds=0&w=320&h=240&year=1650&boatSpeed=0&continue=1');
  try{
    await page.evaluate(sceneReader);
    // Player-facing panels carry no duel button, and the debug section of Sea Settings opens closed.
    assert.equal(await page.locator('#captain-castle-duel-btn').count(),0,'Captain\'s Orders has no Castle Duel button');
    assert.equal(await page.locator('#castle-duel-toggle-btn').count(),0,'nor has Sea Settings');
    assert.equal(await page.locator('#captain-panel button,#panel button,#boat-panel button,#camera-panel button').filter({hasText:/Castle Duel/}).count(),0);
    assert.equal(await page.locator('#perf-castle-duel-btn').count(),1,'the debug panel has it');
    assert.equal(await page.locator('#environment-debug').evaluate(details=>details.open),false);

    // The town's own bastion is shot about first: its ruin must survive the duel.
    const bastion=await page.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const port=oceanFleet.terrain.port,building=port.instances.find(i=>i.prefabId==='stone_sea_bastion');
      if(!building)return null;
      const half=(building.depth??building.length)*.5,cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      for(let i=0;i<6;i++){
        const x=(i-3)*1.5,z=half,y=3+i%3,at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[sin,0,cos],velocity:[-sin*400,0,-cos*400],mass:14.5,energy:900000,ammo:'round'});
      }
      window.ownPort=port;window.ownBastion=building;
      return {id:building.id??null};
    });
    assert.ok(bastion,'Lisbon has its bastion');
    await page.waitForFunction(()=>(ownBastion.damageState.fracture?.brokenCount??0)>0&&fractureUploads>0,undefined,{timeout:120000,polling:100});
    await page.waitForFunction(()=>ownBastion.damageState.fracture.flying.size===0,undefined,{timeout:120000,polling:200});
    const ruin=await page.evaluate(()=>({hits:ownBastion.damageState.hits,broken:ownBastion.damageState.fracture.brokenCount,uploads:fractureUploads}));
    assert.ok(ruin.broken>=4,`the bastion has lost blocks (${ruin.broken})`);

    // In through the debug panel's button, with the scene read in the same breath.
    const found=await page.evaluate(()=>{const scene=readScene();document.querySelector('#perf-castle-duel-btn').click();return {scene,active:castleDuel.active};});
    assert.equal(found.active,true,'the duel starts on a procedural coast');
    assert.equal(found.scene.duelClass,false);
    assert.deepEqual(found.scene.camera,['View ship']);
    await frames(20);
    const during=await page.evaluate(()=>({scene:readScene(),transient:oceanFleet.terrain.port.transient===true,
      hidden:['#camera-dock','#helm-controls','#voyage-hud','#captain-panel'].filter(id=>document.querySelector(id)&&getComputedStyle(document.querySelector(id)).display!=='none'),
      launch:document.querySelector('#perf-castle-duel-btn').textContent,hud:document.querySelector('#castle-duel-hud').hidden,
      sight:getComputedStyle(document.body,'::after').display}));
    assert.equal(during.scene.port,'Strait of the Two Castles');
    assert.equal(during.transient,true);
    assert.deepEqual(during.scene.camera,['Free camera']);
    assert.deepEqual(during.hidden,[],'the ship\'s controls are out of sight while the duel runs');
    assert.equal(during.sight,'none','and so is the free camera\'s cannon sight');
    assert.equal(during.hud,false);
    assert.equal(during.launch,'🏰 Exit Castle Duel');
    assert.notEqual(during.scene.cam.fovY,found.scene.cam.fovY);

    // The ships and the voyage wait.
    await frames(45);
    const later=await page.evaluate(()=>readScene());
    assert.deepEqual(later.vessels,during.scene.vessels,'no ship has moved, rolled or risen');
    assert.deepEqual(later.vessels.map(v=>v.slice(0,3)),found.scene.vessels.map(v=>v.slice(0,3)),'nor been moved to make room');
    assert.deepEqual(later.voyage,found.scene.voyage,'the voyage has not advanced');
    assert.equal(later.skyTime,found.scene.skyTime,'nor has the sky clock');

    // The normal game's keys do nothing; the duel's fire key fires once however long it is held.
    await page.evaluate(()=>document.activeElement?.blur?.());
    const chartBefore=await page.evaluate(()=>{const drawer=document.querySelector('#chart-drawer');return drawer?[drawer.hidden,drawer.className]:null;});
    for(const key of ['KeyB','KeyV','KeyZ','KeyM','KeyP','KeyH'])await page.keyboard.press(key);
    await frames(3);
    const clockA=await page.evaluate(()=>castleDuel.playerBattery.state.time);
    await frames(10);
    const keyed=await page.evaluate(()=>({camera:readScene().camera,clock:castleDuel.playerBattery.state.time,
      chart:(()=>{const drawer=document.querySelector('#chart-drawer');return drawer?[drawer.hidden,drawer.className]:null;})(),
      seaPanel:document.querySelector('#panel').classList.contains('hidden'),spyglass:document.body.classList.contains('spyglass-active')}));
    assert.deepEqual(keyed.camera,['Free camera'],'B and V change no camera');
    assert.ok(keyed.clock>clockA,'P pauses nothing');
    assert.deepEqual(keyed.chart,chartBefore,'M opens no chart');
    assert.equal(keyed.seaPanel,true,'H opens no settings');
    assert.equal(keyed.spyglass,false,'Z raises no spyglass');
    // Fresh castles for each trial of the guns: the enemy's first volley is three seconds off.
    assert.equal(await page.evaluate(()=>castleDuel.rematch()),true);
    await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.up('Space');
    await frames(20);
    assert.equal(await page.evaluate(()=>castleDuel.playerCastle.magazine.shotsFired??0),1,'a held Space fires one gun');

    // Castle damage never reaches the career save; the town's own ruin does.
    await page.evaluate(()=>{castleDuel.rematch();castleDuel.setElevation(3);castleDuel.setTraverse(0);});
    await page.waitForFunction(()=>{castleDuel.fire(true);return (castleDuel.enemyCastle.damageState.hits??0)>0;},undefined,{timeout:60000,polling:250});
    const save=await page.evaluate(key=>{
      const voyage=oceanVoyage.voyage,kept=voyage.keepSaved;
      voyage.keepSaved=true;oceanVoyage.saveNow();voyage.keepSaved=kept;
      return localStorage.getItem(key);
    },CAREER_KEY);
    assert.ok(save,'the career was saved while the duel ran');
    assert.doesNotMatch(save,/Two Castles|castle_duel/,'with nothing of the duel in it');
    assert.match(save,/stone_sea_bastion/,'and with the town\'s shot-about bastion on record');

    // Night battle and rematch, then out.
    await page.locator('#cd-night-btn').evaluate(button=>button.click());
    await frames(3);
    const night=await page.evaluate(()=>readScene());
    assert.equal(night.sunElev,'-18');assert.equal(night.sky,'manual');
    await page.locator('#cd-reset-btn').evaluate(button=>button.click());
    await frames(5);
    const rematch=await page.evaluate(()=>({hits:castleDuel.enemyCastle.damageState.hits??0,integrity:castleDuel.enemyCastle.damageState.integrity,winner:castleDuel.winner,port:oceanFleet.terrain.port===castleDuel.port}));
    assert.deepEqual(rematch,{hits:0,integrity:1,winner:null,port:true});

    const uploadsBefore=await page.evaluate(()=>fractureUploads);
    const left=await page.evaluate(()=>{document.querySelector('#cd-exit-btn').click();return {scene:readScene(),active:castleDuel.active,sameOwnPort:oceanFleet.terrain.port===ownPort};});
    assert.equal(left.active,false);
    assert.equal(left.sameOwnPort,true,'the coast has its own port again');
    assert.deepEqual(left.scene,found.scene,'camera, lens, sky, ships, voyage and port are as they were found');
    // The town's ruin is cut again on the port's new buffers, rather than standing whole with its damage forgotten.
    await page.waitForFunction(before=>fractureUploads>before,uploadsBefore,{timeout:120000,polling:100});
    const ruinAfter=await page.evaluate(()=>({hits:ownBastion.damageState.hits,broken:ownBastion.damageState.fracture?.brokenCount??0}));
    assert.equal(ruinAfter.hits,ruin.hits);
    assert.ok(ruinAfter.broken>=ruin.broken,`the bastion is the ruin it was (${ruinAfter.broken} of ${ruin.broken} blocks down)`);
    await frames(10);
    const settled=await page.evaluate(()=>readScene());
    assert.deepEqual(settled.camera,found.scene.camera);
    assert.equal(settled.cam.fovY,found.scene.cam.fovY);
    assert.equal(settled.sunElev,found.scene.sunElev);

    // From the deck: the eye goes back to where it stood.
    await page.locator('#camera-panel button').filter({hasText:'Boat camera'}).evaluate(button=>button.click());
    await frames(10);
    const deck=await page.evaluate(()=>{const cam=oceanFleet.camera;cam.yaw=0.4;cam.pitch=-0.2;const scene=readScene();castleDuel.start();return scene;});
    await frames(10);
    const deckBack=await page.evaluate(()=>{castleDuel.stop();return readScene();});
    assert.deepEqual(deckBack,deck,'the deck view is given back too');
    await frames(5);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('on a surveyed island with no port to borrow the duel is refused, and says so',{timeout:600000},async()=>{
  const {context,page,errors,frames}=await open('/?landfall=coast&clouds=0&w=320&h=240');
  try{
    await page.evaluate(sceneReader);
    await frames(5);
    const result=await page.evaluate(()=>{const before=readScene();document.querySelector('#perf-castle-duel-btn').click();return {before,after:readScene(),active:castleDuel.active,
      hud:document.querySelector('#castle-duel-hud').hidden,toast:document.querySelector('#voyage-hud .voyage-toast')?.textContent??'',toastHidden:document.querySelector('#voyage-hud .voyage-toast')?.hidden,
      launch:document.querySelector('#perf-castle-duel-btn').textContent};});
    assert.equal(result.active,false,'no duel with no castles to show');
    assert.deepEqual(result.after,result.before,'and nothing of the scene is touched');
    assert.equal(result.hud,true);
    assert.equal(result.launch,'🏰 Castle Duel');
    assert.match(result.toast,/cannot be raised on this coast/);
    assert.equal(result.toastHidden,false);
    await frames(5);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('at open sea the duel raises a coast clear of the ship, and takes it away again',{timeout:900000},async()=>{
  const {context,page,errors,frames}=await open('/?castles=1&follower=0&clouds=0&w=320&h=240');
  try{
    await page.evaluate(sceneReader);
    await page.waitForFunction(()=>castleDuel.active,undefined,{timeout:600000,polling:500});
    await frames(10);
    const during=await page.evaluate(()=>{
      const terrain=oceanFleet.terrain,boat=oceanFleet.vessels[0].boat,region=terrain.baseRegion??terrain.region,centre=castleDuel.port.center;
      return {scene:readScene(),coastOff:Math.hypot(region.x-boat.x,region.z-boat.z),span:region.span,duelOff:Math.hypot(centre.x-boat.x,centre.z-boat.z),bed:terrain.height(boat.x,boat.z)};
    });
    assert.equal(during.scene.port,'Strait of the Two Castles');
    assert.ok(during.coastOff>during.span,`the coast is raised ${Math.round(during.coastOff)} m from the ship, beyond its ${during.span} m span`);
    assert.ok(during.duelOff>2000,`and the castles stand ${Math.round(during.duelOff)} m from her`);
    assert.ok(during.bed<-5,`she still lies in deep water (${during.bed.toFixed(1)} m)`);
    await frames(30);
    const left=await page.evaluate(()=>{const before=readScene();document.querySelector('#cd-exit-btn').click();return {before,after:readScene(),terrain:oceanFleet.terrain===null};});
    assert.deepEqual(left.before.vessels,during.scene.vessels,'the ship waited where she was');
    assert.equal(left.terrain,true,'the coast raised for the duel is gone');
    assert.deepEqual(left.after.vessels,during.scene.vessels);
    assert.equal(left.after.port,null);
    assert.equal(left.after.duelClass,false);
    await frames(20);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
