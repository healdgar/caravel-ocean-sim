import { boatForwardSpeed, KNOT_TO_MPS } from './boat.js';
import { sailingState, pointOfSail } from './sailing.js';

export function instrumentReadout(boat){
  const s=sailingState(boat),speed=boatForwardSpeed(boat)/KNOT_TO_MPS;
  const degrees=s.apparentAngle*180/Math.PI,angle=Math.abs(degrees);
  const direction=angle<3?'Ahead':angle>177?'Astern':`${Math.round(angle)}° ${degrees<0?'port':'starboard'}`;
  let cue=pointOfSail(s.apparentAngle,s.apparentSpeed);
  if(boat.propulsion==='manual')cue='Set-speed mode';
  else if(s.maneuver)cue='Transferring yards · crew handling rig';
  else if(s.forward<0&&angle>=55&&s.rig.some(p=>p.pressure<-.5))cue='Canvas backed · transfer yards';
  else if(speed<-.05)cue=s.forward>0&&Math.abs(boat.rudderTarget??0)>3?'Wind filling sails · centre rudder':'Drifting astern · steering is reversed';
  else if(angle<42&&s.apparentSpeed>=.5)cue='In irons · rudder needs water flow';
  else if(s.rig.some(p=>p.pressure<-.5))cue+=' · bad tack';
  return {speed:(Math.abs(speed)<.05?0:speed).toFixed(1),motion:speed<-.05?'ASTERN':'AHEAD',
    wind:(s.apparentSpeed/KNOT_TO_MPS).toFixed(1),degrees,direction,calm:s.apparentSpeed<.5,cue};
}

// Presentation only: the instruments never change the physics or resolution.
export function createSailingInstruments(boat,search,controls){
  let saved={};try{saved=JSON.parse(localStorage.getItem('sailing-instruments')||'{}')||{};}catch{/* unavailable storage */}
  const root=document.createElement('aside');root.id='sailing-instruments';root.setAttribute('aria-label','Sailing instruments');
  root.innerHTML=`<div class="instrument-speed"><span class="instrument-label">SPEED THROUGH WATER</span><div><strong id="sailing-knots">0.0</strong> <span>kn</span></div><span id="sailing-motion">AHEAD</span></div>
    <div class="instrument-wind"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27"/><path class="wind-bow" d="M29 9 L32 3 L35 9"/><text x="32" y="36">BOW</text><g id="sailing-wind-arrow"><path d="M32 10 V23 M27 18 L32 23 L37 18"/></g></svg><div><span class="instrument-label">APPARENT WIND · FROM</span><div><strong id="sailing-wind-knots">0.0</strong> kn</div><span id="sailing-wind-direction">Ahead</span></div></div>
    <div id="sailing-cue"></div>`;
  const speedCard=root.querySelector('.instrument-speed'),windCard=root.querySelector('.instrument-wind');
  for(const [key,label,card]of [['speedHud','Show speed indicator',speedCard],['windHud','Show wind indicator',windCard]]){
    boat[key]=search.has(key)?search.get(key)!=='0':saved[key]!==false;
    const row=document.createElement('label'),input=document.createElement('input');row.textContent=label;
    input.type='checkbox';input.id='boat-'+key;input.checked=boat[key];card.hidden=!boat[key];
    input.onchange=()=>{boat[key]=input.checked;card.hidden=!input.checked;try{localStorage.setItem('sailing-instruments',JSON.stringify({speedHud:boat.speedHud,windHud:boat.windHud}));}catch{/* unavailable storage */}update(performance.now(),true);};
    row.append(input);controls.append(row);
  }
  const fields=Object.fromEntries(['knots','motion','wind-knots','wind-direction','cue'].map(key=>[key,root.querySelector('#sailing-'+key)]));
  const arrow=root.querySelector('#sailing-wind-arrow');let last=-Infinity;
  function update(now,force=false){
    root.hidden=search.get('ui')==='0'||(!boat.speedHud&&!boat.windHud);
    if(root.hidden||(!force&&now-last<100))return;last=now;
    const r=instrumentReadout(boat);
    for(const [key,value]of Object.entries({knots:r.speed,motion:r.motion,'wind-knots':r.wind,'wind-direction':r.calm?'Calm':r.direction,cue:r.cue}))if(fields[key].textContent!==value)fields[key].textContent=value;
    arrow.setAttribute('transform',`rotate(${r.degrees} 32 32)`);arrow.style.opacity=r.calm?'0':'1';
    speedCard.dataset.astern=String(r.motion==='ASTERN');
  }
  document.body.append(root);update(0,true);return {root,update};
}
