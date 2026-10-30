// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
export function createGunneryControls(parent,gunnery){
  const section=document.createElement('section');section.className='gunnery-controls';
  const title=document.createElement('h3');title.textContent='Gunnery';section.append(title);
  const note=document.createElement('p');note.textContent='Prepare a side. Wait for the gun crews, then order a single broadside.';section.append(note);
  const rows=[];
  for(const side of ['port','starboard']){
    const row=document.createElement('div');row.className='gunnery-battery';
    const label=document.createElement('strong');label.textContent=side==='port'?'Port battery':'Starboard battery';
    const status=document.createElement('span');status.setAttribute('role','status');status.id='guns-'+side+'-status';
    const actions=document.createElement('div');actions.className='gunnery-actions';
    const prepare=document.createElement('button');prepare.textContent='Prepare '+side;prepare.id='guns-prepare-'+side;
    prepare.onclick=()=>{gunnery.prepare(side);update();};
    const fire=document.createElement('button');fire.textContent='Fire '+side;fire.id='guns-fire-'+side;fire.className='gun-fire';
    fire.onclick=()=>{gunnery.fire(side);update();};
    const fireLoaded=document.createElement('button');fireLoaded.textContent='Fire loaded';fireLoaded.id='guns-fire-loaded-'+side;fireLoaded.className='gun-fire-loaded';
    fireLoaded.title='Fire all currently loaded guns on this side without waiting for the remaining guns to finish loading';
    fireLoaded.onclick=()=>{gunnery.fireLoaded?.(side);update();};
    actions.append(prepare,fire,fireLoaded);row.append(label,status,actions);section.append(row);rows.push({side,status,prepare,fire,fireLoaded});
  }
  const fireAtWill=document.createElement('button');fireAtWill.id='guns-fire-at-will';fireAtWill.textContent='Fire at will: Off';
  fireAtWill.setAttribute('aria-pressed','false');
  fireAtWill.title='Automatically reload and fire guns as soon as each battery bears and finishes loading';
  fireAtWill.onclick=()=>{gunnery.setFireAtWill?.(!gunnery.fireAtWill);update();};
  section.append(fireAtWill);
  const cease=document.createElement('button');cease.textContent='Cease fire';cease.onclick=()=>{gunnery.cease();update();};section.append(cease);
  const standDown=document.createElement('button');standDown.textContent='Stand down gun crews';standDown.onclick=()=>{gunnery.standDown();update();};section.append(standDown);
  const ammoRow=document.createElement('label');ammoRow.className='gunnery-ammo';
  const ammoName=document.createElement('span');ammoName.textContent='Shot type';
  const ammoSelect=document.createElement('select');ammoSelect.id='guns-ammo';ammoSelect.setAttribute('aria-label','Shot type');
  for(const [val,txt] of [
    ['round','Round shot (solid iron · hull penetration)'],
    ['hot','Hot shot (glowing red-hot · starts fires)'],
    ['chain','Chain shot (whirling · rips sails & rigging)'],
    ['grape','Grape shot (clustered · shreds canvas & decks)'],
  ]){
    const opt=document.createElement('option');opt.value=val;opt.textContent=txt;ammoSelect.append(opt);
  }
  ammoSelect.value=gunnery.ammo??'round';
  ammoSelect.onchange=()=>{gunnery.setAmmo?.(ammoSelect.value);update();};
  ammoRow.append(ammoName,ammoSelect);section.append(ammoRow);
  const range=gunnery.elevationRange??{min:-4,max:10};
  const elevationRow=document.createElement('label');elevationRow.className='gunnery-elevation';
  const elevationName=document.createElement('span');elevationName.textContent='Quoin elevation';
  const elevationInput=document.createElement('input');
  Object.assign(elevationInput,{type:'range',min:range.min,max:range.max,step:.5,value:gunnery.elevation??0,id:'guns-elevation'});
  elevationInput.setAttribute('aria-label','Quoin elevation');
  const elevationOutput=document.createElement('output');elevationOutput.id='guns-elevation-value';
  const formatElevation=v=>`${v>0?'+':''}${Number(v).toFixed(1)}°`;
  elevationOutput.textContent=formatElevation(gunnery.elevation??0);
  elevationInput.oninput=()=>{const v=gunnery.setElevation?.(Number(elevationInput.value))??Number(elevationInput.value);elevationOutput.textContent=formatElevation(v);update();};
  elevationRow.append(elevationName,elevationInput,elevationOutput);section.append(elevationRow);
  const tRange=gunnery.traverseRange??(gunnery.isSwivelBattery?{min:-45,max:45}:{min:-8,max:8});
  const traverseRow=document.createElement('label');traverseRow.className='gunnery-traverse';
  const traverseName=document.createElement('span');
  traverseName.textContent=gunnery.isSwivelBattery?'Swivel traverse':'Gunport train';
  const traverseInput=document.createElement('input');
  Object.assign(traverseInput,{type:'range',min:tRange.min,max:tRange.max,step:gunnery.isSwivelBattery?1:.5,value:gunnery.traverse??0,id:'guns-traverse'});
  traverseInput.setAttribute('aria-label',gunnery.isSwivelBattery?'Swivel traverse':'Gunport train');
  const traverseOutput=document.createElement('output');traverseOutput.id='guns-traverse-value';
  const formatTraverse=v=>{
    const n=Number(v);
    if(Math.abs(n)<0.05)return '0.0° beam';
    return `${n>0?'+':''}${n.toFixed(1)}° ${n>0?'fore':'aft'}`;
  };
  traverseOutput.textContent=formatTraverse(gunnery.traverse??0);
  traverseInput.oninput=()=>{const v=gunnery.setTraverse?.(Number(traverseInput.value))??Number(traverseInput.value);traverseOutput.textContent=formatTraverse(v);update();};
  traverseRow.append(traverseName,traverseInput,traverseOutput);section.append(traverseRow);
  const trainTargetBtn=document.createElement('button');trainTargetBtn.id='guns-train-target';
  trainTargetBtn.textContent=gunnery.isSwivelBattery?'Swivel onto target':'Train onto target';
  trainTargetBtn.title='Automatically swivel/train and elevate the battery toward the nearest target on the active side';
  trainTargetBtn.onclick=()=>{
    const res=gunnery.trainOnTarget?.(gunnery.selectedSide);
    if(res){
      elevationInput.value=res.elevation;
      elevationOutput.textContent=formatElevation(res.elevation);
      traverseInput.value=res.traverse;
      traverseOutput.textContent=formatTraverse(res.traverse);
    }
    update();
  };
  section.append(trainTargetBtn);
  const aimArcsBtn=document.createElement('button');aimArcsBtn.id='guns-aim-arcs';
  aimArcsBtn.title='Toggle 3D aerial ballistic trajectory ribbons and impact rings';
  aimArcsBtn.onclick=()=>{gunnery.setShowTrajectory?.(!(gunnery.showTrajectory??true));update();};
  section.append(aimArcsBtn);
  const aimStatus=document.createElement('p');aimStatus.id='guns-aim-status';aimStatus.className='gunnery-aim-status';
  aimStatus.hidden=true;section.append(aimStatus);
  const magazineStatus=document.createElement('p');magazineStatus.id='guns-magazine-status';magazineStatus.className='gunnery-magazine';
  magazineStatus.hidden=true;section.append(magazineStatus);
  const damageStatus=document.createElement('p');damageStatus.id='guns-damage-status';damageStatus.setAttribute('role','status');
  damageStatus.hidden=true;section.append(damageStatus);
  parent.append(section);
  function formatDamage(r){
    if(!r)return '';
    if(r.kind==='ship'){
      const partLabel=r.hitPartId?` [${r.hitPartId}]`:'';
      const extras=[];
      if(r.magazineExploded)extras.push(`MAGAZINE EXPLOSION (${r.magazineExplosionYieldMj} MJ)`);
      else if(r.magazineDeflagrated)extras.push(`magazine deflagration (${r.magazineExplosionYieldMj} MJ)`);
      if(r.hullCracked)extras.push('HULL CRACKED UNDER STRAIN');
      if(r.hitZone==='rigging'&&r.sailRips)extras.push('sail ripped');
      if(r.enteredThroughWindow)extras.push('window entry');
      if(r.hitBackWall)extras.push('struck back wall');
      if(r.fires)extras.push(`${r.fires} fire${r.fires>1?'s':''} burning`);
      if(r.casualtiesKilled||r.casualtiesWounded){
        extras.push(`${r.casualtiesKilled||0} killed, ${r.casualtiesWounded||0} wounded (${r.crewAble}/${r.crewTotal} able, morale ${Math.round((r.battleMorale??1)*100)}% ${r.moraleState||'steady'})`);
      }
      if(r.surrendered)extras.push('🏳️ STRUCK COLORS (SURRENDERED)');
      if(r.sunk)extras.push('Foundering');
      const extraText=extras.length?` · ${extras.join(', ')}`:'';
      const zone=r.hitZone==='rigging'?`${r.mastGroup||'main'} rigging${partLabel} (${Math.round(r.rigIntegrity*100)}% rig)`:`hull${partLabel} (${Math.round(r.hullIntegrity*100)}% hull${r.breaches?`, ${r.breaches} breach${r.breaches>1?'es':''}`:''})`;
      return `Struck ${r.targetName} ${zone} · ${r.energyKj} kJ${extraText}`;
    }
    if(r.kind==='building'){
      return `Struck ${r.buildingName} · ${Math.round(r.integrity*100)}% integrity (${r.state}) · ${r.energyKj} kJ`;
    }
    if(r.kind==='terrain'){
      return `Shore strike (${r.elevation} m elev) · ${r.craterRadius} m crater · ${r.energyKj} kJ`;
    }
    return '';
  }
  function update(){
    standDown.disabled=!gunnery.selectedSide;
    const mag=gunnery.magazine;
    if(mag){
      magazineStatus.hidden=false;
      const ammoKey=gunnery.ammo??'round';
      const roundsLeft=mag.rounds?.[ammoKey]??0;
      const pct=Math.round((mag.powderFraction??1)*100);
      const magText=mag.exploded
        ?`Powder magazine: DETONATED (${mag.explosionYieldMj} MJ)`
        :`Powder magazine: ${mag.barrelsRemaining}/${mag.barrelsTotal} bbl (${Math.round(mag.powderKg)} kg · ${pct}%) · ${roundsLeft} ${ammoKey} shot`;
      if(magazineStatus.textContent!==magText)magazineStatus.textContent=magText;
    }else{
      magazineStatus.hidden=true;
    }
    const latest=formatDamage(gunnery.lastDamageReport);
    damageStatus.hidden=!latest;
    if(latest&&damageStatus.textContent!==latest)damageStatus.textContent=latest;
    for(const r of rows){
      const s=gunnery.summary(r.side),ordered=gunnery.ordered===r.side;
      const rs=ordered?gunnery.rollStatus?.(r.side):null;
      const fmtDeg=v=>`${v>0?'+':''}${Number(v).toFixed(1)}°`;
      const orderText=rs?.stage==='firing'?`As she bears · give fire! (${fmtDeg(rs.worldElevation)})`
        :rs?.stage==='steady'?`Steady on the roll · ${fmtDeg(rs.worldElevation)} → ${fmtDeg(rs.targetElevation)}`
        :rs?`Laying quoins (${fmtDeg(rs.targetElevation)}) · ready & steady`
        :'Captain’s order · stand clear';
      const held=s.ready===s.total?gunnery.blockedReason(r.side):null;
      const text=ordered?orderText:s.queued?`${s.queued} guns firing`:s.loading?`${s.ready}/${s.total} ready · ${s.loading} loading`:s.ready?`${s.ready}/${s.total} ready${held?' · '+held:''}`:s.spent?`${s.spent} discharged · prepare to reload`:`${s.total} guns secured`;
      if(r.status.textContent!==text)r.status.textContent=text;
      r.fire.disabled=!gunnery.canFire(r.side);
      const canPartial=gunnery.canFireLoaded?.(r.side)??gunnery.canFire(r.side);
      r.fireLoaded.disabled=!canPartial;
      const loadedLabel=s.ready>0&&s.ready<s.total?`Fire loaded (${s.ready})`:'Fire loaded';
      if(r.fireLoaded.textContent!==loadedLabel)r.fireLoaded.textContent=loadedLabel;
      r.prepare.disabled=!!gunnery.ordered||!!s.queued||(s.ready+s.loading===s.total&&gunnery.selectedSide===r.side)||['port','starboard'].some(side=>side!==r.side&&gunnery.summary(side).loading>0);
    }
    const faw=Boolean(gunnery.fireAtWill);
    fireAtWill.setAttribute('aria-pressed',String(faw));
    const fawText=faw?`Fire at will: On (${gunnery.selectedSide||'port'})`:'Fire at will: Off';
    if(fireAtWill.textContent!==fawText)fireAtWill.textContent=fawText;
    const showArcs=gunnery.showTrajectory??true;
    aimArcsBtn.setAttribute('aria-pressed',String(showArcs));
    const arcsBtnText=showArcs?'Aiming arcs: On':'Aiming arcs: Off';
    if(aimArcsBtn.textContent!==arcsBtnText)aimArcsBtn.textContent=arcsBtnText;
    const aim=gunnery.aimSummary;
    if(showArcs&&aim){
      aimStatus.hidden=false;
      const zoneLabel=aim.hitKind==='ship'
        ?(aim.hitZone==='rigging'?'Target rigging hit':'Target hull hit')
        :(aim.hitKind==='building'||aim.hitKind==='terrain')
          ?'Shore / fort impact'
          :'Sea splash';
      const travTxt=Math.abs(aim.targetTraverse??0)>=0.5?` · ${formatTraverse(aim.targetTraverse)}`:'';
      const aimText=`Ballistic aim (${aim.side}${travTxt}): ~${aim.rangeMeters} m · ${aim.flightSeconds}s flight · ${zoneLabel}`;
      if(aimStatus.textContent!==aimText)aimStatus.textContent=aimText;
    }else{
      aimStatus.hidden=true;
    }
  }
  update();return {update,element:section};
}
