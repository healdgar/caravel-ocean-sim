import { OceanAstronomyEngine } from './vendor/astronomy-engine.js';
import { OCEAN_STARS } from './star-catalog.js';

const ASTRO_RAD=Math.PI/180,ASTRO_AU_KM=149597870.7,ASTRO_J2000=Date.UTC(2000,0,1,12),ASTRO_YEAR_MS=365.25*86400000;
const astroClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const astroUnit=a=>{const l=Math.hypot(...a)||1;return a.map(x=>x/l);};
const astroCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function astronomyDirection(azimuth,altitude){const a=azimuth*ASTRO_RAD,h=altitude*ASTRO_RAD;return [Math.sin(a)*Math.cos(h),Math.sin(h),-Math.cos(a)*Math.cos(h)];}
export function astronomyObserver(anchor,position={x:0,z:0}){
  // Great-circle displacement in metres; does not extrapolate the island's local map.
  const east=(position.x||0)-anchor.x,north=-((position.z||0)-anchor.z),distance=Math.hypot(east,north)/6371008.8;
  const bearing=Math.atan2(east,north),lat=anchor.latitude*ASTRO_RAD,lon=anchor.longitude*ASTRO_RAD;
  const phi=Math.asin(astroClamp(Math.sin(lat)*Math.cos(distance)+Math.cos(lat)*Math.sin(distance)*Math.cos(bearing),-1,1));
  const lambda=lon+Math.atan2(Math.sin(bearing)*Math.sin(distance)*Math.cos(lat),Math.cos(distance)-Math.sin(lat)*Math.sin(phi));
  return {latitude:phi/ASTRO_RAD,longitude:((lambda/ASTRO_RAD+540)%360)-180,height:Math.max(0,position.eye||0)};
}
export function computeAstronomy(date,observer){
  const A=OceanAstronomyEngine,t=new Date(date),o=new A.Observer(observer.latitude,observer.longitude,observer.height||0);
  if(!Number.isFinite(t.getTime()))throw new RangeError('Invalid astronomical date');
  const rotation=A.Rotation_EQJ_HOR(t,o);
  const world=a=>{const v=A.RotateVector(rotation,new A.Vector(...a,A.MakeTime(t)));return [-v.y,v.z,-v.x];};
  const body=name=>{const eq=A.Equator(name,t,o,true,true),g=A.Horizon(t,o,eq.ra,eq.dec),h=A.Horizon(t,o,eq.ra,eq.dec,'normal');return {direction:astronomyDirection(h.azimuth,h.altitude),altitude:h.altitude,geometricAltitude:g.altitude,azimuth:h.azimuth,distanceKm:eq.dist*ASTRO_AU_KM};};
  const sun=body('Sun'),moon=body('Moon'),mi=A.Illumination('Moon',t),si=A.Illumination('Sun',t);
  const sg=A.GeoVector('Sun',t,true),mg=A.GeoVector('Moon',t,true);
  moon.sunDirection=astroUnit(world([sg.x-mg.x,sg.y-mg.y,sg.z-mg.z]));
  moon.right=astroUnit(astroCross(moon.direction,Math.abs(moon.direction[1])>.999?[0,0,1]:[0,1,0]));
  moon.up=astroUnit(astroCross(moon.right,moon.direction));
  moon.radius=Math.asin(1737.4/moon.distanceKm);moon.phase=mi.phase_fraction;moon.phaseAngle=mi.phase_angle;moon.phaseLongitude=A.MoonPhase(t);
  moon.irradiance=14*Math.pow(10,-.4*(mi.mag-si.mag));
  const alpha=mi.phase_angle*ASTRO_RAD;moon.lambert=Math.max(.002,(Math.sin(alpha)+(Math.PI-alpha)*Math.cos(alpha))/Math.PI);
  const matrix=new Float32Array(16);for(let i=0;i<3;i++){const axis=[0,0,0];axis[i]=1;matrix.set(world(axis),i*4);}matrix[15]=1;
  const twilight=astroClamp((-sun.altitude-4)/12,0,1),moonAbove=Math.max(0,moon.direction[1]);
  // Exposure is presentation, never a change to the Sun/Moon energy ratio.
  const exposureScale=1+(Math.pow(twilight,2)*7999)/(1+moon.irradiance*moonAbove*10000);
  return {date:t.toISOString(),observer:{...observer},sun,moon,starRotation:matrix,starVisibility:twilight,exposureScale,shadowDirection:sun.direction[1]>0?sun.direction:moon.direction,moonShadows:sun.direction[1]<=0&&moon.direction[1]>0};
}
export function propagatedStars(date){
  const years=(new Date(date).getTime()-ASTRO_J2000)/ASTRO_YEAR_MS;
  return OCEAN_STARS.map(star=>({hip:star[0],name:star[1],direction:astroUnit([star[2]+star[5]*years,star[3]+star[6]*years,star[4]+star[7]*years]),magnitude:star[8],colorIndex:star[9]}));
}
export function createAstronomyClock(search=new URLSearchParams(),position={x:0,z:0}){
  const number=(key,fallback,min,max)=>search.has(key)&&Number.isFinite(+search.get(key))?astroClamp(+search.get(key),min,max):fallback;
  const requested=search.get('astroDate'),epoch=Date.parse(requested||'2026-10-21T00:00:00Z');
  const clock={mode:search.get('skyMode')==='astronomy'?'astronomy':'manual',epochMs:Number.isFinite(epoch)?epoch:Date.UTC(2026,9,21),elapsedSeconds:0,rate:number('astroRate',1,0,3600),stars:search.get('stars')!=='0',constellations:search.get('constellations')==='1',anchor:{latitude:number('latitude',17.635,-90,90),longitude:number('longitude',-63.238,-180,180),x:position.x||0,z:position.z||0},state:null,revision:0};
  let sampled=-Infinity,anchorKey='';
  clock.set=(values={},boat=position)=>{
    if(values.mode!==undefined)clock.mode=values.mode==='astronomy'?'astronomy':'manual';
    if(values.date!==undefined){const t=Date.parse(values.date);if(!Number.isFinite(t))throw new RangeError('Enter a valid date');clock.epochMs=t;clock.elapsedSeconds=0;}
    if(values.latitude!==undefined||values.longitude!==undefined){const latitude=Number(values.latitude??clock.anchor.latitude),longitude=Number(values.longitude??clock.anchor.longitude);if(!Number.isFinite(latitude)||!Number.isFinite(longitude))throw new RangeError('Invalid observer position');clock.anchor={latitude:astroClamp(latitude,-90,90),longitude:astroClamp(longitude,-180,180),x:boat.x||0,z:boat.z||0};}
    for(const key of ['stars','constellations'])if(values[key]!==undefined)clock[key]=!!values[key];
    if(values.rate!==undefined)clock.rate=astroClamp(Number(values.rate)||0,0,3600);
    sampled=-Infinity;clock.revision++;return clock.update(0,boat);
  };
  clock.update=(elapsed=0,boat=position)=>{
    if(clock.mode==='astronomy')clock.elapsedSeconds+=Math.max(0,elapsed)*clock.rate;
    const now=clock.epochMs+clock.elapsedSeconds*1000,o=astronomyObserver(clock.anchor,boat),key=[o.latitude.toFixed(5),o.longitude.toFixed(5),o.height.toFixed(0)].join(',');
    if(!clock.state||Math.abs(now-sampled)>=1000||key!==anchorKey){clock.state=computeAstronomy(now,o);sampled=now;anchorKey=key;}
    return clock.state;
  };
  clock.share=()=>({skyMode:clock.mode,astroDate:new Date(clock.epochMs+clock.elapsedSeconds*1000).toISOString(),astroRate:clock.rate,latitude:clock.state?.observer.latitude??clock.anchor.latitude,longitude:clock.state?.observer.longitude??clock.anchor.longitude,stars:clock.stars?'1':'0',constellations:clock.constellations?'1':'0'});
  clock.update(0,position);return clock;
}
export function writeAstronomyFrame(frame,clock){
  if(frame.length<132)throw new RangeError('Celestial Frame requires 132 floats / 528 bytes');
  const s=clock.state,m=s.moon,active=clock.mode==='astronomy';
  frame.set(m.direction,96);frame[99]=active?m.irradiance:0;frame.set(m.right,100);frame[103]=m.radius;
  frame.set(m.up,104);frame[107]=m.phase;frame.set(m.sunDirection,108);frame[111]=m.lambert;
  frame[112]=active?1:0;frame[113]=active&&clock.stars?s.starVisibility:0;frame[114]=active&&clock.constellations?s.starVisibility:0;frame[115]=active&&s.moonShadows?1:0;frame.set(s.starRotation,116);
}
