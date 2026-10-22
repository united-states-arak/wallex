# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.3.4

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-slim
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA} \
    STARCOACH_MODE=paper
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# bunfig.toml is not copied: its only entry is the [test] preload for `bun test`, which no runtime command reads.
COPY package.json tsconfig.json ./
COPY src ./src
COPY config ./config
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh \
 && mkdir -p state logs data control \
 && chown -R bun:bun /app/state /app/logs /app/data /app/control
USER bun
VOLUME ["/app/state", "/app/logs", "/app/data", "/app/control"]
EXPOSE 9464 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["bun", "docker/healthcheck.ts"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["daemon"]
