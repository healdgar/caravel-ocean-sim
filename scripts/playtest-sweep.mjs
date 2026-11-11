// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Plays the page as a player with no plan would: clicks every control it shows and presses every key, one at a
// time, and says which of them threw, were covered by something else, put a NaN into the game's state, stopped the
// frames, or did nothing that can be seen. "Nothing seen" is a lead to read the handler by, not a verdict.
//   node scripts/playtest-sweep.mjs                    every scene
//   node scripts/playtest-sweep.mjs sea dock           chosen scenes: sea, dock, coast, phone
//   node scripts/playtest-sweep.mjs --keys sea         press the keys as well
// PLAYTEST_OUT=folder keeps report.json and a picture of each scene as the sweep left it.
import {once} from 'node:events';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

const args=process.argv.slice(2),wantKeys=args.includes('--keys'),out=process.env.PLAYTEST_OUT;
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/`;
const SCENES={
  sea:{url:base+'?ocean=1',viewport:{width:1280,height:800}},
  dock:{url:coastalRegionStageURL(base,'lisbon','dock','clear',1550).toString(),viewport:{width:1280,height:800}},
  coast:{url:base+'?region=havana&landfall=coast&boat=1',viewport:{width:1280,height:800}},
  phone:{url:base,viewport:{width:390,height:844},hasTouch:true,isMobile:true},
};
const chosen=args.filter(a=>SCENES[a]);
const scenes=chosen.length?chosen:Object.keys(SCENES);
// Controls that end the scene or reach outside the page. Erasing has its own test (tests/save-reset-gpu.test.mjs).
const LEFT_ALONE=/reset voyage|erase|abandon|retire|share|copy|full ?screen|install|download/i;
const KEYS=[...'abcdefghijklmnopqrstuvwxyz0123456789','[',']','-','=',',','.','/',';','Space','Enter','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Tab'];
const MAX_STEPS=Number(process.env.PLAYTEST_STEPS||160);

const browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
if(out)mkdirSync(out,{recursive:true});

// Runs in the page. What the player could act on, and the state a control might change.
function instrument(){
  const pathOf=el=>{
    const parts=[];
    for(let node=el;node&&node!==document.body;node=node.parentElement){
      if(node.id){parts.unshift('#'+CSS.escape(node.id));break;}
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${[...node.parentElement.children].indexOf(node)+1})`);
    }
    return (parts[0]?.startsWith('#')?'':'body > ')+parts.join(' > ');
  };
  window.playtestControls=()=>{
    const list=[];
    for(const el of document.querySelectorAll('button,input,select,summary,[role=button],[role=tab],[role=switch],a[href]')){
      const r=el.getBoundingClientRect(),cs=getComputedStyle(el);
      if(!(r.width>2&&r.height>2)||cs.visibility==='hidden'||cs.display==='none'||el.closest('[hidden]'))continue;
      const label=(el.getAttribute('aria-label')||el.title||el.textContent||el.name||el.id||'').trim().replace(/\s+/g,' ').slice(0,70);
      list.push({path:pathOf(el),label,tag:el.tagName.toLowerCase(),type:el.type||'',id:el.id,cls:String(el.className).slice(0,60),disabled:el.disabled===true,
        href:el.getAttribute('href')||'',options:el.tagName==='SELECT'?[...el.options].map(o=>o.value):null,value:el.value??null});
    }
    return list;
  };
  window.playtestState=()=>{
    const dom=[];
    for(const el of document.body.querySelectorAll('button,input,select,textarea,summary,details,dialog,section,aside,nav,[role],[aria-pressed],[aria-expanded],[hidden],[data-expanded]')){
      dom.push([pathOf(el),el.className,el.hidden,el.disabled===true,el.getAttribute('aria-pressed'),el.getAttribute('aria-expanded'),el.open===true,el.checked===true,
        el.matches('select,input')?el.value:'',el.matches('button')?el.textContent.trim().slice(0,60):'',getComputedStyle(el).display==='none'].join('|'));
    }
    dom.push('body|'+document.body.className);
    const leaves={},seen=new WeakSet();let count=0;
    const walk=(value,path,depth)=>{
      if(count>20000)return;
      const type=typeof value;
      if(value==null||type==='boolean'||type==='string'){leaves[path]=type==='string'?value.slice(0,80):String(value);count++;return;}
      if(type==='number'){leaves[path]=Number.isFinite(value)?Number(value.toPrecision(5)):String(value);count++;return;}
      if(type!=='object'||depth>=4||seen.has(value))return;
      seen.add(value);
      const kind=value.constructor?.name||'';
      if(ArrayBuffer.isView(value)||value instanceof Node||/^GPU|^Audio|Promise|Worker|Observer/.test(kind))return;
      if(value instanceof Map||value instanceof Set){leaves[path+'.size']=value.size;count++;return;}
      if(Array.isArray(value)){leaves[path+'.length']=value.length;count++;if(value.length<=6)value.forEach((v,i)=>walk(v,`${path}[${i}]`,depth+1));return;}
      let keys=0;
      for(const key of Object.keys(value)){
        if(++keys>90)break;
        let v;try{v=value[key];}catch{continue;}
        if(typeof v!=='function')walk(v,path+'.'+key,depth+1);
      }
    };
    for(const name of Object.keys(window))if(/^ocean/.test(name)&&name!=='oceanStartup'){
      let root;try{root=window[name];}catch{continue;}
      if(name==='oceanFleet'){(root.vessels||[]).slice(0,2).forEach((v,i)=>{walk(v.boat,`fleet[${i}].boat`,1);walk(v.follower,`fleet[${i}].follower`,2);});continue;}
      if(name==='oceanVoyage'){walk(root.voyage,'voyage',1);walk(root.helmsman,'helmsman',2);walk(root.pursuit,'pursuit',2);walk(root.approach,'approach',2);continue;}
      walk(root,name,1);
    }
    return {dom,leaves};
  };
  window.playtestFrames=ms=>new Promise(resolve=>{let frames=0;const start=performance.now();const tick=()=>{frames++;performance.now()-start<ms?requestAnimationFrame(tick):resolve(frames);};requestAnimationFrame(tick);});
}

const ready=page=>page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:250});
const state=page=>page.evaluate(()=>window.playtestState());
const differs=(a,b)=>{
  const dom=a.dom.length!==b.dom.length||a.dom.some((line,i)=>line!==b.dom[i]);
  const leaves=[];
  for(const key of new Set([...Object.keys(a.leaves),...Object.keys(b.leaves)]))if(a.leaves[key]!==b.leaves[key])leaves.push(key);
  return {dom,leaves};
};
const nonFinite=snapshot=>Object.entries(snapshot.leaves).filter(([,v])=>v==='NaN'||v==='Infinity'||v==='-Infinity').map(([k])=>k);

const report=[];
for(const name of scenes){
  const scene=SCENES[name],{url,...contextOptions}=scene;
  const context=await browser.newContext(contextOptions);
  await context.addInitScript(instrument);
  const page=await context.newPage();
  let errors=[];
  page.on('pageerror',e=>errors.push('thrown: '+e.message));
  page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push('console: '+m.text().slice(0,300));});
  page.on('dialog',d=>{errors.push(`dialog (${d.type()}): ${d.message().slice(0,120)}`);d.dismiss().catch(()=>{});});
  const enter=async()=>{await page.goto(url);await ready(page);await page.waitForTimeout(4000);};
  await enter();
  const rows=[],done=new Set();
  const startErrors=errors.splice(0);
  const started=await state(page);
  rows.push({scene:name,control:'(startup)',result:startErrors.length?'error':'ok',errors:startErrors,nonFinite:nonFinite(started)});
  // What moves on its own, so that it is not credited to a click.
  const drift=async()=>{const a=await state(page);await page.waitForTimeout(500);const b=await state(page);return {last:b,noisy:new Set(differs(a,b).leaves)};};
  const judge=async(row,act)=>{
    const {last,noisy}=await drift();
    // The page rewrites its own address as she sails; only a new document is a navigation.
    const before=nonFinite(last),born=await page.evaluate(()=>performance.timeOrigin);
    try{await act(row);}catch(e){row.failed=String(e.message).split('\n')[0].slice(0,200);}
    await page.waitForTimeout(600);
    if(await page.evaluate(()=>performance.timeOrigin).catch(()=>0)!==born){
      row.navigated=page.url().replace(base,'/').slice(0,140);
      await ready(page).catch(()=>{});
      row.errors=errors.splice(0);row.result=row.errors.length?'error':'navigated';
      await enter();errors.splice(0);
      return;
    }
    const after=await state(page),change=differs(last,after);
    const moved=change.leaves.filter(k=>!noisy.has(k));
    row.frames=await page.evaluate(()=>window.playtestFrames(400));
    row.errors=errors.splice(0);
    row.newNonFinite=nonFinite(after).filter(k=>!before.includes(k));
    row.changed=[...(change.dom?['(panel or button state)']:[]),...moved.slice(0,6)];
    row.result=row.errors.length?'error':row.newNonFinite.length?'NaN':row.frames===0?'frames stopped':row.blocked?'covered':row.failed?'failed':row.changed.length?'effect':'nothing seen';
  };
  const click=async row=>{
    const target=page.locator(row.path).first();
    const why=e=>(String(e.message).split('\n').find(l=>/intercepts pointer events|not visible|outside of the viewport|not enabled|not stable/.test(l))||String(e.message).split('\n')[0]).trim().slice(0,220);
    try{await target.click({timeout:2500});}
    catch(e){
      // A panel an earlier click opened may lie over it. Escape should put that away; if it does not, the player is stuck too.
      row.under=why(e);
      await page.keyboard.press('Escape');await page.waitForTimeout(300);
      try{await target.click({timeout:2000});}
      catch(again){row.blocked=why(again);await target.evaluate(el=>el.click());}
    }
  };
  for(let step=0;step<MAX_STEPS;step++){
    const list=await page.evaluate(()=>window.playtestControls());
    const next=list.find(c=>!done.has([c.tag,c.id,c.cls,c.label].join('|')));
    if(!next)break;
    done.add([next.tag,next.id,next.cls,next.label].join('|'));
    const row={scene:name,control:`${next.tag}${next.type&&next.tag==='input'?'['+next.type+']':''} "${next.label}"`,path:next.path};
    rows.push(row);
    if(LEFT_ALONE.test(next.label+' '+next.cls+' '+next.id)||next.tag==='a'&&!next.href.startsWith('#')){row.result='left alone';continue;}
    if(next.disabled){row.result='disabled';continue;}
    // Every other choice of a list, then the one it began on; a slider to each end, then back.
    if(next.tag==='select'){
      rows.pop();
      for(const value of [...next.options.filter(v=>v!==next.value).slice(0,4),next.value]){
        const each={scene:name,control:`${row.control} → ${value}`,path:row.path};rows.push(each);
        await judge(each,r=>page.locator(r.path).first().selectOption(value,{timeout:2500}));
      }
      continue;
    }
    if(next.tag==='input'&&next.type==='range'){
      rows.pop();
      for(const where of ['min','max','start']){
        const each={scene:name,control:`${row.control} → ${where}`,path:row.path};rows.push(each);
        await judge(each,r=>page.locator(r.path).first().evaluate((el,[to,original])=>{el.value=to==='min'?el.min||0:to==='max'?el.max||100:original;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},[where,next.value]));
      }
      continue;
    }
    if(next.tag==='input'&&!/checkbox|radio|button|submit/.test(next.type)){row.result='left alone';continue;}
    await judge(row,click);
    // A switch is tried both ways, so the sweep leaves it as it found it and the way back is tested too.
    if(next.tag==='input'&&next.type==='checkbox'&&!row.navigated){const back={...row,control:row.control+' (back)'};delete back.blocked;rows.push(back);await judge(back,click);}
  }
  if(wantKeys){
    await enter();errors.splice(0);
    for(const key of KEYS){
      const row={scene:name,control:`key ${key}`};rows.push(row);
      await judge(row,async()=>{await page.evaluate(()=>document.activeElement?.blur?.());await page.keyboard.press(key);});
    }
  }
  if(out)await page.screenshot({path:`${out}/${name}.png`}).catch(()=>{});
  report.push(...rows);
  await context.close();
  const tally={};for(const r of rows)tally[r.result]=(tally[r.result]||0)+1;
  console.log(`\n== ${name}: ${rows.length} rows  ${Object.entries(tally).map(([k,v])=>`${k} ${v}`).join(', ')}`);
  for(const r of rows){
    if((r.result==='effect'&&!r.under)||r.result==='ok'||r.result==='disabled'||r.result==='left alone')continue;
    console.log(`  ${r.result.padEnd(14)} ${r.control}`);
    for(const e of r.errors??[])console.log(`      ${e}`);
    if(r.blocked)console.log(`      ${r.blocked}`);
    else if(r.under)console.log(`      reached only after Escape: ${r.under}`);
    if(r.failed)console.log(`      ${r.failed}`);
    if(r.newNonFinite?.length)console.log(`      non-finite: ${r.newNonFinite.slice(0,8).join(', ')}`);
    if(r.navigated)console.log(`      → ${r.navigated}`);
    if(r.nonFinite?.length)console.log(`      non-finite at startup: ${r.nonFinite.slice(0,12).join(', ')}`);
  }
}
if(out)writeFileSync(`${out}/report.json`,JSON.stringify(report,null,1));
await browser.close();server.closeAllConnections?.();server.close();
