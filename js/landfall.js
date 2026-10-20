import { ISLAND, LANDFALL_VIEWS, islandCoordinates } from './terrain-model.js';

export const LANDFALL_WEATHER = Object.freeze({
  clear:{sunElev:32,sunAzim:225,haze:0.8,clouds:0.3,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  sunset:{sunElev:7,sunAzim:275,haze:1.5,clouds:0.35,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  backlit:{sunElev:12,sunAzim:5,haze:1.8,clouds:0.2,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  mist:{sunElev:24,sunAzim:225,haze:7,clouds:0.8,cloudBase:0.35,cloudDepth:2.2,cloudDensity:1.5,cloudAnvil:0.15},
});

export function createLandfallUI({dock,active,stage,weather,onWeather,onOpen,getPosition}){
  const button=document.createElement('button');button.textContent='Landfall';button.id='landfall-button';
  button.setAttribute('aria-controls','landfall-panel');button.setAttribute('aria-expanded','false');
  const panel=document.createElement('section');panel.id='landfall-panel';panel.hidden=true;
  panel.setAttribute('aria-labelledby','landfall-title');
  panel.innerHTML=`<div class="panel-header"><strong id="landfall-title">Saba · Lesser Antilles</strong><button class="icon-button" aria-label="Hide landfall" title="Hide landfall"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    <div class="panel-body"><p class="landfall-intro">A first landfall. Real island relief, generated vegetation, changing light.</p>
    <div class="landfall-stages" role="group" aria-label="Landfall starting point"></div>
    <p>Start at the horizon, on approach, or near the coast. Sailing physics remain at normal speed.</p>
    <div class="landfall-weather" role="group" aria-label="Landfall weather"></div>
    <p id="landfall-position"></p><details><summary>World map & sources</summary><div id="landfall-chart"></div>
    <p>World overview · Saba is the first rendered region.</p>
    <p class="landfall-credit">Terrain: Mapzen / USGS / NOAA. World outline: Natural Earth (public domain). Vegetation is generated. Shore clearance is approximate; ports and voyage compression are still to come.</p></details>
    <button id="landfall-ocean">Return to open ocean</button></div>`;
  const setOpen=open=>{panel.hidden=!open;button.setAttribute('aria-expanded',String(open));document.body.classList.toggle('landfall-open',open);
    if(open){onOpen();if(document.pointerLockElement)document.exitPointerLock();panel.querySelector('.panel-header button').focus({preventScroll:true});}};
  button.onclick=()=>setOpen(panel.hidden);panel.querySelector('.panel-header button').onclick=()=>setOpen(false);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){setOpen(false);button.focus();}});
  for(const [id,label] of [['horizon','Horizon'],['approach','Approach'],['coast','Near coast']]){
    const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(active&&stage===id));
    b.onclick=()=>{const url=new URL(location.href);url.searchParams.set('landfall',id);url.searchParams.delete('cam');
      url.searchParams.set('view','boat');url.searchParams.set('boat','1');url.searchParams.set('boatHeading','0');url.searchParams.set('boatSpeed','4');
      url.searchParams.set('weather',weather);location.assign(url.href);};panel.querySelector('.landfall-stages').append(b);
  }
  const weatherButtons=new Map();
  for(const [id,label] of [['clear','Clear'],['sunset','Sunset'],['backlit','Backlit'],['mist','Sea mist']]){
    const b=document.createElement('button');b.textContent=label;b.disabled=!active;b.setAttribute('aria-pressed',String(weather===id));
    b.onclick=()=>{weather=id;onWeather(LANDFALL_WEATHER[id]);for(const [key,control] of weatherButtons)control.setAttribute('aria-pressed',String(key===id));
      const url=new URL(location.href);url.searchParams.set('weather',id);
      for(const key of Object.keys(LANDFALL_WEATHER[id]))url.searchParams.delete(key);
      history.replaceState(null,'',url);};
    weatherButtons.set(id,b);panel.querySelector('.landfall-weather').append(b);
  }
  panel.querySelector('#landfall-ocean').onclick=()=>{const url=new URL(location.href);url.searchParams.delete('landfall');url.searchParams.delete('weather');url.searchParams.delete('cam');location.assign(url.href);};
  let chartLoaded=false;
  panel.querySelector('details').addEventListener('toggle',async e=>{
    if(!e.target.open||chartLoaded)return;chartLoaded=true;
    const target=panel.querySelector('#landfall-chart');
    try{
      const response=await fetch('assets/world/land.json');if(!response.ok)throw new Error('Map unavailable');
      const rings=await response.json();const ns='http://www.w3.org/2000/svg';
      const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 720 360');svg.setAttribute('role','img');svg.setAttribute('aria-label','World map locating Saba in the eastern Caribbean');
      const path=document.createElementNS(ns,'path');path.setAttribute('d',rings.map(r=>r.map(([x,y],i)=>`${i?'L':'M'}${((x+180)*2).toFixed(2)},${((90-y)*2).toFixed(2)}`).join(' ')+'Z').join(' '));
      path.setAttribute('fill','#627e77');svg.append(path);
      const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',(ISLAND.longitude+180)*2);dot.setAttribute('cy',(90-ISLAND.latitude)*2);dot.setAttribute('r','6');dot.setAttribute('fill','#f5bf77');dot.setAttribute('stroke','#fff');svg.append(dot);
      target.append(svg);
    }catch{target.textContent='World map could not load. Close and reopen to retry.';chartLoaded=false;}
  });
  dock.append(button);document.body.append(panel);
  let last=0;return {close:()=>setOpen(false),update(now){if(!active||panel.hidden||now-last<1000)return;last=now;
    const p=getPosition(),geo=islandCoordinates(p.x,p.z);
    panel.querySelector('#landfall-position').textContent=`${geo.latitude.toFixed(3)}° N · ${Math.abs(geo.longitude).toFixed(3)}° W${p.coastBlocked?' · Shore clearance reached':''}`;
  }};
}
