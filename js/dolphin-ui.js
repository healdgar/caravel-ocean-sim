import {DOLPHIN_ENCOUNTER_SECONDS} from './dolphin-state.js';
export function createDolphinControls({parent,encounter,boat,getTerrain=()=>null,getVessels=()=>[boat],onView=()=>{}}){
  const details=document.createElement('details');details.id='environment-debug';
  details.innerHTML='<summary>Environment & encounters</summary><p>Dolphin pods visit occasionally in fair weather. Use the controls below to preview an encounter.</p><label>Natural dolphin sightings <input id="natural-dolphins" type="checkbox" checked></label><div class="encounter-buttons"><button id="spot-dolphins">Spot dolphin pod</button><button id="view-dolphins">View pod</button><button id="end-dolphins">End encounter</button></div><p id="dolphin-status" role="status">No pod nearby</p>';
  const toggle=details.querySelector('input'),trigger=details.querySelector('#spot-dolphins'),end=details.querySelector('#end-dolphins'),status=details.querySelector('#dolphin-status');
  const toast=document.createElement('div');toast.id='encounter-notice';toast.hidden=true;toast.setAttribute('role','status');document.body.append(toast);
  let until=0,lastEvent=null,last=-Infinity;
  function notice(event){if(!event||event===lastEvent)return;lastEvent=event;toast.textContent=event.text;toast.hidden=false;until=performance.now()+8000;}
  toggle.onchange=()=>{encounter.enabled=toggle.checked;};
  trigger.onclick=()=>{if(encounter.trigger(boat,{terrain:getTerrain(),vessels:getVessels()})){notice(encounter.event);}update(performance.now(),true);};
  end.onclick=()=>{encounter.clear();toast.hidden=true;update(performance.now(),true);};
  const view=details.querySelector('#view-dolphins');view.onclick=onView;
  function update(now,force=false){
    notice(encounter.event);if(now>until)toast.hidden=true;
    if(!force&&now-last<500)return;last=now;
    end.disabled=!encounter.active;view.disabled=!encounter.active;trigger.disabled=encounter.active;
    status.textContent=encounter.active?`Pod of ${encounter.count} · ${Math.max(0,Math.ceil(DOLPHIN_ENCOUNTER_SECONDS-encounter.age))} s nearby`:encounter.event?.text??'No pod nearby';
  }
  parent.append(details);update(0,true);return {update,notice,root:details,toast};
}
