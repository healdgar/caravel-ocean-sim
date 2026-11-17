#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""Writes js/crew-skeleton.js from scripts/crew_skeleton.py and the two base bodies' rest poses.

The runtime's joint list, slots and rest places are this script's output, never typed by hand: run it again
whenever the skeleton or assets/crew/sailor.glb or sailor-female.glb changes.

  python3 scripts/write-crew-skeleton-js.py
"""
import importlib.util, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from crew_skeleton import JOINTS, PARENT, FACE_JOINTS  # noqa: E402

spec = importlib.util.spec_from_file_location('extend', os.path.join(HERE, 'extend-crew-skeleton.py'))
extend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extend)


def rest_places(name):
    doc, _ = extend.read_glb(os.path.join(ROOT, 'assets', 'crew', name))
    names = [doc['nodes'][j]['name'] for j in doc['skins'][0]['joints']]
    if names != list(JOINTS):
        raise SystemExit(f'{name} is not on the crew skeleton')
    worlds, _ = extend.worlds_of(doc['nodes'])
    return [worlds[j][:3, 3] for j in doc['skins'][0]['joints']]


def table(places):
    rows = []
    for k in range(0, len(places), 6):
        rows.append('  ' + ', '.join('[' + ', '.join(f'{v:.4f}'.rstrip('0').rstrip('.').replace('-0', '-0') if abs(v) >= 5e-5 else '0' for v in p) + ']' for p in places[k:k + 6]) + ',')
    return '\n'.join(rows)


names = ',\n'.join('  ' + ', '.join(f"'{n}'" for n in JOINTS[k:k + 6]) for k in range(0, len(JOINTS), 6))
parents = ', '.join(str(JOINTS.index(PARENT[n])) if PARENT[n] else '-1' for n in JOINTS)
text = f"""// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The crew skeleton: Unreal 5's 80-joint body, as Tripo rigs it, and 13 face joints under the head. Written by
// scripts/write-crew-skeleton-js.py from scripts/crew_skeleton.py and the base bodies; do not edit by hand.
// The order is every crew GLB's skin order: each joint follows its parent and is followed by all its descendants.

export const CREW_JOINT_NAMES = Object.freeze([
{names}
]);
export const CREW_JOINT_COUNT = {len(JOINTS)};
// Each joint's parent's slot, -1 for the root.
export const CREW_JOINT_PARENTS = Object.freeze([{parents}]);
// Each joint's slot, by name.
export const CREW_SLOT = Object.freeze(Object.fromEntries(CREW_JOINT_NAMES.map((name, slot) => [name, slot])));
export const CREW_FACE_JOINT_NAMES = Object.freeze([{', '.join(f"'{n}'" for n in FACE_JOINTS)}]);
// Where each joint is at rest on the male and female base bodies (assets/crew/sailor.glb, sailor-female.glb), metres.
export const CREW_REST_MALE_PLACES = Object.freeze([
{table(rest_places('sailor.glb'))}
]);
export const CREW_REST_FEMALE_PLACES = Object.freeze([
{table(rest_places('sailor-female.glb'))}
]);
"""
out = os.path.join(ROOT, 'js', 'crew-skeleton.js')
open(out, 'w').write(text)
print('wrote', out)
