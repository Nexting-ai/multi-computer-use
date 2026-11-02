"""Presentation only: assembles every desktop's saved Building into one
scene and renders the city. Usage:
  blender -b --factory-startup --python city.py -- <in-dir> <out.png>
<in-dir> holds W01/scene.blend, W02/scene.blend, ..."""
import bpy, math, os, sys

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for d in sorted(os.listdir(src)):
    path = os.path.join(src, d, "scene.blend")
    if not os.path.exists(path):
        continue
    with bpy.data.libraries.load(path) as (data_from, data_to):
        data_to.objects = ["Building"]
    for o in data_to.objects:
        o.name = d
        scene.collection.objects.link(o)
bpy.ops.mesh.primitive_plane_add(size=400, location=(40, 40, 0))
ground = bpy.context.active_object
gm = bpy.data.materials.new("Ground")
gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.82, 0.82, 0.8, 1)
ground.data.materials.append(gm)
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
sun.data.energy = 4
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-40))
scene.collection.objects.link(sun)
cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.location = (-55, -70, 95)
scene.collection.objects.link(cam)
target = bpy.data.objects.new("Target", None)
target.location = (37, 37, 12)
scene.collection.objects.link(target)
track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis, track.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
cam.data.lens = 40
scene.camera = cam
scene.world = bpy.data.worlds.new("World")
scene.world.color = (0.75, 0.82, 0.9)
scene.render.engine = "CYCLES"
scene.cycles.samples = 64
scene.cycles.use_denoising = False  # Debian builds lack OpenImageDenoise
scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
