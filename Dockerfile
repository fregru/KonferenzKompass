FROM oven/bun:1-alpine
WORKDIR /app
ENV TZ=Europe/Berlin NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public
COPY tsconfig.json ./
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
