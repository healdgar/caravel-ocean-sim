"""Render front/side/back of an authoring GLB, without changing the source.

Blender --background --factory-startup --disable-autoexec --python
scripts/preview-crew.py -- source.glb output.png
"""
import math
import pathlib
import sys
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
if len(args) != 2:
    raise SystemExit('Expected source.glb output.png')
source, output = [pathlib.Path(value).resolve() for value in args]
if source == output or output.suffix.lower() != '.png':
    raise SystemExit('Output must be a separate PNG file')
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))
objects = list(bpy.context.scene.objects)
rigged = any(obj.type == 'ARMATURE' for obj in objects)
for obj in objects:
    if obj.type == 'ARMATURE':
        obj.animation_data_clear()
        obj.data.pose_position = 'REST'
bpy.context.view_layer.update()
# Flatten the rest mesh before duplicating views. This avoids shared armature
# modifiers deforming copies in another view's coordinates, and excludes Blender
# importer bone-display helper objects from the inspection sheet.
static = []
for obj in objects:
    if obj.type != 'MESH' or (rigged and not any(m.type == 'ARMATURE' for m in obj.modifiers)):
        continue
    copy = bpy.data.objects.new(obj.name+'-rest', obj.data.copy())
    copy.data.transform(obj.matrix_world)
    bpy.context.collection.objects.link(copy)
    static.append(copy)
for obj in objects:
    bpy.data.objects.remove(obj, do_unlink=True)
objects = static
textured = any(material.use_nodes and any(node.type == 'TEX_IMAGE' for node in material.node_tree.nodes)
               for material in bpy.data.materials)
if not textured:
    clay = bpy.data.materials.new('Inspection clay')
    clay.use_nodes = True
    shader = clay.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (0.27, 0.32, 0.36, 1)
    shader.inputs['Roughness'].default_value = 0.75
    for obj in objects:
        if obj.type == 'MESH':
            obj.data.materials.clear()
            obj.data.materials.append(clay)
bpy.context.view_layer.update()
points = [obj.matrix_world @ Vector(corner) for obj in objects
          if obj.type == 'MESH' for corner in obj.bound_box]
if not points:
    raise SystemExit('GLB has no mesh')
low = Vector(tuple(min(p[k] for p in points) for k in range(3)))
high = Vector(tuple(max(p[k] for p in points) for k in range(3)))
height = high.z - low.z
if height <= 0:
    raise SystemExit('GLB has no height')
scale = 1.8 / height
center = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
# Use shared mesh data for the three views; original transforms stay intact.
for index, angle in enumerate([0, math.pi / 2, math.pi]):
    mapping = {obj: obj if index == 0 else obj.copy() for obj in objects}
    if index:
        for obj in mapping.values():
            bpy.context.collection.objects.link(obj)
    pivot = bpy.data.objects.new('View-' + str(index), None)
    bpy.context.collection.objects.link(pivot)
    pivot.location.x = (index - 1) * 2.2
    pivot.rotation_euler.z = angle
    pivot.scale = (scale,) * 3
    origin = bpy.data.objects.new('Normalize-' + str(index), None)
    bpy.context.collection.objects.link(origin)
    origin.parent = pivot
    origin.location = -center
    for original, copy in mapping.items():
        # On subsequent copies, the originals have already been attached to view 0.
        copy.parent = mapping.get(original.parent, origin)
        for modifier in copy.modifiers:
            if modifier.type == 'ARMATURE' and modifier.object in mapping:
                modifier.object = mapping[modifier.object]

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 1800
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(output)
scene.world.color = (0.18, 0.18, 0.18)
scene.view_settings.view_transform = 'AgX'

def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()

bpy.ops.object.camera_add(location=(0, -12, 1.05))
camera = bpy.context.object
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 7.1
aim(camera, (0, 0, 1.05))
scene.camera = camera
for location, power, size in [((2, -4, 5), 650, 5), ((-4, -2, 3), 450, 4), ((0, 3, 5), 700, 4)]:
    bpy.ops.object.light_add(type='AREA', location=location)
    light = bpy.context.object
    light.data.energy = power
    light.data.shape = 'DISK'
    light.data.size = size
    aim(light, (0, 0, 1))
bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.015))
floor = bpy.context.object
material = bpy.data.materials.new('Studio floor')
material.diffuse_color = (0.16, 0.18, 0.20, 1)
floor.data.materials.append(material)
bpy.ops.render.render(write_still=True)
print('Crew review rendered:', output)
