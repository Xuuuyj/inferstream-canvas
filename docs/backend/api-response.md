---
title: 接口响应约定
description: 业务接口统一响应结构与前端处理约定
---

# 接口响应约定

后端业务接口统一返回 JSON：

```json
{
  "code": 0,
  "data": {},
  "msg": "ok"
}
```

- `code`: 业务状态码，`0` 表示成功，非 `0` 表示失败。
- `data`: 业务数据。失败时通常为 `null`。
- `msg`: 响应消息。成功默认为 `ok`，失败时放错误原因。

前端请求逻辑以 `code` 判断业务是否成功。当前后端业务失败也会返回 HTTP 200，前端不要只依赖 HTTP 状态码判断结果。

接口连接失败、服务不可达、返回体不是约定 JSON 时，前端按网络或接口异常处理。

## 用 openai.fit 登录

- `POST /api/auth/fit/login`，请求体 `{ code, codeVerifier, state }`：`code` 是页面里隐藏的 openai.fit 桥接页（`https://openai.fit/canvas/bridge`）发的一次性登录码（43 位 base64url，60 秒内有效、只能用一次），`state` 和 `codeVerifier` 是画布浏览器在内存里生成的随机串（43–128 位 base64url，hello 消息里只带 state 和 S256 challenge）。三项只经过 postMessage 和这个请求体，令牌不发给这个接口。
- 后端带 `X-Canvas-Connect-Secret`（`FIT_CONNECT_SECRET`）请求 openai.fit 的 `POST /api/canvas/exchange`，换回 `{ user_id, username, display_name }`（openai.fit 不返回令牌），按 `users.fit_user_id` 找到或新建画布账号。不跟随跳转，10 秒超时；日志不记授权码、verifier、state、密钥和响应体。
- 成功返回和密码登录一样的 `{ token, user }`。失败沿用 `Fail`（HTTP 200、`code` 非 0），`msg` 是给用户看的原因：未配置密钥「openai.fit 登录未开启」；参数格式不对「登录请求无效…」；openai.fit 回 400「openai.fit 授权已失效（可能已用过或超时）…」、401/503「openai.fit 登录暂不可用…」、403「openai.fit 账号已被禁用」、429「登录太频繁，请稍后再试」，连不上、超时、5xx 或跳转「连接 openai.fit 失败，请稍后重试」；画布账号被禁用「账号已被禁用」，关联的是管理员账号「请从后台登录」。
- 按 IP 每分钟 10 次（超了 429），请求体上限 4KB；不受「是否开放注册」和每 IP 每日注册上限约束（身份来自 openai.fit）。
- 登录、`/api/auth/me` 返回的 `user` 里，用 openai.fit 登录建的账号多一个 `fitUserId`（关联的 openai.fit 用户 ID，不是秘密；前端用它判断 openai.fit 那边换了人时画布账号要不要跟着换）；用户名密码账号没有这个字段。

## openai.fit 公开目录

- `GET /api/fit/catalog` 的 `data.pricing[]` 每项有 `model_name`、`supported_endpoint_types`、`tags`、`billing_usage_schema`、`enable_groups` 五个字段（上游没有时为 null），原样取自 openai.fit 的 `/api/pricing`。`enable_groups` 是能用这个模型的令牌分组，画布按它估计用户每个令牌分组里有多少视频、图片、文本模型，给三把令牌自动预选和「一键新建」选分组；拿到令牌后以 `/v1/models` 为准。
- 每项还原样带上 fit 价格库算价格读的计价字段 `quota_type`、`model_ratio`、`completion_ratio`、`model_price`、`billing_mode`、`billing_expr`、`billing_usage_examples`、`billing_plugin_variants`（上游没有就不输出）；`billing_plugin_variants` 每项只留 `billing_expr`、`billing_mode`、`billing_usage_schema`、`billing_usage_examples`，插件名、插件 key、图标不转发。`description` 等其他字段不转发。
- `data.groupRatio` 是 `/api/pricing` 顶层的 `group_ratio`（各分组倍率）；`data.status` 只有 openai.fit `/api/status` 里的 `price`、`usd_exchange_rate`、`quota_display_type`、`display_in_currency`、`quota_per_unit`、`custom_currency_symbol`、`custom_currency_exchange_rate`（fit 前端显示价格读的币种设置），其余字段不转发。三处上游（价目表、能力目录、status）有一处失败就算这次刷新失败，按上面的规则回旧数据（`stale=true`）或报错。

## AutoDL 渠道

- `POST /api/ai/autodl/workflows` 使用上述业务响应结构。请求为 `{ baseUrl, workflowId? }`，不传上游 API Key；不带工作流 ID 返回列表，带 ID 返回详情。元数据包含 `uuid`、`name`、`kind` 和详情的 `input_rules`，不返回上游内部节点映射。
- AutoDL 视频继续使用现有 `/api/v1/videos` 创建、查询及任务响应结构。
- `/api/v1/audio/speech` 是 AI 协议代理入口。AutoDL 成功时返回 `{ provider: "autodl", audio_url, mime_type }`；MiniMax 和 TokenDance MiniMax 成功时解码上游 hex，并返回所选格式的音频二进制；失败仍使用现有 `Fail` 业务结构。其他语音协议的响应保持原样。
- 现有 `/api/v1/canvas/audio-tasks` 消费 AutoDL 的上游音频 URL，返回既有任务结构，不新增结果下载或转存。

## 渠道自定传参转译

- 沿用 `/api/v1/images/generations`、`/api/v1/images/edits`、`/api/v1/audio/speech`、`/api/v1/videos` 及现有画布任务入口。命中自定义的账号请求携带 `{ model, n, _parameterTranslation: { kind, variables } }`；视频另携带面板 `seconds`，沿用现有按秒费用计算。`kind` 为 `image`、`video`、`audio`。
- `_parameterTranslation` 是系统内部负载。后端按账号或公共渠道读取保存的原文，转译后只向供应商发送配置里的方法、地址、请求头、查询参数和请求体。
- 图片 JSON 结果归一为 `{ data: [{ url }] }`；音频 URL 归一为 `{ provider: "parameter-translation", audio_url }`。配置直接返回文件时沿用二进制响应及 MIME。失败仍用现有 `Fail` 业务结构。
- 视频沿用现有任务响应，增加 `parameter_translation: true` 标记；私有查询快照和公共渠道脚本不随响应返回。创建、查询、完成和失败均进入现有任务管理，失败不重发默认请求。
