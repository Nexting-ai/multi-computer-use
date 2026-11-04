"""Assembles a finished city block and prepares its fly-around (same for
every arm; not part of the agents' work).

  blender -b --factory-startup --python assemble.py -- city <city.blend> <out.blend>
  blender -b --factory-startup --python assemble.py -- modules <dir> <out.blend> [base] [theme]

`city`: one desktop built every plot in city.blend. `modules`: <dir>/Wnn/
studio.blend each hold one plot's collection Module, placed on plot Pnn.
The fixed surroundings (theme town: streets, trees, street lights; theme
jungle: a rainforest clearing with paths, a runway and a river), evening light and a
10 s orbit at 24 fps are added; frames are rendered separately with Eevee."""
import math
import os
import sys

import bpy
import mathutils

args = sys.argv[sys.argv.index("--") + 1:]
mode, source, out = args[:3]
base = args[3] if len(args) > 3 else "city"  # city (4 x 4) or street (8 x 4)
THEME = args[4] if len(args) > 4 else "town"  # town (streets) or jungle

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

W, H = COLS * SPACING + 40, ROWS * SPACING + 40  # the plots' area
xs = [(i - COLS / 2) * SPACING for i in range(COLS + 1)]
ys = [(j - ROWS / 2) * SPACING for j in range(ROWS + 1)]

# Prototypes, instanced many times: a tree, a street light, a palm.
def proto(name, parts):
    col = bpy.data.collections.new(name)
    for o in parts:
        for u in o.users_collection:
            u.objects.unlink(o)
        col.objects.link(o)
    return col


def part(op, mat, **kw):
    op(**kw)
    o = bpy.context.active_object
    o.data.materials.append(mat)
    return o


tree_col = proto("Tree", [
    part(bpy.ops.mesh.primitive_cylinder_add, bark, radius=0.25, depth=3, location=(0, 0, 1.5)),
    part(bpy.ops.mesh.primitive_ico_sphere_add, leaf, subdivisions=2, radius=2.2, location=(0, 0, 4.2)),
])
light_col = proto("StreetLight", [
    part(bpy.ops.mesh.primitive_cylinder_add, pole, radius=0.1, depth=6, location=(0, 0, 3)),
    part(bpy.ops.mesh.primitive_uv_sphere_add, lamp, radius=0.35, location=(0, 0, 6.1)),
])


def instance(col, x, y, scale=1.0, turn=0.0):
    e = bpy.data.objects.new(col.name, None)
    e.instance_type = "COLLECTION"
    e.instance_collection = col
    e.location = (x, y, 0)
    e.scale = (scale, scale, scale)
    e.rotation_euler = (0, 0, turn)
    dressing.objects.link(e)


if THEME == "town":
    # Paved streets between the plots: xs run along y, ys along x.
    box((W * 3, H * 3, 0.2), (0, 0, -0.32), grass)
    box((W, H, 0.1), (0, 0, -0.25), asphalt)
    for x in xs:  # dashed centre lines
        for t in range(-int(H / 2) + 20, int(H / 2) - 19, 6):
            box((0.25, 2.5, 0.02), (x, t, -0.19), paint)
    for y in ys:
        for t in range(-int(W / 2) + 20, int(W / 2) - 19, 6):
            box((2.5, 0.25, 0.02), (t, y, -0.19), paint)
    side = 3.6
    for x in xs:
        for t in range(-int(H / 2) + 25, int(H / 2) - 24, 10):
            instance(tree_col if (t // 10) % 2 else light_col, x + side, t + 5)
    for y in ys:
        for t in range(-int(W / 2) + 25, int(W / 2) - 24, 10):
            instance(light_col if (t // 10) % 2 else tree_col, t + 5, y - side)
else:
    # A clearing in a rainforest: dirt paths between the plots, a runway on
    # one side, a river on the other, dense jungle all around.
    import random

    rnd = random.Random(7)
    soil = material("Soil", (0.32, 0.2, 0.12), 0.9)
    moss = material("Moss", (0.12, 0.26, 0.09))
    water = material("Water", (0.08, 0.32, 0.36), 0.05)
    dark_leaf = material("DarkLeaves", (0.07, 0.24, 0.08))
    palm_leaf = material("PalmLeaves", (0.2, 0.42, 0.12))
    runway_light = material("RunwayLight", (0.6, 0.85, 1.0), 0.3, emit=30)
    plaza = material("Plaza", (0.55, 0.5, 0.4), 0.85)  # sandstone plots
    for o in scene.objects:
        if o.name.endswith("_plot") and o.type == "MESH":
            o.data.materials.clear()
            o.data.materials.append(plaza)
    box((W * 4, H * 4, 0.2), (0, 0, -0.32), moss)
    box((W, H, 0.1), (0, 0, -0.25), grass)
    for x in xs:
        box((4, H, 0.04), (x, 0, -0.19), soil)
    for y in ys:
        box((W, 4, 0.04), (0, y, -0.19), soil)
    run_y = -H / 2 - 28
    box((W + 160, 30, 0.1), (0, run_y, -0.22), asphalt)
    edge_light = proto("RunwayLight", [
        part(bpy.ops.mesh.primitive_uv_sphere_add, runway_light, radius=0.3, location=(0, 0, 0.1)),
    ])
    for t in range(-int((W + 140) / 2), int((W + 140) / 2), 14):
        box((7, 0.5, 0.02), (t, run_y, -0.16), paint)
        for edge in (-15.5, 15.5):
            instance(edge_light, t, run_y + edge)
    box((W + 300, 26, 0.1), (0, H / 2 + 40, -0.28), water)
    # Jungle trees and palms: tall trunks with layered crowns.
    jungle = proto("JungleTree", [
        part(bpy.ops.mesh.primitive_cylinder_add, bark, radius=0.45, depth=12, location=(0, 0, 6)),
        part(bpy.ops.mesh.primitive_ico_sphere_add, dark_leaf, subdivisions=2, radius=4.5, location=(0, 0, 12.5)),
        part(bpy.ops.mesh.primitive_ico_sphere_add, leaf, subdivisions=2, radius=3.2, location=(2.2, 1.0, 10.5)),
    ])
    fronds = []
    for k in range(7):
        a = k / 7 * math.tau
        f = part(bpy.ops.mesh.primitive_cube_add, palm_leaf, size=1, location=(math.cos(a) * 2.2, math.sin(a) * 2.2, 8.6))
        f.scale = (4.4, 0.7, 0.05)
        f.rotation_euler = (0, math.radians(18), a)
        fronds.append(f)
    palm = proto("Palm", [
        part(bpy.ops.mesh.primitive_cylinder_add, bark, radius=0.22, depth=9, location=(0, 0, 4.5)),
        *fronds,
    ])
    placed = 0
    while placed < 520:
        x = rnd.uniform(-W * 1.4, W * 1.4)
        y = rnd.uniform(-H * 1.6, H * 1.6)
        if abs(x) < W / 2 + 6 and abs(y) < H / 2 + 6:
            continue  # the clearing
        if abs(y - run_y) < 22 and abs(x) < (W + 160) / 2 + 4:
            continue  # the runway
        if abs(y - (H / 2 + 40)) < 15:
            continue  # the river
        instance(jungle if rnd.random() < 0.65 else palm, x, y, rnd.uniform(0.8, 1.5), rnd.uniform(0, math.tau))
        placed += 1
    # Palms and lanterns along the clearing's paths.
    for x in xs:
        for t in range(-int(H / 2) + 25, int(H / 2) - 24, 12):
            instance(palm if (t // 12) % 2 else light_col, x + 3.2, t + 6, 0.7)
# Evening light: low warm sun, soft blue sky, Eevee with bloom and AO.
for o in scene.objects:
    if o.type == "LIGHT" and o.data.type == "SUN":
        o.data.energy = 4.0
        o.data.color = (1.0, 0.82, 0.62)
        o.data.angle = math.radians(3)
        o.rotation_euler = (math.radians(68), 0, math.radians(-50))
world = scene.world
sky = (0.42, 0.55, 0.78, 1) if THEME == "town" else (0.55, 0.62, 0.66, 1)  # humid haze
world.node_tree.nodes["Background"].inputs["Color"].default_value = sky
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
scene.render.resolution_percentage = 100

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
