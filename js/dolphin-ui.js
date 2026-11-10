import {DOLPHIN_ENCOUNTER_SECONDS} from './dolphin-state.js';
export function createDolphinControls({parent,encounter,boat,getTerrain=()=>null,getVessels=()=>[boat],onView=()=>{},castleDuel=null,onClosePanel=()=>{},onCoastlineSwap=()=>{}}){
  const details=document.createElement('details');details.id='environment-debug';
  details.innerHTML='<summary>Environment, encounters &amp; debug</summary><p>Dolphin pods visit occasionally in fair weather. Use the controls below to preview an encounter or toggle debug modes.</p><label>Natural dolphin sightings <input id="natural-dolphins" type="checkbox" checked></label><div class="encounter-buttons"><button id="spot-dolphins">Spot dolphin pod</button><button id="view-dolphins">View pod</button><button id="end-dolphins">End encounter</button></div><p id="dolphin-status" role="status">No pod nearby</p><div id="debug-mode-controls" style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.12);"><strong style="display:block;font-size:12px;margin-bottom:6px;opacity:0.85;">Debug &amp; Side Modes</strong><div class="encounter-buttons"><button type="button" id="debug-coastline-btn">Coastline: 1550 Historical</button><button type="button" id="castle-duel-toggle-btn">🏰 Castle Duel</button></div><p id="debug-coastline-status" role="status" style="margin-top:6px;font-size:12px;opacity:0.8;">1550 historical coastline active</p></div>';
  const toggle=details.querySelector('input'),trigger=details.querySelector('#spot-dolphins'),end=details.querySelector('#end-dolphins'),status=details.querySelector('#dolphin-status');
  const coastBtn=details.querySelector('#debug-coastline-btn'),coastStatus=details.querySelector('#debug-coastline-status');
  const duelBtn=details.querySelector('#castle-duel-toggle-btn');
  const toast=document.createElement('div');toast.id='encounter-notice';toast.hidden=true;toast.setAttribute('role','status');document.body.append(toast);
  let until=0,lastEvent=null,last=-Infinity;
  function notice(event){if(!event||event===lastEvent)return;lastEvent=event;toast.textContent=event.text;toast.hidden=false;until=performance.now()+8000;}
  toggle.onchange=()=>{encounter.enabled=toggle.checked;};
  trigger.onclick=()=>{if(encounter.trigger(boat,{terrain:getTerrain(),vessels:getVessels()})){notice(encounter.event);}update(performance.now(),true);};
  end.onclick=()=>{encounter.clear();toast.hidden=true;update(performance.now(),true);};
  const view=details.querySelector('#view-dolphins');view.onclick=onView;

  function syncCoastlineUI(){
    const disc=getTerrain()?.discovery;
    if(!disc||!disc.enabled){
      coastBtn.disabled=true;
      coastBtn.textContent='Coastline: Procedural';
      coastStatus.textContent='No historical/modern coastline swap for this scene';
      return;
    }
    coastBtn.disabled=false;
    const is1550=Boolean(disc.applied);
    coastBtn.textContent=is1550?'Switch to 2026 Modern Coastline':'Switch to 1550 Historical Coastline';
    coastStatus.textContent=is1550?'1550 historical coastline active':'2026 modern baseline coastline active';
  }
  coastBtn.onclick=()=>{
    const disc=getTerrain()?.discovery;
    if(!disc)return;
    if(disc.toggleUpgraded(boat)){
      onCoastlineSwap();
    }
    syncCoastlineUI();
  };
  const initDisc=getTerrain()?.discovery;
  initDisc?.subscribe?.(()=>syncCoastlineUI());

  if(castleDuel){
    castleDuel.bindLaunchButton?.(duelBtn,onClosePanel);
  }else{
    duelBtn.hidden=true;
  }

  function update(now,force=false){
    notice(encounter.event);if(now>until)toast.hidden=true;
    if(!force&&now-last<500)return;last=now;
    end.disabled=!encounter.active;view.disabled=!encounter.active;trigger.disabled=encounter.active;
    status.textContent=encounter.active?`Pod of ${encounter.count} · ${Math.max(0,Math.ceil(DOLPHIN_ENCOUNTER_SECONDS-encounter.age))} s nearby`:encounter.event?.text??'No pod nearby';
    syncCoastlineUI();
  }
  parent.append(details);update(0,true);return {update,notice,root:details,toast};
}
