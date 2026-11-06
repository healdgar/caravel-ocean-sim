import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

// The share of the picture near white, with the panels hidden so only the scene counts.
async function glare(query){
  const page=await browser.newPage({viewport:{width:960,height:540}});
  try{
    await page.goto(`${base}?broadside=1&ship=nina&view=ship&w=960&h=540&clouds=0${query}`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
    assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
    await page.waitForTimeout(2000);
    assert.ok(await page.evaluate(()=>(window.oceanFleet.vessels[0].gunnery.computeAimTrajectories({wind:[0,0,0],fallbackSide:'port'})?.length??0)>0),'the arcs are up');
    await page.addStyleTag({content:'body>*:not(canvas){visibility:hidden!important}'});
    const png=(await page.screenshot()).toString('base64');
    return await page.evaluate(async(data)=>{
      const blob=await (await fetch(`data:image/png;base64,${data}`)).blob(),bitmap=await createImageBitmap(blob);
      const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
      const {data:pixels}=context.getImageData(0,0,bitmap.width,bitmap.height);
      let bright=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i]+pixels[i+1]+pixels[i+2]>600)bright++;
      return bright/(pixels.length/4);
    },png);
  }finally{await page.close();}
}

test('aim arcs do not blind the player at night',{timeout:300000},async()=>{
  const share=await glare('&skyMode=astronomy&astroDate=2026-06-15T02:00:00Z');
  assert.ok(share<.002,`${(share*100).toFixed(2)}% of the night picture is near white`);
});
