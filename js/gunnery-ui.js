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
    actions.append(prepare,fire);row.append(label,status,actions);section.append(row);rows.push({side,status,prepare,fire});
  }
  const cease=document.createElement('button');cease.textContent='Cease fire';cease.onclick=()=>{gunnery.cease();update();};section.append(cease);
  const standDown=document.createElement('button');standDown.textContent='Stand down gun crews';standDown.onclick=()=>{gunnery.standDown();update();};section.append(standDown);
  const range=gunnery.elevationRange??{min:-4,max:10};
  const elevationRow=document.createElement('label');elevationRow.className='gunnery-elevation';
  const elevationName=document.createElement('span');elevationName.textContent='Quoin elevation';
  const elevationInput=document.createElement('input');
  Object.assign(elevationInput,{type:'range',min:range.min,max:range.max,step:.5,value:gunnery.elevation??0,id:'guns-elevation'});
  elevationInput.setAttribute('aria-label','Quoin elevation');
  const elevationOutput=document.createElement('output');elevationOutput.id='guns-elevation-value';
  const formatElevation=v=>`${v>0?'+':''}${Number(v).toFixed(1)}°`;
  elevationOutput.textContent=formatElevation(gunnery.elevation??0);
  elevationInput.oninput=()=>{const v=gunnery.setElevation?.(Number(elevationInput.value))??Number(elevationInput.value);elevationOutput.textContent=formatElevation(v);};
  elevationRow.append(elevationName,elevationInput,elevationOutput);section.append(elevationRow);
  parent.append(section);
  function update(){
    standDown.disabled=!gunnery.selectedSide;
    for(const r of rows){
      const s=gunnery.summary(r.side),ordered=gunnery.ordered===r.side;
      const held=s.ready===s.total?gunnery.blockedReason(r.side):null;
      const text=ordered?'Captain’s order · stand clear':s.queued?`${s.queued} guns firing`:s.loading?`${s.ready}/${s.total} ready · ${s.loading} loading`:s.ready?`${s.ready}/${s.total} ready${held?' · '+held:''}`:s.spent?`${s.spent} discharged · prepare to reload`:`${s.total} guns secured`;
      if(r.status.textContent!==text)r.status.textContent=text;
      r.fire.disabled=!gunnery.canFire(r.side);
      r.prepare.disabled=!!gunnery.ordered||!!s.queued||s.loading>0||(s.ready===s.total&&gunnery.selectedSide===r.side)||['port','starboard'].some(side=>side!==r.side&&gunnery.summary(side).loading>0);
    }
  }
  update();return {update,element:section};
}
