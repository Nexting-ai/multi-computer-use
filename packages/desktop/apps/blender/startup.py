"""Interactive start: UI scale, the Scripting workspace, module.py in the
text editor. Applied once the window exists."""
import os

import bpy


def arrange():
    window = bpy.context.window_manager.windows[0]
    space = bpy.data.workspaces.get("Scripting")
    if space and os.environ.get("BLENDER_WORKSPACE") == "Scripting":
        window.workspace = space
        # The window switches screens on the next redraw: edit the
        # workspace's own screen.
        for area in space.screens[0].areas:
            if area.type == "TEXT_EDITOR":
                area.spaces[0].text = bpy.data.texts.get("module.py")
                area.spaces[0].show_line_numbers = True
                area.spaces[0].top = 0
    return None


bpy.context.preferences.view.ui_scale = float(os.environ.get("UI_SCALE", "1.0"))
bpy.app.timers.register(arrange, first_interval=1.0)
