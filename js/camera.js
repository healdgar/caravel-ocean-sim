// Copyright (c) 2026 Six Cailloux, LLC. MIT.

export const ORBIT_LIMIT = Math.PI * .5 - .02;
export function orbitElevation(value) { return Math.max(-ORBIT_LIMIT,Math.min(ORBIT_LIMIT,value)); }
export function orbitDistance(value) { return Math.max(1,Math.min(600,value)); }

// Pan the focus in the camera's screen plane. Distances are world metres;
// using CSS height keeps a touch gesture independent of the rendering scale.
export function panOrbit(orbit,dx,dy,radius,fovY,height) {
  const metres=2*radius*Math.tan(fovY*.5)/Math.max(1,height);
  const sy=Math.sin(orbit.yaw),cy=Math.cos(orbit.yaw);
  const se=Math.sin(orbit.elevation),ce=Math.cos(orbit.elevation);
  orbit.panX=(orbit.panX||0)+metres*(-dx*cy-dy*sy*se);
  orbit.panY=(orbit.panY||0)+metres*dy*ce;
  orbit.panZ=(orbit.panZ||0)+metres*(dx*sy-dy*cy*se);
}

export function placeOrbitCamera(camera,orbit,x,y,z,radius) {
  const horizontal=radius*Math.cos(orbit.elevation);
  const focusX=x+(orbit.panX||0),focusY=y+(orbit.panY||0),focusZ=z+(orbit.panZ||0);
  camera.x=focusX+Math.sin(orbit.yaw)*horizontal;
  camera.y=focusY+radius*Math.sin(orbit.elevation);
  camera.z=focusZ+Math.cos(orbit.yaw)*horizontal;
  camera.yaw=-orbit.yaw;
  camera.pitch=-orbit.elevation;
}
