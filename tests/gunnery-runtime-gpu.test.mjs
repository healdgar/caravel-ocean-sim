// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';

const gunneryRuntimePort=process.env.GUNNERY_RUNTIME_TEST_PORT||8140;
let gunneryRuntimeServer,gunneryRuntimeBrowser;
before(async()=>{
  gunneryRuntimeServer=spawn(process.execPath,['server.mjs',String(gunneryRuntimePort)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await once(gunneryRuntimeServer.stdout,'data');
  gunneryRuntimeBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await gunneryRuntimeBrowser?.close();gunneryRuntimeServer?.kill();});

function instrumentGunneryRuntime(){
  window.gunneryRuntime={callback:null,errors:[],render:{},compute:{},device:null,target:null,now:0};
  window.requestAnimationFrame=callback=>{gunneryRuntime.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);gunneryRuntime.device=d;d.addEventListener('uncapturederror',e=>gunneryRuntime.errors.push(e.error.message));return d;};
  const configurations=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configurations.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){
    const desc=configurations.get(this),{width,height}=this.canvas;
    if(!gunneryRuntime.target||gunneryRuntime.target.width!==width||gunneryRuntime.target.height!==height){gunneryRuntime.target?.destroy();gunneryRuntime.format=desc.format;gunneryRuntime.target=desc.device.createTexture({size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});}
    return gunneryRuntime.target;
  };
  const render=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(p){gunneryRuntime.render[p.label]=(gunneryRuntime.render[p.label]||0)+1;return render.call(this,p);};
  const labels=new WeakMap(),setCompute=GPUComputePassEncoder.prototype.setPipeline,dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.setPipeline=function(p){labels.set(this,p.label);return setCompute.call(this,p);};
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...args){const label=labels.get(this);gunneryRuntime.compute[label]=(gunneryRuntime.compute[label]||0)+1;return dispatch.apply(this,args);};
}

async function gunneryRuntimePage(model){
  const source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
  const marker='window.oceanFleet={vessels,config:fleetConfig,wakes:wakePool,renderAssets};',controls='const gunControls=createGunneryControls(captainBody,shipGuns);',event='sceneAudio.gunneryEvent(event);';
  for(const s of [marker,controls,event])assert.ok(source.includes(s),'native fixture must instrument current production integration: '+s);
  const fixture=source.replace(marker,marker+'window.gunneryFixture={boat,vessels,shipGuns,gunEffects,gunSea,shipAsset,events:[]};')
    .replace(controls,controls+'window.gunneryFixture.controls=gunControls;')
    .replace(event,event+'window.gunneryFixture?.events.push({type:event.type,shotId:event.shotId,time:event.time,position:event.position,kind:event.kind});');
  const capture=!!process.env.GUNNERY_RUNTIME_SHOTS,page=await gunneryRuntimeBrowser.newPage({viewport:capture?{width:960,height:600}:{width:480,height:360}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.text().includes('init failed'))errors.push(m.text());});
  await page.addInitScript(instrumentGunneryRuntime);
  await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:fixture}));
  await page.goto(`http://localhost:${gunneryRuntimePort}/?ship=${model}&view=ship&fleet=${model==='victory'?'nina':'victory'}&boatHeading=0&sunElev=30&clouds=0&windSpeed=1&swellHs=.1&orbitElevation=12&orbitYaw=90&orbitDistance=${model==='victory'?65:34}&sailFore=0&sailMain=0&sailMizzen=0&w=${capture?960:144}&h=${capture?600:108}`);
  await page.waitForFunction(()=>gunneryRuntime.callback||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
  assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
  return {page,errors};
}

async function gunneryRuntimeStep(page,dt=.1){
  const frame=await page.evaluate(async dt=>{
    const r=gunneryRuntime;r.now=Math.max(r.now,performance.now())+dt*1000;
    const callback=r.callback;r.callback=null;r.render={};r.compute={};const start=performance.now();callback(r.now);
    await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));
    return {errors:r.errors,render:r.render,compute:r.compute,milliseconds:performance.now()-start,
      counts:gunneryFixture.gunEffects.counts,shots:gunneryFixture.events.filter(e=>e.type==='shot').length,impacts:gunneryFixture.events.filter(e=>e.type==='impact').length};
  },dt);assert.deepEqual(frame.errors,[]);return frame;
}

async function gunneryRuntimeCapture(page,name){
  if(!process.env.GUNNERY_RUNTIME_SHOTS)return;
  await page.evaluate(async()=>{
    const r=gunneryRuntime,t=r.target,d=r.device,width=t.width,height=t.height,row=Math.ceil(width*4/256)*256;
    const read=d.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=d.createCommandEncoder();enc.copyTextureToBuffer({texture:t},{buffer:read,bytesPerRow:row},[width,height]);d.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const bytes=new Uint8Array(read.getMappedRange()),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const c=canvas.getContext('2d'),data=c.createImageData(width,height),bgra=r.format.startsWith('bgra');
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=y*row+x*4,b=(y*width+x)*4;data.data[b]=bytes[a+(bgra?2:0)];data.data[b+1]=bytes[a+1];data.data[b+2]=bytes[a+(bgra?0:2)];data.data[b+3]=255;}
    c.putImageData(data,0,0);read.unmap();read.destroy();let image=document.querySelector('#gunnery-native-capture');if(!image){image=document.createElement('img');image.id='gunnery-native-capture';image.style='position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none';document.body.prepend(image);document.querySelector('canvas').style.visibility='hidden';}image.src=canvas.toDataURL();
  });
  await page.screenshot({path:new URL('../shots/'+name,import.meta.url).pathname,fullPage:false});
}

for(const model of ['nina','victory'])test(`${model}: captain UI, attended loading drill, spoken-order delay, recoil, depth smoke and actual FFT water impacts work together`,{timeout:180000},async()=>{
  const {page,errors}=await gunneryRuntimePage(model);
  try{
    const idle=await gunneryRuntimeStep(page);assert.equal(idle.render.gunneryVolume,undefined);assert.equal(idle.compute['roundshot actual sea sweep'],undefined);
    await page.getByRole('button',{name:'Captain',exact:true}).click();
    assert.equal(await page.locator('#guns-fire-starboard').isDisabled(),true);
    await page.locator('#guns-prepare-starboard').click();
    const loading=await page.evaluate(async()=>{
      const {stepCompany}=await import('/js/crew.js'),f=gunneryFixture,state=f.shipGuns.state,boat=f.boat,company=f.vessels[0].crew.state;
      const visible=state.guns.filter(g=>g.side==='starboard'&&g.visibleCrew),observed=new Set(),attendance=new Set(),jobs=new Set();
      f.shipGuns.update(.1,[1,0,0]);const initiallyUnattended=visible.filter(g=>g.stage==='swab'&&g.elapsed===0).length;
      let ticks=0,toolDraws=0,toolShadows=0;
      // Test-only acceleration of the real crew/controller clocks. No gun is
      // forced ready; production still runs these seconds in real time.
      for(;ticks<6000&&f.shipGuns.summary('starboard').ready!==f.shipGuns.summary('starboard').total;ticks++){
        stepCompany(company,boat,.1,1);f.shipGuns.update(.1,[1,0,0]);
        for(const g of visible){observed.add(g.stage);if(boat.gunneryAttendance?.has(g.id))attendance.add(g.id);}
        for(const s of company.crew)if(s.job)jobs.add(s.job.kind);
        if(!toolDraws&&visible.some(g=>g.stage==='ram'&&boat.gunneryAttendance?.has(g.id))){
          const r=gunneryRuntime;r.now=Math.max(r.now,performance.now())+100;r.render={};r.compute={};const callback=r.callback;r.callback=null;callback(r.now);
          await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));
          toolDraws=r.render['crew gun tools']??0;toolShadows=r.render['crew gun tool shadows']??0;
        }
      }
      f.controls.update();return {ticks,visible:visible.length,initiallyUnattended,stages:[...observed],attendance:attendance.size,jobs:[...jobs],summary:f.shipGuns.summary('starboard'),events:f.events.map(e=>e.type),finite:company.crew.every(s=>s.transform.every(Number.isFinite)),toolDraws,toolShadows};
    });
    assert.ok(loading.visible>0&&loading.initiallyUnattended>0,JSON.stringify(loading));
    assert.equal(loading.attendance,loading.visible,JSON.stringify(loading));assert.equal(loading.summary.ready,loading.summary.total,JSON.stringify(loading));
    for(const stage of ['swab','load','ram','runout','prime','ready'])assert.ok(loading.stages.includes(stage),JSON.stringify(loading));
    assert.ok(loading.finite);assert.ok(loading.jobs.some(j=>j.includes('gun')),JSON.stringify(loading));assert.ok(!loading.events.includes('shot'));
    assert.ok(loading.toolDraws>0&&loading.toolShadows>0,JSON.stringify(loading));
    // CPU-fast loading cannot authorize fire until actual sea clearance returns.
    assert.equal(await page.locator('#guns-fire-starboard').isEnabled(),false);
    await gunneryRuntimeStep(page,.05);await gunneryRuntimeStep(page,.05);
    await page.evaluate(()=>gunneryFixture.controls.update());
    assert.equal(await page.locator('#guns-fire-starboard').isEnabled(),true);
    await page.locator('#guns-fire-starboard').click();
    const ordered=await page.evaluate(()=>({side:gunneryFixture.shipGuns.ordered,time:gunneryFixture.shipGuns.state.time,shots:gunneryFixture.events.filter(e=>e.type==='shot').length}));
    assert.equal(ordered.side,'starboard');assert.equal(ordered.shots,0);
    await page.getByRole('button',{name:'Hide captain orders',exact:true}).click();
    const initialOrderFrame=await gunneryRuntimeStep(page);assert.equal(initialOrderFrame.shots,0,'a click must finish the captain order before firing');
    const battleHud=await page.evaluate(()=>{
      const root=document.querySelector('#helm-controls'),deck=root?.querySelector('.helm-battle-deck');
      const style=root?getComputedStyle(root):null;
      const rect=sel=>{const r=document.querySelector(sel)?.getBoundingClientRect();return r?{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}:null;};
      return {
        battle:root?.dataset.battle,
        deckVisible:Boolean(deck&&!deck.hidden&&getComputedStyle(deck).display!=='none'),
        backdrop:style?.backdropFilter||style?.webkitBackdropFilter||'none',
        bgImage:style?.backgroundImage||'',
        rudderKicker:document.querySelector('#helm-rudder-kicker')?.textContent,
        sailsKicker:document.querySelector('#helm-sails-kicker')?.textContent,
        hasTrainBtn:Boolean(document.querySelector('#helm-train-target')),
        hasSteerBearBtn:Boolean(document.querySelector('#helm-steer-bear')),
        ammoRect:rect('.helm-ammo-pills'),
        elevInputRect:rect('#helm-elevation'),
        elevOutRect:rect('#helm-elevation-value'),
        travInputRect:rect('#helm-traverse'),
        travOutRect:rect('#helm-traverse-value'),
      };
    });
    assert.equal(battleHud.battle,'true','lower helm dock transitions to battle mode');
    assert.equal(battleHud.deckVisible,true,'context-specific battle controls are visible in lower dock');
    assert.equal(battleHud.backdrop,'none','expensive backdrop-filter blur is omitted in favor of nautical wood');
    assert.ok(battleHud.bgImage.includes('gradient'),'nautical wood grain backdrop is applied');
    assert.equal(battleHud.rudderKicker,'BATTLE HELM');
    assert.equal(battleHud.sailsKicker,'FIGHTING RIG');
    assert.equal(battleHud.hasTrainBtn,true);
    assert.equal(battleHud.hasSteerBearBtn,true);
    assert.ok(battleHud.elevInputRect.width>=56,`elevation slider is spacious (${battleHud.elevInputRect.width}px)`);
    assert.ok(battleHud.travInputRect.width>=56,`train slider is spacious (${battleHud.travInputRect.width}px)`);
    assert.ok(battleHud.elevInputRect.right<=battleHud.elevOutRect.left+1,'elevation slider does not overlap its readout');
    assert.ok(battleHud.travInputRect.right<=battleHud.travOutRect.left+1,'train slider does not overlap its readout');
    assert.ok(battleHud.elevOutRect.right<=battleHud.travInputRect.left,'elevation readout does not overlap train control');
    let maxSmoke=0,sawBall=false,sawFlash=false,sawCrown=false,sawProbe=false,sawResolve=false,sawRecoil=false,shotFrame=null,impactFrame=null,last=null;
    for(let i=0;i<180;i++){
      last=await gunneryRuntimeStep(page);maxSmoke=Math.max(maxSmoke,last.counts.volumes);sawBall||=!!last.render.gunneryBall;sawFlash||=last.counts.volumes>0;
      sawCrown||=!!last.render.gunneryCrown;sawProbe||=!!last.compute['roundshot actual sea sweep'];sawResolve||=!!last.compute['resolve cannon effects depth'];
      const recoil=await page.evaluate(()=>gunneryFixture.shipGuns.state.guns.some(g=>g.stage==='recoil'&&g.offset>0));sawRecoil||=recoil;
      if(last.shots&&!shotFrame){shotFrame=i;await gunneryRuntimeCapture(page,`gunnery-${model}-first-shot.png`);}
      if(last.impacts&&!impactFrame){impactFrame=i;await gunneryRuntimeCapture(page,`gunnery-${model}-impact.png`);}
      if(last.shots===loading.summary.total&&last.impacts>0&&i>(shotFrame??0)+12)break;
    }
    assert.equal(last.shots,loading.summary.total,JSON.stringify({last,loading}));assert.ok(last.impacts>0,JSON.stringify(last));
    await gunneryRuntimeCapture(page,`gunnery-${model}-broadside.png`);
    for(const [label,value]of Object.entries({sawBall,sawFlash,sawCrown,sawProbe,sawResolve,sawRecoil}))assert.equal(value,true,label);
    assert.ok(maxSmoke<=256);assert.ok(shotFrame>1,'no immediate click-to-shot bypass');
    const stable=await page.evaluate(()=>({events:gunneryFixture.events,other:gunneryFixture.vessels.slice(1).map(v=>({modelId:v.boat.modelId,secured:v.gunnery.state.guns.every(g=>g.stage==='secured')})),errors:gunneryRuntime.errors}));
    assert.equal(stable.other.length,1);assert.notEqual(stable.other[0].modelId,model);assert.equal(stable.other[0].secured,true);assert.deepEqual(stable.errors,[]);assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('explicit full Victory battery stress fixture bounds all 52 muzzle clouds in the real resumed HDR pass',{timeout:180000},async()=>{
  const {page,errors}=await gunneryRuntimePage('victory');
  try{
    await gunneryRuntimeStep(page);
    const stress=await page.evaluate(async()=>{
      const f=gunneryFixture,{gunMuzzlePose}=await import('/js/gunnery-models.js');
      // Visual-only worst case: synthesize simultaneous events at all52actual
      // attachments. The real drill, safety interlock and flight run above.
      const guns=f.shipGuns.state.guns.filter(g=>g.side==='starboard');
      for(const g of guns){const pose=gunMuzzlePose({...g,offset:0},f.boat);f.gunEffects.emitShot({id:g.id,position:pose.position,direction:pose.direction,chargeKg:g.mass*.3});}
      f.gunEffects.setProjectiles([]);f.gunEffects.update(.05,{wind:[1,0,0],eye:[0,10,65]});
      return {total:guns.length,counts:f.gunEffects.counts};
    });
    assert.equal(stress.total,52);assert.equal(stress.counts.volumes,208);
    const frame=await gunneryRuntimeStep(page,.001);assert.equal(frame.render.gunneryVolume,1);assert.equal(frame.compute['resolve cannon effects depth'],1);assert.ok(frame.counts.volumes<=208);
    assert.deepEqual(frame.errors,[]);assert.deepEqual(errors,[]);await gunneryRuntimeCapture(page,'gunnery-victory-52-gun-stress.png');
  }finally{await page.close();}
});
