// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The frame loop in the real page: what it uploads each frame, what it asks of each vessel each
// frame, how its clocks behave when the sea's time loop starts again, and what its resolution
// governor is told.
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

function instrument(){
  window.gpuErrors=[];window.frameBlock={whole:0,patches:[]};
  const write=GPUQueue.prototype.writeBuffer;
  // Uploads of the frame block: the whole of it, or a part (buffer offset in bytes, then first float and float count).
  GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset,size){
    if(buffer.label==='frame ubo (celestial528)'){
      if(offset===0&&dataOffset===undefined&&size===undefined)window.frameBlock.whole++;
      else window.frameBlock.patches.push([offset,dataOffset,size]);
    }
    return write.apply(this,arguments);
  };
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
  // The clock frames are told. Stretched, it reports a slow cadence to the game with no work added to the GPU or the page.
  const raf=window.requestAnimationFrame.bind(window),clock={start:0,base:0,scale:1};
  window.requestAnimationFrame=callback=>raf(now=>callback(clock.base+(now-clock.start)*clock.scale));
  window.stretchFrameClock=scale=>{const now=performance.now();clock.base+=(now-clock.start)*clock.scale;clock.start=now;clock.scale=scale;};
  // The GPU timer's readings, drawn together on request. On this GPU the timed window takes in the wait for the display,
  // so it never reads as the light load a desktop card reports; the governor's old rule turned on that reading.
  const mapped=GPUBuffer.prototype.getMappedRange;
  GPUBuffer.prototype.getMappedRange=function(...args){
    const range=mapped.apply(this,args);
    if(window.lightGpuTimings&&this.label==='timing read'){
      const stamps=new BigUint64Array(range);let first=0n;
      for(const stamp of stamps)if(stamp&&(!first||stamp<first))first=stamp;
      for(let i=0;i<stamps.length;i++)if(stamps[i])stamps[i]=first+(stamps[i]-first)/50n;
    }
    return range;
  };
}
async function open(path,viewport={width:640,height:400}){
  const context=await browser.newContext({viewport});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(instrument);
  await page.goto(origin+path);
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
  assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
  const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
  return {context,page,errors,frames};
}
// Uploads of the frame block over a number of frames, after an optional change to the player's ship's fires.
const uploadsOver=(page,count,change=null)=>page.evaluate(async({count,change})=>{
  await new Promise(requestAnimationFrame);
  frameBlock.whole=0;frameBlock.patches.length=0;
  const boat=oceanFleet.vessels[0].boat;
  if(change==='light')boat.damage.worldFires=[{position:[boat.x,(boat.heave??0)+4,boat.z],intensity:2.4}];
  if(change==='flare')boat.damage.worldFires[0].intensity=1.2;
  if(change==='out')boat.damage.worldFires.length=0;
  for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);
  return {whole:frameBlock.whole,patches:frameBlock.patches.map(patch=>[...patch])};
},{count,change});
// The picture's mean red, green and blue, with the panels hidden so only the scene counts.
async function meanColour(page){
  const png=(await page.screenshot()).toString('base64');
  return page.evaluate(async data=>{
    const blob=await (await fetch(`data:image/png;base64,${data}`)).blob(),bitmap=await createImageBitmap(blob);
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    const {data:pixels}=context.getImageData(0,0,bitmap.width,bitmap.height),sum=[0,0,0];
    for(let i=0;i<pixels.length;i+=4){sum[0]+=pixels[i];sum[1]+=pixels[i+1];sum[2]+=pixels[i+2];}
    return sum.map(total=>total/(pixels.length/4));
  },png);
}
const resolutionPercent=page=>page.evaluate(()=>Number(/(\d+)%/.exec(document.querySelector('#resolution-status').textContent)?.[1]??NaN));

test('the frame block goes up whole once a frame, its fire lights only when they change, and a sunk hull is asked once for her crew',{timeout:900000},async()=>{
  const {context,page,errors,frames}=await open('/?ocean=1&view=ship&ship=nina&follower=1&clouds=0&w=320&h=240&skyMode=astronomy&astroDate=2026-06-15T02:00:00Z');
  try{
    await frames(20);
    const sailing=await uploadsOver(page,40);
    assert.ok(sailing.whole>=39&&sailing.whole<=41,`${sailing.whole} whole uploads of the frame block in 40 frames`);
    assert.deepEqual(sailing.patches,[],'with nothing burning no part of it is sent a second time');

    // Stop the clock so the only thing that changes is the fire.
    await page.keyboard.press('KeyP');
    await frames(3);
    const stopped=await page.evaluate(async()=>{const data=oceanFleet.vessels[0].hullData,at=data[19];for(let i=0;i<5;i++)await new Promise(requestAnimationFrame);return data[19]===at;});
    assert.equal(stopped,true,'the simulation is paused');
    await page.addStyleTag({content:'body>*:not(canvas){visibility:hidden!important}'});
    await frames(3);
    const dark=await meanColour(page);

    // A fire is one patch from the first fire float (23) to the last (87), 92 bytes into the block, sent when it changes.
    const lit=await uploadsOver(page,30,'light');
    assert.ok(lit.whole>=29&&lit.whole<=31,`${lit.whole} whole uploads in 30 frames with a fire burning`);
    assert.deepEqual(lit.patches,[[92,23,65]],'a steady fire is sent once, not every frame');
    const fire=await meanColour(page);
    assert.ok(fire[0]>dark[0]+1.5&&fire[0]-dark[0]>fire[2]-dark[2],`the fire lights the ship and the sea warm: red ${dark[0].toFixed(1)} to ${fire[0].toFixed(1)}, blue ${dark[2].toFixed(1)} to ${fire[2].toFixed(1)}`);

    const flared=await uploadsOver(page,10,'flare');
    assert.deepEqual(flared.patches,[[92,23,65]],'a change in the fire is one more');
    const out=await uploadsOver(page,10,'out');
    assert.deepEqual(out.patches,[[92,23,65]],'and so is its going out');
    const after=await meanColour(page);
    assert.ok(Math.abs(after[0]-dark[0])<0.5,`with the fire out the picture is as dark as before (${dark[0].toFixed(2)}, ${after[0].toFixed(2)})`);

    // A sunk hull's crew is scanned for anyone still in sight: once a frame, however many passes ask.
    const scans=await page.evaluate(async()=>{
      const vessel=oceanFleet.vessels[1],crew=vessel.crew.state.crew;
      let scans=0;
      crew.some=function(test,...rest){if(/overboard\?\.gone/.test(String(test)))scans++;return Array.prototype.some.call(this,test,...rest);};
      vessel.boat.damage.sunk=true;
      await new Promise(requestAnimationFrame);
      scans=0;
      for(let i=0;i<20;i++)await new Promise(requestAnimationFrame);
      vessel.boat.damage.sunk=false;delete crew.some;
      return scans;
    });
    assert.ok(scans>=19&&scans<=21,`${scans} scans of the sunk hull's crew in 20 frames`);
    await frames(5);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('the lookout waits eight seconds from the start, and not again each time the sea clock comes round',{timeout:900000},async()=>{
  // The sea's clock is set three seconds short of its loop, and a second ship is in company for the lookout to cry.
  const {context,page,errors}=await open('/?ocean=1&t=597&follower=1&clouds=0&w=320&h=240');
  try{
    const watch=await page.evaluate(async()=>{
      const vessel=oceanFleet.vessels[0],samples=[];
      for(;;){
        await new Promise(requestAnimationFrame);
        const clock=vessel.hullData[19],run=clock>=597?clock-597:clock+3;
        samples.push([run,clock,vessel.boat.lookoutSighting?.kind??null]);
        if(run>=11.6||samples.length>6000)break;
      }
      return samples;
    });
    const early=watch.filter(([run])=>run<7.5),late=watch.filter(([run])=>run>=8.6&&run<11.6);
    assert.ok(late.length>10&&late.some(([,clock])=>clock<8),`the watch ran past the loop (${watch.length} frames, ${late.length} after the wait)`);
    assert.deepEqual(early.filter(([,,kind])=>kind!==null),[],'nothing is cried in the first eight seconds, wherever the sea clock started');
    assert.deepEqual(late.filter(([,,kind])=>kind===null),[],'and once the sail is cried the sighting stands while the sea clock starts again');
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('a slow cadence lowers the resolution with the performance panel open, as it does with it closed',{timeout:900000},async()=>{
  const {context,page,errors}=await open('/?ocean=1&follower=0&clouds=0',{width:640,height:360});
  try{
    assert.equal(await resolutionPercent(page),100);
    await page.evaluate(()=>{window.lightGpuTimings=true;});
    await page.locator('#performance-toggle').click();
    // The panel is timing the GPU, and finds it lightly loaded: the measurement that used to tell the governor all was well.
    await page.waitForFunction(()=>Number(/GPU sampled window\s+([\d.]+) ms/.exec(document.querySelector('#gpu-profile-details').textContent)?.[1])>0,undefined,{timeout:60000,polling:200});
    // Every frame now reports three refreshes gone by.
    await page.evaluate(()=>stretchFrameClock(3));
    await page.waitForFunction(()=>Number(/(\d+)%/.exec(document.querySelector('#resolution-status').textContent)?.[1])<100,undefined,{timeout:30000,polling:250});
    assert.ok(await resolutionPercent(page)<100);
    const timed=await page.evaluate(()=>Number(/GPU sampled window\s+([\d.]+) ms/.exec(document.querySelector('#gpu-profile-details').textContent)?.[1]));
    assert.ok(timed>0&&timed<13.5,`the GPU was being timed, and lightly loaded, all the while (${timed} ms)`);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});

test('a stream flag left busy does not switch the resolution governor off',{timeout:900000},async()=>{
  const {context,page,errors}=await open('/?region=cartagena&realDEM=off&follower=0&clouds=0&boatSpeed=0',{width:640,height:360});
  try{
    // Let the coast finish arriving, then leave its busy flag set, as a section that failed outside its guard would.
    await page.waitForFunction(()=>oceanFleet.terrain&&!oceanFleet.terrain.streamBusy,undefined,{timeout:300000,polling:500});
    await page.evaluate(()=>Object.defineProperty(oceanFleet.terrain,'streamBusy',{get:()=>true,configurable:true}));
    const before=await resolutionPercent(page);
    assert.ok(before>35,`there is resolution left to give up (${before}%)`);
    await page.evaluate(()=>stretchFrameClock(3));
    await page.waitForFunction(was=>Number(/(\d+)%/.exec(document.querySelector('#resolution-status').textContent)?.[1])<was,before,{timeout:30000,polling:250});
    assert.ok(await resolutionPercent(page)<before);
    assert.deepEqual(errors,[]);
  }finally{await context.close();}
});
