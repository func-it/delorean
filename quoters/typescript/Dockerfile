# syntax=docker/dockerfile:1
# The TypeScript implementation of the API: Node runs the sources as they are
# (type stripping, no build step), on the production dependencies only, as a
# numeric non-root user. Built from the repository's root, for the shared prompts:
#   docker build -f quoters/typescript/Dockerfile -t delorean-typescript .
#   docker run -p 24793:24793 -e OPENROUTER_API_KEY delorean-typescript
#   docker run -p 24793:24793 -e ENGINES=fake delorean-typescript
#   docker run delorean-typescript version

# Dependencies, cached apart from the sources.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /app
COPY quoters/typescript/package.json quoters/typescript/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
ENV NODE_ENV=production PORT=24793 ENGINES=live PROMPTS_DIR=/app/prompts
COPY --from=deps /app/node_modules ./node_modules
COPY quoters/typescript/package.json ./
COPY quoters/typescript/src ./src
COPY prompts/guard.json prompts/parse.json prompts/parse-films.json prompts/identify.json prompts/judge.json ./prompts/
ARG VERSION=dev
ENV DELOREAN_VERSION=${VERSION}
EXPOSE 24793
USER 65532:65532
ENTRYPOINT ["node", "src/main.ts"]
CMD ["serve"]
