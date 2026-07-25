# node:24-slim ships npm 11 — the lockfile is written by npm 11 and npm 10 can't resolve it
FROM node:24-slim
WORKDIR /app

# Phase 2 (affirmation relay): ssh-keygen -Y verify is the signature verifier —
# node:24-slim does not ship openssh-client, and without it every signed
# affirmation 500s by design (a verifier that fails open is worse than none).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY ui ./ui
RUN npx vite build --config ui/vite.config.ts

RUN mkdir -p /data

ENV NODE_ENV=production
ENV SWITCHYARD_DB=/data/switchyard.db
ENV ATTACHMENTS_DIR=/data/attachments
ENV PORT=3300
EXPOSE 3300

CMD ["npx", "tsx", "src/server.ts"]
