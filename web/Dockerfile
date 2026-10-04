# syntax=docker/dockerfile:1

# Dependencies, cached apart from the sources.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# The contract types are committed (src/generated): the build needs nothing outside web/.
FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# The standalone server only (postbuild copies the static assets into it): no npm, no sources.
FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=24790 \
    HOSTNAME=0.0.0.0
# Owned by the unprivileged `node` user: Next writes its fetch cache under .next/cache.
COPY --from=build --chown=node:node /app/.next/standalone ./
# The daily budget's total (BUDGET_FILE): a volume mounted here starts out owned by `node`.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 24790
CMD ["node", "server.js"]
