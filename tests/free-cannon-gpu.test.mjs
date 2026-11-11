import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

async function open(params){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',sunElev:50,clouds:0,...params}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  return {page,errors};
}
const rounds=page=>page.evaluate(()=>window.oceanFreeCannon.state.guns[0].roundsFired);

test('in the free camera, holding F shells what the sight is on',async()=>{
  let {page,errors}=await open({});
  await page.waitForFunction(()=>window.oceanProps?.port?.instances?.length>0,null,{timeout:60000,polling:200});
  const hall=await page.evaluate(()=>{
    const all=window.oceanProps.port.instances,best=[...all].sort((a,b)=>(b.height??0)*(b.width??0)-(a.height??0)*(a.width??0))[0];
    return {x:best.x,z:best.z,y:best.baseY??best.y??0,height:best.height??10,id:best.id};
  });
  await page.close();
  const from={x:hall.x+60,z:hall.z+60,y:hall.y+hall.height*.5+.8};
  const yaw=Math.atan2(hall.x-from.x,-(hall.z-from.z))*180/Math.PI;
  ({page,errors}=await open({cam:[from.x,from.y,from.z,yaw,0].join(',')}));
  try{
    assert.equal(await rounds(page),0);
    const sight=await page.evaluate(()=>getComputedStyle(document.body,'::after').content);
    assert.notEqual(sight,'none','the sight shows in the free camera');
    await page.keyboard.down('f');
    await page.waitForFunction(()=>window.oceanFreeCannon.state.guns[0].roundsFired>=2,null,{timeout:60000,polling:100});
    await page.keyboard.up('f');
    // The port may still be loading when the second round goes: wait for it, as the first page does.
    await page.waitForFunction(()=>window.oceanProps?.port?.instances?.some(b=>(b.damageState?.hits??0)>0),null,{timeout:60000,polling:200});
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('aboard ship, F is the broadside again and the cannon stays quiet',async()=>{
  const {page,errors}=await open({});
  try{
    await page.keyboard.press('b');
    await page.waitForFunction(()=>!document.body.classList.contains('free-cannon'),null,{timeout:30000,polling:100});
    await page.keyboard.down('f');
    await page.waitForTimeout(1500);
    await page.keyboard.up('f');
    assert.equal(await rounds(page),0);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
