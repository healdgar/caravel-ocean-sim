// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
const port=8124,origin=`http://localhost:${port}`;let server,browser;
before(async()=>{server=spawn(process.execPath,['server.mjs',String(port)],{stdio:['ignore','pipe','inherit']});await once(server.stdout,'data');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});});
after(async()=>{await browser?.close();server?.kill();});
async function load(options={},path='/'){
 const page=await browser.newPage(options),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.inspection={callback:null,errors:[]};window.requestAnimationFrame=cb=>{inspection.callback=cb;return 1;};const req=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){const d=await req.apply(this,a);inspection.device=d;d.addEventListener('uncapturederror',e=>inspection.errors.push(e.error.message));return d;};});
 const main=await readFile(new URL('../js/main.js',import.meta.url),'utf8');await page.route('**/js/main.js',r=>r.fulfill({contentType:'text/javascript',body:main.replace('  resize();\n  updateResolutionStatus();','  Object.assign(window.inspection,{cam,boat,shipOrbit,render:()=>frame(last)});\n  resize();\n  updateResolutionStatus();')}));
 await page.goto(origin+path+'?view=ship&cam=100,-7,200,0,0&boatX=23&boatZ=-41&propulsion=manual&boatSpeed=0&follower=0&crew=0&windSpeed=2&swellHs=.1&orbitDistance=8&orbitElevation=0&orbitPanY=-6&resolution=native');
 await page.waitForFunction(()=>inspection.callback||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});assert.equal(await page.locator('#err').textContent(),'');
 const render=()=>page.evaluate(async()=>{if(inspection.render)inspection.render();else{const frame=inspection.callback;inspection.callback=null;frame(performance.now());}await inspection.device.queue.onSubmittedWorkDone();return {cam:{...inspection.cam},orbit:{...inspection.shipOrbit},boat:inspection.boat?[inspection.boat.x,inspection.boat.z]:null,errors:inspection.errors};});
 return{page,errors,render};
}
async function inspectionUILayout(page){return page.evaluate(()=>({
 width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale,
 hud:[...document.querySelectorAll('#sailing-instruments,#camera-dock,#helm-controls')].map(element=>{
  const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height];
 }),
}));}
test('actual inspection controls orbit below water, pan focus and approach the hull',{timeout:120000},async()=>{
 const {page,errors,render}=await load({viewport:{width:800,height:600}});try{
  const before=await render();assert.deepEqual(before.boat,[23,-41],'restoring the inspection camera must not move the shared ship');
  await page.mouse.move(380,360);await page.mouse.down();await page.mouse.move(380,160,{steps:4});await page.mouse.up();const below=await render();
  assert.ok(below.cam.y<0,'ordinary orbit can plunge below the sea');assert.ok(below.orbit.elevation<0);
  await page.mouse.move(400,330);await page.mouse.down({button:'right'});await page.mouse.move(470,400,{steps:4});await page.mouse.up({button:'right'});const pan=await render();
  assert.ok(Math.hypot(pan.orbit.panX,pan.orbit.panZ)>.1,'right drag changes horizontal focus');assert.notEqual(pan.orbit.panY,before.orbit.panY);
  await page.mouse.wheel(0,-300);await page.waitForFunction(()=>inspection.shipOrbit.distance<8,undefined,{polling:20,timeout:3000});
  const close=await render();assert.ok(close.orbit.distance<8&&close.orbit.distance<10);
  assert.deepEqual(errors,[]);assert.deepEqual(close.errors,[]);
 }finally{await page.close();}
});
test('mobile two-finger gestures pan and pinch without changing orbit angle',{timeout:120000},async()=>{
 const {page,errors,render}=await load({viewport:{width:402,height:874},deviceScaleFactor:3,isMobile:true,hasTouch:true});try{
  const before=await render(),layout=await inspectionUILayout(page),cdp=await page.context().newCDPSession(page);
  const point=(id,x,y)=>({id,x,y,radiusX:2,radiusY:2,force:1});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point(1,130,380),point(2,270,380)]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point(1,110,420),point(2,290,420)]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const after=await render();assert.ok(after.orbit.distance<before.orbit.distance,'pinch out approaches the hull');
  assert.notEqual(after.orbit.panY,before.orbit.panY);assert.ok(Math.abs(after.orbit.elevation-before.orbit.elevation)<1e-9,'two-finger pan does not orbit');
  assert.deepEqual(await inspectionUILayout(page),layout,'touch pinch changes the scene, never the HUD or browser viewport scale');
  assert.deepEqual(errors,[]);assert.deepEqual(after.errors,[]);
 }finally{await page.close();}
});

for(const path of ['/', '/docs/index.html'])test(`${path}: Ctrl-wheel zoom belongs to the scene and leaves HUD size and browser scale unchanged`,{timeout:120000},async()=>{
 const {page,errors,render}=await load({viewport:{width:800,height:600}},path);try{
  const before=await render(),layout=await inspectionUILayout(page);
  await page.evaluate(()=>{window.inspection.wheels=[];addEventListener('wheel',e=>inspection.wheels.push({target:e.target.id,ctrl:e.ctrlKey,prevented:e.defaultPrevented,trusted:e.isTrusted}));});
  await page.mouse.move(400,300);await page.keyboard.down('Control');
  try{await page.mouse.wheel(0,-240);}finally{await page.keyboard.up('Control');}
  await page.waitForFunction(()=>inspection.wheels.some(e=>e.target==='c'&&e.ctrl),undefined,{polling:20,timeout:3000});
  const wheel=await page.evaluate(()=>inspection.wheels.find(e=>e.target==='c'&&e.ctrl));
  assert.equal(wheel.trusted,true,'exercise native browser input');assert.equal(wheel.prevented,true,'browser page zoom must be canceled over the scene');
  const after=await render();if(path==='/')assert.ok(after.orbit.distance<before.orbit.distance,'the same input still approaches the ship');
  assert.deepEqual(await inspectionUILayout(page),layout,'camera zoom cannot resize any HUD controls or the visual viewport');
  const outside=await page.evaluate(()=>{const event=new WheelEvent('wheel',{deltaY:20,ctrlKey:true,bubbles:true,cancelable:true});document.querySelector('#rudder-centre').dispatchEvent(event);return event.defaultPrevented;});
  assert.equal(outside,false,'zoom cancellation stays scoped to the scene rather than disabling page accessibility');
  assert.deepEqual(errors,[]);assert.deepEqual(after.errors,[]);
 }finally{await page.close();}
});
