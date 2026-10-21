import assert from 'node:assert/strict';
import{spawn}from'node:child_process';import{once}from'node:events';import{test}from'node:test';import{chromium}from'playwright';

test('loaded guns check all six displaced sea bands before firing, with no idle query work',{timeout:120000},async()=>{
 const port=process.env.GUNPORT_TEST_PORT||8144,server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
 try{await once(server.stdout,'data');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
 const page=await browser.newPage();await page.route('**/__gunports',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__gunports`);
 const result=await page.evaluate(async()=>{
  const{createGunportSafety}=await import('/js/gunport-safety.js'),{createGunDefinitions,gunMuzzlePose}=await import('/js/gunnery-models.js'),{CASCADES}=await import('/js/wgsl/common.js');
  const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[],B=GPUBufferUsage,T=GPUTextureUsage;device.onuncapturederror=e=>errors.push(e.error.message);
  const f=new Float32Array(96);f.set([1/16,1/16,1/16,1/16,1/16,1/16],48);const frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(frame,0,f);
  const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
  const computePipe=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}})};
  const guard=await createGunportSafety({device,frameUBO:frame,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,computePipe});
  const boat={modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,revision:2,gunnery:{guns:createGunDefinitions('nina').map(g=>({...g,stage:'ready',diameter:.1,offset:0}))}};
  const gun=boat.gunnery.guns[2],pose=()=>gunMuzzlePose(gun,boat),block=t=>guard.block(gun,pose(),t,boat.revision);
  let writes=0;const write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(...a)=>{writes++;return write(...a)};
  const encode=time=>{const e=device.createCommandEncoder(),active=guard.encode(e,boat,time);device.queue.submit([e.finish()]);guard.read();return active};
  const settle=async()=>{for(let i=0;i<1000&&guard.pending;i++)await new Promise(r=>setTimeout(r,1));if(guard.pending)throw Error('Gunport query stalled')};
  const idle=encode(0),idleWrites=writes;
  boat.gunnerySide='starboard';const unseen=block(1);
  device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array([0,0x4800,0,0]),{bytesPerRow:8},[1,1]);
  encode(1);await settle();const wet=block(1);
  device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array(4),{bytesPerRow:8},[1,1]);
  const beforeRefresh=block(1.1);encode(1.1);await settle();const dry=block(1.1),stale=block(1.41);
  boat.revision++;const revised=block(1.1);encode(1.2);await settle();const recovered=block(1.2);
  guard.clear();const cleared=block(1.2);guard.destroy();await device.queue.onSubmittedWorkDone();device.destroy();return{errors,idle,idleWrites,unseen,wet,beforeRefresh,dry,stale,revised,recovered,cleared};
 });
 assert.deepEqual(result.errors,[]);assert.equal(result.idle,false);assert.equal(result.idleWrites,0);
 assert.equal(result.unseen,'Checking sea at gunports');assert.equal(result.wet,'Gunports awash');assert.equal(result.beforeRefresh,'Gunports awash');assert.equal(result.dry,null);assert.equal(result.stale,'Checking sea at gunports');assert.equal(result.revised,'Checking sea at gunports');assert.equal(result.recovered,null);assert.equal(result.cleared,'Checking sea at gunports');
 }finally{await browser?.close();server.kill()}
});
