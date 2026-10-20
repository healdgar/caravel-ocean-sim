import { SAIL_KEYS, sailingState } from './sailing.js';

const CONTROL_ICONS = {
  camera:'<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="m8 6 1-3h6l1 3"/>',
  captain:'<path d="M4 9c0-6 16-6 16 0l-2 5H6Z"/><path d="M6 14v3c3 3 9 3 12 0v-3M9 10h6"/>',
  map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16"/>',
  weather:'<path d="M7 16a4 4 0 1 1 1-8 5 5 0 0 1 9 1 3.5 3.5 0 1 1 1 7ZM8 19l-1 2M13 19l-1 2M18 19l-1 2"/>',
  ship:'<path d="M12 2v14M10 4 4 13h6M14 6l5 7h-5M3 17h18l-3 4H6Z"/>',
  share:'<path d="M12 16V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  port:'<path d="m14 5-7 7 7 7"/>',
  starboard:'<path d="m10 5 7 7-7 7"/>',
  centre:'<circle cx="12" cy="12" r="6"/><path d="M12 3v4m0 10v4M3 12h4m10 0h4"/>',
};

export function controlIcon(button,icon,label){
  button.type='button';button.classList.add('icon-button');button.title=label;button.setAttribute('aria-label',label);
  button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${CONTROL_ICONS[icon]}</svg>`;
  return button;
}

// Small presentation surface; all commands use the existing helm and crew model.
export function createHelmControls(boat,onSails){
  const root=document.createElement('section');root.id='helm-controls';root.setAttribute('aria-label','Helm controls');
  root.innerHTML=`<div class="helm-rudder"><div class="helm-label"><label for="boat-rudder">Rudder</label><output id="rudder-angle" aria-live="off">Centred</output></div>
    <div class="rudder-controls"><button id="rudder-port"></button><input type="range" id="boat-rudder" min="-35" max="35" step="0.5" value="${boat.rudderTarget}" aria-label="Rudder"><button id="rudder-centre"></button><button id="rudder-starboard"></button></div></div>
    <div class="helm-sails"><div class="helm-label"><span>Sails</span><output id="helm-canvas" aria-live="off">Full canvas</output></div>
    <div class="sail-buttons" role="group" aria-label="Sail amount"><button data-sail="0" aria-label="Furl sails">Furl</button><button data-sail="0.5" aria-label="Reef sails">Reef</button><button data-sail="1" aria-label="Full sails">Full</button></div></div>`;
  const slider=root.querySelector('#boat-rudder'),angle=root.querySelector('#rudder-angle'),canvas=root.querySelector('#helm-canvas');
  const buttons=[...root.querySelectorAll('[data-sail]')];
  const setRudder=value=>{boat.rudderTarget=Math.max(-35,Math.min(35,value));slider.value=boat.rudderTarget;update(performance.now(),true);};
  slider.oninput=()=>setRudder(Number(slider.value));
  for(const [id,icon,label,action] of [
    ['port','port','Rudder to port',()=>setRudder(boat.rudderTarget-5)],
    ['centre','centre','Centre rudder',()=>setRudder(0)],
    ['starboard','starboard','Rudder to starboard',()=>setRudder(boat.rudderTarget+5)],
  ]) controlIcon(root.querySelector('#rudder-'+id),icon,label).onclick=action;
  for(const button of buttons)button.onclick=()=>{onSails(Number(button.dataset.sail));update(performance.now(),true);};
  let last=-Infinity;
  function update(now,force=false){
    if(!force&&now-last<100)return;last=now;
    if(document.activeElement!==slider)slider.value=boat.rudderTarget;
    const target=boat.rudderTarget,actual=boat.rudder??0,side=target<0?'port':'starboard';
    angle.textContent=Math.abs(target)<.25?'Centred':`${Math.abs(target).toFixed(0)}° ${side}`;
    angle.title=`Actual rudder: ${actual.toFixed(1)}°`;
    slider.setAttribute('aria-valuetext',angle.textContent);
    const rig=sailingState(boat).rig,deployed=rig.reduce((sum,p)=>sum+p.deployed,0)/3;
    const uniform=SAIL_KEYS.every(k=>Math.abs(boat[k]-boat.sailFore)<.001),targetSail=boat.sailFore;
    const working=SAIL_KEYS.some((k,i)=>Math.abs(boat[k]-rig[i].deployed)>.015);
    canvas.textContent=boat.propulsion!=='sail'?'Set-speed mode':working?`Setting · ${Math.round(deployed*100)}%`:uniform&&targetSail===1?'Full canvas':uniform&&targetSail===0?'Furled':`${Math.round(deployed*100)}% canvas`;
    for(const b of buttons)b.setAttribute('aria-pressed',String(boat.propulsion==='sail'&&uniform&&Math.abs(Number(b.dataset.sail)-targetSail)<.001));
  }
  document.body.append(root);update(0,true);return {root,update};
}
