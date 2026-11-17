#!/bin/sh
set -eu

# 镜像以 node 用户（uid 1000）运行；宿主机挂进来的 data 目录不归它时 SQLite 只会报看不懂的错，这里先说清楚。
if [ ! -w /app/data ]; then
  echo "/app/data 不可写：宿主机的 data 目录要归 uid 1000（容器里的 node 用户），例如 sudo chown -R 1000:1000 data" >&2
  exit 1
fi

# 两个进程都只监听本机，线上由宿主机 Caddy 反代（/api/* 直达 Go，其余给 Next）；.env 里的 BIND_ADDR、PORT 在容器里不生效。
# 只有 docker-compose.local.yml（APP_ENV=dev，靠端口映射访问）让前端监听 0.0.0.0。
WEB_HOST=127.0.0.1
if [ "${APP_ENV:-production}" = "dev" ]; then
  WEB_HOST=0.0.0.0
fi

BIND_ADDR=127.0.0.1 PORT=8080 /app/server &
API_PID=$!

cd /app/web
HOSTNAME="$WEB_HOST" PORT=3000 node server.js &
WEB_PID=$!

shutdown() {
  trap - INT TERM
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
  exit 0
}

trap shutdown INT TERM

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
wait "$API_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true
exit 1
