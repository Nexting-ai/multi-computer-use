"""Independent grader: reads the saved scene file (never the live session).
Usage: blender -b /work/scene.blend --python grade.py"""
import bpy, json

def srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

o = bpy.data.objects.get("Building")
out = {"found": o is not None}
if o:
    m = o.active_material
    col = m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value if m else None
    out.update(
        dimensions=[round(v, 3) for v in o.dimensions],
        location=[round(v, 3) for v in o.location],
        color="".join(f"{round(srgb(v) * 255):02X}" for v in col[:3]) if col else None,
    )
print("GRADE " + json.dumps(out))
