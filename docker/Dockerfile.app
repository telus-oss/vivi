FROM oven/bun:1.3.12-debian AS build

WORKDIR /app

# Install dependencies first (cacheable layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build frontend
COPY . .
RUN bun run build

# --- Production image ---
FROM oven/bun:1.3.12-debian

# Docker CLI is needed to manage sandbox containers and compose services
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built app from build stage
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/docker ./docker
COPY --from=build /app/docker-compose.yml ./docker-compose.yml

# Config dir — secrets.json, allowlist.json, git-policy.json are created at runtime
RUN mkdir -p /app/config

# Data directory for SQLite, staging files, sockets
RUN mkdir -p /app/data

EXPOSE 7700

ENV PORT=7700
ENV HOST=0.0.0.0

CMD ["bun", "run", "server/index.ts"]
