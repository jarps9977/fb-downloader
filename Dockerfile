FROM node:20-bookworm-slim

# ffmpeg merges DASH video and audio renditions without re-encoding.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
USER node

EXPOSE 3000
CMD ["node", "server.js"]
