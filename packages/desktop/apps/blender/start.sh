#!/bin/bash
# A fresh copy of the starting scene per desktop; the task saves over it.
set -e
# Keep saved work across a container restart.
# SCENE: scene (building schedule), studio (one plot) or city (sixteen plots).
SCENE="${SCENE:-scene}"
[ -f "/work/$SCENE.blend" ] || cp "/opt/app/$SCENE.blend" "/work/$SCENE.blend"
[ "$SCENE" = scene ] || export BLENDER_WORKSPACE=Scripting
read -r W H <<<"$(echo "$SCREEN" | tr x ' ')"
nohup blender "/work/$SCENE.blend" --window-geometry 0 0 "$W" "$H" \
  --python /opt/app/startup.py \
  >/tmp/app.log 2>&1 &
for _ in $(seq 150); do
  xdotool search --name "Blender" >/dev/null 2>&1 && break
  sleep 0.2
done
sleep 3
