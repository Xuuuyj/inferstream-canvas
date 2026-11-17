# 修改声明

## InferStream 修改（2026-11-16）

[InferStream 无限画布](https://canvas.inferstream.cn/) 基于下述 openai.fit 修改版。此版本替换了站点名称、标识、标签页图标、公告和推广链接，并从首页下架了 openai.fit 推广素材。

## openai.fit 修改记录

本仓库是无限画布（infinite-canvas）的修改版，用于 openai.fit 运营的 canvas.openai.fit。按 AGPL-3.0 第 5 条的要求，在这里说明修改情况。

## 基本信息

- 上游项目：[tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas)，前作 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)、[HuFakai/infinite-canvas](https://github.com/HuFakai/infinite-canvas)。
- 上游基线：tigerowo/infinite-canvas 的提交 `f5d5a86`（v0.8.3，feat(audio): support MiniMax TTS）。2026-11-17 合并上游 v0.8.4（提交 `786b3b2`），未带入其中的「匿名公网上传」。
- 修改方：openai.fit。
- 修改日期：2026-11-01 起；本站版本号带 `-fit` 后缀，首个版本为 `v0.8.3-fit.1`。
- 许可证：沿用 AGPL-3.0，见 [LICENSE](LICENSE)，未做任何改动。上游和前作的版权声明、作者署名全部保留；页面上保留「无限画布」名称和上游署名。

## 主要改动

- **只接 openai.fit**：模型渠道收敛为一条 openai.fit 渠道。用户的 openai.fit 令牌只保存在浏览器里，由浏览器直接请求 https://openai.fit；画布服务器不保存、不经手令牌，原来替用户调用模型的后端路由全部下线。模型列表按令牌可用的模型和 openai.fit 公开目录（后端新增的只读镜像 `/api/fit/catalog`）自动分类。
- **用 openai.fit 账号自动登录**：画布页面在需要时加载一个隐藏的 openai.fit 桥接页（`https://openai.fit/canvas/bridge`，只和 `https://canvas.openai.fit` 互发 postMessage）。用户已登录 openai.fit 时，桥接页列出用户自己的令牌（不含密钥）、按需取回完整令牌或新建「无限画布-视频/图片/文本」令牌，并给一次性登录码（带 state 和 PKCE S256）；画布后端只拿登录码和 verifier，用共享密钥（`FIT_CONNECT_SECRET`）向 openai.fit 换回用户身份，按 openai.fit 用户找到或自动新建画布账号（后端接口 `/api/auth/fit/login`，用户表新增 `fit_user_id`）。令牌只存进浏览器，视频、图片、文本三类请求分别用各自的令牌；原有的用户名密码登录和手动填写令牌保留。openai.fit 退出后画布清掉自动取的令牌；openai.fit 换了账号、或自动登录会把本机画布项目同步进账号时先弹窗征求同意。
- **下线的功能**：云端渠道、算力点、TokenDance、RunningHub / ComfyUI 工作流、AI 起草工作流、传参翻译、Linux.do 登录、服务端后台出图、用户自带对象存储（S3 / WebDAV）、版本检查和版本更新弹窗（页面上不再显示版本号，也不去 GitHub 读上游的版本号和更新日志）。
- **图片和视频请求**：请求体改由 openai.fit 在线生成台的同一套纯函数生成。`web/scripts/sync-fit-generate.ts` 把 openai.fit 所用的 new-api 修改版里这些文件同步到 `web/src/lib/fit-generate/`，同步时替换导入路径、删掉原文件版权头以外的注释、个别局部标识符改名，程序逻辑和发出的请求体与原文件一致，同步结果禁止手改。这些文件同为 AGPL-3.0，原文件带的版权头（Copyright (C) 2023-2026 QuantumNous）原样保留，来源提交和每个文件的哈希记在 `SOURCE.json`。画布的参数面板、生成前校验、参考素材托管（openai.fit 的 /v1/uploads）、成片下载和出图都按这套契约改写；成片和生成的图片只保存在用户浏览器里。
- **模型价格**：模型选择器显示 openai.fit 模型的价格。同一个同步脚本把 openai.fit 在线生成台的价格提示组件、模型广场的价格计算库和币种格式化也同步到 `web/src/lib/fit-generate/`（`components/`、`pricing/`、`shared/`，处理方式同上），i18n、站点配置 store 和样式工具换成 `shims/` 下的手写垫片；`/api/fit/catalog` 多转发 openai.fit 公开价目表里的计价字段和 `/api/status` 里的币种设置。
- **语音**：只走 OpenAI 标准的 `/v1/audio/speech`，不再按模型名走 MiniMax、MiMo、GLM、Gemini、AutoDL 的私有请求。
- **部署**：Dockerfile 去掉 ComfyUI Bridge 编译阶段，改为非 root 运行、只监听本机、带健康检查；docker-compose 只用本机构建的镜像；新增 `deploy/`（Caddy 配置、发版和回滚脚本、加密备份、磁盘告警）和 `COMMIT` 文件（源码包里写入真实提交号）；删除上游的 GitHub 镜像发布、npm 发布工作流和 `render.yaml`。
- **安全加固**：图片代理只放行图片和音视频、限制大小并拦截跨站盗链；登录、注册、上传等接口加限流和请求体上限，每个 IP 每 24 小时注册的账号数有上限；图片代理只连 80 和 443 端口；注册校验用户名和密码长度；生产环境遇到弱密钥或默认管理员配置拒绝启动；账号同步的模型配置不再保存令牌和渠道；普通用户不能发布公开工作流；提示词库默认不再自动同步。
- **推广位**：顶部公告、首页轮播和首页按钮换成 openai.fit 自家内容；删除原有赞助商、微信群、打赏和第三方推广链接。首页的 Agent、全景图功能演示暂时沿用上游作者 CDN 上的固定版本文件（含 3D 导演台）。
- **品牌**：网页标题、站点图标和 logo 换成 openai.fit 的 F\ 标。
- **源码入口**：顶栏、画布工具栏、后台页头的「源代码」入口，首页和登录页底部的署名小字，都指向本站 `/source/` 提供的源码包。
- **Codex 连接入口**：本地 Agent 的启动命令锁定 `@tigerowo/canvas-agent` 的固定版本，并加上 openai.fit Codex 一键安装包的下载入口。
- **文档**：README 删除赞助商、微信群、下载和广告招商等内容，自动配置地址改为 canvas.openai.fit；商务合作改为 openai.fit 的联系方式；开源协议补充源码获取方式。
- **提示词库封面**：同步来源图床（GitHub、推特、YouMind 等）上的封面，列表接口换成本站地址 `/api/prompts/<id>/cover`，由服务器经图片代理同样的安全拨号取回一次、存在 `PROMPT_COVER_DIR`（默认 `data/prompt-covers`），以后从本地提供；取不到的 6 小时内不再重试，前端显示占位图；封面图改为滚到才加载。

后续版本的改动随发版补充到本文件和 `CHANGELOG.md`。

## 尚不完整的部分

- **3D 导演台**：`web/public/director/` 目前只有上游提供的构建产物，没有可修改的源代码；本站原样提供这份构建产物（源码包里也是它）。源码待上游作者提供后补进源码包。

## InferStream 单点登录（2026-11-16）

添加中转站一次性授权码登录、独立用户映射与本地项目同步确认。

## InferStream 设置界面（2026-11-16）

在 InferStream 登录模式下显示账号信息并停用旧版令牌桥接及导入入口，更新设置和工作台提示。

## InferStream 设置界面（2026-11-16）

在 InferStream 登录模式下显示账号信息并停用旧版令牌桥接及导入入口，更新设置和工作台提示。

## InferStream 生图（2026-11-16）

增加 InferStream API Token 校验、会话级令牌存储和 gpt-image-2 生图及参考图编辑。转发配置见 deploy/inferstream-edge.Caddyfile。

## InferStream 设置界面（2026-11-16）

在 InferStream 登录模式下显示账号信息并停用旧版令牌桥接及导入入口，更新设置和工作台提示。

## InferStream 生图配置校验修复（2026-11-16）

生图工作台和画布节点使用已验证的 InferStream Token 判断是否可以生成。

## InferStream 设置界面（2026-11-16）

在 InferStream 登录模式下显示账号信息并停用旧版令牌桥接及导入入口，更新设置和工作台提示。

## InferStream 登录页（2026-11-17）

画布公开登录页仅保留 InferStream 单点登录入口。

## InferStream 设置界面（2026-11-16）

在 InferStream 登录模式下显示账号信息并停用旧版令牌桥接及导入入口，更新设置和工作台提示。

## InferStream 生图设置（2026-11-17）

令牌按账号保存在当前浏览器，完成设置时验证待保存的令牌，模型选择器使用 InferStream 生图渠道。

## InferStream 视频生成与 Key 选择（2026-11-17）

InferStream 登录模式下支持视频生成（seedance-2.0-mini，文生视频）：经 /inferstream/v1/videos 调网关的 OpenAI videos 接口，成片下载后存在浏览器里。生图、视频各用一把 InferStream API Key，可以在设置里从 InferStream 账号导入自己已建的 Key（登录后缺哪项自动导入一把），也可以手动粘贴。转发配置见 deploy/inferstream-edge.Caddyfile。

## InferStream 视频参考图（2026-11-17）

InferStream 视频支持连入的参考图和首帧：画布把图片读成 data URL，按 Seedance 的 content 列表发给网关，由网关托管到上游后提交；提示词里的 @图片N 换成 @图N。

## 局部编辑遮罩图（2026-11-17）

局部编辑时把带蓝色遮罩的参考图存进图片存储并写入节点的生成记录（`maskEdit`），结果节点的参考栏显示这张图，提示词面板隐藏固定前缀并折叠成标签；重试时补回前缀。
