"""Server-side image step for Visitor Recognizer.

Reads one image from stdin. argv[1] is the model path, argv[2] a JSON options object:
  {"zones": [[{"x":0..1,"y":0..1}, ...], ...],  # Ring privacy zones: blacked out before anything else
   "embed": true|false,                           # compute face templates (only with recognition consent)
   "maxFaces": 5}
Prints JSON: {"decodable": bool, "maskedJpeg": base64 | null, "faces": [{"box": [x,y,w,h], "embedding": [...]|null}]}
Nothing is written to disk and no network access is made.
"""
import base64
import io
import json
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

model_path = sys.argv[1]
opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
data = sys.stdin.buffer.read()

try:
    image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")  # phone photos carry rotation in EXIF
except Exception:
    print(json.dumps({"decodable": False, "maskedJpeg": None, "faces": []}))
    sys.exit(0)

rgb = np.array(image)
h, w = rgb.shape[:2]
for zone in opts.get("zones") or []:
    pts = np.array([[int(float(p.get("x", 0)) * w), int(float(p.get("y", 0)) * h)] for p in zone], dtype=np.int32)
    if len(pts) >= 3:
        cv2.fillPoly(rgb, [pts], (0, 0, 0))

ok, jpeg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [int(cv2.IMWRITE_JPEG_QUALITY), 85])
masked_b64 = base64.b64encode(jpeg.tobytes()).decode("ascii") if ok else None

gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
boxes = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
boxes = sorted([tuple(int(v) for v in b) for b in boxes], key=lambda b: b[2] * b[3], reverse=True)
# Haar cascades produce small false positives (e.g. in clothing or background); ignore detections far smaller
# than the main face.
if boxes:
    boxes = [b for b in boxes if b[2] >= 0.25 * boxes[0][2]]
boxes = boxes[: int(opts.get("maxFaces", 5))]

faces = []
interpreter = None
if opts.get("embed") and boxes:
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=model_path)
    interpreter.allocate_tensors()

pil = Image.fromarray(rgb)
for (x, y, bw, bh) in boxes:
    embedding = None
    if interpreter is not None:
        mx, my = int(bw * 0.2), int(bh * 0.2)
        crop = pil.crop((max(0, x - mx), max(0, y - my), min(w, x + bw + mx), min(h, y + bh + my)))
        face = np.asarray(crop.resize((112, 112), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
        nchw = np.transpose(face, (2, 0, 1))[np.newaxis, ...]
        for detail in interpreter.get_input_details():
            interpreter.set_tensor(detail["index"], nchw)
        interpreter.invoke()
        out = interpreter.get_tensor(interpreter.get_output_details()[0]["index"])
        embedding = np.asarray(out[0], dtype=np.float32).tolist()
    faces.append({"box": [x, y, bw, bh], "embedding": embedding})

print(json.dumps({"decodable": True, "maskedJpeg": masked_b64, "faces": faces}))
