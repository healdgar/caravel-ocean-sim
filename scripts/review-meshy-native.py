"""Review two native Meshy walking GLBs without changing meshes or skin weights.

Blender --background --factory-startup --disable-autoexec --python
scripts/review-meshy-native.py -- male/walking.glb female/walking.glb output-dir
"""
import json
import math
import pathlib
import sys

import bpy
from mathutils import Vector

male, female, out = [pathlib.Path(p).resolve() for p in sys.argv[sys.argv.index('--') + 1:]]
out.mkdir(parents=True, exist_ok=True)
(out / 'frames').mkdir(exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
actors = []
report = []
for index, source in enumerate((male, female)):
    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(source))
    objects = set(scene.objects) - before
    rig = next(o for o in objects if o.type == 'ARMATURE')
    action = rig.animation_data.action
    if not action:
        raise RuntimeError('Walking GLB has no active imported animation')
    # Keep the imported action slot; only remove NLA duplicates if supplied.
    for track in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(track)
    pivot = bpy.data.objects.new(source.parent.name, None)
    bpy.context.collection.objects.link(pivot)
    pivot.location.x = (index - .5) * 1.1
    for obj in objects:
        if obj.type == 'MESH' and not any(m.type == 'ARMATURE' for m in obj.modifiers):
            bpy.data.objects.remove(obj, do_unlink=True)
        elif obj.parent not in objects:
            obj.parent = pivot
    actors.append((rig, action, tuple(action.frame_range)))
    report.append({'source': str(source), 'bones': len(rig.data.bones),
                   'action': action.name, 'frameRange': list(action.frame_range),
                   'anatomyModified': False, 'weightsModified': False})

scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x = 1100
scene.render.resolution_y = 850
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.world = bpy.data.worlds.new('Studio')
scene.world.color = (.18, .18, .18)
scene.view_settings.view_transform = 'AgX'

def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=(.25, -7, 1.3))
scene.camera = bpy.context.object
scene.camera.data.type = 'ORTHO'
scene.camera.data.ortho_scale = 3.0
aim(scene.camera, (0, 0, .88))
for location, power, size in [((2, -4, 5), 600, 5), ((-4, -2, 3), 400, 4), ((0, 3, 5), 650, 4)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = power
    light.data.shape = 'DISK'
    light.data.size = size
    aim(light, (0, 0, 1))
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.025))
material = bpy.data.materials.new('Floor')
material.diffuse_color = (.14, .16, .18, 1)
bpy.context.object.data.materials.append(material)
scene.frame_start = 0
scene.frame_end = math.ceil(max(a[2][1] for a in actors))
scene.frame_set(0)
bpy.ops.file.pack_all()
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'native-rig-review.blend'))

# Sample the same phase of each native walking cycle, preserving native bones.
for index in range(24):
    for rig, action, (start, end) in actors:
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        strip = track.strips.new('Review phase', 0, action)
        strip.use_animated_time = True
        strip.strip_time = start + index / 24 * (end - start)
        strip.influence = 1
    scene.frame_set(0)
    bpy.context.view_layer.update()
    scene.render.filepath = str(out / 'frames' / f'{index:04}.png')
    bpy.ops.render.render(write_still=True)
    for rig, action, _ in actors:
        for track in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(track)
        rig.animation_data.action = action
        rig.animation_data.action_slot = action.slots[0]
(out / 'review.json').write_text(json.dumps(report, indent=2) + '\n')
