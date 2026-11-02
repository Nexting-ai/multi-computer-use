# One desktop: an X display, one application, and the agent that owns both.
# Build context: packages/desktop.  docker build -f image/Dockerfile --build-arg APP=blender .
FROM node:24-bookworm-slim
ARG APP
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11-utils xdotool imagemagick openbox python3-venv libglib2.0-0 libgl1 \
      libgl1-mesa-dri fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# OCR: PP-OCR models on ONNX Runtime (CPU).
RUN python3 -m venv /opt/ocr && /opt/ocr/bin/pip install --no-cache-dir -q \
      rapidocr-onnxruntime==1.4.4 onnxruntime==1.31.1 opencv-python==5.0.0.93 numpy==2.4.6
COPY apps/${APP}/install.sh /opt/app/install.sh
RUN bash /opt/app/install.sh
WORKDIR /opt/desktop
RUN npm init -y >/dev/null && npm install --no-audit --no-fund sharp@0.35.5 tsx@4.23.15 >/dev/null
COPY src ./src
COPY image/start.sh image/ocr_server.py image/openbox.xml ./
COPY apps/${APP} /opt/app
RUN if [ -f /opt/app/build.sh ]; then bash /opt/app/build.sh; fi
ENV SCREEN=1600x1000 DISPLAY=:0 AGENT_PORT=7000 LIBGL_ALWAYS_SOFTWARE=1 UI_SCALE=1.25
EXPOSE 7000
ENTRYPOINT ["bash", "/opt/desktop/start.sh"]
