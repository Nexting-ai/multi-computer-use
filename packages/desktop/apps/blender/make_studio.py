"""Starting scenes for the studio task (building one city block):
  studio.blend  one 20 x 20 m plot at the origin (one desktop per module)
  city.blend    sixteen plots P01..P16 on a 4 x 4 grid, 30 m apart (one desktop
                builds every module)
Each plot is a concrete slab with a kerb; builds go into the plot's collection
(Module, or P01..P16). Camera, sun, sky and a fast preview render are set; the
text editor holds module.py with the conventions."""
import math

import bpy
import mathutils

GRID, SPACING, PLOT = 4, 30.0, 20.0


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=False)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def material(name, rgb, rough=0.8):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def plot(name, cx, cy, slab):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(cx, cy, -0.1))
    o = bpy.context.active_object
    o.scale = (PLOT, PLOT, 0.2)
    o.name = f"{name}_plot"
    o.data.materials.append(slab)
    for c in o.users_collection:
        c.objects.unlink(o)
    bpy.context.scene.collection.objects.link(o)  # the plot is not part of the build
    return col


def environment(cx, cy, distance, height, aim, lens):
    scene = bpy.context.scene
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.5
    sun.rotation_euler = (math.radians(48), math.radians(8), math.radians(-35))
    scene.collection.objects.link(sun)
    scene.world = bpy.data.worlds.new("Sky")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.74, 0.9, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
    cam.location = (cx + distance, cy - distance, height)
    target = mathutils.Vector((cx, cy, aim))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False  # Debian builds lack OpenImageDenoise
    scene.render.resolution_x, scene.render.resolution_y = 960, 600
    scene.render.filepath = "/work/render.png"


def script(text):
    t = bpy.data.texts.new("module.py")
    t.write(text)


def ui():
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D":
                area.spaces[0].shading.color_type = "MATERIAL"
    prefs = bpy.context.preferences
    prefs.view.show_splash = False
    bpy.ops.wm.save_userpref()


slab = None
# One plot per desktop.
reset()
slab = material("Plot", (0.55, 0.55, 0.53))
plot("Module", 0, 0, slab)
environment(0, 0, 60, 50, 24, 30)  # frames a 60 m tower on its plot
script(
    "# Build the brief's building inside the collection 'Module'.\n"
    "# Plot: 20 x 20 m centred at the origin, ground at z = 0. Metres.\n"
    "# Run with Alt+P. Render a preview with F12; save with Ctrl+S.\n"
)
ui()
bpy.ops.wm.save_as_mainfile(filepath="/opt/app/studio.blend")

# Sixteen plots on one desktop.
reset()
slab = material("Plot", (0.55, 0.55, 0.53))
for i in range(GRID * GRID):
    cx = (i % GRID - (GRID - 1) / 2) * SPACING
    cy = ((GRID - 1) / 2 - i // GRID) * SPACING
    plot(f"P{i + 1:02d}", cx, cy, slab)
environment(0, 0, 150, 95, 25, 32)
script(
    "# Build each brief's building inside its plot's collection P01..P16.\n"
    "# Plots are 20 x 20 m on a 4 x 4 grid, 30 m apart; P01 is top-left,\n"
    "# P04 top-right, P16 bottom-right. Plot centre of Pn (n = 1..16):\n"
    "#   x = ((n - 1) % 4 - 1.5) * 30,  y = (1.5 - (n - 1) // 4) * 30\n"
    "# Ground at z = 0. Metres. Run with Alt+P. Render with F12; save with Ctrl+S.\n"
)
ui()
bpy.ops.wm.save_as_mainfile(filepath="/opt/app/city.blend")
