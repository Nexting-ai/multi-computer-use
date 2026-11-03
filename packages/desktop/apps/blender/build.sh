# Build-time: the task's starting scene and the user preferences.
set -e
blender -b --factory-startup --python /opt/app/make_scene.py
blender -b --factory-startup --python /opt/app/make_studio.py
