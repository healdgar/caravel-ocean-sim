// Share configuration only: leave capture/debug flags and device resolution behind.
const BOAT_LINK_KEYS = {
  length: 'boatLength', beam: 'boatBeam', heading: 'boatHeading',
  speed: 'boatSpeed', eye: 'boatEye', rudderTarget: 'boatRudder',
  sailFore: 'sailFore', sailMain: 'sailMain', sailMizzen: 'sailMizzen',
  provisionDays: 'provisionDays', cargoTonnes: 'cargoTonnes',
  x:'boatX',z:'boatZ',
  rowingEffort:'rowingEffort',rowingTurn:'rowingTurn',rowingCadence:'rowingCadence',
};

export const ROUGH_SEAS = {
  windSpeed: 28, windDir: 123, fetchKm: 300,
  swellHs: 8, swellLength: 95, swellDir: 236, choppy: 1.6, foam: 1.7,
  clouds: 0.88, cloudBase: 0.85, cloudDepth: 4.2, cloudDensity: 1.3, cloudAnvil: 0.9, haze: 5,
};

export function cameraModeFromLink(search) {
  const mode = search.get('view');
  return ['boat', 'free', 'ship'].includes(mode) ? mode : search.get('boat') === '0'||search.has('cam') ? 'free' : 'boat';
}

export function propulsionFromLink(search) {
  const mode = search.get('propulsion');
  if (mode === 'sail' || mode === 'manual') return mode;
  return 'sail'; // A speed parameter alone must never silently enable powered motion.
}

export function createShareLink(href, settings, boat, cameraMode, camera=null) {
  const url = new URL(href);
  url.search = ''; url.hash = '';
  const scene=new URL(href).searchParams;
  for(const key of ['landfall','weather','region','lat','lon','broadside','scenario','broadsideSide','broadsideRange','gunsReady'])if(scene.has(key))url.searchParams.set(key,scene.get(key));
  const setNumber = (key, value) => {
    if (Number.isFinite(value)) url.searchParams.set(key, String(Number(value.toFixed(6))));
  };
  if(camera?.astronomy)for(const [key,value] of Object.entries(camera.astronomy))url.searchParams.set(key,String(value));
  url.searchParams.set('boat', cameraMode === 'boat' ? '1' : '0');
  url.searchParams.set('view', cameraMode);
  if(cameraMode==='ship'&&camera?.orbit){
    const orbit=camera.orbit;
    setNumber('orbitYaw',(orbit.yaw*180/Math.PI-boat.heading)%360);
    setNumber('orbitElevation',orbit.elevation*180/Math.PI);setNumber('orbitDistance',orbit.distance);
    for(const axis of ['X','Y','Z'])setNumber('orbitPan'+axis,orbit['pan'+axis]||0);
  }else if(cameraMode==='free'&&camera?.cam){
    const c=camera.cam;
    url.searchParams.set('cam',[c.x,c.y,c.z,c.yaw*180/Math.PI,c.pitch*180/Math.PI].map(n=>Number(n.toFixed(6))).join(','));
  }
  if(boat.modelId&&boat.modelId!=='nina')url.searchParams.set('ship',boat.modelId);
  url.searchParams.set('propulsion', boat.propulsion === 'sail' ? 'sail' : 'manual');
  for (const [key, value] of Object.entries(settings)) setNumber(key, value);
  for (const [key, param] of Object.entries(BOAT_LINK_KEYS)) setNumber(param, boat[key]);
  url.searchParams.set('prow', boat.showProw ? '1' : '0');
  url.searchParams.set('effects', boat.effects === false ? '0' : '1');
  url.searchParams.set('crew', boat.crew === false ? '0' : '1');
  url.searchParams.set('follower',boat.followingShip===false?'0':'1');
  if(Array.isArray(boat.fleet))url.searchParams.set('fleet',boat.fleet.map(entry=>(entry.enabled===false?'!':'')+entry.modelId).join(','));
  for(const key of ['speedHud','windHud','headingHud'])url.searchParams.set(key,boat[key]===false?'0':'1');
  return url.href;
}
