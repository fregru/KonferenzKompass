FROM oven/bun:1-alpine
WORKDIR /app
ENV TZ=Europe/Berlin NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public
COPY tsconfig.json ./
# The app only writes to data/ (database, uploads, imports); everything else stays root-owned and read-only.
RUN mkdir -p data && chown bun:bun data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["bun", "run", "src/index.ts"]
