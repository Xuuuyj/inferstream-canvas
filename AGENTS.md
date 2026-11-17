# AGENTS.md

> 本站（canvas.openai.fit）交接总览在 `docs/fit/HANDOFF.md`（内部文档，不随源码包发布），接手先读它。

本文档用于约束本项目中的 AI / 自动化开发行为。开发时优先遵循本文件，其次遵循用户当前消息。

## 基本原则

- 先读现有代码，再动手修改，优先沿用项目已有结构和写法。
- 写代码保持最少行数，能简单实现就不要引入复杂抽象。
- 标准格式、协议、解析、压缩、加密、日期等通用能力优先使用成熟稳定的库，不要手写底层实现，除非用户明确要求或项目已有实现必须沿用。
- 不要为了“兼容更多场景”写大量分支，只实现当前明确需要的功能。
- 项目尚未上线，不需要兼容旧数据；表结构或字段调整时直接按新设计修改，不写旧字段兼容、数据迁移兜底或删除旧表的清理逻辑，除非用户明确要求。例外：画布 2026-11-02 已上线，浏览器里旧版存的那一把 openai.fit 令牌（`apiKey`）要迁移成手动令牌（`lib/fit-config.ts` 的 `migrateFitKeys`）。
- 每次写完代码，不需要检查语法，不需要执行构建，用户会自己做。
- 不要改无关文件，不要顺手重构。
- 任何文件编辑、改动、删除或格式化前，必须先询问用户是否允许；只有得到明确同意后才能修改。
- 如果工作区已有用户改动，不要回滚，不要覆盖；只在必要范围内追加修改。

## 反复提醒沉淀

- 如果开发过程中总是遇到某个问题，或者用户反复提醒同一个注意事项，需要把该注意事项补充到本文件。
- 补充时写成明确、可执行的规则，避免只写模糊描述。
- 新规则应放到最相关的章节；找不到合适章节时放到“项目注意事项”。

## 后端规范

- 后端使用 Go + Gin + GORM。
- `handler/` 只处理 HTTP 入参、调用 service、返回 `OK` / `Fail`。
- `service/` 放业务逻辑、默认值、校验、时间、ID、鉴权等处理。
- `repository/` 只做数据库访问和 GORM 查询。
- `model/` 只定义数据结构、枚举和简单模型方法。
- 列表接口优先沿用 `model.Query`、`Normalize`、分页和标签筛选方式。
- 业务接口保持 `{ code, data, msg }` 的响应结构。
- 新增数据表时同步更新 `docs/backend/backend-database.md`。

## 前端规范

- 前端使用 Next.js App Router、React、TypeScript、Ant Design、Tailwind、Zustand。
- 编写 Ant Design 相关代码时，参考 https://ant.design/llms-full.txt 理解组件 API、示例和设计规范，并优先结合项目当前 antd 版本与既有写法。
- API 请求统一放在 `web/src/services/api/`。
- 全局或跨页面状态优先放在 `web/src/stores/`。
- 已经放在全局 store 或全局 hook 中的状态/动作，组件需要时直接使用对应 store/hook，不要为了“纯组件”层层透传 props；避免一个组件传递过多参数。
- 全局组件、全局常量、全局配置等全局性质的内容不要作为 props 或参数层层传递；哪里需要就在哪里直接从对应全局入口获取。
- 多个页面重复出现的 UI 副作用动作，例如复制文本并提示、下载并提示、统一确认弹窗，优先抽成 `web/src/hooks/` 下的全局 hook；不要放进 store，除非它确实是需要共享/订阅的状态。
- 画布相关状态和组件放在 `web/src/app/(user)/canvas/` 内部。
- 页面里只有一个主业务组件时直接写在 `page.tsx`，不要单独拆 `Manager` 组件再传一堆 props。
- 不要新增只做简单转发的组件，例如只 `return <X>{children}</X>` 或只换个名字透传 props；直接在使用处使用真实组件或把逻辑写进当前文件。
- 页面私有 hook 放在对应页面目录下，例如 `admin/assets/use-admin-assets.ts`；只有多个页面真实复用的 hook 才放到外层 `hooks/`。
- 管理后台页面私有组件放到各自页面目录的 `components/` 下，例如 `admin/assets/components/`、`admin/prompts/components/`；不要为了单页面使用放到 `admin/components/` 共享目录。
- 管理后台主题、背景、卡片阴影、表格配色等统一在 `web/src/lib/app-theme.ts`、`AppProviders` 或必要的全局 CSS 作用域中配置；页面私有组件不要自己写 `dark ? ...` 主题分支。
- 组件优先使用函数组件和现有 hooks，不新增大型状态管理方案。
- UI 图标优先使用 `lucide-react` 或项目已经使用的 Ant Design 图标。
- 页面文案保持中文。
- 不要在组件里堆太多无关逻辑；复杂逻辑优先抽成同目录工具函数或小组件。
- 样式优先由组件自己管理；组件私有样式优先使用 Tailwind className 或少量内联 style，不要为单个组件新增大量全局 CSS。
- 全局 CSS 只放基础变量、全局重置、跨页面通用样式和少量第三方组件必要覆盖；不要在 `globals.css` 堆页面私有样式。
- 代码尽量短小直接，少拆不必要组件，少做多层 props 传递，避免为了抽象堆出更多代码。
- 前端业务数据需要浏览器本地持久化时，默认使用 `localforage`；`localStorage` 只用于极小的简单配置，不要用来保存业务列表、生成记录、图片、base64 或大 JSON。

## 画布 UI 规范

- 做 canvas 前端 UI 时必须遵循当前画布主题。
- 优先使用 `canvasThemes`、`useThemeStore` 或 Ant Design `ConfigProvider` token。
- 不要硬编码黑白、stone、slate 等颜色导致浅色/深色主题不一致。
- 新增画布按钮、弹窗、浮层时，尽量复用已有工具栏、节点面板、Modal 的视觉风格。
- 画布顶部工具栏和状态信息优先采用极简扁平风格：无边框、无阴影、无胶囊背景，融入整体背景，弱化按钮感，仅保留轻微 hover 反馈，保持简洁现代、低视觉重量。
- 图片节点尺寸逻辑要尊重原始比例，除非功能明确要求自由变形。
- 批量生成、多图展示、助手面板等画布交互要尽量简洁，不要占用过多画布空间。

## 文档规范

- README 保持简洁，只放项目介绍、核心功能、快速开始和文档入口。
- `docs/index.md` 放给 AI 使用的文档索引，不要再放到 `docs/` 内容目录里。
- 详细功能介绍写到 `docs/overview/features.md`。
- 后续待办写到 `docs/progress/todo.md`。
- 已实现但还需要用户测试确认的事项写到 `docs/progress/pending-test.md`。
- `docs/progress/pending-test.md` 用来记录这个版本实际做了哪些可测试变更；`CHANGELOG.md` 的 `Unreleased` 只保留对这些变更的版本级归纳，避免逐条照搬实现细节。
- 每次 todo 事项完成后，先从 `docs/progress/todo.md` 移到 `docs/progress/pending-test.md`，不要直接写进正式功能说明；用户确认测试通过后再更新 `docs/overview/features.md`。
- 每次任务完成前，都要根据实际变更检查并更新 `docs/progress/todo.md` 和 `docs/progress/pending-test.md`；如果功能或待办没有变化，也要确认无需修改。
- 接口响应规则写到 `docs/backend/api-response.md`。
- 数据库结构写到 `docs/backend/backend-database.md`。
- 文档不要写过期日期；除非用户明确要求记录具体时间。

## 发版本流程

- 发版本时，先把 `CHANGELOG.md` 的 `Unreleased` 变更整理成新的版本记录，并保留空的 `Unreleased` 标题。
- 按当前版本号提升一个版本，更新根目录 `VERSION`。
- 将当前未提交的代码全部提交到 Git。
- 提交完成后，给当前提交打最新版本号对应的 tag，例如 `v0.0.5`。
- 发版本流程中不要执行编译、测试或构建，除非用户明确要求。

## 项目注意事项

- 未登录时画布项目和“我的素材”保存在浏览器本地；登录且账号同步可用时会同步保存到账号/云端，文档中不要忽略未登录本地保存场景。第一期服务器不存媒体（不开服务端对象存储）：生成的图片、视频、音频只保存在用户浏览器里，换设备或清缓存会丢，文档和界面说明不要承诺云端保存媒体。
- 用户的 openai.fit 令牌只存在浏览器 localStorage，只发往 https://openai.fit；画布服务器不保存令牌，账号同步的模型配置在上传前和服务端存库前都会剔除令牌、渠道和地址；涉及安全说明时要写清楚。
- 「用 openai.fit 登录」走 openai.fit 桥接页：画布页面在需要时（画布要登录、三把令牌没选全、设置弹窗开着、刚去 openai.fit 登录还没回来；`/admin` 和点过「退出登录」后不挂）放一个隐藏 iframe `https://openai.fit/canvas/bridge`，只收 origin 是 `https://openai.fit`、source 是这个 iframe 的消息，发消息的 targetOrigin 写死 `https://openai.fit`（协议见 `web/src/lib/fit-bridge.ts`，和 fit 的 `controller/canvas_bridge.js` 逐字一致）。桥接页给的一次性登录码带 state 和 PKCE（verifier 只在内存里），画布后端只拿 code 加 verifier 去 openai.fit 换身份，不经手令牌，换取接口也不返回令牌。令牌是桥接页取的（记着 `fitAccount`）时，每次打开页面挂一下桥接页发 `ping`（只看 fit 登录提示 cookie、不发 fit 请求），fit 退出了就清掉这三把（手动令牌不动），每 12 小时用一次 hello 核对 fit 账号；fit 换了人时原账号的令牌马上清掉，改用新账号的令牌和画布账号必须先弹窗问；静默登录画布前本机有没同步过这个 fit 账号的画布项目也先问（`asksBeforeProjectSync`）。这几处不要改成静默。
- 画布同源的任何脚本（页面上的 XSS、`/director` 的构建产物、依赖包）都能驱动桥接页，用户在 fit 登录着时能经它取到用户令牌的完整 key、新建令牌（fit 按用户限额，见 fit 仓库 docs/canvas-bridge.md）。所以画布源上不能引入不受控的第三方脚本，换 `/director` 产物、加依赖都按「能拿到访客全部 fit 令牌」审。
- 令牌分三把：视频（含上传参考素材、轮询、下载成片）、图片、文本（含语音），存在 `fitKeys` 的三个槽位（槽位里的密钥字段也叫 `apiKey`），另有手动令牌 `fitManualKey`（填了三类都用它）和 `fitAccount`（令牌属于哪个 fit 用户）。这些都只存浏览器、永不上传（前端 `SYNC_SECRET_KEYS`、后端 `modelConfigSecretKeys` 都剔除）。发请求一律按模型类型取令牌（`fitKeyFor` / `fitKeyForModel`，渠道里不存令牌）；视频任务记下提交时用的是哪把（`fitKeyRef`，是令牌 id 不是密钥），轮询、下载用同一把。
- Docker 静态资源路径目前仍是待办项，文档中不要过度承诺生产部署已经完全验证。
- 内网地址和内部 Gitea 仓库的地址只写在不进源码包的文件里（`deploy/private/`、`docs/fit/PLAN.md`、`docs/progress/*`，见 `.gitattributes` 的 export-ignore）；进源码包的文件（包括 `deploy/` 下的文档、本文件、README）只写「内部 Gitea 仓库，地址见 deploy/private/README.md」。发版时源码包闸门会拦 `192.168.*` 这类地址。
- 3D 导演台业主 2026-11-02 开放（`web/src/constant/features.ts` 的 `DIRECTOR_ENABLED=true`，Caddy 不拦 /director）。要关就两边一起改：开关改 false，并在 `deploy/Caddyfile` 加 `@director` 回 404。`web/public/director/` 只有上游构建产物，换新产物时先跑 `features.test.ts` 的外部地址名单（它和画布同源，能读到浏览器里的令牌）。
- `web/src/lib/fit-generate/` 下除 `shims/`、`__tests__/` 外是 openai.fit 在线生成台的同步副本（含模型选择器用的价格提示 `components/`、模型广场价格库 `pricing/` 和币种格式化 `shared/`，价格一律用它们算，不在画布另写），禁止手改、不要格式化；fit 契约变了用 `cd web && bun run sync:fit --repo <线上源码提交的干净检出>` 更新，发版前跑 `FIT_REPO=<fit 仓库> bun run check:fit`（不带 FIT_REPO 只核对哈希，不算数；release.py 设了 FIT_REPO 时会自己跑，不通过就拒绝）。同步时按内部词表 `deploy/private/source-redactions.json`（不进源码包）删注释、改标识符名，sync:fit 和 check:fit 都需要这份词表；词表改了要重新 sync:fit。
