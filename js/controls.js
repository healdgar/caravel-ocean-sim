import { SAIL_KEYS, sailingState } from './sailing.js';
import {getShipModel} from './ship-models.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {deckStationLabel} from './boat.js';

const CONTROL_ICONS = {
  camera:'<rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="4"/><path d="m8 6 1-3h6l1 3"/>',
  captain:'<path d="M4 9c0-6 16-6 16 0l-2 5H6Z"/><path d="M6 14v3c3 3 9 3 12 0v-3M9 10h6"/>',
  map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16M15 5v16"/>',
  chart:'<path d="M12 3.5V6M12 6 6.5 20.5M12 6l5.5 14.5M8.6 15h6.8"/><circle cx="12" cy="6" r="1.5"/>',
  weather:'<path d="M7 16a4 4 0 1 1 1-8 5 5 0 0 1 9 1 3.5 3.5 0 1 1 1 7ZM8 19l-1 2M13 19l-1 2M18 19l-1 2"/>',
  ship:'<path d="M12 2v14M10 4 4 13h6M14 6l5 7h-5M3 17h18l-3 4H6Z"/>',
  share:'<path d="M12 16V3m-4 4 4-4 4 4M6 11H4v10h16V11h-2"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',
  port:'<path d="m14 5-7 7 7 7"/>',
  starboard:'<path d="m10 5 7 7-7 7"/>',
  centre:'<circle cx="12" cy="12" r="6"/><path d="M12 3v4m0 10v4M3 12h4m10 0h4"/>',
  pause:'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  play:'<path d="M7 5v14l11-7Z"/>',
};

export function controlIcon(button,icon,label){
  button.type='button';button.classList.add('icon-button');button.title=label;button.setAttribute('aria-label',label);
  button.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${CONTROL_ICONS[icon]}</svg>`;
  return button;
}

function formatHelmElevation(v){
  const n=Number(v)||0;
  return `${n>0?'+':''}${n.toFixed(1)}°`;
}

function formatHelmTraverse(v){
  const n=Number(v)||0;
  if(Math.abs(n)<0.05)return '0.0°';
  return `${n>0?'+':''}${n.toFixed(1)}°${n>0?'F':'A'}`;
}

// Small presentation surface; all commands use the existing helm, crew and gunnery models.
export function createHelmControls(boat,onSails,onPropulsionChange=()=>{},battleContext=null){
  const model=getShipModel(boat.modelId??'nina'),active=[...new Set(model.rig.sails.map(s=>['fore','main','mizzen'].indexOf(s.controlGroup)))].filter(i=>i>=0);
  const rowing=Object.hasOwn(ROWING_DESIGNS,model.id);
  const gunnery=battleContext?.gunnery??boat.gunnery??null;
  const hasGuns=Boolean(gunnery&&gunnery.state?.guns?.length>0);
  const root=document.createElement('section');root.id='helm-controls';root.setAttribute('aria-label','Helm controls');
  root.dataset.battle='false';
  root.style.setProperty('--nautical-wood-tex','url("assets/caravel-oak-albedo.webp")');
  root.innerHTML=`<div class="helm-rudder"><div class="helm-label"><label for="boat-rudder"><span class="helm-kicker" id="helm-rudder-kicker">HELM</span>Rudder</label><span class="helm-meta"><output id="rudder-angle" aria-live="off">Centred</output></span></div>
    <div class="rudder-controls"><button id="rudder-port"></button><input type="range" id="boat-rudder" min="-35" max="35" step="0.5" value="${boat.rudderTarget}" aria-label="Rudder"><button id="rudder-centre"></button><button id="rudder-starboard"></button></div></div>
    <div class="helm-sails"><div class="helm-label"><span><span class="helm-kicker" id="helm-sails-kicker">RIG</span>Sails</span><span class="helm-meta" id="helm-sails-meta"><output id="helm-canvas" aria-live="off">Full canvas</output></span></div>
    <div class="sail-buttons" role="group" aria-label="Sail amount"><button data-sail="0" aria-label="Furl sails">Furl</button><button data-sail="0.5" aria-label="Reef sails">Reef</button><button data-sail="1" aria-label="Full sails">Full</button></div></div>`;
  const slider=root.querySelector('#boat-rudder'),angle=root.querySelector('#rudder-angle'),canvas=root.querySelector('#helm-canvas');
  const rudderKicker=root.querySelector('#helm-rudder-kicker'),sailsKicker=root.querySelector('#helm-sails-kicker');
  const helmMeta=root.querySelector('.helm-meta');
  const sailsMeta=root.querySelector('#helm-sails-meta');
  root.querySelector('.helm-sails').hidden=active.length===0;
  let rowingOutput,rowButtons=[];
  if(rowing){
    const section=document.createElement('div');section.className='helm-rowing';section.style.gridColumn=active.length?'1 / -1':'auto';
    section.innerHTML='<div class="helm-label"><span><span class="helm-kicker">CREW</span>'+(model.id==='taino-canoe'?'Paddles':'Oars')+'</span><output id="helm-rowing-effort"></output></div><div class="sail-buttons" role="group" aria-label="Rowing effort"><button data-rowing="0">Rest</button><button data-rowing="0.5">Easy</button><button data-rowing="1">Full</button></div>';
    root.append(section);rowingOutput=section.querySelector('output');rowButtons=[...section.querySelectorAll('[data-rowing]')];
    for(const button of rowButtons)button.onclick=()=>{boat.propulsion='sail';boat.rowingEffort=Number(button.dataset.rowing);onPropulsionChange();update(performance.now(),true);};
  }
  const buttons=[...root.querySelectorAll('[data-sail]')];
  const setRudder=value=>{boat.rudderTarget=Math.max(-35,Math.min(35,value));slider.value=boat.rudderTarget;update(performance.now(),true);};
  slider.oninput=()=>setRudder(Number(slider.value));
  for(const [id,icon,label,action] of [
    ['port','port','Rudder to port',()=>setRudder(boat.rudderTarget-5)],
    ['centre','centre','Centre rudder',()=>setRudder(0)],
    ['starboard','starboard','Rudder to starboard',()=>setRudder(boat.rudderTarget+5)],
  ]) controlIcon(root.querySelector('#rudder-'+id),icon,label).onclick=action;
  for(const button of buttons)button.onclick=()=>{onSails(Number(button.dataset.sail));update(performance.now(),true);};

  const anchorBtn=document.createElement('button');
  anchorBtn.type='button';anchorBtn.id='helm-anchor-btn';anchorBtn.className='helm-quarters-pill helm-anchor-pill';
  anchorBtn.hidden=true;
  anchorBtn.setAttribute('aria-pressed','false');
  anchorBtn.onclick=()=>{battleContext?.onAnchorToggle?.();update(performance.now(),true);};
  helmMeta.append(anchorBtn);

  const viewHost=active.length?sailsMeta:helmMeta;
  const viewToggleBtn=document.createElement('button');
  viewToggleBtn.type='button';viewToggleBtn.id='helm-view-toggle';viewToggleBtn.className='helm-quarters-pill helm-view-pill';
  viewToggleBtn.textContent='View: Deck';
  viewToggleBtn.title="Switch camera view (Deck / Crow's Nest / Ship orbit · V or B key) · Drag mouse or press ↑↓←→ keys to turn view · W/S/Q/E to walk deck";
  viewToggleBtn.onclick=()=>{battleContext?.onToggleView?.();update(performance.now(),true);};

  const viewResetBtn=document.createElement('button');
  viewResetBtn.type='button';viewResetBtn.id='helm-view-reset';viewResetBtn.className='helm-quarters-pill';
  viewResetBtn.hidden=true;
  viewResetBtn.onclick=()=>{battleContext?.onResetView?.();update(performance.now(),true);};
  viewHost.append(viewResetBtn,viewToggleBtn);

  let battleDeck=null,quartersBtn=null,battleBadge=null,battleTelemetry=null,vitalityPill=null,magazinePill=null;
  let trainTargetBtn=null,steerBearBtn=null,aimArcsBtn=null,fireAtWillBtn=null,standDownBtn=null;
  let elevationInput=null,elevationOutput=null,traverseInput=null,traverseOutput=null;
  const batteryCards=[];
  const ammoButtons=[];
  let battleOverride=null,inBattleState=false,lastSelectedSide=null,lastOrderedSide=null;

  function findNearestCombatTarget(){
    const vessels=battleContext?.getVessels?.()??[];
    let best=null,bestDist=Infinity;
    for(const v of vessels){
      if(!v?.boat||v.boat===boat||v.boat.damage?.sunk)continue;
      const isEnemy=v.faction==='enemy';
      const d=Math.hypot((v.boat.x??0)-(boat.x??0),(v.boat.z??0)-(boat.z??0));
      const score=isEnemy?d:d+5000;
      if(score<bestDist){bestDist=score;best={x:v.boat.x??0,z:v.boat.z??0,name:v.asset?.model?.name??v.modelId??'Vessel',faction:v.faction,dist:d,hull:v.boat.damage?.hullIntegrity??1};}
    }
    if(!best){
      const port=battleContext?.getPortGunnery?.();
      if(port?.forts?.length){
        for(const f of port.forts){
          const d=Math.hypot((f.x??0)-(boat.x??0),(f.z??0)-(boat.z??0));
          if(d<bestDist){bestDist=d;best={x:f.x??0,z:f.z??0,name:f.name??'Shore battery',faction:'enemy',dist:d,hull:f.integrity??1};}
        }
      }
    }
    return best;
  }

  function steerBroadsideToBear(){
    const target=findNearestCombatTarget();
    if(!target)return;
    const dx=target.x-(boat.x??0),dz=target.z-(boat.z??0);
    const bearingDeg=(Math.atan2(dx,-dz)*180/Math.PI+360)%360;
    const heading=((boat.heading??0)%360+360)%360;
    const normDiff=deg=>((deg-heading+540)%360)-180;
    const stbdHeading=(bearingDeg-90+360)%360;
    const portHeading=(bearingDeg+90)%360;
    const diffStbd=normDiff(stbdHeading),diffPort=normDiff(portHeading);
    const side=gunnery?.selectedSide||(Math.abs(diffStbd)<=Math.abs(diffPort)?'starboard':'port');
    const diff=side==='starboard'?diffStbd:diffPort;
    const rudderCmd=Math.max(-30,Math.min(30,Math.round(diff*0.85*2)/2));
    setRudder(rudderCmd);
  }

  function isBattleActive(){
    if(!hasGuns)return false;
    if(gunnery.selectedSide!==lastSelectedSide||gunnery.ordered!==lastOrderedSide){
      if(gunnery.selectedSide||gunnery.ordered)battleOverride=null;
      lastSelectedSide=gunnery.selectedSide;
      lastOrderedSide=gunnery.ordered;
    }
    if(battleOverride==='open')return true;
    if(battleOverride==='closed')return false;
    if(battleContext?.broadside)return true;
    const vessels=battleContext?.getVessels?.()??[];
    if(vessels.slice(1).some(v=>v.faction==='enemy'&&!v.boat?.damage?.sunk))return true;
    if(gunnery.selectedSide||gunnery.ordered||gunnery.fireAtWill)return true;
    if((gunnery.state?.projectiles?.length??0)>0)return true;
    if(gunnery.state?.guns?.some(g=>g.stage!=='secured'))return true;
    const portProj=battleContext?.getPortGunnery?.()?.projectiles;
    if(portProj&&portProj.length>0)return true;
    if((boat.damage?.hits??0)>0)return true;
    return false;
  }

  function buildBatteryCard(side){
    const card=document.createElement('div');card.className='helm-battery-card';card.dataset.side=side;
    const head=document.createElement('div');head.className='helm-battery-head';
    const title=document.createElement('strong');title.textContent=side==='port'?'Port':'Starboard';
    const status=document.createElement('span');status.className='helm-battery-status';status.id=`helm-guns-${side}-status`;
    head.append(title,status);

    const meter=document.createElement('div');meter.className='helm-battery-meter';
    const readyFill=document.createElement('span');readyFill.className='helm-meter-ready';
    const loadingFill=document.createElement('span');loadingFill.className='helm-meter-loading';
    meter.append(readyFill,loadingFill);

    const actions=document.createElement('div');actions.className='helm-battery-actions';
    const notifyGunnery=()=>{battleContext?.onGunneryChange?.();update(performance.now(),true);};
    const prepBtn=document.createElement('button');prepBtn.type='button';prepBtn.id=`helm-prepare-${side}`;
    prepBtn.textContent='Prep';
    prepBtn.title=`Prepare ${side} battery`;
    prepBtn.onclick=()=>{gunnery.prepare(side);notifyGunnery();};

    const fireBtn=document.createElement('button');fireBtn.type='button';fireBtn.id=`helm-fire-${side}`;
    fireBtn.className='helm-fire-btn';fireBtn.textContent=`Fire ${side}`;
    fireBtn.onclick=()=>{gunnery.fire(side);notifyGunnery();};

    const fireLoadedBtn=document.createElement('button');fireLoadedBtn.type='button';fireLoadedBtn.id=`helm-fire-loaded-${side}`;
    fireLoadedBtn.className='helm-fire-loaded-btn';fireLoadedBtn.textContent='Loaded';
    fireLoadedBtn.title='Fire all currently loaded guns on this side immediately';
    fireLoadedBtn.onclick=()=>{gunnery.fireLoaded?.(side);notifyGunnery();};

    actions.append(prepBtn,fireBtn,fireLoadedBtn);
    card.append(head,meter,actions);
    batteryCards.push({side,card,status,readyFill,loadingFill,prepBtn,fireBtn,fireLoadedBtn});
    return card;
  }

  if(hasGuns){
    const notifyGunnery=()=>{battleContext?.onGunneryChange?.();update(performance.now(),true);};
    quartersBtn=document.createElement('button');
    quartersBtn.type='button';quartersBtn.id='helm-quarters-toggle';quartersBtn.className='helm-quarters-pill';
    quartersBtn.setAttribute('aria-pressed','false');
    quartersBtn.title='Toggle battle quarters control panel (collapse to inspect ship)';
    quartersBtn.textContent='Quarters';
    quartersBtn.onclick=()=>{
      battleOverride=inBattleState?'closed':'open';
      if(battleOverride==='open'&&!gunnery.selectedSide){
        gunnery.prepare(battleContext?.broadsideSide??'starboard');
      }
      notifyGunnery();
    };
    helmMeta.append(quartersBtn);

    battleDeck=document.createElement('div');
    battleDeck.className='helm-battle-deck';
    battleDeck.hidden=true;

    const portCard=buildBatteryCard('port');
    const stbdCard=buildBatteryCard('starboard');

    const centerCol=document.createElement('div');centerCol.className='helm-battle-center';
    const topBar=document.createElement('div');topBar.className='helm-battle-bar';
    const statusGroup=document.createElement('div');statusGroup.className='helm-battle-status-group';
    battleBadge=document.createElement('span');battleBadge.className='helm-battle-badge';
    battleBadge.innerHTML='<span class="helm-battle-dot"></span><span>QUARTERS</span>';
    battleTelemetry=document.createElement('span');battleTelemetry.id='helm-battle-telemetry';battleTelemetry.className='helm-battle-telemetry';
    battleTelemetry.textContent='Batteries at quarters';
    vitalityPill=document.createElement('span');vitalityPill.id='helm-ship-vitality';vitalityPill.className='helm-vitality-pill';
    vitalityPill.textContent='Hull 100%';
    magazinePill=document.createElement('span');magazinePill.id='helm-magazine-pill';magazinePill.className='helm-magazine-pill';
    statusGroup.append(battleBadge,battleTelemetry,vitalityPill,magazinePill);

    const toggles=document.createElement('div');toggles.className='helm-battle-toggles';
    trainTargetBtn=document.createElement('button');trainTargetBtn.type='button';trainTargetBtn.id='helm-train-target';
    trainTargetBtn.className='helm-chip-btn helm-chip-gold';
    trainTargetBtn.textContent=gunnery.isSwivelBattery?'Swivel':'Aim';
    trainTargetBtn.title='Automatically lay horizontal traverse and ballistic elevation onto the nearest target';
    trainTargetBtn.onclick=()=>{
      const side=gunnery.selectedSide||battleContext?.broadsideSide||'starboard';
      const res=gunnery.trainOnTarget?.(side);
      if(res){
        elevationInput.value=res.elevation;
        elevationOutput.textContent=formatHelmElevation(res.elevation);
        traverseInput.value=res.traverse;
        traverseOutput.textContent=formatHelmTraverse(res.traverse);
      }
      notifyGunnery();
    };

    steerBearBtn=document.createElement('button');steerBearBtn.type='button';steerBearBtn.id='helm-steer-bear';
    steerBearBtn.className='helm-chip-btn';
    steerBearBtn.textContent='Bear';
    steerBearBtn.title='Turn the helm to bring your broadside perpendicular to the nearest target';
    steerBearBtn.onclick=()=>steerBroadsideToBear();

    aimArcsBtn=document.createElement('button');aimArcsBtn.type='button';aimArcsBtn.id='helm-aim-arcs';
    aimArcsBtn.className='helm-chip-btn';
    aimArcsBtn.textContent='Arcs';
    aimArcsBtn.title='Toggle 3D aerial ballistic trajectory ribbons';
    aimArcsBtn.onclick=()=>{gunnery.setShowTrajectory?.(!(gunnery.showTrajectory??true));notifyGunnery();};

    fireAtWillBtn=document.createElement('button');fireAtWillBtn.type='button';fireAtWillBtn.id='helm-fire-at-will';
    fireAtWillBtn.className='helm-chip-btn';
    fireAtWillBtn.textContent='Auto';
    fireAtWillBtn.title='Fire at will: automatically reload and fire guns as soon as each battery bears';
    fireAtWillBtn.onclick=()=>{
      if(!gunnery.fireAtWill&&!gunnery.selectedSide)gunnery.prepare(battleContext?.broadsideSide??'starboard');
      gunnery.setFireAtWill?.(!gunnery.fireAtWill);
      notifyGunnery();
    };

    standDownBtn=document.createElement('button');standDownBtn.type='button';standDownBtn.id='helm-stand-down';
    standDownBtn.className='helm-chip-btn';
    standDownBtn.textContent='Stand down';
    standDownBtn.title='Cease fire and stand down gun crews';
    standDownBtn.onclick=()=>{
      gunnery.standDown();
      if(battleOverride==='open')battleOverride=null;
      notifyGunnery();
    };

    toggles.append(trainTargetBtn,steerBearBtn,aimArcsBtn,fireAtWillBtn,standDownBtn);
    topBar.append(statusGroup,toggles);

    const ordnanceBar=document.createElement('div');ordnanceBar.className='helm-ordnance-bar';
    const ammoGroup=document.createElement('div');ammoGroup.className='helm-ammo-pills';
    ammoGroup.setAttribute('role','group');ammoGroup.setAttribute('aria-label','Battle shot type');
    for(const [val,label,tip] of [
      ['round','Round','Round shot · solid iron for hull penetration'],
      ['chain','Chain','Chain shot · whirling shot that rips sails & rigging'],
      ['grape','Grape','Grape shot · anti-personnel & canvas cluster'],
      ['hot','Hot','Hot shot · heated iron that ignites ship fires'],
    ]){
      const btn=document.createElement('button');btn.type='button';btn.dataset.helmAmmo=val;
      btn.textContent=label;btn.title=tip;
      btn.setAttribute('aria-pressed',String((gunnery.ammo??'round')===val));
      btn.onclick=()=>{gunnery.setAmmo?.(val);notifyGunnery();};
      ammoGroup.append(btn);ammoButtons.push(btn);
    }

    const slidersWrap=document.createElement('div');slidersWrap.className='helm-aim-sliders';
    const eRange=gunnery.elevationRange??{min:-4,max:10};
    const elevLabel=document.createElement('label');elevLabel.className='helm-aim-control';
    const elevSpan=document.createElement('span');elevSpan.textContent='Elev';
    elevationInput=document.createElement('input');
    Object.assign(elevationInput,{type:'range',min:eRange.min,max:eRange.max,step:.5,value:gunnery.elevation??0,id:'helm-elevation'});
    elevationInput.setAttribute('aria-label','Battle quoin elevation');
    elevationOutput=document.createElement('output');elevationOutput.id='helm-elevation-value';
    elevationOutput.textContent=formatHelmElevation(gunnery.elevation??0);
    elevationInput.oninput=()=>{
      const v=gunnery.setElevation?.(Number(elevationInput.value))??Number(elevationInput.value);
      elevationOutput.textContent=formatHelmElevation(v);
      notifyGunnery();
    };
    elevLabel.append(elevSpan,elevationInput,elevationOutput);

    const tRange=gunnery.traverseRange??(gunnery.isSwivelBattery?{min:-45,max:45}:{min:-8,max:8});
    const travLabel=document.createElement('label');travLabel.className='helm-aim-control';
    const travSpan=document.createElement('span');travSpan.textContent=gunnery.isSwivelBattery?'Swivel':'Train';
    traverseInput=document.createElement('input');
    Object.assign(traverseInput,{type:'range',min:tRange.min,max:tRange.max,step:gunnery.isSwivelBattery?1:.5,value:gunnery.traverse??0,id:'helm-traverse'});
    traverseInput.setAttribute('aria-label',gunnery.isSwivelBattery?'Battle swivel traverse':'Battle gunport train');
    traverseOutput=document.createElement('output');traverseOutput.id='helm-traverse-value';
    traverseOutput.textContent=formatHelmTraverse(gunnery.traverse??0);
    traverseInput.oninput=()=>{
      const v=gunnery.setTraverse?.(Number(traverseInput.value))??Number(traverseInput.value);
      traverseOutput.textContent=formatHelmTraverse(v);
      notifyGunnery();
    };
    travLabel.append(travSpan,traverseInput,traverseOutput);

    slidersWrap.append(elevLabel,travLabel);
    ordnanceBar.append(ammoGroup,slidersWrap);
    centerCol.append(topBar,ordnanceBar);

    battleDeck.append(portCard,centerCol,stbdCard);
    root.prepend(battleDeck);
  }

  let last=-Infinity;
  function update(now,force=false){
    if(!force&&now-last<100)return;last=now;
    const activeBattle=isBattleActive();
    if(activeBattle!==inBattleState){
      inBattleState=activeBattle;
      root.dataset.battle=String(activeBattle);
      if(battleDeck)battleDeck.hidden=!activeBattle;
      document.body.classList.toggle('battle-ui-open',activeBattle);
      if(rudderKicker)rudderKicker.textContent=activeBattle?'BATTLE HELM':'HELM';
      if(sailsKicker)sailsKicker.textContent=activeBattle?'FIGHTING RIG':'RIG';
    }
    if(quartersBtn)quartersBtn.setAttribute('aria-pressed',String(inBattleState));
    if(document.activeElement!==slider)slider.value=boat.rudderTarget;
    const target=boat.rudderTarget,actual=boat.rudder??0,side=target<0?'port':'starboard';
    angle.textContent=Math.abs(target)<.25?'Centred':`${Math.abs(target).toFixed(0)}° ${side}`;
    angle.title=`Actual rudder: ${actual.toFixed(1)}°`;
    slider.setAttribute('aria-valuetext',angle.textContent);
    const rig=sailingState(boat).rig,deployed=active.length?active.reduce((sum,i)=>sum+rig[i].deployed,0)/active.length:0;
    const targetSail=boat[SAIL_KEYS[active[0]]]??0,uniform=active.every(i=>Math.abs(boat[SAIL_KEYS[i]]-targetSail)<.001);
    const working=active.some(i=>Math.abs(boat[SAIL_KEYS[i]]-rig[i].deployed)>.015);
    canvas.textContent=boat.propulsion!=='sail'?'Set-speed mode':working?`Setting · ${Math.round(deployed*100)}%`:uniform&&targetSail===1?'Full canvas':uniform&&targetSail===0?'Furled':inBattleState&&deployed>=0.45&&deployed<=0.6?`Battle · ${Math.round(deployed*100)}%`:`${Math.round(deployed*100)}% canvas`;
    for(const b of buttons)b.setAttribute('aria-pressed',String(boat.propulsion==='sail'&&uniform&&Math.abs(Number(b.dataset.sail)-targetSail)<.001));
    if(rowingOutput){const effort=boat.rowingEffort??0;rowingOutput.textContent=effort===0?'Rest':Math.round(effort*100)+'% effort';for(const b of rowButtons)b.setAttribute('aria-pressed',String(boat.propulsion==='sail'&&Math.abs(Number(b.dataset.rowing)-effort)<.001));}

    const anchor=battleContext?.anchor??null;
    if(anchorBtn){
      const canDrop=Boolean(anchor?.installed&&!anchor.active&&anchor.eligibility?.allowed);
      const isActive=Boolean(anchor?.installed&&anchor.active);
      const showAnchor=canDrop||isActive;
      anchorBtn.hidden=!showAnchor;
      if(showAnchor){
        const fm=anchor.depthFathoms??anchor.eligibility?.depthFathoms;
        const fmTxt=Number.isFinite(fm)?` ${Math.round(fm)}fm`:'';
        if(anchor.phase==='weighing'){
          anchorBtn.textContent='⚓ Hauling…';
          anchorBtn.disabled=true;
          anchorBtn.setAttribute('aria-pressed','true');
          anchorBtn.title=anchor.status;
        }else if(isActive){
          anchorBtn.textContent=`⚓ Haul${fmTxt}`;
          anchorBtn.disabled=false;
          anchorBtn.setAttribute('aria-pressed','true');
          anchorBtn.title=`${anchor.status} · Click to haul (weigh) anchor`;
        }else{
          anchorBtn.textContent=`⚓ Drop${fmTxt}`;
          anchorBtn.disabled=false;
          anchorBtn.setAttribute('aria-pressed','false');
          anchorBtn.title=`${anchor.eligibility.reason}${fmTxt?` (${fm.toFixed(1)} fathoms)`:''} · Click to let go anchor`;
        }
      }
    }

    if(viewToggleBtn){
      const camMode=battleContext?.getCameraMode?.()??(boat.enabled?'boat':'ship');
      const station=deckStationLabel(boat);
      const viewTxt=camMode==='boat'?`View: ${station}`:camMode==='ship'?'View: Ship':'View: Free';
      if(viewToggleBtn.textContent!==viewTxt)viewToggleBtn.textContent=viewTxt;
      viewToggleBtn.setAttribute('aria-pressed',String(camMode!=='boat'));
      const walked=camMode==='boat'&&Math.hypot(boat.deckWalkX||0,boat.deckWalkZ||0)>0.25;
      const orbit=battleContext?.getShipOrbit?.();
      const panned=camMode==='ship'&&orbit&&Math.hypot(orbit.panX||0,orbit.panY||0,orbit.panZ||0)>0.5;
      if(viewResetBtn){
        viewResetBtn.hidden=!(walked||panned);
        if(walked){
          viewResetBtn.textContent='To Helm';
          viewResetBtn.title='Walk back to the helm station and look ahead';
        }else if(panned){
          viewResetBtn.textContent='Centre';
          viewResetBtn.title='Centre inspection view pivot back on your ship';
        }
      }
    }

    if(hasGuns&&inBattleState){
      let anyReady=false,anyFiring=false;
      for(const b of batteryCards){
        const s=gunnery.summary(b.side),ordered=gunnery.ordered===b.side;
        const rs=ordered?gunnery.rollStatus?.(b.side):null;
        const held=s.ready===s.total?gunnery.blockedReason(b.side):null;
        const statusTxt=ordered
          ?(rs?.stage==='firing'?`Give fire!`:rs?.stage==='steady'?`Steady (${formatHelmElevation(rs.worldElevation)})`:`Laying (${formatHelmElevation(rs?.targetElevation??0)})`)
          :s.queued?`${s.queued} firing`
          :s.loading?`${s.ready}/${s.total} · ${s.loading} load`
          :s.ready?`${s.ready}/${s.total} ready${held?' · held':''}`
          :s.spent?`${s.spent} spent`
          :`${s.total} secured`;
        if(b.status.textContent!==statusTxt)b.status.textContent=statusTxt;
        const total=Math.max(1,s.total);
        const readyPct=Math.round((s.ready/total)*100);
        const loadPct=Math.round((s.loading/total)*100);
        b.readyFill.style.width=`${readyPct}%`;
        b.loadingFill.style.width=`${loadPct}%`;
        const canFull=gunnery.canFire(b.side);
        const canPart=gunnery.canFireLoaded?.(b.side)??canFull;
        b.fireBtn.disabled=!canFull;
        b.fireLoadedBtn.disabled=!canPart;
        const partialLabel=s.ready>0&&s.ready<s.total?`Loaded (${s.ready})`:'Loaded';
        if(b.fireLoadedBtn.textContent!==partialLabel)b.fireLoadedBtn.textContent=partialLabel;
        b.prepBtn.disabled=!!gunnery.ordered||!!s.queued||(s.ready+s.loading===s.total&&gunnery.selectedSide===b.side)||['port','starboard'].some(other=>other!==b.side&&gunnery.summary(other).loading>0);
        const prepLabel=s.spent>0&&s.loading===0?'Reload':'Prep';
        if(b.prepBtn.textContent!==prepLabel)b.prepBtn.textContent=prepLabel;
        b.card.dataset.active=String(gunnery.selectedSide===b.side||ordered);
        b.card.dataset.ready=String(canPart);
        if(canPart)anyReady=true;
        if(ordered||s.queued>0)anyFiring=true;
      }
      battleBadge.dataset.state=anyFiring?'firing':anyReady?'ready':'loading';

      const curAmmo=gunnery.ammo??'round';
      for(const btn of ammoButtons)btn.setAttribute('aria-pressed',String(btn.dataset.helmAmmo===curAmmo));
      if(document.activeElement!==elevationInput){
        const ev=gunnery.elevation??0;
        elevationInput.value=ev;
        elevationOutput.textContent=formatHelmElevation(ev);
      }
      if(document.activeElement!==traverseInput){
        const tv=gunnery.traverse??0;
        traverseInput.value=tv;
        traverseOutput.textContent=formatHelmTraverse(tv);
      }
      const showArcs=gunnery.showTrajectory??true;
      aimArcsBtn.setAttribute('aria-pressed',String(showArcs));
      const faw=Boolean(gunnery.fireAtWill);
      fireAtWillBtn.setAttribute('aria-pressed',String(faw));
      standDownBtn.disabled=!gunnery.selectedSide&&!gunnery.ordered&&!faw;

      const dmg=boat.damage;
      const hullPct=Math.round((dmg?.hullIntegrity??1)*100);
      const rigPct=Math.round((dmg?.rigIntegrity??1)*100);
      const fires=dmg?.worldFires?.length??0;
      const cas=dmg?.crewCasualties;
      const moralePct=Math.round((dmg?.battleMorale??1)*100);
      const crewTxt=cas?` · Crew ${cas.able}/${cas.total} · Morale ${moralePct}%`:'';
      const vitTxt=dmg?.surrendered
        ?`🏳️ Colors struck · Hull ${hullPct}%${crewTxt}`
        :`Hull ${hullPct}% · Rig ${rigPct}%${crewTxt}${fires?` · ${fires}🔥`:''}`;
      if(vitalityPill.textContent!==vitTxt)vitalityPill.textContent=vitTxt;

      const mag=gunnery.magazine;
      if(mag){
        const rounds=mag.rounds?.[curAmmo]??0;
        const magTxt=mag.exploded?'DETONATED':`${mag.barrelsRemaining} bbl · ${rounds}`;
        if(magazinePill.textContent!==magTxt)magazinePill.textContent=magTxt;
      }

      const aim=gunnery.aimSummary;
      const tgt=findNearestCombatTarget();
      let telemTxt='Batteries at quarters';
      if(aim&&(gunnery.showTrajectory??true)){
        const zone=aim.hitKind==='ship'?(aim.hitZone==='rigging'?'Rigging':'Hull'):(aim.hitKind==='building'||aim.hitKind==='terrain')?'Shore':'Splash';
        const trav=Math.abs(aim.targetTraverse??0)>=0.5?` ${formatHelmTraverse(aim.targetTraverse)}`:'';
        telemTxt=`~${aim.rangeMeters}m (${aim.flightSeconds}s · ${zone}${trav})`;
      }else if(tgt){
        telemTxt=`${tgt.name} · ${Math.round(tgt.dist)}m · ${Math.round(tgt.hull*100)}%`;
      }
      if(gunnery.lastDamageReport?.targetName&&gunnery.lastDamageReport?.energyKj){
        const r=gunnery.lastDamageReport;
        const casHit=(r.casualtiesKilled||r.casualtiesWounded)?` (-${(r.casualtiesKilled||0)+(r.casualtiesWounded||0)} crew · ${Math.round((r.battleMorale??1)*100)}% morale)`:'';
        telemTxt+=r.surrendered?` · 🏳️ ${r.targetName} SURRENDERED!`:` · Hit ${r.energyKj}kJ${casHit}`;
      }
      if(battleTelemetry.textContent!==telemTxt)battleTelemetry.textContent=telemTxt;
    }
  }
  document.body.append(root);update(0,true);
  return {root,update,get inBattle(){return inBattleState;}};
}
