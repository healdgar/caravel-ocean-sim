# Sail-force model — 2026-10-19

Forces use the displayed sail geometry, rather than a trim score measured against
the automatic controller's own target. Sheet targets and the operating rig are
unchanged. This is an authored low-order model, not a measured caravel polar.

## Calculation

- Sample 36 triangles per sail from `lateenClothPoint`, with the renderer's hull
  scale, camber, furling, mast supports and yard pose. Ignore decorative flutter.
- At each triangle, subtract forward/leeway and roll/pitch point velocity from
  the height-dependent wind. Compute incidence against the triangle normal.
- Use `q = 0.5 ρ V²`, `L = q S CL`, and `D = q S CD`. Lift is perpendicular to
  relative airflow; drag follows it. Normal winding cannot change the result.
- Attached lift slope is `2π AR / (AR + 2)`. Induced drag is
  `CL² / (π AR e)`, with authored `e = 0.7`. A smooth 18–35° blend reaches
  separated-plate coefficients `CL = 1.6 sin α cos α`, `CD = 0.04 + 1.6 sin² α`.
  These stall and plate coefficients are assumptions, not measured sail data.
- Sum forces and `r × F` about the loaded centre of gravity. Integrate forward,
  sideways, roll and pitch loads through existing inertia, righting and drag.
  Vertical force is used in torque but does not yet alter buoyancy/heave;
  aerodynamic yaw and sail-to-sail interference remain omitted.
- Pressure-derived canvas fill approaches its target over 0.25 seconds. Force
  queries do not advance the canvas. Furled visual bundles have zero exposed area.

NASA Glenn documents the [lift equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/lift-equation/),
[drag equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/drag-equation/)
and [induced drag](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/induced-drag-coefficient/).
These support the force structure, not the authored coefficients or historical calibration.

## Remaining rig defect

The retained-yard bad-tack pose leaves the clew windward. The old force model
awarded it 72% of a nominal good-tack force regardless of its geometry. The new
model correctly identifies backed cloth and permits astern force. The HUD shows
“Canvas backed · transfer yards”; the existing captain's transfer order moves
the rig to its drawing side. Neither helm input nor that cue supplies thrust.

Routine bad-tack sheet/yard geometry still needs correction. A trial that swung
the clew leeward without transferring the yard failed physical rope/cloth
clearance tests and was rejected. Do not hide intersections, restore a power
bonus, or claim this operating rig is mechanically complete. A proper correction
must pass the existing rendered triangle/rope clearance checks before optimizing
trim or calibrating voyage speeds.

## Validation

`tests/sail-aerodynamics.test.mjs` covers cloth-coordinate identity, exposed area,
continuous stall behavior, normal reversal, pressure and area scaling, actual
sheet sensitivity, and energy dissipation in still air over 300 randomized
translation/roll/pitch cases. `tests/sailing.test.mjs` covers vessel inertia,
reefing, wave response, mirrored loads, 10–120 FPS integration and wind-driven
sternway. Recovery time, reaching a particular heading, and subsequent forward
motion are not guaranteed: they depend on actual canvas geometry and water flow.

Run `node scripts/sail-force-audit.mjs` for reproducible fixed-pose loads.

## Performance assessment

Visible Chrome on the local Apple M4 Max held 60 FPS at 1920×1080 and
3840×2160 before the change (maximum cloud quality at 4K). Those original
`777aac5` fixtures included a legacy speed parameter and therefore selected
set-speed mode: their approximately 0.05 ms/frame boat-update cost was not a
full sailing-mode comparison. Headless Chromium had a much slower presentation
cadence despite low CPU work, so it was not used to infer desktop performance.

After the changes, explicit **sailing mode** at 3840×2160, maximum clouds and
all crew averaged 60.0 FPS on the drawing tack and 59.9 FPS after a wind reversal.
Mean boat-physics time was 0.17 ms/frame and 0.58 ms/frame respectively; total
JavaScript averaged 0.85 ms and 1.14 ms. Each sample covered eight seconds after
four seconds of warm-up. These are short Mac checks, not iPhone measurements or
long-session thermal tests. The user confirmed performance was fine, so no
quality or resolution reductions were made.

Full validation: 149 tests passed on Metal, including rendered rig clearance
and all three standalone bundles. Controlled before/after runoff captures and
visible 4K sailing renders supplemented the automated checks.
