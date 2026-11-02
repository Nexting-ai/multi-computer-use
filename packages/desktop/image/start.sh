#!/bin/bash
# Start the display, then the application, then the agent (foreground).
set -euo pipefail
mkdir -p /work
# A restarted container keeps /tmp: clear the previous display's lock.
rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}"
Xvfb "$DISPLAY" -screen 0 "${SCREEN}x24" -nolisten tcp +extension GLX >/tmp/xvfb.log 2>&1 &
for _ in $(seq 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
# A window manager, as on any desktop: title bars, dialog focus and stacking.
openbox --config-file /opt/desktop/openbox.xml >/tmp/wm.log 2>&1 &
sleep 0.5
bash /opt/app/start.sh
exec node --import tsx /opt/desktop/src/agent.ts
