// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Pictures of a ship under fire, from the real game. Shots go through the game's own sweep and damage
// code against the live vessel, so the renderer shows what a battle would leave. Same seed every run.
//   OUT=dir node scripts/damage-review.mjs before nina,victory,victory-fall,nina-fall,nina-aloft,victory-aloft
// Each scene also prints what a row of level shots does against the gaps, and what became of hands aloft.
// SETTLE_MS overrides the wait after the last shot. HEADED=1 shows the window.
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {fireBroadside} from './damage-battle.mjs';

const label=process.argv[2]??'review',ships=(process.argv[3]??'nina,victory').split(',');
const outDir=process.env.OUT;if(!outDir)throw Error('Set OUT to the folder for the pictures');
const WIDTH=1400,HEIGHT=900;
// Yaw and elevation in degrees, as the orbit URL parameters take them.
const SCENES={
  nina:{ship:'nina',settle:4000,volleys:[{shots:50,mass:1.4,speed:330,minY:5.5,maxY:9.5},{shots:40,mass:1.4,speed:330,minY:2.4,maxY:5.2}],views:[
    {name:'stern-quarter',yaw:30,elevation:12,distance:26},
    {name:'beam',yaw:0,elevation:8,distance:30},
    {name:'stern-high',yaw:60,elevation:30,distance:24},
    {name:'stern',yaw:90,elevation:14,distance:24},
  ]},
  victory:{ship:'victory',settle:9000,volleys:[{shots:70,mass:14.5,speed:430,minY:15,maxY:34},{shots:45,mass:14.5,speed:430,minY:3.5,maxY:11}],views:[
    {name:'masts-beam',yaw:0,elevation:4,distance:40},
    {name:'masts-close',yaw:-25,elevation:10,distance:22},
    {name:'stern-quarter',yaw:45,elevation:12,distance:50},
    {name:'bow-quarter',yaw:-50,elevation:10,distance:50},
  ]},
  // One mast shot away, pictured as it goes.
  'victory-fall':{ship:'victory',settle:300,frames:[1000,1500,1500,2500],volleys:[{shots:60,mass:14.5,speed:430,minY:24,maxY:34,mast:'main'}],views:[{name:'fall',yaw:-20,elevation:6,distance:62}]},
  // Shots at her hull with the leaks left open, pictured as she takes on water.
  'nina-flood':{ship:'nina',settle:500,leaking:true,frames:[3000,4000,5000,6000],volleys:[{shots:16,mass:1.4,speed:330,minY:.8,maxY:4}],views:[{name:'flood',yaw:20,elevation:8,distance:34}]},
  'victory-flood':{ship:'victory',settle:500,leaking:true,frames:[8000,10000,12000,14000],volleys:[{shots:50,mass:14.5,speed:430,minY:1,maxY:8}],views:[{name:'flood',yaw:20,elevation:6,distance:70}]},
  // A raked mast, so the break stands well along her from the mast's foot. Only the topmast goes.
  'cloud-fall':{ship:'flying-cloud',settle:300,frames:[800,1200,1500,2500],volleys:[{shots:60,mass:14.5,speed:430,minY:30,maxY:40,mast:'main',untilStage:1}],views:[{name:'fall',yaw:-20,elevation:6,distance:80}]},
  'nina-fall':{ship:'nina',settle:300,frames:[600,800,1000,2000],volleys:[{shots:60,mass:1.4,speed:330,minY:6,maxY:9,mast:'mizzen'}],views:[{name:'fall',yaw:20,elevation:8,distance:34}]},
  // Hands on the mast when it goes: rung counts from the deck, so these land in different places.
  'nina-aloft':{ship:'nina',settle:300,frames:[300,500,800,1500,3000],aloft:[{mast:1,side:-1,rung:24},{mast:1,side:-1,rung:12},{mast:1,side:1,rung:3}],volleys:[{shots:60,mass:1.4,speed:330,minY:6,maxY:9,mast:'main'}],views:[{name:'fall',yaw:20,elevation:8,distance:34}]},
  'victory-aloft':{ship:'victory',settle:300,frames:[500,800,1200,2500,4000],aloft:[{mast:1,side:1,rung:25},{mast:1,side:-1,rung:8},{mast:1,side:-1,rung:2}],volleys:[{shots:60,mass:14.5,speed:430,minY:24,maxY:34,mast:'main'}],views:[{name:'fall',yaw:-20,elevation:6,distance:62}]},
};
await mkdir(outDir,{recursive:true});
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:!process.env.HEADED,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
for(const name of ships){
  const scene=SCENES[name];if(!scene)throw Error('No damage scene for '+name);
  const ship=scene.ship;
  const page=await browser.newPage({viewport:{width:WIDTH,height:HEIGHT}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  const first=scene.views[0],url=new URL(base);
  for(const [key,value] of Object.entries({ship,view:'ship',orbitYaw:first.yaw,orbitElevation:first.elevation,orbitDistance:first.distance,follower:0,clouds:0,w:WIDTH,h:HEIGHT,polygons:'fixed',boatSpeed:0}))url.searchParams.set(key,String(value));
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:600000,polling:500});
  if(await page.evaluate(()=>oceanStartup.state)!=='ready')throw Error('Game failed to start: '+errors.join('\n'));
  await page.waitForTimeout(3000);
  // The picture is of the ship, not the panels over her.
  await page.addStyleTag({content:'body *{visibility:hidden!important}canvas{visibility:visible!important}'});
  await page.screenshot({path:join(outDir,`${name}-${label}-0-intact.png`)});
  const report=await page.evaluate(fireBroadside,{volleys:scene.volleys,aloft:scene.aloft??[],leaking:scene.leaking});
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Arcs')?.click());
  console.log(name,JSON.stringify(report));
  await page.waitForTimeout(Number(process.env.SETTLE_MS??scene.settle));
  let at=first,frame=0;
  for(const wait of scene.frames??[]){
    await page.screenshot({path:join(outDir,`${name}-${label}-frame${frame++}.png`)});
    console.log(name,'water:',JSON.stringify(await page.evaluate(()=>{const b=oceanFleet.vessels[0].boat,d=b.damage;return {tonnes:+d.floodingTonnes.toFixed(1),sinkageM:+d.floodingSinkage.toFixed(2),rollDeg:+(d.floodingRoll*57.3).toFixed(1),pitchDeg:+(d.floodingPitch*57.3).toFixed(1),holes:d.holes?.length??0,sunk:d.sunk};})));
    await page.waitForTimeout(wait);
    if(scene.aloft)console.log(name,'hands after',wait,'ms',JSON.stringify(await page.evaluate(()=>window.damageReviewHands())));
  }
  for(const v of scene.views){
    if(v!==at){
      // The orbit has no public setter: drag and wheel it as a player would.
      await page.mouse.move(WIDTH/2,HEIGHT/2);await page.mouse.down();
      await page.mouse.move(WIDTH/2-((v.yaw-at.yaw)*Math.PI/180)/.005,HEIGHT/2+((v.elevation-at.elevation)*Math.PI/180)/.004,{steps:16});await page.mouse.up();
      const ticks=Math.round(Math.log(v.distance/at.distance)/Math.log(1/.9));
      for(let i=0;i<Math.abs(ticks);i++)await page.mouse.wheel(0,ticks>0?100:-100);
      at=v;await page.waitForTimeout(2000);
    }
    const file=join(outDir,`${name}-${label}-${v.name}.png`);await page.screenshot({path:file});console.log('wrote',file);
  }
  console.log(name,'hands still at an open edge',JSON.stringify(await page.evaluate(()=>window.damageReviewEdge())));
  if(errors.length)console.log('errors:',errors.slice(0,5).join('\n'));
  await page.close();
}
await browser.close();server.closeAllConnections?.();server.close();process.exit(0);
