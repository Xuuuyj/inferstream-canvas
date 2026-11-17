---
title: 快速开始
description: 用最少步骤把无限画布跑起来
---

# 快速开始

## 本地启动

先复制配置并取消 `.env` 末尾「本机开发」段的注释（它把 `APP_ENV` 设成 `dev`，并把生产段的占位符换成开发值）：

```bash
cp .env.example .env
```

用 Docker 本地构建：

```bash
docker compose -f docker-compose.local.yml up -d --build
```

或者不用 Docker：

```bash
go run .

# 另开一个终端窗口
cd web
bun install
bun run dev
```

启动后访问 `http://localhost:3000`。正式部署见 [Docker 部署](docker.md)。

## 首次使用

- 打开右上角设置，填入 openai.fit 令牌（可点「去 openai.fit 选令牌」），再点「验证并同步模型」；也可以从 openai.fit 令牌列表点「聊天 → 无限画布」直接带入。
- 模型列表按令牌能用的模型和 openai.fit 公开目录自动同步，图片和视频的参数按 openai.fit 卡片显示。
- 需要提示词仓库内容时，管理员可进入 `/admin/prompts` 手动同步。

## 说明

- 未登录时画布项目和「我的素材」保存在浏览器本地；登录且账号同步可用时会同步保存到账号。生成的图片、视频、音频只保存在浏览器里，换设备或清缓存会丢，要及时下载。
- openai.fit 令牌只存在浏览器 localStorage，生成请求由浏览器直接发往 https://openai.fit；画布服务器不保存令牌。
