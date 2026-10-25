import { ISLAND, LANDFALL_VIEWS, islandCoordinates, SPANISH_MAIN_1550_REGIONS, resolveGlobalCoastalRegion } from './terrain-model.js';
export { SPANISH_MAIN_1550_REGIONS, resolveGlobalCoastalRegion } from './coastal-world.js';

export const LANDFALL_WEATHER = Object.freeze({
  clear:{sunElev:32,sunAzim:225,haze:0.8,clouds:0.3,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  sunset:{sunElev:7,sunAzim:275,haze:1.5,clouds:0.35,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  backlit:{sunElev:12,sunAzim:5,haze:1.8,clouds:0.2,cloudBase:1.2,cloudDepth:1.8,cloudDensity:1,cloudAnvil:0.05},
  mist:{sunElev:24,sunAzim:225,haze:7,clouds:0.8,cloudBase:0.35,cloudDepth:2.2,cloudDensity:1.5,cloudAnvil:0.15},
});

export const LANDFALL_SEA = Object.freeze({
  horizon:Object.freeze({swellHs:.65,windSpeed:5.5}),
  approach:Object.freeze({swellHs:.65,windSpeed:5.5}),
  coast:Object.freeze({swellDir:22,swellHs:1.2,swellLength:95,windSpeed:5.5,windDir:118}),
});

// Preset yaw is absolute in free view, but boarding uses a relative look angle.
// Explicit camera links already carry their intended angle and take precedence.
export function landfallCameraYaw(stage,mode,explicitCamera,currentYaw){
  return LANDFALL_VIEWS[stage]?.heading!==undefined&&mode==='boat'&&!explicitCamera?0:currentYaw;
}

export function landfallStageURL(href,stage,weather='clear'){
  const view=LANDFALL_VIEWS[stage];if(!view)throw new RangeError('Unknown landfall stage');
  const url=new URL(href);
  for(const key of ['cam','boatX','boatZ','boatHeading','boatRudder','swellDir','swellHs','swellLength','swellSpread','windSpeed'])url.searchParams.delete(key);
  url.searchParams.set('landfall',stage);url.searchParams.set('view','boat');url.searchParams.set('boat','1');
  url.searchParams.set('boatHeading',String(view.heading??0));url.searchParams.set('boatSpeed','4');url.searchParams.set('weather',weather);
  for(const [key,value]of Object.entries(LANDFALL_SEA[stage]))url.searchParams.set(key,String(value));
  return url;
}

export function coastalRegionStageURL(href,regionSpec='cartagena',stage='coast',weather='clear'){
  const region=resolveGlobalCoastalRegion(regionSpec);
  const url=landfallStageURL(href,stage,weather);
  url.searchParams.set('region',region.id);
  url.searchParams.set('lat',String(region.latitude));
  url.searchParams.set('lon',String(region.longitude));
  url.searchParams.set('boatHeading',String(region.shoreBearing??112));
  return url;
}

export function createLandfallUI({dock,active,stage,weather,region=ISLAND,onWeather,onOpen,getPosition}){
  const button=document.createElement('button');button.textContent='Landfall';button.id='landfall-button';
  button.setAttribute('aria-controls','landfall-panel');button.setAttribute('aria-expanded','false');
  const panel=document.createElement('section');panel.id='landfall-panel';panel.hidden=true;
  panel.setAttribute('aria-labelledby','landfall-title');
  const isSaba=!region||region.id==='saba';
  const titleText=isSaba?'Saba · Lesser Antilles':`${region.name}${region.subtitle?' · '+region.subtitle:''}`;
  panel.innerHTML=`<div class="panel-header"><strong id="landfall-title">${titleText}</strong><button class="icon-button" aria-label="Hide landfall" title="Hide landfall"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    <div class="panel-body"><p class="landfall-intro">Saba’s real relief and aerial colour seed a continuous island, with generated branches and foliage revealed on approach.</p>
    <div class="landfall-destinations" style="display:grid;gap:6px;margin:8px 0">
      <label style="display:grid;gap:4px"><span>Region / Spanish Main (~1550)</span><select id="landfall-region" aria-label="Coastal region"></select></label>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:end">
        <label style="display:grid;gap:2px"><span>Latitude (°N)</span><input id="landfall-lat" type="number" min="-85" max="85" step="0.001" value="${region.latitude.toFixed(3)}"></label>
        <label style="display:grid;gap:2px"><span>Longitude (°E)</span><input id="landfall-lon" type="number" min="-180" max="180" step="0.001" value="${region.longitude.toFixed(3)}"></label>
        <button type="button" id="landfall-goto">Sail to coordinates</button>
      </div>
    </div>
    <div class="landfall-stages" role="group" aria-label="Landfall starting point"></div>
    <p>Start at the horizon, on approach, or off Wells Bay. Detailed beach and breaking surf are still to come. Sailing physics remain at normal speed.</p>
    <div class="landfall-weather" role="group" aria-label="Landfall weather"></div>
    <p id="landfall-position"></p><details><summary>World map & sources</summary><div id="landfall-chart"></div>
    <p>World overview · Saba is the first rendered region.</p>
    <p class="landfall-credit">Relief and aerial imagery: Beeldmateriaal Nederland, Saba 2023 LiDAR / Saba RGB (CC BY 4.0), downsampled, reprojected and modified for terrain, colour and vegetation seeds. Wells Bay shoreline: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>, ODbL1.0; modified coastal data and reconstruction recipe are in the public project repository. World outline: Natural Earth (public domain). Trees and historical cleanup are authored approximations. Shore clearance is approximate; ports and voyage compression are still to come.</p></details>
    <button id="landfall-ocean">Return to open ocean</button></div>`;
  const regionSelect=panel.querySelector('#landfall-region');
  const latInput=panel.querySelector('#landfall-lat');
  const lonInput=panel.querySelector('#landfall-lon');
  for(const [id,label] of [['saba','Saba · Lesser Antilles (LiDAR)'],...Object.values(SPANISH_MAIN_1550_REGIONS).map(r=>[r.id,`${r.name} · ${r.subtitle}`])]){
    const opt=document.createElement('option');opt.value=id;opt.textContent=label;regionSelect.append(opt);
  }
  if(!isSaba&&!Object.hasOwn(SPANISH_MAIN_1550_REGIONS,region.id)){
    const opt=document.createElement('option');opt.value='custom';opt.textContent=`Custom (${region.latitude.toFixed(3)}°, ${region.longitude.toFixed(3)}°)`;regionSelect.append(opt);
    regionSelect.value='custom';
  }else{
    regionSelect.value=isSaba?'saba':region.id;
  }
  regionSelect.onchange=()=>{
    const val=regionSelect.value;
    if(val==='saba'){
      const url=landfallStageURL(location.href,stage||'coast',weather);
      url.searchParams.delete('region');url.searchParams.delete('lat');url.searchParams.delete('lon');
      location.assign(url.href);
    }else if(Object.hasOwn(SPANISH_MAIN_1550_REGIONS,val)){
      location.assign(coastalRegionStageURL(location.href,val,stage||'coast',weather).href);
    }
  };
  panel.querySelector('#landfall-goto').onclick=()=>{
    const lat=Number(latInput.value),lon=Number(lonInput.value);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
    location.assign(coastalRegionStageURL(location.href,{latitude:lat,longitude:lon},stage||'coast',weather).href);
  };
  const setOpen=open=>{panel.hidden=!open;button.setAttribute('aria-expanded',String(open));document.body.classList.toggle('landfall-open',open);
    if(open){onOpen();if(document.pointerLockElement)document.exitPointerLock();panel.querySelector('.panel-header button').focus({preventScroll:true});}};
  button.onclick=()=>setOpen(panel.hidden);panel.querySelector('.panel-header button').onclick=()=>setOpen(false);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){setOpen(false);button.focus();}});
  for(const [id,label] of [['horizon','Horizon'],['approach','Approach'],['coast',isSaba?'Wells Bay approach':'Harbor / coast approach']]){
    const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(active&&stage===id));
    b.onclick=()=>{
      if(isSaba){
        const url=landfallStageURL(location.href,id,weather);
        url.searchParams.delete('region');url.searchParams.delete('lat');url.searchParams.delete('lon');
        location.assign(url.href);
      }else if(Object.hasOwn(SPANISH_MAIN_1550_REGIONS,region.id)){
        location.assign(coastalRegionStageURL(location.href,region.id,id,weather).href);
      }else{
        location.assign(coastalRegionStageURL(location.href,{latitude:region.latitude,longitude:region.longitude},id,weather).href);
      }
    };
    panel.querySelector('.landfall-stages').append(b);
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
  panel.querySelector('#landfall-ocean').onclick=()=>{const url=new URL(location.href);for(const k of ['landfall','weather','cam','region','lat','lon'])url.searchParams.delete(k);location.assign(url.href);};
  let chartLoaded=false;
  panel.querySelector('details').addEventListener('toggle',async e=>{
    if(!e.target.open||chartLoaded)return;chartLoaded=true;
    const target=panel.querySelector('#landfall-chart');
    try{
      const response=await fetch('assets/world/land.json');if(!response.ok)throw new Error('Map unavailable');
      const rings=await response.json();const ns='http://www.w3.org/2000/svg';
      const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 720 360');svg.setAttribute('role','img');svg.setAttribute('aria-label','World map locating Saba in the eastern Caribbean');
      svg.style.cursor='crosshair';
      const path=document.createElementNS(ns,'path');path.setAttribute('d',rings.map(r=>r.map(([x,y],i)=>`${i?'L':'M'}${((x+180)*2).toFixed(2)},${((90-y)*2).toFixed(2)}`).join(' ')+'Z').join(' '));
      path.setAttribute('fill','#627e77');svg.append(path);
      const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',(region.longitude+180)*2);dot.setAttribute('cy',(90-region.latitude)*2);dot.setAttribute('r','6');dot.setAttribute('fill','#f5bf77');dot.setAttribute('stroke','#fff');svg.append(dot);
      svg.addEventListener('click',ev=>{
        const rect=svg.getBoundingClientRect();if(!rect.width||!rect.height)return;
        const x=(ev.clientX-rect.left)/rect.width*720,y=(ev.clientY-rect.top)/rect.height*360;
        const lat=Math.max(-85,Math.min(85,90-y/2)),lon=Math.max(-180,Math.min(180,x/2-180));
        latInput.value=lat.toFixed(3);lonInput.value=lon.toFixed(3);
        dot.setAttribute('cx',String((lon+180)*2));dot.setAttribute('cy',String((90-lat)*2));
      });
      target.append(svg);
    }catch{target.textContent='World map could not load. Close and reopen to retry.';chartLoaded=false;}
  });
  dock.append(button);document.body.append(panel);
  let last=0;return {close:()=>setOpen(false),update(now){if(!active||panel.hidden||now-last<1000)return;last=now;
    const p=getPosition(),geo=islandCoordinates(p.x,p.z,region);
    const ns=geo.latitude>=0?'N':'S',ew=geo.longitude>=0?'E':'W';
    panel.querySelector('#landfall-position').textContent=`${Math.abs(geo.latitude).toFixed(3)}° ${ns} · ${Math.abs(geo.longitude).toFixed(3)}° ${ew}${p.coastBlocked?' · Shore clearance reached':''}`;
  }};
}
