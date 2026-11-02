"""Independent grader: reads the saved board file (never the live session)
and runs KiCad's design rule check on it.
Usage: python3 grade.py /work/badge.kicad_pcb"""
import json, subprocess, sys, tempfile
import pcbnew

path = sys.argv[1]
board = pcbnew.LoadBoard(path)
texts = [t.GetText() for t in board.GetDrawings() if isinstance(t, pcbnew.PCB_TEXT)]
with tempfile.NamedTemporaryFile(suffix=".json") as f:
    subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "-o", f.name, path],
                   check=False, capture_output=True)
    try:
        report = json.load(open(f.name))
        violations = len(report.get("violations", [])) + len(report.get("unconnected_items", []))
    except Exception:
        violations = None
print("GRADE " + json.dumps({"texts": texts, "drc_violations": violations}))
