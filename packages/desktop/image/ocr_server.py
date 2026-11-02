"""Long-lived OCR worker for the desktop agent (one model load per desktop).
Protocol on stdin/stdout: a 4-byte big-endian length and a PNG; the reply is
one JSON line: [[x0, y0, x1, y1, text, confidence], ...] in image pixels."""
import json, os, struct, sys
import numpy as np, cv2
from rapidocr_onnxruntime import RapidOCR

# One desktop per CPU: a single inference thread avoids oversubscription.
threads = int(os.environ.get("OCR_THREADS", "1"))
engine = RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=threads)
inp, out = sys.stdin.buffer, sys.stdout
while True:
    head = inp.read(4)
    if len(head) < 4:
        break
    data = inp.read(struct.unpack(">I", head)[0])
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    result, _ = engine(image)
    lines = []
    for box, text, conf in result or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append([min(xs), min(ys), max(xs), max(ys), text, float(conf)])
    out.write(json.dumps(lines) + "\n")
    out.flush()
