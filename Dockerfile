# Build with: docker compose build
FROM oven/bun:1.4.0-alpine AS base
WORKDIR /app

# Cache dependencies separately so source edits do not reinstall packages.
FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun builds TypeScript without needing the development dependencies.
FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/package.json /app/bun.lock ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/tsconfig.json ./
# Keep sources for the existing database and command maintenance scripts.
COPY --from=build /app/src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY database ./database
# This public fallback CA is shared. Project-specific CAs are mounted at runtime.
COPY certs/supabase-root-2021.crt ./certs/supabase-root-2021.crt
USER bun
STOPSIGNAL SIGTERM
CMD ["bun", "dist/index.js"]
