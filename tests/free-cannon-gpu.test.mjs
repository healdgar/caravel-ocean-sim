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
  // The city's biggest building ashore, which joins the port's own at the first ball that meets it (js/city-targets.js).
  await page.waitForFunction(()=>window.oceanProps?.port&&window.oceanLand?.pack?.city?.typedCount>0,null,{timeout:60000,polling:200});
  const hall=await page.evaluate(async()=>{
    const {CITY_BUILDING_TYPES,CITY_TYPED_FLOATS:F,CITY_TYPES_WATERSIDE}=await import('/js/old-world-buildings.js');
    const {typed,typedTypes,typedCount}=window.oceanLand.pack.city,area=i=>(CITY_BUILDING_TYPES[typedTypes[i]].height??0)*(CITY_BUILDING_TYPES[typedTypes[i]].width??0);
    let best=-1;
    for(let i=0;i<typedCount;i++)if(!CITY_TYPES_WATERSIDE.has(typedTypes[i])&&(best<0||area(i)>area(best)))best=i;
    return {x:typed[best*F],z:typed[best*F+2],y:typed[best*F+1],height:CITY_BUILDING_TYPES[typedTypes[best]].height,id:`city_${best}`};
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
