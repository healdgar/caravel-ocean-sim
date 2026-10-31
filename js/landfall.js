import { ISLAND, LANDFALL_VIEWS, islandCoordinates, SPANISH_MAIN_1550_REGIONS, COLONIAL_ERAS, resolveColonialEra, HISTORICAL_COLONIAL_PORTS, computeColonyGrowthProfile, INDIGENOUS_CULTURE_REGIONS, UNINHABITED_PELAGIC_ISLANDS, resolveIndigenousCultureRegion, computeIndigenousSettlementProfile, SOVEREIGN_INDIGENOUS_POLITIES, createIndigenousSovereigntyState, getActiveIndigenousSovereigntyState, setActiveIndigenousSovereigntyState, resetActiveIndigenousSovereigntyState, saveIndigenousSovereigntyToStorage, loadIndigenousSovereigntyFromStorage, serializeIndigenousSovereignty, restoreIndigenousSovereignty, resolveRegionSovereigntyRecord, applyIndigenousSupportAction, resolveGlobalCoastalRegion } from './terrain-model.js';
import { snapCoordinateToCoastlineRings } from './coastal-world.js';
export { SPANISH_MAIN_1550_REGIONS, COLONIAL_ERAS, resolveColonialEra, HISTORICAL_COLONIAL_PORTS, computeColonyGrowthProfile, INDIGENOUS_CULTURE_REGIONS, UNINHABITED_PELAGIC_ISLANDS, resolveIndigenousCultureRegion, computeIndigenousSettlementProfile, SOVEREIGN_INDIGENOUS_POLITIES, createIndigenousSovereigntyState, getActiveIndigenousSovereigntyState, setActiveIndigenousSovereigntyState, resetActiveIndigenousSovereigntyState, saveIndigenousSovereigntyToStorage, loadIndigenousSovereigntyFromStorage, serializeIndigenousSovereignty, restoreIndigenousSovereignty, resolveRegionSovereigntyRecord, applyIndigenousSupportAction, resolveGlobalCoastalRegion } from './coastal-world.js';

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
  harbor:Object.freeze({swellDir:22,swellHs:.55,swellLength:75,windSpeed:5.2,windDir:118}),
  dock:Object.freeze({swellDir:22,swellHs:.35,swellLength:65,windSpeed:5.0,windDir:118}),
});

// Compute natural shoreward swell and coastal breeze directions from a region's shoreward bearing.
// In the wave spectrum (js/wgsl/sim.js), direction angle theta propagates along (cos(theta), sin(theta))
// in world (X=East, Z=South), whereas compass bearing B points along (sin(B), -cos(B)) -> theta = B - 90°.
export function coastalSeaForRegion(regionSpec,stage='coast'){
  const base=LANDFALL_SEA[stage]||LANDFALL_SEA.coast;
  if(!regionSpec)return base;
  const region=typeof regionSpec==='string'||(regionSpec.latitude!==undefined&&regionSpec.shoreBearing===undefined)
    ?resolveGlobalCoastalRegion(regionSpec)
    :regionSpec;
  if(!region||region.id==='saba')return base;
  if(region.id==='lisbon'||region.portType==='royal-arsenal-dock'){
    // Fair Portuguese Nortada / Tagus land-breeze (from NE ~42°, propagation θ = 132°) carrying ships down the Tagus Gorge.
    return Object.freeze({...base,swellDir:stage==='dock'?162:265,windDir:132});
  }
  const shoreBearing=Number.isFinite(region.shoreBearing)?region.shoreBearing:112;
  const swellDir=((Math.round(shoreBearing-90)%360)+360)%360;
  const windDir=stage==='dock'?((Math.round(shoreBearing-108)%360)+360)%360:(swellDir+36)%360;
  return Object.freeze({...base,swellDir,windDir});
}

// Preset yaw is absolute in free view, but boarding uses a relative look angle.
// Explicit camera links already carry their intended angle and take precedence.
export function landfallCameraYaw(stage,mode,explicitCamera,currentYaw){
  const isKnownStage=LANDFALL_VIEWS[stage]?.heading!==undefined||stage==='dock'||stage==='harbor';
  return isKnownStage&&mode==='boat'&&!explicitCamera?0:currentYaw;
}

export function landfallStageURL(href,stage,weather='clear'){
  const view=LANDFALL_VIEWS[stage]||(stage==='dock'||stage==='harbor'?LANDFALL_VIEWS.coast:null);
  if(!view)throw new RangeError('Unknown landfall stage');
  const url=new URL(href);
  for(const key of ['ocean','cam','boatX','boatZ','boatHeading','boatRudder','swellDir','swellHs','swellLength','swellSpread','windSpeed'])url.searchParams.delete(key);
  url.searchParams.set('landfall',stage);url.searchParams.set('view','boat');url.searchParams.set('boat','1');
  url.searchParams.set('boatHeading',String(view.heading??0));url.searchParams.set('boatSpeed',stage==='dock'?'1.5':'4');url.searchParams.set('weather',weather);
  for(const [key,value]of Object.entries(LANDFALL_SEA[stage]||LANDFALL_SEA.coast))url.searchParams.set(key,String(value));
  return url;
}

export function coastalRegionStageURL(href,regionSpec='cartagena',stage='coast',weather='clear',year=undefined){
  const url=landfallStageURL(href,stage,weather);
  const effectiveYear=year!==undefined
    ?year
    :(typeof regionSpec==='object'&&regionSpec?.year!==undefined)
      ?regionSpec.year
      :(url.searchParams.has('year')?Number(url.searchParams.get('year')):undefined);
  const specWithYear=effectiveYear!==undefined
    ?(typeof regionSpec==='string'?{id:regionSpec,year:effectiveYear}:{...regionSpec,year:effectiveYear})
    :regionSpec;
  const region=resolveGlobalCoastalRegion(specWithYear);
  url.searchParams.set('region',region.id);
  url.searchParams.set('lat',String(region.latitude));
  url.searchParams.set('lon',String(region.longitude));
  if(effectiveYear!==undefined&&Number(effectiveYear)!==1550){
    url.searchParams.set('year',String(region.year));
  }else if(effectiveYear===1550){
    url.searchParams.delete('year');
  }
  const dockTurn=region.id==='lisbon'||region.portType==='royal-arsenal-dock'?100:108;
  const heading=stage==='dock'?(((region.shoreBearing??112)-dockTurn)%360+360)%360:(region.shoreBearing??112);
  url.searchParams.set('boatHeading',String(heading));
  const sea=coastalSeaForRegion(region,stage);
  for(const [key,value]of Object.entries(sea))url.searchParams.set(key,String(value));
  return url;
}

const POST_1550_FEATURED_PORTS = Object.freeze([
  'st-augustine',
  'portobelo',
  'jamestown',
  'new-amsterdam',
  'tortuga',
  'boston',
  'willemstad',
  'port-royal',
  'nassau',
  'charleston',
]);

export function createLandfallUI({dock,active,stage,weather,region=ISLAND,discovery=null,onUpgradeApplied=null,onIndigenousAction=null,onWeather,onOpen,getPosition}){
  const button=document.createElement('button');button.textContent='Landfall';button.id='landfall-button';
  button.setAttribute('aria-controls','landfall-panel');button.setAttribute('aria-expanded','false');
  const panel=document.createElement('section');panel.id='landfall-panel';panel.hidden=true;
  panel.setAttribute('aria-labelledby','landfall-title');
  const isSaba=!region||region.id==='saba';
  const simYear=Number.isFinite(region?.year)?region.year:1550;
  const eraInfo=resolveColonialEra(simYear);
  const growth=region?.colonyGrowth||(isSaba?null:computeColonyGrowthProfile(region,simYear));
  const indigenous=region?.indigenousSettlement||(isSaba?null:computeIndigenousSettlementProfile(region,simYear));
  const indigenousCulture=resolveIndigenousCultureRegion(region?.latitude,region?.longitude);
  const isWilderness=!isSaba&&region.hasColonialPort===false;
  const hasIndigenousVillage=Boolean(isWilderness&&indigenous?.hasIndigenousSettlement);
  const stageBadge=growth?.stage?growth.stage.replace(/-/g,' '):(isWilderness?'wilderness':'settlement');
  const titleText=isSaba?'Saba · Lesser Antilles':`${region.name} (${simYear})${region.subtitle?' · '+region.subtitle:hasIndigenousVillage?` · ${indigenous.polityName||indigenous.cultureName}`:isWilderness?` · ${simYear} Wilderness Coast`:''}`;
  const introText=isSaba
    ?'Saba’s real relief and aerial colour seed a continuous island, with generated branches and foliage revealed on approach.'
    :isWilderness
      ?`${region.name} (${region.latitude.toFixed(3)}°, ${region.longitude.toFixed(3)}°) in ${simYear} (${eraInfo.label}) reconstructs an uncolonized coastline from high-resolution SRTM elevation, co-registered satellite land-cover, and natural estuaries—with no European colonial settlement yet established.${hasIndigenousVillage?` Inhabited by ${indigenous.cultureName} (${indigenous.settlementStyle}; est. ~${indigenous.estimatedVillagePopulation} residents). ${indigenous.historicalNote}`:''}${growth?.historicalNote?' '+growth.historicalNote+'.':''}`
      :`${region.name} (${region.latitude.toFixed(3)}°, ${region.longitude.toFixed(3)}°) in ${simYear} (${eraInfo.label} · ${stageBadge}) combines high-resolution SRTM elevation, co-registered satellite land-cover, and historical colony growth.${growth?.historicalNote?' '+growth.historicalNote+'.':''}`;
  panel.innerHTML=`<div class="panel-header"><strong id="landfall-title">${titleText}</strong><button class="icon-button" aria-label="Hide landfall" title="Hide landfall"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
    <div class="panel-body"><p class="landfall-intro">${introText}</p>
    <div id="landfall-discovery-card" hidden></div>
    <div id="landfall-indigenous-sovereignty" hidden></div>
    <div class="landfall-destinations" style="display:grid;gap:6px;margin:8px 0">
      <label style="display:grid;gap:4px"><span>Region / Colonial Port (1550–1689)</span><select id="landfall-region" aria-label="Coastal region"></select></label>
      <div style="display:grid;grid-template-columns:1fr 92px;gap:6px;align-items:end">
        <label style="display:grid;gap:2px"><span>Historical Era</span><select id="landfall-era" aria-label="Historical era"></select></label>
        <label style="display:grid;gap:2px"><span>Year</span><input id="landfall-year" type="number" min="1492" max="1689" step="1" value="${simYear}"></label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:end">
        <label style="display:grid;gap:2px"><span>Latitude (°N)</span><input id="landfall-lat" type="number" min="-85" max="85" step="0.001" value="${region.latitude.toFixed(3)}"></label>
        <label style="display:grid;gap:2px"><span>Longitude (°E)</span><input id="landfall-lon" type="number" min="-180" max="180" step="0.001" value="${region.longitude.toFixed(3)}"></label>
        <button type="button" id="landfall-goto">Sail to coordinates</button>
      </div>
    </div>
    <div class="landfall-stages" role="group" aria-label="Landfall starting point"></div>
    <p>Start at the horizon, on approach, or off Wells Bay. Detailed beach and breaking surf are still to come. Sailing physics remain at normal speed.</p>
    <div class="landfall-weather" role="group" aria-label="Landfall weather"></div>
    <div id="landfall-sun-sliders" class="landfall-sun-sliders"></div>
    <p id="landfall-position"></p><details><summary>World map & sources</summary><div id="landfall-chart"></div>
    <p>World overview · Click any coastline on the chart to set coordinates.</p>
    <p class="landfall-credit">Relief and aerial imagery: Beeldmateriaal Nederland, Saba 2023 LiDAR / Saba RGB (CC BY 4.0), AWS Terrarium SRTM Z13/Z14, and Esri World Imagery, downsampled, reprojected and modified for 1550–1689 terrain, colour and vegetation seeds. Wells Bay shoreline: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>, ODbL1.0; modified coastal data and reconstruction recipe are in the public project repository. World outline: Natural Earth (public domain).</p></details>
    <button id="landfall-ocean">Return to open ocean</button></div>`;
  const regionSelect=panel.querySelector('#landfall-region');
  const eraSelect=panel.querySelector('#landfall-era');
  const yearInput=panel.querySelector('#landfall-year');
  const latInput=panel.querySelector('#landfall-lat');
  const lonInput=panel.querySelector('#landfall-lon');
  for(const era of Object.values(COLONIAL_ERAS)){
    const opt=document.createElement('option');
    opt.value=String(era.defaultYear);
    opt.textContent=`${era.label} (${era.startYear}–${era.endYear})`;
    if(era.id===eraInfo.id)opt.selected=true;
    eraSelect.append(opt);
  }
  const post1550Entries=POST_1550_FEATURED_PORTS
    .map(id=>HISTORICAL_COLONIAL_PORTS.find(p=>p.id===id))
    .filter(Boolean)
    .map(p=>[p.id,`${p.name} · Founded ${p.foundedYear} (${p.crown})`]);
  const allPresetIds=new Set([...Object.keys(SPANISH_MAIN_1550_REGIONS),...POST_1550_FEATURED_PORTS]);
  for(const [id,label] of [
    ['saba','Saba · Lesser Antilles (LiDAR)'],
    ...Object.values(SPANISH_MAIN_1550_REGIONS).map(r=>[r.id,`${r.name} · ${r.subtitle}`]),
    ...post1550Entries,
  ]){
    const opt=document.createElement('option');opt.value=id;opt.textContent=label;regionSelect.append(opt);
  }
  if(!isSaba&&!allPresetIds.has(region.id)){
    const opt=document.createElement('option');opt.value='custom';opt.textContent=`Custom (${region.latitude.toFixed(3)}°, ${region.longitude.toFixed(3)}° · ${isWilderness?`${simYear} Wilderness Coast`:`${simYear} ${stageBadge}`})`;regionSelect.append(opt);
    regionSelect.value='custom';
  }else{
    regionSelect.value=isSaba?'saba':region.id;
  }
  const getSelectedYear=()=>{
    const y=Number(yearInput.value);
    return Number.isFinite(y)?Math.max(1492,Math.min(1689,Math.round(y))):simYear;
  };
  const navigateToSelected=(targetYear)=>{
    const val=regionSelect.value;
    if(val==='saba'){
      const url=landfallStageURL(location.href,stage||'coast',weather);
      url.searchParams.delete('region');url.searchParams.delete('lat');url.searchParams.delete('lon');
      location.assign(url.href);
    }else if(allPresetIds.has(val)){
      const portMeta=HISTORICAL_COLONIAL_PORTS.find(p=>p.id===val);
      const effectiveY=targetYear!==undefined?targetYear:(portMeta&&portMeta.foundedYear>getSelectedYear()?Math.min(1685,portMeta.foundedYear+15):getSelectedYear());
      location.assign(coastalRegionStageURL(location.href,val,stage||'coast',weather,effectiveY).href);
    }else{
      const lat=Number(latInput.value),lon=Number(lonInput.value);
      if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
      location.assign(coastalRegionStageURL(location.href,{latitude:lat,longitude:lon},stage||'coast',weather,targetYear??getSelectedYear()).href);
    }
  };
  regionSelect.onchange=()=>navigateToSelected(undefined);
  eraSelect.onchange=()=>{
    const y=Number(eraSelect.value);
    if(Number.isFinite(y)){
      yearInput.value=String(y);
      navigateToSelected(y);
    }
  };
  yearInput.onchange=()=>navigateToSelected(getSelectedYear());
  panel.querySelector('#landfall-goto').onclick=()=>{
    const lat=Number(latInput.value),lon=Number(lonInput.value);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return;
    location.assign(coastalRegionStageURL(location.href,{latitude:lat,longitude:lon},stage||'coast',weather,getSelectedYear()).href);
  };
  const setOpen=open=>{panel.hidden=!open;button.setAttribute('aria-expanded',String(open));document.body.classList.toggle('landfall-open',open);
    if(open){onOpen();if(document.pointerLockElement)document.exitPointerLock();panel.querySelector('.panel-header button').focus({preventScroll:true});}};
  button.onclick=()=>setOpen(panel.hidden);panel.querySelector('.panel-header button').onclick=()=>setOpen(false);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){setOpen(false);button.focus();}});
  const stageButtons=[
    ['horizon','Horizon'],
    ['approach','Approach'],
    ['coast',isSaba?'Wells Bay approach':isWilderness?'Wilderness coast approach':'Harbor / coast approach'],
    ...(!isSaba&&!isWilderness?[['dock',region.id==='lisbon'?'Lisbon departure dock':'Harbor dock']]:[]),
  ];
  for(const [id,label] of stageButtons){
    const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(active&&stage===id));
    b.onclick=()=>{
      if(isSaba){
        const url=landfallStageURL(location.href,id,weather);
        url.searchParams.delete('region');url.searchParams.delete('lat');url.searchParams.delete('lon');
        location.assign(url.href);
      }else if(allPresetIds.has(region.id)){
        location.assign(coastalRegionStageURL(location.href,region.id,id,weather,getSelectedYear()).href);
      }else{
        location.assign(coastalRegionStageURL(location.href,{latitude:region.latitude,longitude:region.longitude},id,weather,getSelectedYear()).href);
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
  panel.querySelector('#landfall-ocean').onclick=()=>{const url=new URL(location.href);for(const k of ['landfall','weather','cam','region','lat','lon'])url.searchParams.delete(k);url.searchParams.set('ocean','1');location.assign(url.href);};
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
        let lat=Math.max(-85,Math.min(85,90-y/2)),lon=Math.max(-180,Math.min(180,x/2-180));
        const snapped=snapCoordinateToCoastlineRings(lat,lon,rings,3.5);
        if(snapped){lat=snapped.latitude;lon=snapped.longitude;}
        latInput.value=lat.toFixed(3);lonInput.value=lon.toFixed(3);
        dot.setAttribute('cx',String((lon+180)*2));dot.setAttribute('cy',String((90-lat)*2));
      });
      target.append(svg);
    }catch{target.textContent='World map could not load. Close and reopen to retry.';chartLoaded=false;}
  });
  dock.append(button);document.body.append(panel);

  const sovContainer=panel.querySelector('#landfall-indigenous-sovereignty');
  let lastSovMessage='';
  const renderIndigenousSovereigntyCard=()=>{
    if(!sovContainer||!indigenousCulture){
      if(sovContainer)sovContainer.hidden=true;
      return;
    }
    sovContainer.hidden=false;
    const sovState=getActiveIndigenousSovereigntyState();
    const rec=resolveRegionSovereigntyRecord(indigenousCulture.id,region);
    const liveProfile=computeIndigenousSettlementProfile({
      ...region,
      year:getSelectedYear(),
      hasColonialPort:rec.resistsColonization?false:region.hasColonialPort,
    },getSelectedYear());
    const strengthPct=Math.round((rec.strengthScore??0)*100);
    const retPct=Math.round((liveProfile.retention??0)*100);
    const isRogue=sovState.allegiance==='rogue-liberator';
    sovContainer.style.cssText='margin:8px 0;padding:10px;border-radius:8px;border:1px solid rgba(224,176,96,0.38);background:rgba(20,30,28,0.82);display:grid;gap:6px;font-size:12px';
    sovContainer.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
        <strong style="color:#f5bf77">${rec.polityName}</strong>
        <span style="padding:2px 6px;border-radius:4px;background:${rec.isSovereignPolity?'rgba(56,158,108,0.35)':rec.resistsColonization?'rgba(212,148,58,0.32)':'rgba(255,255,255,0.1)'};font-size:11px">${rec.polityTierLabel}</span>
      </div>
      <div style="opacity:0.9">
        Allegiance: <strong>${isRogue?'🛡️ Rogue Indigenous Liberator':'👑 European Crown'}</strong> · Strength: <strong>${strengthPct}%</strong> · Pop. Persistence: <strong>${retPct}%</strong> (~${liveProfile.estimatedRegionalPop.toLocaleString()} in region)
      </div>
      <div style="opacity:0.82;font-size:11px">
        Trades: ${rec.tradeCount} · Cannon Supplied: ${rec.suppliedCannon} · Quarantine: ${rec.medicalQuarantine?'Active':'None'} · Repelled Colonizers: ${rec.repelledExpeditions}
      </div>
      ${lastSovMessage?`<div style="color:#9fe6b8;font-size:11px">${lastSovMessage}</div>`:''}
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:2px">
        <button type="button" data-sov-action="go-rogue">🛡️ Go Rogue &amp; Ally</button>
        <button type="button" data-sov-action="trade">🤝 Trade Fairly</button>
        <button type="button" data-sov-action="share-medicine">🌿 Quarantine &amp; Medicine</button>
        <button type="button" data-sov-action="arm-settlement">💣 Arm &amp; Fortify</button>
        <button type="button" data-sov-action="proclaim-sovereignty">👑 Proclaim Sovereign Polity</button>
      </div>
    `;
    for(const btn of sovContainer.querySelectorAll('[data-sov-action]')){
      btn.onclick=()=>{
        const action=btn.getAttribute('data-sov-action');
        const res=applyIndigenousSupportAction(indigenousCulture.id,action,sovState);
        saveIndigenousSovereigntyToStorage(sovState);
        lastSovMessage=res.message;
        renderIndigenousSovereigntyCard();
        onIndigenousAction?.(res);
      };
    }
  };
  renderIndigenousSovereigntyCard();

  const discoveryBanner=document.createElement('aside');
  discoveryBanner.id='landfall-discovery-banner';
  discoveryBanner.hidden=true;
  discoveryBanner.setAttribute('role','status');
  discoveryBanner.setAttribute('aria-live','polite');
  document.body.append(discoveryBanner);
  const discoveryCard=panel.querySelector('#landfall-discovery-card');
  let bannerDismissedForState='';
  let appliedHideTimer=null;

  const triggerSwap=()=>{
    if(!discovery)return;
    const ship=typeof getPosition==='function'?getPosition():null;
    if(discovery.swapToUpgraded(ship)){
      onUpgradeApplied?.();
    }
  };
  const triggerRevert=()=>{
    if(!discovery?.revertToBase)return;
    const ship=typeof getPosition==='function'?getPosition():null;
    if(discovery.revertToBase(ship)){
      onUpgradeApplied?.();
    }
  };

  if(discovery&&discovery.enabled){
    discovery.subscribe(state=>{
      if(appliedHideTimer){clearTimeout(appliedHideTimer);appliedHideTimer=null;}
      const pct=state.stats?.restoredEstuaryPct??14.2;
      const palms=state.stats?.palmCount??0;
      if(state.status==='charting'){
        discoveryCard.hidden=false;
        discoveryCard.innerHTML=`<div class="discovery-eyebrow">Uncharted Waters · First Explorer</div>
          <p class="discovery-body">${state.message||'You are the first mariner to sail to this location. Generating 1550 historical territory in the background…'}</p>
          <div class="discovery-bar" role="progressbar" aria-label="Reconstructing 1550 territory"><span></span></div>`;
        if(bannerDismissedForState!=='charting'){
          discoveryBanner.hidden=false;
          discoveryBanner.innerHTML=`<div class="discovery-header"><span class="discovery-eyebrow">Uncharted Waters · First Explorer</span>
            <button type="button" class="icon-button" aria-label="Dismiss notice" style="width:28px;height:28px;min-height:28px;padding:4px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
            <p class="discovery-title">First Mariner at ${region.name}</p>
            <p class="discovery-body">${state.message}</p>
            <div class="discovery-bar" role="progressbar" aria-label="Reconstructing 1550 territory"><span></span></div>`;
          discoveryBanner.querySelector('button').onclick=()=>{bannerDismissedForState='charting';discoveryBanner.hidden=true;};
        }
      }else if(state.status==='ready'){
        const detail=`${pct}% modern coastal fill restored to 1550 tidal estuaries${palms?` · ${palms} coastal palms`:''}`;
        discoveryCard.hidden=false;
        discoveryCard.innerHTML=`<div class="discovery-eyebrow">Discovery Complete · 1550 Territory Ready</div>
          <p class="discovery-body">Congratulations on your discovery! ${detail}. Cached for all future mariners.</p>
          <div class="discovery-actions"><button type="button" class="discovery-swap-btn">Swap to 1550 Upgraded Territory</button></div>`;
        discoveryCard.querySelector('.discovery-swap-btn').onclick=triggerSwap;
        if(bannerDismissedForState!=='ready'){
          discoveryBanner.hidden=false;
          discoveryBanner.innerHTML=`<div class="discovery-header"><span class="discovery-eyebrow">Discovery Complete · 1550 Territory Ready</span>
            <button type="button" class="icon-button" id="discovery-close" aria-label="Dismiss notice" style="width:28px;height:28px;min-height:28px;padding:4px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
            <p class="discovery-title">Congratulations on your discovery, Captain!</p>
            <p class="discovery-body">The 1550 historical territory for ${region.name} (${detail}) has been generated and cached for all mariners.</p>
            <div class="discovery-actions">
              <button type="button" class="discovery-swap-btn" id="landfall-upgrade-swap">Swap to 1550 Upgraded Territory</button>
              <button type="button" id="landfall-upgrade-later">Keep current chart</button>
            </div>`;
          discoveryBanner.querySelector('#landfall-upgrade-swap').onclick=triggerSwap;
          discoveryBanner.querySelector('#landfall-upgrade-later').onclick=discoveryBanner.querySelector('#discovery-close').onclick=()=>{
            bannerDismissedForState='ready';discoveryBanner.hidden=true;
          };
        }
      }else if(state.status==='cached'){
        const detail=`${pct}% modern coastal fill restored to 1550 estuaries · Mariner #${state.visits}`;
        discoveryCard.hidden=false;
        discoveryCard.innerHTML=`<div class="discovery-eyebrow">Charted 1550 Coastline · Mariner #${state.visits}</div>
          <p class="discovery-body">Discovered and cached by a fellow mariner (${detail}).</p>
          <div class="discovery-actions"><button type="button" class="discovery-swap-btn">Swap to 1550 Upgraded Territory</button></div>`;
        discoveryCard.querySelector('.discovery-swap-btn').onclick=triggerSwap;
        if(bannerDismissedForState!=='cached'){
          discoveryBanner.hidden=false;
          discoveryBanner.innerHTML=`<div class="discovery-header"><span class="discovery-eyebrow">Charted 1550 Coastline · Mariner #${state.visits}</span>
            <button type="button" class="icon-button" id="discovery-close" aria-label="Dismiss notice" style="width:28px;height:28px;min-height:28px;padding:4px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
            <p class="discovery-title">1550 Territory Available for ${region.name}</p>
            <p class="discovery-body">${detail}.</p>
            <div class="discovery-actions">
              <button type="button" class="discovery-swap-btn" id="landfall-upgrade-swap">Swap to 1550 Upgraded Territory</button>
              <button type="button" id="landfall-upgrade-later">Dismiss</button>
            </div>`;
          discoveryBanner.querySelector('#landfall-upgrade-swap').onclick=triggerSwap;
          discoveryBanner.querySelector('#landfall-upgrade-later').onclick=discoveryBanner.querySelector('#discovery-close').onclick=()=>{
            bannerDismissedForState='cached';discoveryBanner.hidden=true;
          };
        }
      }else if(state.status==='applied'){
        const detail=`${pct}% modern coastal fill restored to 1550 tidal estuaries${palms?` · ${palms} coastal palms`:''}`;
        discoveryCard.hidden=false;
        discoveryCard.innerHTML=`<div class="discovery-eyebrow">1550 Historical Territory Active</div>
          <p class="discovery-body">Sailing the reconstructed 1550 AI orthophoto + Depth Anything V2 + SRTM coastline of ${region.name} (${detail}).</p>
          <div class="discovery-actions"><button type="button" class="discovery-revert-btn">Compare: Switch to 2026 Modern Baseline</button></div>`;
        discoveryCard.querySelector('.discovery-revert-btn').onclick=triggerRevert;
        discoveryBanner.hidden=false;
        discoveryBanner.innerHTML=`<div class="discovery-header"><span class="discovery-eyebrow">${state.isCurated1550?'Curated 1550 Spanish Main Port':'1550 Historical Territory Active'}</span>
          <button type="button" class="icon-button" id="discovery-close" aria-label="Dismiss notice" style="width:28px;height:28px;min-height:28px;padding:4px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
          <p class="discovery-title">${state.isCurated1550?`1550 Territory Active — ${region.name}`:'Territory Upgraded — Congratulations, Captain!'}</p>
          <p class="discovery-body">Sailing the reconstructed 1550 coastline, tidal mangrove estuaries, beaches and primary canopy (${detail}).</p>
          <div class="discovery-actions">
            <button type="button" id="landfall-upgrade-revert">Compare: 2026 Modern Baseline</button>
            <button type="button" id="landfall-upgrade-dismiss">Dismiss</button>
          </div>`;
        discoveryBanner.querySelector('#landfall-upgrade-revert').onclick=triggerRevert;
        discoveryBanner.querySelector('#landfall-upgrade-dismiss').onclick=discoveryBanner.querySelector('#discovery-close').onclick=()=>{discoveryBanner.hidden=true;};
        appliedHideTimer=setTimeout(()=>{discoveryBanner.hidden=true;},8500);
      }else if(state.status==='reverted'){
        discoveryCard.hidden=false;
        discoveryCard.innerHTML=`<div class="discovery-eyebrow">2026 Modern Baseline Active</div>
          <p class="discovery-body">Viewing the uncarved 2026 modern satellite + SRTM baseline for ${region.name}.</p>
          <div class="discovery-actions"><button type="button" class="discovery-swap-btn">Switch to 1550 Historical Territory</button></div>`;
        discoveryCard.querySelector('.discovery-swap-btn').onclick=triggerSwap;
        discoveryBanner.hidden=false;
        discoveryBanner.innerHTML=`<div class="discovery-header"><span class="discovery-eyebrow">2026 Modern Baseline Active</span>
          <button type="button" class="icon-button" id="discovery-close" aria-label="Dismiss notice" style="width:28px;height:28px;min-height:28px;padding:4px"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
          <p class="discovery-title">Viewing 2026 Modern Baseline — ${region.name}</p>
          <p class="discovery-body">Modern reclaimed piers, landfill and 2026 coastline restored for comparison.</p>
          <div class="discovery-actions">
            <button type="button" class="discovery-swap-btn" id="landfall-upgrade-swap">Switch to 1550 Historical Territory</button>
            <button type="button" id="landfall-upgrade-dismiss">Dismiss</button>
          </div>`;
        discoveryBanner.querySelector('#landfall-upgrade-swap').onclick=triggerSwap;
        discoveryBanner.querySelector('#landfall-upgrade-dismiss').onclick=discoveryBanner.querySelector('#discovery-close').onclick=()=>{discoveryBanner.hidden=true;};
      }
    });
  }

  let last=0;return {close:()=>setOpen(false),update(now){if(!active||panel.hidden||now-last<1000)return;last=now;
    const p=getPosition(),geo=islandCoordinates(p.x,p.z,region);
    const ns=geo.latitude>=0?'N':'S',ew=geo.longitude>=0?'E':'W';
    const groundNote=p.aground||p.coastBlocked?' · Run aground':p.shoalScraping?' · Scraping shoal':'';
    panel.querySelector('#landfall-position').textContent=`${Math.abs(geo.latitude).toFixed(3)}° ${ns} · ${Math.abs(geo.longitude).toFixed(3)}° ${ew}${groundNote}`;
  }};
}
