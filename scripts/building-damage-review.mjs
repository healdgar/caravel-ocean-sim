// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Pictures of a building under fire, from the real game. Shots go through the game's own sweep and damage
// code against the live port. Same seed every run, so before and after compare.
//   OUT=dir node scripts/building-damage-review.mjs before breach,bastion,fortress,warehouse
// HEADED=1 shows the window.
import {once} from 'node:events';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {aimAtBuilding,fireOnBuilding,rubbleReport} from './fort-battle.mjs';

const label=process.argv[2]??'review',names=(process.argv[3]??'bastion').split(',');
const outDir=process.env.OUT;if(!outDir)throw Error('Set OUT to the folder for the pictures');
const WIDTH=1400,HEIGHT=900;
const SCENES={
  bastion:{prefab:'stone_sea_bastion',face:1,height:6,views:[{name:'front',yaw:-14,elevation:6,distance:58},{name:'close',yaw:16,elevation:12,distance:30}],
    volleys:[{shots:6,mass:14.5,speed:330,minY:2,maxY:7,centre:-6,span:5,face:1},{shots:18,mass:14.5,speed:330,minY:1,maxY:8,centre:5,span:9,face:1}]},
  // Lighter shot, low on the landward wall, close in: a breach and what it brings down, with no magazine.
  breach:{prefab:'stone_sea_bastion',face:-1,height:5,views:[{name:'front',yaw:24,elevation:9,distance:44},{name:'close',yaw:8,elevation:12,distance:30}],
    volleys:[{shots:2,mass:5.4,speed:380,minY:2,maxY:3,centre:-2,span:2,face:-1,range:12},{shots:1,mass:5.4,speed:380,minY:2,maxY:3,centre:3,span:1,face:-1,range:12}]},
  fortress:{prefab:'bastion_trace_fortress',face:1,height:6,views:[{name:'front',yaw:15,elevation:8,distance:66},{name:'close',yaw:-18,elevation:14,distance:36}],
    volleys:[{shots:6,mass:14.5,speed:330,minY:1,maxY:6,centre:-5,span:5,face:1},{shots:18,mass:14.5,speed:330,minY:1,maxY:8,centre:3,span:10,face:1}]},
  warehouse:{prefab:'royal_warehouse',face:-1,height:4,views:[{name:'front',yaw:20,elevation:8,distance:42},{name:'close',yaw:-15,elevation:12,distance:26}],
    volleys:[{shots:18,mass:14.5,speed:430,minY:1,maxY:6,centre:0,span:10,face:-1}]},
};
await mkdir(outDir,{recursive:true});
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/`;
const browser=await chromium.launch({headless:!process.env.HEADED,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
for(const name of names){
  const scene=SCENES[name];if(!scene)throw Error('No building scene for '+name);
  const page=await browser.newPage({viewport:{width:WIDTH,height:HEIGHT}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [key,value] of Object.entries({ship:'victory',view:'ship',follower:0,clouds:0,w:WIDTH,h:HEIGHT,polygons:'fixed',boatSpeed:0}))url.searchParams.set(key,String(value));
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:600000,polling:500});
  if(await page.evaluate(()=>oceanStartup.state)!=='ready')throw Error('Game failed to start: '+errors.join('\n'));
  await page.addStyleTag({content:'body *{visibility:hidden!important}canvas{visibility:visible!important}'});
  const look=v=>page.evaluate(aimAtBuilding,{prefab:scene.prefab,face:scene.face,height:scene.height,...v});
  console.log(name,JSON.stringify(await look(scene.views[0])));
  await page.waitForTimeout(3000);
  for(const v of scene.views){await look(v);await page.waitForTimeout(800);await page.screenshot({path:join(outDir,`${name}-${label}-0-intact-${v.name}.png`)});}
  await look(scene.views[0]);await page.waitForTimeout(500);
  // Each volley in turn, pictured as it comes down and once it has settled.
  for(const [index,volley] of scene.volleys.entries()){
    const report=await page.evaluate(fireOnBuilding,{prefab:scene.prefab,volleys:[volley]});
    console.log(name,JSON.stringify(report));
    // Her drift moves the orbit, so aim again before each picture.
    let frame=0;
    for(const wait of [500,600,800]){
      await page.waitForTimeout(wait);
      await look(scene.views[0]);
      await page.screenshot({path:join(outDir,`${name}-${label}-1-volley${index}-fall${frame++}.png`)});
    }
    await page.waitForTimeout(4500);
    await look(scene.views[0]);await page.waitForTimeout(100);
    await page.screenshot({path:join(outDir,`${name}-${label}-1-volley${index}-settled.png`)});
  }
  console.log('rubble',JSON.stringify(await page.evaluate(rubbleReport)));
  for(const v of scene.views){
    await look(v);await page.waitForTimeout(1500);
    const file=join(outDir,`${name}-${label}-2-${v.name}.png`);await page.screenshot({path:file});console.log('wrote',file);
  }
  if(errors.length)console.log('errors:',errors.slice(0,5).join('\n'));
  await page.close();
}
await browser.close();server.closeAllConnections?.();server.close();process.exit(0);
