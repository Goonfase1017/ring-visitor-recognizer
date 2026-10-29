FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-dev ffmpeg curl && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir ai-edge-litert pillow numpy opencv-python-headless \
    && mkdir -p /app/data /app/public/snapshots
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/model ./model
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 3000
CMD ["node", "dist/index.js"]
