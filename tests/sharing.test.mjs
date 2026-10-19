import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraModeFromLink, propulsionFromLink, createShareLink, ROUGH_SEAS } from '../js/sharing.js';

const boat = { length: 12, beam: 3.6, heading: 278.123456789, speed: 9.5, eye: 2.4, rudderTarget: -12.5, showProw: true };

test('share link carries the live storm, lighting, and boat configuration on a Pages subpath', () => {
  const settings = { ...ROUGH_SEAS, sunElev: 12.3, sunAzim: -180, clouds: 0.76, cloudBase: 1.4, cloudDepth: 3.8,
    cloudDensity: 1.65, cloudAnvil: 0.8, cloudQuality: 0.75, bloom: 0, swellSpread: 48, spindrift: 1.5 };
  const link = new URL(createShareLink('https://healdgar.github.io/seasick-simulator/?windSpeed=7', settings, boat, 'boat'));
  assert.equal(link.pathname, '/seasick-simulator/');
  for (const [key, value] of Object.entries(settings)) assert.equal(Number(link.searchParams.get(key)), value);
  assert.equal(link.searchParams.get('boat'), '1');
  assert.equal(cameraModeFromLink(link.searchParams), 'boat');
  for (const [key, value] of Object.entries({ boatLength: 12, boatBeam: 3.6, boatHeading: 278.123457, boatSpeed: 9.5, boatEye: 2.4, boatRudder: -12.5 })) {
    assert.equal(Number(link.searchParams.get(key)), value);
  }
  assert.equal(link.searchParams.get('prow'), '1');
});

test('sharing replaces stale URL settings and strips capture, resolution, and hidden-UI flags', () => {
  const link = new URL(createShareLink('http://localhost:8087/ocean.html?shot=frame.png&seq=120&dbg=1&w=4096&h=2160&resolution=0.5&ui=0&windSpeed=2#old', { windSpeed: 28, invalid: NaN }, { ...boat, speed: 0, showProw: false }, 'ship'));
  assert.equal(link.origin, 'http://localhost:8087');
  assert.equal(link.pathname, '/ocean.html');
  assert.equal(link.hash, '');
  for (const key of ['shot', 'seq', 'dbg', 'w', 'h', 'resolution', 'ui', 'invalid']) assert.equal(link.searchParams.has(key), false);
  assert.equal(link.searchParams.get('windSpeed'), '28');
  assert.equal(link.searchParams.get('boatSpeed'), '0');
  assert.equal(link.searchParams.get('prow'), '0');
  assert.equal(link.searchParams.get('boat'), '0');
  assert.equal(cameraModeFromLink(link.searchParams), 'ship');
});

test('camera links support all three views and legacy boat links', () => {
  for (const mode of ['boat', 'free', 'ship']) {
    const link = new URL(createShareLink('https://example.com/', {}, boat, mode));
    assert.equal(cameraModeFromLink(link.searchParams), mode);
  }
  assert.equal(cameraModeFromLink(new URLSearchParams('boat=1')), 'boat');
  assert.equal(cameraModeFromLink(new URLSearchParams('boat=0')), 'free');
  assert.equal(cameraModeFromLink(new URLSearchParams('view=invalid&boat=1')), 'boat');
  assert.equal(cameraModeFromLink(new URLSearchParams('view=ship&boat=1')), 'ship');
});

test('sharing preserves the wake and spray switch', () => {
  for (const effects of [true, false]) {
    const url = new URL(createShareLink('https://example.com/', {}, { ...boat, effects }, 'ship'));
    assert.equal(url.searchParams.get('effects'), effects ? '1' : '0');
  }
});

test('loading links preserve provision days and additional cargo, including empty stores',()=>{
  for(const provisionDays of [0,60,120]){
    const link=new URL(createShareLink('https://example.com/',{}, {...boat,provisionDays,cargoTonnes:12.5},'ship'));
    assert.equal(Number(link.searchParams.get('provisionDays')),provisionDays);
    assert.equal(Number(link.searchParams.get('cargoTonnes')),12.5);
  }
});

test('sharing keeps the calm-water target rather than a transient wave-driven speed', () => {
  const url = new URL(createShareLink('https://example.com/', {}, { ...boat, surgeVelocity: 2.1 }, 'boat'));
  assert.equal(Number(url.searchParams.get('boatSpeed')), boat.speed);
  assert.equal(url.searchParams.has('surgeVelocity'), false);
});

test('sailing links preserve propulsion and individual sail targets; old speed links retain manual mode',()=>{
  const ship={...boat,propulsion:'sail',sailFore:0,sailMain:.5,sailMizzen:1};
  const url=new URL(createShareLink('https://example.com/',{},ship,'boat'));
  assert.equal(propulsionFromLink(url.searchParams),'sail');
  for(const key of ['sailFore','sailMain','sailMizzen'])assert.equal(Number(url.searchParams.get(key)),ship[key]);
  assert.equal(propulsionFromLink(new URLSearchParams()),'sail');
  assert.equal(propulsionFromLink(new URLSearchParams('boatSpeed=6')),'manual');
  assert.equal(propulsionFromLink(new URLSearchParams('boatSpeed=6&propulsion=sail')),'sail');
});

test('speed and wind instrument visibility survives sharing independently',()=>{
  for(const speedHud of [true,false])for(const windHud of [true,false]){
    const link=new URL(createShareLink('https://example.com/',{}, {...boat,speedHud,windHud},'boat'));
    assert.equal(link.searchParams.get('speedHud'),speedHud?'1':'0');
    assert.equal(link.searchParams.get('windHud'),windHud?'1':'0');
  }
});
