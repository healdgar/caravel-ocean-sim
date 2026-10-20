// Debug encounter controls stay inside the environmental disclosure.
export function createMarineControls({parent,encounter,boat,getTerrain=()=>null,getVessels=()=>[boat],onView=()=>{},notice=()=>{}}){
  const root=document.createElement('div');root.className='marine-encounters';
  root.innerHTML='<p>Sharks pass occasionally; whales may breach, dive with a raised fluke, or surface to blow.</p><label>Natural shark and whale sightings <input id="natural-marine" type="checkbox" checked></label><div class="encounter-buttons"><button data-encounter="shark">Spot shark</button><button data-encounter="breach">Whale breach</button><button data-encounter="fluke">Whale fluke dive</button><button data-encounter="blow">Whale blow</button><button id="view-marine">View marine animal</button><button id="end-marine">End marine encounter</button></div><p id="marine-status" role="status">No shark or whale nearby</p>';
  const toggle=root.querySelector('input'),buttons=[...root.querySelectorAll('[data-encounter]')],view=root.querySelector('#view-marine'),end=root.querySelector('#end-marine'),status=root.querySelector('#marine-status');
  let last=-Infinity,lastEvent=null;
  function report(){if(encounter.event&&encounter.event!==lastEvent){lastEvent=encounter.event;notice(encounter.event);}}
  function trigger(kind){
    encounter.trigger(kind==='shark'?'shark':'whale',boat,{terrain:getTerrain(),vessels:getVessels(),...(kind==='shark'?{}:{behavior:kind})});report();update(performance.now(),true);
  }
  for(const button of buttons)button.onclick=()=>trigger(button.dataset.encounter);
  toggle.onchange=()=>{encounter.enabled=toggle.checked;};view.onclick=onView;
  end.onclick=()=>{encounter.clear();update(performance.now(),true);};
  function update(now,force=false){
    report();if(!force&&now-last<500)return;last=now;
    view.disabled=end.disabled=!encounter.active;for(const button of buttons)button.disabled=encounter.active;
    status.textContent=encounter.active?encounter.event?.text??'Marine encounter nearby':encounter.event?.text??'No shark or whale nearby';
  }
  parent.append(root);update(0,true);return {root,update,trigger};
}
