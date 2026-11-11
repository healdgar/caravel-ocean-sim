// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';

const gunneryFxPort=process.env.GUNNERY_FX_TEST_PORT||8137;
let gunneryFxServer,gunneryFxBrowser;
before(async()=>{
  gunneryFxServer=spawn(process.execPath,['server.mjs',String(gunneryFxPort)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await once(gunneryFxServer.stdout,'data');
  gunneryFxBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await gunneryFxBrowser?.close();gunneryFxServer?.kill();});

// A bare device, a frame ten metres back from the origin, two hulls, and a 256-pixel target the effects draw into.
function installGunneryFxRig(){
  window.gunneryFxRig=async()=>{
    const {createGunneryEffects}=await import('/js/gunnery-effects.js'),{CASCADES}=await import('/js/wgsl/common.js');
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const B=GPUBufferUsage,T=GPUTextureUsage;
    const make=(data,usage,label)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const f=new Float32Array(96);f[0]=f[5]=1;f[11]=-1;f[14]=.1;f.set([0,1,10,0],16);f.set([1,0,0,0],20);f.set([0,1,0,0],24);f.set([0,0,-1,0],28);
    f.set([0,.8,.6,2],32);f.set([256,256,1/256,1/256],36);f.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);f[72]=1;f[73]=.001;
    const frame=make(f,B.UNIFORM|B.COPY_SRC,'test frame'),sun=make(new Float32Array([1,0,0,0]),B.STORAGE,'test sun');
    // Hull records as the scene keeps them: right, up, forward, size, origin, rig.
    const hullData=new Float32Array(48);for(const h of [0,1])hullData.set([1,0,0,1, 0,1,0,0, 0,0,-1,0, 3.6,12,0,0, 0,0,0,0, 0,0,0,0],h*24);
    const hulls=make(hullData,B.STORAGE|B.UNIFORM,'test hulls'),hullUniforms=[0,1].map(i=>make(new Float32Array(64),B.UNIFORM|B.COPY_SRC,'test hull '+i));
    const texture=(layers,color)=>{const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;};
    const sky=texture(1,[100,120,150]),trans=texture(1,[220,210,195]),env=texture(6,[70,90,110]);
    const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),seaSampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
    const shader=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(v=>v.type==='error').map(v=>label+': '+v.message));return module;};
    const fx=await createGunneryEffects({device,frameUBO:frame,hulls,hullCount:2,transView:trans.createView(),skyView:sky.createView(),sampler,envView:env.createView({dimension:'cube'}),sunVis:sun,seaView:sea.createView({dimension:'2d-array'}),seaSampler,shader,format:'rgba16float',samples:4});
    const ms=device.createTexture({size:[256,256],sampleCount:4,format:'rgba16float',usage:T.RENDER_ATTACHMENT});
    const target=device.createTexture({size:[256,256],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
    const depth=device.createTexture({size:[256,256],sampleCount:4,format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
    const read=device.createBuffer({size:256*256*8,usage:B.COPY_DST|B.MAP_READ}),readFloats=device.createBuffer({size:1024,usage:B.COPY_DST|B.MAP_READ}),depthView=depth.createView();
    // Bind groups made since the rig was set up: drawing smoke through one kept depth view must make none a frame.
    const made={groups:0},createGroup=device.createBindGroup.bind(device);device.createBindGroup=(...args)=>{made.groups++;return createGroup(...args);};
    const half=n=>{const sign=n&0x8000?-1:1,e=(n>>10)&31,m=n&1023;return sign*(e===0?m*2**-24:e===31?Infinity:(1+m/1024)*2**(e-15));};
    // Every upload the effects make, by the buffer it went to. The rig's own are told apart by their labels.
    const uploads=[],original=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(buffer,...rest)=>{if(!buffer.label.startsWith('test '))uploads.push(buffer.label);return original(buffer,...rest);};
    const setFrame=()=>original(frame,0,f);
    async function render(occlusion=0,backgroundAlpha=1){
      const encoder=device.createCommandEncoder();fx.encodeLights(encoder,{frame,hull:i=>hullUniforms[i]});fx.encode(encoder);
      let pass=encoder.beginRenderPass({colorAttachments:[{view:ms.createView(),resolveTarget:target.createView(),clearValue:[.02,.04,.06,backgroundAlpha],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depthView,depthClearValue:occlusion,depthLoadOp:'clear',depthStoreOp:'store'}});
      // As the game draws them: balls, splashes and debris in the scene's multisampled pass, then the smoke and
      // flame volumes onto its resolved colour, marched against a resolved copy of its depth.
      fx.drawProjectiles(pass);fx.drawInPass(pass);pass.end();
      if(fx.volumesActive){fx.resolveDepth(encoder,depthView,256,256);pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'load',storeOp:'store'}]});fx.drawVolumes(pass);pass.end();}
      encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256*8},[256,256]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const data=Array.from(new Uint16Array(read.getMappedRange()),half);read.unmap();return data;
    }
    // The effects' own GPU work for a frame nobody looks at: smoke is carried by the wind whether drawn or not.
    const advance=()=>{const encoder=device.createCommandEncoder(),ran=fx.encode(encoder);device.queue.submit([encoder.finish()]);return ran;};
    async function floats(buffer,count,first=0){
      const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,first*4,readFloats,0,count*4);device.queue.submit([encoder.finish()]);
      await readFloats.mapAsync(GPUMapMode.READ,0,count*4);const data=Array.from(new Float32Array(readFloats.getMappedRange(0,count*4)));readFloats.unmap();return data;
    }
    const empty=await render();
    // What a picture shows that the empty scene does not: how much of it, how bright, and where across the frame.
    const changed=data=>{let count=0,peak=0,sum=0,min=1e8,across=0;for(let p=0;p<256*256;p++){const i=p*4,l=(data[i]+data[i+1]+data[i+2])/3;peak=Math.max(peak,l);min=Math.min(min,l);sum+=l;if(Math.abs(data[i]-empty[i])+Math.abs(data[i+1]-empty[i+1])+Math.abs(data[i+2]-empty[i+2])>.002){count++;across+=p%256;}}return {count,peak,mean:sum/(256*256),min,centre:count?across/count:128};};
    const panel=(pixels,label)=>{const figure=document.createElement('figure'),caption=document.createElement('figcaption'),canvas=document.createElement('canvas');canvas.width=canvas.height=256;caption.textContent=label;const ctx=canvas.getContext('2d'),data=ctx.createImageData(256,256);for(let i=0;i<data.data.length;i++)data.data[i]=i%4===3?255:Math.round(255*Math.pow(Math.max(0,pixels[i])/(1+Math.max(0,pixels[i])),1/2.2));ctx.putImageData(data,0,0);figure.append(caption,canvas);document.body.append(figure);};
    document.body.style='margin:0;background:#111;color:white;display:flex;font:16px sans-serif';
    const finish=async()=>{await device.queue.onSubmittedWorkDone();fx.destroy();device.destroy();};
    // What the GPU's sort left for the passes after it: how many volumes it draws, and the workgroups the depth is copied with.
    const sorted=async()=>{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(fx.drawBuffer,0,readFloats,0,32);device.queue.submit([encoder.finish()]);
      await readFloats.mapAsync(GPUMapMode.READ,0,32);const words=Array.from(new Uint32Array(readFloats.getMappedRange(0,32)));readFloats.unmap();return {volumes:words[1],depthGroups:words.slice(4,7)};};
    return {device,errors,f,frame,setFrame,hulls,hullData,hullUniforms,write:original,fx,render,advance,floats,sorted,changed,panel,uploads,made,finish};
  };
}
async function gunneryFxPage(){
  const page=await gunneryFxBrowser.newPage();await page.route('**/__gunnery-fx',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto(`http://localhost:${gunneryFxPort}/__gunnery-fx`);await page.evaluate(installGunneryFxRig);return page;
}

test('a gun leaves a flash, a jet and a bank of dense smoke that the GPU carries off on the wind; roundshot and splashes draw with correct depth',{timeout:180000},async()=>{
  const page=await gunneryFxPage();
  try{
    const result=await page.evaluate(async()=>{
      const {errors,f,setFrame,fx,render,advance,floats,sorted,changed,panel,uploads,made,finish}=await gunneryFxRig();
      let clock=590;
      // The frame carries the clock and the wind, and the smoke takes both from it on the GPU. The effects are
      // handed the clock, and the wind only to know when a bank's record can be dropped.
      const air=(x,z)=>{const speed=Math.hypot(x,z);f[56]=speed?x/speed:1;f[57]=speed?z/speed:0;f[58]=speed;};
      const run=(seconds,dt=.05)=>{for(let i=0,n=Math.round(seconds/dt);i<n;i++){clock+=dt;if(clock>=600)clock-=600;f[19]=clock;setFrame();fx.update(dt,{time:clock,wind:[f[56]*f[58],0,f[57]*f[58]]});advance();}};
      // The newest bank, as the GPU has it: centre, half-widths, how thick.
      let slot=0;const bank=async()=>{slot=fx.state.banks.at(-1)?.slot??slot;const v=await floats(fx.volumeBuffer,20,(fx.volumeSlots.banks+slot)*20);return {centre:v.slice(0,3),radii:[v[7],v[11],v[15]],extinction:v[16]};};
      const sky=()=>{setFrame();};
      f[19]=clock;setFrame();fx.update(.1,{time:clock});const idleWrites=uploads.length,idleWork=advance();
      // A calm. One gun, firing along the picture.
      fx.emitShot({position:[-3,1,0],direction:[1,0,0],chargeKg:3});run(.025,.025);const fired=uploads.slice();
      const flashPixels=await render(),flash=changed(flashPixels);panel(flashPixels,'25 ms: flash');
      run(.225,.025);const smokePixels=await render(),smoke=changed(smokePixels),groupsOnceSmoking=made.groups,occluded=changed(await render(.03));panel(smokePixels,'250 ms: jet');
      const smokeCounts=fx.counts;f[35]=0;sky();const night=changed(await render());f[35]=2;sky();
      run(2.75);const billowPixels=await render(),billow=changed(billowPixels),facing=await sorted();panel(billowPixels,'3 s: bank, calm');
      const opacityPixels=await render(0,0),alpha=[];for(let i=3;i<opacityPixels.length;i+=4)alpha.push(opacityPixels[i]);const peakOpacity=Math.max(...alpha);
      const calm=await bank();
      // The eye stands in the bank with a wall close before it, as on a deck with smoke lying against the rail, so
      // every walk is cut short at the wall. How unlike its neighbour each pixel of the veil is, as a share of the veil.
      const bare=await render(1),uneven=pixels=>{let veil=0,jump=0;for(let y=0;y<256;y++)for(let x=0;x<255;x++){const i=(y*256+x)*4,a=pixels[i]-bare[i],b=pixels[i+4]-bare[i+4];veil+=a+b;jump+=Math.abs(a-b);}return {veil:veil/(2*256*255),uneven:2*jump/veil};};
      const eye=[f[16],f[17],f[18]],walled=[];f.set([calm.centre[0],calm.centre[1],calm.centre[2]+Math.min(...calm.radii)*.5],16);sky();
      for(const metres of [.6,1.2,2.4]){const pixels=await render(.1/metres);walled.push({metres,...uneven(pixels)});if(metres===1.2)panel(pixels,'3 s: in the bank, a wall 1.2 m off');}
      f.set(eye,16);sky();
      // The eye stands off and turns its back on the smoke: none of it is drawn, and the scene's depth is not copied for it.
      f[18]=40;f[0]=-1;f[11]=1;sky();const behind=changed(await render()),away=await sorted();f[18]=10;f[0]=1;f[11]=-1;sky();
      // A breeze from the left of the picture, 5 m/s, on a new gun. The clock passes its turn-over on the way.
      fx.clear();run(.05);air(0,-5);const before=uploads.length;
      fx.emitShot({position:[0,1,0],direction:[1,0,0],chargeKg:3});run(.05);const sent=uploads.length-before;
      run(3.95);const at4=await bank(),breezePixels=await render();panel(breezePixels,'4 s: 5 m/s across');
      run(4,.2);const at8=await bank(),drifting=uploads.length-before-sent,banksAt8=fx.counts.banks;
      // It comes on to blow: the bank is torn away long before a calm would have let it go.
      air(0,-18);run(10,.2);const torn=await bank(),gone=changed(await render()),groupsMadeLater=made.groups-groupsOnceSmoking;
      // And once it has gone its record goes too: no smoke pass, no depth copied, nothing drawn for it.
      run(1.4,.2);const kept=fx.counts.banks,stillWorking=advance()||fx.volumesActive;
      // Eight guns alike in every way, side by side and fired together: their jets are not alike.
      fx.clear();air(0,0);run(.05);for(let gun=0;gun<8;gun++)fx.emitShot({position:[-3,1,-2.4*gun],direction:[1,0,0],chargeKg:3});run(1);
      const jets=[];for(const shot of fx.state.shots){const v=await floats(fx.volumeBuffer,20,(fx.volumeSlots.jets+shot.slot)*20);jets.push({centre:v.slice(0,3),radii:[v[7],v[11],v[15]],aim:v.slice(12,15),extinction:v[16]});}
      const rowPixels=await render();panel(rowPixels,'1 s: eight guns');
      fx.clear();air(0,0);f[35]=2;sky();fx.setProjectiles([{position:[0,1,0],radius:.3}]);fx.update(0,{time:clock});const ball=changed(await render());
      fx.clear();fx.emitImpact({position:[0,0,0],velocity:[25,-35,-5],massKg:12});run(.3,.05);const splashPixels=await render(),splash=changed(splashPixels),splashOccluded=changed(await render(.03));panel(splashPixels,'300 ms: real water impact');
      const birth=Array.from(fx.state.impacts[0].position);fx.clear();run(.1);const cleared=changed(await render());
      await finish();return {errors,idleWrites,idleWork,fired,flash,smoke,occluded,night,billow,peakOpacity,calm,walled,facing,behind,away,sent,at4,at8,drifting,banksAt8,torn,gone,kept,stillWorking,groupsMadeLater,jets,ball,splash,splashOccluded,birth,cleared,smokeCounts};
    });
    if(process.env.GUNNERY_FX_SHOT)await page.screenshot({path:process.env.GUNNERY_FX_SHOT,fullPage:true});
    const told=JSON.stringify(result);
    assert.deepEqual(result.errors,[],told);assert.equal(result.idleWrites,0);assert.equal(result.idleWork,false,'no guns, no smoke pass: '+told);
    assert.deepEqual(result.fired.sort(),['cannon smoke banks','cannon smoke shots'],'a gun sends its own record and its bank\'s, once: '+told);
    assert.ok(result.flash.count>25&&result.flash.peak>.95,told);
    // The flash was brought inside the bloom's range on purpose (a peak near 1.1, once above 2). It must still
    // outshine the sunlit smoke it throws by at least two to one.
    assert.ok(result.smoke.count>100&&result.smoke.peak<result.flash.peak*.5,told);
    assert.deepEqual([result.smokeCounts.shots,result.smokeCounts.banks,result.smokeCounts.volumes],[1,1,3]);assert.equal(result.occluded.count,0,told);
    assert.ok(result.night.mean<result.smoke.mean,told);
    assert.ok(result.billow.count>result.smoke.count*2,told);
    assert.ok(result.peakOpacity>.8&&result.peakOpacity<=1,'a 3-second-old single discharge must retain a dense central powder cloud: '+told);
    // In a calm the bank stays off the muzzle it left, and has risen a little.
    assert.ok(Math.abs(result.calm.centre[2])<1&&result.calm.centre[0]>0&&result.calm.centre[0]<6&&result.calm.centre[1]>1.5,told);
    // Seen from within, against a wall close by, it is an even veil that thickens with the air before the wall: no
    // pixel finds the smoke where its neighbour misses it. (A walk that trusted one sample gave .1 to .24 here.)
    assert.ok(result.walled.every(wall=>wall.veil>.06&&wall.uneven<.05)&&result.walled[2].veil>result.walled[0].veil,'smoke cut short by near timber must not stipple: '+told);
    assert.equal(result.sent,2,told);assert.equal(result.drifting,0,'smoke on the wind sends nothing: '+told);
    // Caught up by the air, it goes at the wind's own pace and way: 5 m/s, less the second or so it took to be caught.
    const carried=t=>-5*(t-1.35*(1-Math.exp(-t/1.35)));
    for(const [at,t] of [[result.at4,4],[result.at8,8]])assert.ok(Math.abs(at.centre[2]-carried(t))<1.6,t+' s: '+told);
    assert.ok(Math.abs((result.at8.centre[2]-result.at4.centre[2])/4+5)<.2,'downwind at the wind\'s speed: '+told);
    assert.ok(Math.abs(result.at8.centre[0]-result.at4.centre[0])<1.2,'and not across it: '+told);
    // It rises, spreads and thins as it goes.
    assert.ok(result.at8.centre[1]>result.at4.centre[1]+.5,told);
    assert.ok(result.at8.radii.every((r,i)=>r>result.at4.radii[i]*1.15)&&result.at8.extinction<result.at4.extinction*.7&&result.at8.extinction>0,told);
    assert.equal(result.banksAt8,1);
    assert.ok(result.torn.extinction===0&&result.gone.count===0,'a gale has it gone in seconds: '+told);
    assert.ok(result.kept===0&&result.stillWorking===false,'and then nothing is kept, built or drawn for it: '+told);
    assert.equal(result.groupsMadeLater,0,'once the smoke is up, drawing it through the same depth view makes no bind group a frame');
    // Smoke that is not in view is not drawn, and the depth it would be drawn against is not copied.
    assert.deepEqual(result.facing,{volumes:1,depthGroups:[32,32,1]},told);
    assert.deepEqual(result.away,{volumes:0,depthGroups:[0,0,0]},told);assert.equal(result.behind.count,0,told);
    // Guns alike in every way throw jets that differ in girth, length, reach and lean, so a broadside is no row of beads.
    const spread=values=>Math.max(...values)/Math.min(...values),jets=result.jets,thrown=JSON.stringify(jets);
    assert.equal(jets.length,8);
    assert.ok(spread(jets.map(jet=>jet.radii[0]))>1.25&&spread(jets.map(jet=>jet.radii[2]))>1.15&&spread(jets.map(jet=>jet.centre[0]+3))>1.15,'girth, length and reach: '+thrown);
    let widest=1;for(const a of jets)for(const b of jets)widest=Math.min(widest,a.aim.reduce((sum,v,k)=>sum+v*b.aim[k],0));
    assert.ok(widest<Math.cos(10*Math.PI/180),'lean: '+thrown);
    for(const jet of jets)assert.ok(jet.extinction>0&&jet.aim[0]>.9&&jet.centre[0]>-3&&jet.radii.every(r=>r>.5&&r<9),'each still a jet along its own gun\'s line: '+thrown);
    assert.ok(result.ball.count>5&&result.ball.min<.035,told);
    assert.ok(result.splash.count>20,told);assert.equal(result.splashOccluded.count,0,told);
    assert.deepEqual(result.birth,[0,0,0]);assert.equal(result.cleared.count,0,told);
  }finally{await page.close();}
});

test('a fire is drawn, lit and carried with its hull by the GPU from one record, with nothing sent while it burns steadily',{timeout:120000},async()=>{
  const page=await gunneryFxPage();
  try{
    const result=await page.evaluate(async()=>{
      const {errors,f,frame,setFrame,hulls,hullData,hullUniforms,write,fx,render,floats,changed,panel,uploads,finish}=await gunneryFxRig();
      let clock=20;const tick=dt=>{clock+=dt;f[19]=clock;setFrame();};tick(0);
      // Ashore: a fire where the world says, growing as a ship's fire grows.
      const ashore={position:[0,1,0],intensity:1,age:1,seed:.37};
      const burn=(fire,hull,seconds)=>{const from=uploads.length;for(let i=0;i<Math.round(seconds*60);i++){tick(1/60);fire.age+=1/60;fire.intensity+=.012/60;fx.update(1/60,{time:clock,fires:[fire],fireHulls:[hull]});}return uploads.slice(from);};
      fx.update(1/60,{time:clock,fires:[ashore],fireHulls:[-1]});const lit=uploads.slice();
      const flamePixels=await render(),flame=changed(flamePixels),hidden=changed(await render(.03));panel(flamePixels,'fire ashore');
      const light=(await floats(frame,96)),lightAshore=[light[23],light[27],light[31],light[54]];
      const learning=burn(ashore,-1,1),steady=burn(ashore,-1,3);
      const laterPixels=await render(),later=changed(laterPixels);let flicker=0;for(let i=0;i<laterPixels.length;i++)flicker+=Math.abs(laterPixels[i]-flamePixels[i]);
      const known=fx.fires.intensity(0,clock),truth=ashore.intensity;
      // Aboard: the same record, placed by her hull's transform. Moving the hull moves the fire, and nothing is sent.
      const aboard={position:[99,99,99],localPosition:[0,1,0],intensity:1,age:1,seed:.61};
      hullData[24+16]=-2.5;write(hulls,0,hullData);fx.update(1/60,{time:clock,fires:[aboard],fireHulls:[1]});
      const portPixels=await render(),port=changed(portPixels);panel(portPixels,'fire aboard, hull to the left');
      const pack=(await floats(hullUniforms[1],64))[51],idle=(await floats(hullUniforms[0],64))[51];
      const lightAboard=await floats(frame,96);
      burn(aboard,1,1);hullData[24+16]=2.5;write(hulls,0,hullData);const moved=burn(aboard,1,.5);
      const starboardPixels=await render(),starboard=changed(starboardPixels);panel(starboardPixels,'fire aboard, hull to the right');
      // Out: nothing drawn, nothing lit.
      fx.update(1/60,{time:clock,fires:[],fireHulls:[]});const out=changed(await render()),counts=fx.counts,lightsEncoded=fx.encodeLights({beginComputePass(){throw Error('no fire, no light pass');}});
      await finish();return {errors,lit,flame,hidden,lightAshore,learning,steady,later,flicker,known,truth,port,starboard,pack,idle,lightAboardX:lightAboard[23],moved,out,counts,lightsEncoded};
    });
    if(process.env.GUNNERY_FX_SHOT)await page.screenshot({path:process.env.GUNNERY_FX_SHOT.replace(/(\.\w+)$/,'-fire$1'),fullPage:true});
    const told=JSON.stringify(result);
    assert.deepEqual(result.errors,[],told);
    assert.deepEqual([...new Set(result.lit)].sort(),['cannon smoke volume counts','fires burning'],'lighting a fire sends its record and the count, and no volumes: '+told);
    assert.ok(result.flame.count>150&&result.flame.peak>1,'flame is drawn bright: '+told);assert.equal(result.hidden.count,0,told);
    assert.ok(Math.abs(result.lightAshore[0])<.01&&Math.abs(result.lightAshore[1]-1)<.01&&Math.abs(result.lightAshore[2])<.01&&Math.abs(result.lightAshore[3]-1)<.02,'the frame is handed the fire as a light: '+told);
    assert.ok(result.learning.length<=2&&result.learning.every(label=>label==='fires burning'),'its pace is learned in a write or two: '+told);
    assert.deepEqual(result.steady,[],'a fire burning steadily sends nothing: '+told);
    assert.ok(Math.abs(result.known-result.truth)<.004,'the GPU still has its intensity right: '+told);
    assert.ok(result.later.count>150&&result.flicker>1,'and it still burns and flickers: '+told);
    assert.ok(result.port.count>150&&result.port.centre<110&&result.starboard.centre>146,'a fire aboard goes where her hull goes: '+told);
    assert.deepEqual(result.moved,[],'moving the hull sends nothing for the fire: '+told);
    assert.ok(result.lightAboardX<-2.4&&result.lightAboardX>-2.6,told);
    assert.ok(Math.abs(result.pack-7.4)<.01&&result.idle===0,'her own decks are lit from the same record: '+told);
    assert.equal(result.out.count,0,told);assert.equal(result.counts.fires,0);assert.equal(result.lightsEncoded,false);
  }finally{await page.close();}
});
