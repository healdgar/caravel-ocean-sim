# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
# Bake a textured model's colour onto a reduced copy of it, with a fresh unwrap. A generated model's atlas
# is mostly seams, so reducing it with its texture coordinates stops early and smears what it does reach.
# Reducing the shape alone and baking afterwards loses neither.
#
#   python scripts/rebake-texture.py source.glb reduced.glb out.glb [512]
#
# The Python needs bpy (pip install bpy). safe-decimate.mjs runs this itself when given --python.
import sys

import bpy
import numpy

CAGE_SHARE = .04
RAY_SHARE = .12
MARGIN_PIXELS = 8
SAMPLES = 4
UNWRAP_ANGLE_RADIANS = 1.15
ISLAND_MARGIN = .015
JPEG_QUALITY = 85


def load(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before and o.type == 'MESH']


def ignore_cut_outs():
    # A ray that lands in a leaf's hole would read as nothing. The colour under the hole is what is wanted.
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                for link in list(node.inputs['Alpha'].links):
                    material.node_tree.links.remove(link)
                node.inputs['Alpha'].default_value = 1


def mean_colour():
    # What a ray that hits nothing is left showing. Black would stand out; the average does not.
    pixels = [numpy.array(i.pixels[:]).reshape(-1, 4) for i in bpy.data.images if i.size[0] > 0]
    if not pixels:
        raise SystemExit('The source model has no texture to bake')
    mean = numpy.concatenate(pixels).mean(axis=0)
    return (float(mean[0]), float(mean[1]), float(mean[2]), 1)


def main(source, reduced, out, size):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    detailed = load(source)
    ignore_cut_outs()
    colour = mean_colour()
    low = load(reduced)
    bpy.ops.object.select_all(action='DESELECT')
    for o in low:
        o.select_set(True)
    bpy.context.view_layer.objects.active = low[0]
    if len(low) > 1:
        bpy.ops.object.join()
    target = bpy.context.view_layer.objects.active
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=UNWRAP_ANGLE_RADIANS, island_margin=ISLAND_MARGIN)
    bpy.ops.object.mode_set(mode='OBJECT')

    image = bpy.data.images.new('baked', size, size, alpha=False)
    image.generated_color = colour
    material = bpy.data.materials.new('baked')
    material.use_nodes = True
    nodes = material.node_tree
    shader = nodes.nodes['Principled BSDF']
    node = nodes.nodes.new('ShaderNodeTexImage')
    node.image = image
    nodes.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    shader.inputs['Roughness'].default_value = .9
    nodes.nodes.active = node
    target.data.materials.clear()
    target.data.materials.append(material)

    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = SAMPLES
    reach = max(target.dimensions)
    bpy.ops.object.select_all(action='DESELECT')
    for o in detailed:
        o.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=True, cage_extrusion=reach * CAGE_SHARE, max_ray_distance=reach * RAY_SHARE, margin=MARGIN_PIXELS, use_clear=False)
    for o in detailed:
        bpy.data.objects.remove(o)
    image.pack()
    bpy.ops.object.select_all(action='DESELECT')
    target.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='JPEG', export_jpeg_quality=JPEG_QUALITY)
    print('BAKED', out, len(target.data.polygons), 'triangles', size, 'pixels')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 512)
