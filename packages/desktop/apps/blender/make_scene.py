"""Starting scene for the building task: one 1 m cube named Building with a
grey Facade material, the sidebar (N panel) and the material properties
open, and no splash screen."""
import math

import bpy
import mathutils

bpy.ops.wm.read_factory_settings(use_empty=False)
for o in list(bpy.data.objects):
    if o.type == "MESH":
        bpy.data.objects.remove(o)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
b = bpy.context.active_object
b.name = "Building"
m = bpy.data.materials.new("Facade")
m.use_nodes = True
m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
b.data.materials.append(m)
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == "VIEW_3D":
            space = area.spaces[0]
            space.show_region_ui = True
            # Look over the whole city grid; solid shading shows material colour.
            space.shading.color_type = "MATERIAL"
            view = space.region_3d
            view.view_location = (37.5, 37.5, 15)
            view.view_distance = 150
            view.view_rotation = mathutils.Euler(
                (math.radians(58), 0, math.radians(-35))
            ).to_quaternion()
        if area.type == "PROPERTIES":
            area.spaces[0].context = "MATERIAL"

prefs = bpy.context.preferences
prefs.view.show_splash = False
prefs.view.show_developer_ui = False
bpy.ops.wm.save_userpref()
bpy.ops.wm.save_as_mainfile(filepath="/opt/app/scene.blend")
