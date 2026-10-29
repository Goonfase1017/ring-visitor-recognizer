import io
import json
import sys
import urllib.request

import numpy as np
from PIL import Image
import cv2
from ai_edge_litert.interpreter import Interpreter

image_url = sys.argv[1]
model_path = sys.argv[2]

with urllib.request.urlopen(image_url, timeout=30) as response:
    image = Image.open(io.BytesIO(response.read())).convert("RGB")
gray = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2GRAY)
cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
face_cascade = cv2.CascadeClassifier(cascade_path)
faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(60, 60))
if len(faces) == 0:
    print(json.dumps({"faceDetected": False, "embedding": None}))
    sys.exit(0)

x, y, width, height = max(faces, key=lambda box: box[2] * box[3])
margin_x = int(width * 0.20)
margin_y = int(height * 0.20)
x1 = max(0, x - margin_x)
y1 = max(0, y - margin_y)
x2 = min(image.width, x + width + margin_x)
y2 = min(image.height, y + height + margin_y)
face_image = image.crop((x1, y1, x2, y2)).resize((112, 112), Image.Resampling.BILINEAR)
rgb = np.asarray(face_image, dtype=np.float32) / 255.0
nchw = np.transpose(rgb, (2, 0, 1))[np.newaxis, ...]

interpreter = Interpreter(model_path=model_path)
interpreter.allocate_tensors()
input_details = interpreter.get_input_details()
for detail in input_details:
    interpreter.set_tensor(detail["index"], nchw)
interpreter.invoke()

output_detail = interpreter.get_output_details()[0]
embeddings = interpreter.get_tensor(output_detail["index"])
embedding = np.asarray(embeddings[0], dtype=np.float32)
print(json.dumps({
    "faceDetected": True,
    "faceBox": [int(x), int(y), int(width), int(height)],
    "embedding": embedding.tolist()
}))
