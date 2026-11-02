#!/bin/bash
# A fresh copy of the starting scene per desktop; the task saves over it.
set -e
# Keep saved work across a container restart.
[ -f /work/scene.blend ] || cp /opt/app/scene.blend /work/scene.blend
read -r W H <<<"$(echo "$SCREEN" | tr x ' ')"
nohup blender /work/scene.blend --window-geometry 0 0 "$W" "$H" \
  --python-expr "import bpy; bpy.context.preferences.view.ui_scale = ${UI_SCALE:-1.0}" \
  >/tmp/app.log 2>&1 &
for _ in $(seq 150); do
  xdotool search --name "Blender" >/dev/null 2>&1 && break
  sleep 0.2
done
sleep 3
