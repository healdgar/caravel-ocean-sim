// Share configuration only: leave capture/debug flags and device resolution behind.
const BOAT_LINK_KEYS = {
  length: 'boatLength', beam: 'boatBeam', heading: 'boatHeading',
  speed: 'boatSpeed', eye: 'boatEye', rudderTarget: 'boatRudder',
};

export const ROUGH_SEAS = {
  windSpeed: 28, windDir: 123, fetchKm: 300,
  swellHs: 8, swellLength: 95, swellDir: 236, choppy: 1.6, foam: 1.7,
};

export function cameraModeFromLink(search) {
  const mode = search.get('view');
  return ['boat', 'free', 'ship'].includes(mode) ? mode : search.get('boat') === '1' ? 'boat' : 'free';
}

export function createShareLink(href, settings, boat, cameraMode) {
  const url = new URL(href);
  url.search = ''; url.hash = '';
  const setNumber = (key, value) => {
    if (Number.isFinite(value)) url.searchParams.set(key, String(Number(value.toFixed(6))));
  };
  url.searchParams.set('boat', cameraMode === 'boat' ? '1' : '0');
  url.searchParams.set('view', cameraMode);
  for (const [key, value] of Object.entries(settings)) setNumber(key, value);
  for (const [key, param] of Object.entries(BOAT_LINK_KEYS)) setNumber(param, boat[key]);
  url.searchParams.set('prow', boat.showProw ? '1' : '0');
  return url.href;
}
