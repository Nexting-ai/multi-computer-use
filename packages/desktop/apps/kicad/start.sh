#!/bin/bash
# A fresh copy of the starting board per desktop; the task saves over it.
set -e
[ -f /work/badge.kicad_pcb ] || cp /opt/app/badge.kicad_pcb /work/badge.kicad_pcb
nohup pcbnew /work/badge.kicad_pcb >/tmp/app.log 2>&1 &
for _ in $(seq 300); do
  xdotool search --name "badge" >/dev/null 2>&1 && break
  sleep 0.2
done
