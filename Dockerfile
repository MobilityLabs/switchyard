# node:24-slim ships npm 11 — the lockfile is written by npm 11 and npm 10 can't resolve it
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

RUN mkdir -p /data

ENV NODE_ENV=production
ENV SWITCHYARD_DB=/data/switchyard.db
ENV PORT=3300
EXPOSE 3300

CMD ["npx", "tsx", "src/server.ts"]
