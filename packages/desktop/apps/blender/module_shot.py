"""Standard photo of one building for blind judging (same camera, light and
engine for every arm). Usage:
  blender -b <file.blend> --python module_shot.py -- <collection> <x> <y> <out.png>
<collection> is Module (studio.blend) or Pnn (city.blend); (x, y) its plot
centre. Everything else in the file is hidden."""
import math
import sys

import bpy
import mathutils

name, x, y, out = sys.argv[sys.argv.index("--") + 1:][:4]
x, y = float(x), float(y)
scene = bpy.context.scene
keep = set(bpy.data.collections[name].all_objects) if name in bpy.data.collections else set()
for o in scene.objects:
    if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT", "EMPTY"}:
        hide = o not in keep and not o.name.endswith("_plot")
        if o.name.endswith("_plot"):
            # Only this plot's slab.
            hide = abs(o.location.x - x) > 1 or abs(o.location.y - y) > 1
        o.hide_render = hide
cam = bpy.data.objects.new("JudgeCam", bpy.data.cameras.new("JudgeCam"))
scene.collection.objects.link(cam)
# Frame by the building's height; the 20 m plot stays in view for scale.
top = max((max((o.matrix_world @ mathutils.Vector(c)).z for c in o.bound_box) for o in keep), default=10)
d = max(26.0, top * 0.95 + 10)
cam.location = (x + d, y - d, d * 0.8)
target = mathutils.Vector((x, y, top * 0.45))
cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
cam.data.lens = 30
scene.camera = cam
# Everything that shapes the photo is fixed here, whatever the agent set in
# its file: one sun, a fresh sky, engine, colour management and resolution.
for o in scene.objects:
    if o.type == "LIGHT" and (o.data.type == "SUN" or o not in keep):
        o.hide_render = True
sun = bpy.data.objects.new("JudgeSun", bpy.data.lights.new("JudgeSun", "SUN"))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(48), math.radians(8), math.radians(-35))
scene.collection.objects.link(sun)
world = bpy.data.worlds.new("JudgeSky")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.74, 0.9, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
scene.world = world
scene.render.engine = "BLENDER_EEVEE"
scene.eevee.use_gtao = True
scene.eevee.use_soft_shadows = True
scene.eevee.use_bloom = False
scene.eevee.taa_render_samples = 32
scene.view_settings.view_transform = "Filmic"
scene.view_settings.look = "None"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.film_transparent = False
scene.render.resolution_x, scene.render.resolution_y = 960, 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
