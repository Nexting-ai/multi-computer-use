"""Assembles a finished city block and prepares its fly-around (same for
every arm; not part of the agents' work).

  blender -b --factory-startup --python assemble.py -- city <city.blend> <out.blend>
  blender -b --factory-startup --python assemble.py -- modules <dir> <out.blend> [base]

`city`: one desktop built every plot in city.blend. `modules`: <dir>/Wnn/
studio.blend each hold one plot's collection Module, placed on plot Pnn.
The fixed surroundings (streets, trees, street lights, evening light) and a
10 s orbit at 24 fps are added; frames are rendered separately with Eevee."""
import math
import os
import sys

import bpy
import mathutils

args = sys.argv[sys.argv.index("--") + 1:]
mode, source, out = args[:3]
base = args[3] if len(args) > 3 else "city"  # city (4 x 4) or street (8 x 4)

if mode == "city":
    bpy.ops.wm.open_mainfile(filepath=source)
else:
    bpy.ops.wm.open_mainfile(filepath=f"/opt/app/{base}.blend")
scene = bpy.context.scene
COLS = int(scene.get("plot_cols", 4))
ROWS = int(scene.get("plot_rows", 4))
SPACING = float(scene.get("plot_spacing", 30.0))


def centre(n):
    return ((n - 1) % COLS - (COLS - 1) / 2) * SPACING, ((ROWS - 1) / 2 - (n - 1) // COLS) * SPACING


if mode != "city":
    for name in sorted(os.listdir(source)):
        path = os.path.join(source, name, "studio.blend")
        if not (name.startswith("W") and os.path.exists(path)):
            continue
        n = int(name[1:])
        with bpy.data.libraries.load(path) as (src, dst):
            dst.collections = ["Module"]
        module = dst.collections[0]
        target = bpy.data.collections[f"P{n:02d}"]
        x, y = centre(n)
        for o in list(module.all_objects):
            if o.parent is None:
                o.location.x += x
                o.location.y += y
            target.objects.link(o)

scene = bpy.context.scene


def material(name, rgb, rough=0.8, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*rgb, 1)
    return m


dressing = bpy.data.collections.new("Surroundings")
scene.collection.children.link(dressing)


cubes = {}


def box(size, loc, mat):
    # One shared cube mesh per material: thousands of street dashes stay
    # fast (an operator call per box re-evaluates the whole scene).
    if mat.name not in cubes:
        bpy.ops.mesh.primitive_cube_add(size=1)
        tmp = bpy.context.active_object
        cubes[mat.name] = tmp.data
        tmp.data.materials.append(mat)
        bpy.data.objects.remove(tmp)
    o = bpy.data.objects.new("Box", cubes[mat.name])
    o.location, o.scale = loc, size
    dressing.objects.link(o)
    return o


asphalt = material("Asphalt", (0.09, 0.09, 0.1), 0.6)
paint = material("Paint", (0.9, 0.88, 0.8), 0.5)
bark = material("Bark", (0.25, 0.17, 0.1))
leaf = material("Leaves", (0.18, 0.38, 0.16))
pole = material("Pole", (0.2, 0.2, 0.22), 0.4)
lamp = material("Lamp", (1.0, 0.82, 0.55), 0.3, emit=25)
grass = material("Grass", (0.22, 0.36, 0.17))

W, H = COLS * SPACING + 40, ROWS * SPACING + 40  # paved area
box((W * 3, H * 3, 0.2), (0, 0, -0.32), grass)
box((W, H, 0.1), (0, 0, -0.25), asphalt)
# Streets run between the plots: xs along y, ys along x.
xs = [(i - COLS / 2) * SPACING for i in range(COLS + 1)]
ys = [(j - ROWS / 2) * SPACING for j in range(ROWS + 1)]
for x in xs:  # dashed centre lines
    for t in range(-int(H / 2) + 20, int(H / 2) - 19, 6):
        box((0.25, 2.5, 0.02), (x, t, -0.19), paint)
for y in ys:
    for t in range(-int(W / 2) + 20, int(W / 2) - 19, 6):
        box((2.5, 0.25, 0.02), (t, y, -0.19), paint)

# One tree and one street light, instanced along the streets.
proto = bpy.data.collections.new("Prototypes")
bpy.ops.mesh.primitive_cylinder_add(radius=0.25, depth=3, location=(0, 0, 1.5))
trunk = bpy.context.active_object
trunk.data.materials.append(bark)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=2.2, location=(0, 0, 4.2))
crown = bpy.context.active_object
crown.data.materials.append(leaf)
bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=6, location=(0, 0, 3))
post = bpy.context.active_object
post.data.materials.append(pole)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35, location=(0, 0, 6.1))
bulb = bpy.context.active_object
bulb.data.materials.append(lamp)
tree_col = bpy.data.collections.new("Tree")
light_col = bpy.data.collections.new("StreetLight")
for o, c in ((trunk, tree_col), (crown, tree_col), (post, light_col), (bulb, light_col)):
    for u in o.users_collection:
        u.objects.unlink(o)
    c.objects.link(o)


def instance(col, x, y):
    e = bpy.data.objects.new(col.name, None)
    e.instance_type = "COLLECTION"
    e.instance_collection = col
    e.location = (x, y, 0)
    dressing.objects.link(e)


side = 3.6
for x in xs:
    for t in range(-int(H / 2) + 25, int(H / 2) - 24, 10):
        instance(tree_col if (t // 10) % 2 else light_col, x + side, t + 5)
for y in ys:
    for t in range(-int(W / 2) + 25, int(W / 2) - 24, 10):
        instance(light_col if (t // 10) % 2 else tree_col, t + 5, y - side)

# Evening light: low warm sun, soft blue sky, Eevee with bloom and AO.
for o in scene.objects:
    if o.type == "LIGHT" and o.data.type == "SUN":
        o.data.energy = 4.0
        o.data.color = (1.0, 0.82, 0.62)
        o.data.angle = math.radians(3)
        o.rotation_euler = (math.radians(68), 0, math.radians(-50))
world = scene.world
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.55, 0.78, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.7
scene.render.engine = "BLENDER_EEVEE"
ee = scene.eevee
ee.use_gtao = True
ee.use_bloom = True
ee.use_soft_shadows = True
ee.use_ssr = True
ee.shadow_cascade_size = "2048"
ee.taa_render_samples = 32
scene.view_settings.view_transform = "Filmic"
scene.view_settings.look = "Medium High Contrast"
scene.render.resolution_x, scene.render.resolution_y = 1280, 720

# A 10 s orbit around the block.
pivot = bpy.data.objects.new("Orbit", None)
scene.collection.objects.link(pivot)
cam = scene.camera
cam.parent = pivot
# Close enough that the buildings fill the frame, framed by the paved area.
reach = math.hypot(W, H) / 2
cam.location = (reach * 0.67, -reach * 0.67, reach * 0.42)
aim = bpy.data.objects.new("Aim", None)
aim.location = (0, 0, 4)
scene.collection.objects.link(aim)
track = cam.constraints.new("TRACK_TO")
track.target = aim
track.track_axis, track.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
cam.data.lens = 35
scene.frame_start, scene.frame_end = 1, 240
scene.render.fps = 24
pivot.rotation_euler = (0, 0, 0)
pivot.keyframe_insert("rotation_euler", frame=1)
pivot.rotation_euler = (0, 0, math.radians(360))
pivot.keyframe_insert("rotation_euler", frame=241)
for fc in pivot.animation_data.action.fcurves:
    for k in fc.keyframe_points:
        k.interpolation = "LINEAR"
scene.render.filepath = "/out/frames/f_"
bpy.ops.wm.save_as_mainfile(filepath=out)
