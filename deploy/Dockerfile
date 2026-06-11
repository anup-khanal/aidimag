# aidimag sync server — container image
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist ./dist

# Persistent volume mount point for the sync database
VOLUME /data
ENV AIDIMAG_SYNC_TOKEN=""
EXPOSE 8787

CMD ["node", "dist/cli/index.js", "serve", "--db", "/data/sync.db", "--port", "8787"]

