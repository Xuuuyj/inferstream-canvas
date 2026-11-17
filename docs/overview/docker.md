---
title: Docker 部署
description: 使用 Docker Compose 部署无限画布（canvas.openai.fit）
---

# Docker 部署

canvas.openai.fit 的镜像只在服务器上用发版源码包构建，完整步骤见 `deploy/server-setup.md`（新服务器准备）和 `deploy/RELEASING.md`（发版、回滚）。镜像构建和容器验收还没在服务器上实测过。

## 生产形态（docker-compose.yml）

线上只用 `python -I deploy/release.py` 发版，步骤和回滚见 [deploy/RELEASING.md](../../deploy/RELEASING.md)。发版脚本用要发的那个提交的 git archive 源码包在服务器上构建镜像，同一个包放到 `/source/` 供下载；不要在 git 检出里直接 `docker compose build` 上线，那样镜像可能带着没提交的改动，「源代码」入口也对不上正在运行的版本。

- 只用本机构建的镜像 `fit-canvas:${CANVAS_TAG:-local}`（`pull_policy: never`），不会拉取别人发布的镜像。
- host 网络：前端只监听 `127.0.0.1:3000`，后端只监听 `127.0.0.1:8080`，对外由宿主机 Caddy 反代（`/api/*` 转后端，其余转前端，见 `deploy/Caddyfile`）。
- 容器以 node 用户（uid 1000）运行，宿主机的 `./data` 要先归 1000:1000，否则启动时直接退出并提示。
- `.env` 按 `.env.example` 的生产段填写：`APP_ENV=production`、`PUBLIC_HOST`、`SERVER_PUBLIC_IPS`、强 `JWT_SECRET`，管理员用户名不能是 admin、密码至少 16 位。配置不合要求时容器以非 0 退出。

## 本地构建（开发）

```bash
cp .env.example .env   # 取消 .env 末尾「本机开发」段的注释
docker compose -f docker-compose.local.yml up -d --build
```

启动后访问 `http://localhost:3000`，管理员账号是「本机开发」段里的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。

想在 Linux 本机试一下生产形态（host 网络，只听 127.0.0.1，不对外，只用于开发验证）：

```bash
cp .env.example .env   # 把生产段每个 <…> 换成测试用的值
sudo install -d -o 1000 -g 1000 data
NEXT_PUBLIC_SOURCE_COMMIT=$(git rev-parse HEAD) docker compose build
docker compose up -d
```

## 数据目录

`./data` 挂载到容器内 `/app/data`，保存 SQLite 数据库和提示词数据。第一期服务器不存媒体：生成的图片、视频、音频只保存在用户浏览器里。

Docker 部署时建议把 `.env` 中的 SQLite 路径设置为：

```text
DATABASE_DSN=/app/data/infinite-canvas.db
```
