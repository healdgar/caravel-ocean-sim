# Independent astronomy fixtures

Retrieved 2026-10-21 from the official USNO and NASA/JPL APIs. Raw responses are retained; no simulator-derived expected coordinates are substituted.

- `usno-2026-10-21-0000-saba.json`: https://aa.usno.navy.mil/api/celnav?date=2026-10-21&time=00:00:00&coords=17.635,-63.238
- `usno-2026-10-21-1600-saba.json`: https://aa.usno.navy.mil/api/celnav?date=2026-10-21&time=16:00:00&coords=17.635,-63.238
- `usno-1805-10-21-1200-portsmouth.json`: https://aa.usno.navy.mil/api/celnav?date=1805-10-21&time=12:00:00&coords=50.8,-1.1
- `jpl-1492-moon-saba.json`: exact encoded request saved in `jpl-1492-request.txt`; airless topocentric azimuth/altitude, east-positive geodetic coordinates, Gregorian-only calendar, UT time, DE ephemeris named in the raw header.

USNO documents Hc as **geocentric** altitude. Its positive parallax correction is subtracted to compare with this adapter's already-topocentric geometric altitude. Atmospheric refraction and semidiameter are excluded from that comparison. USNO supports 1800–2050, so the 1492 visual gate instead uses Horizons with an explicit proleptic Gregorian request. Historical Delta-T/Earth rotation model uncertainty prevents a general 2-arcminute navigation accuracy claim.

Official conventions: https://aa.usno.navy.mil/data/api#celnav and https://ssd-api.jpl.nasa.gov/doc/horizons.html . These government reference data do not imply endorsement. Navigation lessons/instruments remain deferred.
