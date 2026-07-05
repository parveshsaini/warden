# syntax=docker/dockerfile:1

FROM node:22-slim AS build
RUN npm install -g pnpm@11
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# node (non-root) still needs npm/npx available to spawn upstream MCP servers
# declared as `command: npx` in the config — the base image provides both.
USER node
EXPOSE 3000

# Mount your config at /app/warden.config.yaml (see examples/docker-compose.yaml).
CMD ["node", "dist/cli.js", "--http"]
