# 走得到：单镜像同时托管 Web 与 API（apps/server 在 8787 端口提供 /api 与构建好的 Web）。
#   docker build -t zoudedao .
#   docker run --rm -p 8787:8787 zoudedao            # 未配置 Key：样例回放模式
#   docker run --rm -p 8787:8787 --env-file .env.local zoudedao
# 浏览器端 AK 由 Vite 在构建时写入前端代码（它本来就会下发到浏览器，靠 Referer 白名单保护）：
#   docker build --build-arg VITE_BAIDU_BROWSER_AK=... -t zoudedao .
# 访问 Docker Hub 或 npm 较慢时，可换成镜像源（内容与官方相同）：
#   docker build --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-slim \
#                --build-arg NPM_REGISTRY=https://registry.npmmirror.com/ -t zoudedao .

ARG NODE_IMAGE=node:24-slim

# ---- build: install from the lockfile, build core/baidu/server/web, prune the server to prod deps
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    npm_config_registry=${NPM_REGISTRY}
RUN corepack enable
WORKDIR /repo

# Fetch every package in the lockfile first, so this layer survives source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

ARG VITE_BAIDU_BROWSER_AK=
RUN pnpm --filter "@zoudedao/server..." --filter "@zoudedao/web..." run build
# Standalone server: dist + production node_modules, workspace packages (core, baidu) copied in.
RUN pnpm --filter @zoudedao/server deploy --prod --legacy /out/server

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="zoudedao" \
      org.opencontainers.image.description="走得到：15 分钟生活圈智能体检与规划助手" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    ZDD_SAMPLES_DIR=/app/data/samples \
    ZDD_OFFICIAL_DIR=/app/data/official \
    ZDD_WEB_DIST=/app/apps/web/dist \
    BAIDU_CACHE_PATH=/app/data/cache/baidu.sqlite
WORKDIR /app

# Code and data stay root-owned and read-only for the app user; only the cache is writable.
COPY --from=build /out/server ./apps/server
COPY --from=build /repo/apps/web/dist ./apps/web/dist
COPY --from=build /repo/data/samples ./data/samples
COPY --from=build /repo/data/official ./data/official
RUN mkdir -p data/cache && chown node:node data/cache

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/server/dist/index.js"]
