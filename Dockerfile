# 基础镜像都固定到 digest（2026-11-01 从 Docker Hub 读到的多架构索引）；升级时 tag 和 digest 一起换。

# 构建 Next.js 前端产物。
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
# 「源代码」入口（AGPL 第 13 条）的地址和提交号在构建时写进前端，发版脚本用 --build-arg 传提交号。
ARG NEXT_PUBLIC_SOURCE_URL=/source/
ARG NEXT_PUBLIC_SOURCE_COMMIT=
ENV NEXT_PUBLIC_SOURCE_URL=$NEXT_PUBLIC_SOURCE_URL \
    NEXT_PUBLIC_SOURCE_COMMIT=$NEXT_PUBLIC_SOURCE_COMMIT
COPY web ./
# 直接 next build，不走 package.json 里的 build:bridge（ComfyUI Bridge 第一期已下线）。
RUN bunx next build

# 构建 Go 后端入口。
FROM golang:1.25.14-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS api-build

WORKDIR /app
COPY go.mod go.sum ./
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

# 运行镜像：Next.js 只监听 127.0.0.1:3000，Go 只监听 127.0.0.1:8080，由宿主机 Caddy 反代（compose 用 host 网络）。
FROM node:22.23.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=127.0.0.1
ENV PORT=3000
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
# 程序文件仍归 root；运行用户 node（uid 1000）只能写数据目录和 Next 缓存目录。
RUN mkdir -p /app/data/prompts /app/web/.next/cache && chown -R node:node /app/data /app/web/.next/cache

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# 先启动内部 Go API，再启动 Next.js 页面服务。
CMD ["/app/docker-entrypoint.sh"]
