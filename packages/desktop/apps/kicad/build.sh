# Build-time: the starting board and a first-run-free KiCad configuration.
set -e
python3 /opt/app/make_board.py /opt/app/badge.kicad_pcb
mkdir -p /root/.config/kicad/9.0
cp /opt/app/fp-lib-table /opt/app/sym-lib-table /root/.config/kicad/9.0/
