"""Independent grader for the studio task: reads the saved file and measures
every build collection (Module, or P01..P16). Never reads the live session.
Usage: blender -b <file.blend> --python grade_module.py"""
import json

import bpy
import mathutils

out = {}
for col in bpy.data.collections:
    if col.name != "Module" and not (col.name.startswith("P") and col.name[1:].isdigit()):
        continue
    objs = [o for o in col.all_objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = -lo
    faces = 0
    mats = set()
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
        if o.type == "MESH":
            faces += len(o.data.polygons)
        mats.update(s.material.name for s in o.material_slots if s.material)
    out[col.name] = {
        "objects": len(objs),
        "faces": faces,
        "materials": len(mats),
        "min": [round(v, 2) for v in lo] if objs else None,
        "max": [round(v, 2) for v in hi] if objs else None,
    }
print("GRADE " + json.dumps(out))
