FROM node:26-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
WORKDIR /app
# Python runtime for the server-side image step (OpenCV face detector + bundled MobileFaceNet model).
# Versions are pinned: OpenCV 5 removed the Haar face detector this app uses.
COPY scripts/requirements.txt /tmp/requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip curl && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --break-system-packages --no-cache-dir -r /tmp/requirements.txt \
    && mkdir -p /app/data && chown -R node:node /app/data
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY model ./model
COPY scripts ./scripts
COPY public ./public
COPY views ./views
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
