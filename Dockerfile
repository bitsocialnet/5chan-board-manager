# ---- Builder stage ----
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild

COPY src/ src/
COPY bin/ bin/
COPY scripts/ scripts/
COPY tsconfig.json ./

RUN npm run build

# ---- Production dependencies ----
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends tini git ca-certificates nano && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1001 5chan && \
    useradd --uid 1001 --gid 5chan --shell /bin/bash --create-home 5chan

WORKDIR /app

COPY --from=deps /app/node_modules/ node_modules/
COPY --from=builder /app/dist/ dist/
COPY package.json ./
COPY bin/ bin/
RUN chmod +x bin/run.js bin/docker-entrypoint.sh
RUN ln -s /app/bin/run.js /usr/local/bin/5chan

RUN mkdir -p /data && chown -R 5chan:5chan /data /app

USER 5chan

ENV XDG_DATA_HOME=/data
ENV XDG_CONFIG_HOME=/data
ENV XDG_STATE_HOME=/data
ENV EDITOR=nano

VOLUME ["/data"]

ENTRYPOINT ["tini", "--", "/app/bin/docker-entrypoint.sh"]
CMD ["5chan", "start"]
