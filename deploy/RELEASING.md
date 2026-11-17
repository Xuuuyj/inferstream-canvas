# canvas.openai.fit 发版

服务器第一次准备见 [server-setup.md](server-setup.md)。本文件和 `deploy/` 下的其他文件都会随源码包公开，不要写密钥、密码和业主 IP。

## 版本号和名字

| 东西 | 例子 | 说明 |
|---|---|---|
| `VERSION` | `v0.8.3-fit.1` | 本站版本号带 `-fit.N` 后缀 |
| git 标签 | `fit-v0.8.3-fit.1` | 按 AGENTS.md「发版本流程」打 |
| 镜像标签 | `v0.8.3-fit.1-a8401c6` | `VERSION` 加 7 位提交号，release.py 自动生成 |
| 源码包 | `infinite-canvas-v0.8.3-fit.1-a8401c6.tar.gz` | 对外地址 `https://canvas.openai.fit/source/` |

## 发版前

1. 自审这次要发的 diff。
2. 跑测试：`go test ./...`；改过的 web 测试 `cd web && bun test <文件>`；`cd web && bunx tsc --noEmit -p .` 的错误数不超过基线、新文件 0 错误；改过 `deploy/` 的脚本就在仓库根目录跑 `python -I -B -m unittest discover -s deploy -p "test_*.py"`（`-B` 不留 `__pycache__`，否则工作区变脏、发版被拒）。
   - fit 生成库副本必须带上 fit 仓库核对：`cd web && FIT_REPO=<fit 仓库> bun run check:fit`（PowerShell 写成 `$env:FIT_REPO='<fit 仓库>'; bun run check:fit`）。它按 `SOURCE.json` 记的提交号读 fit 源文件、脱敏重新生成后逐字节比对。不带 `FIT_REPO` 只核对 `SOURCE.json` 里的哈希，手改副本再把哈希一起改掉就能通过，不能当发版前的核对。
   - 运行 release.py 时设好 `FIT_REPO`，它会自己先跑一次 `check:fit`，不通过就拒绝（`--dry-run` 只警告）；没设只打印提醒。它核对的是本机工作区里的副本，`--ref` 指别的提交时要自己确认。
3. 按 AGENTS.md「发版本流程」整理 `CHANGELOG.md`、改 `VERSION`、提交、打标签。
4. 推到内部 Gitea 仓库（远程名 `gitea`，地址见 `deploy/private/README.md`）：`git push gitea openai-fit --tags`。本机还没有这个远程（例如从内部 Gitea 新克隆的检出，远程默认叫 `origin`）时，照 `deploy/private/README.md` 先 `git remote add gitea <地址>`；内部仓库的地址只记在那个文件里（export-ignore），不进源码包。`origin` 是上游 GitHub，只用来拉更新，先执行一次 `git remote set-url --push origin DISABLED`，防止推错。
5. 工作区要干净。源码包和镜像只来自 `--ref` 指定的提交（默认 HEAD），没提交的改动发不出去；release.py 见到未提交的改动就拒绝，确实要带着它们发（例如只是本机的临时文件）加 `--allow-dirty`。

## 命令

在仓库根目录、用系统 Python 运行（要装 paramiko：`python -m pip install paramiko`）。一定加 `-I`；脚本自己把输出改成 UTF-8，所以 Windows 控制台打印中文不会崩。

```text
python -I deploy/release.py --dry-run          只打印计划和要在服务器上跑的命令，不连服务器（git 核对和源码包闸门只警告）
python -I deploy/release.py --package-only     只在本地打源码包，核对 COMMIT，过源码包闸门
python -I deploy/release.py                    发 HEAD；--ref <提交> 发别的提交
python -I deploy/release.py --switch <镜像标签> 切到服务器上已有的镜像和它那一版的 compose（回滚）
python -I deploy/release.py --caddy            把该提交里的 deploy/Caddyfile 校验后装到服务器并 reload
```

每个命令都可以先加 `--dry-run` 看一遍：只打印计划、不连服务器，下面第 1、2 步的核对不过也只警告。发版和 `--package-only` 的 `--dry-run` 会在本机临时目录打一次源码包来过闸门，扫完就删。

登录信息在 `~/.config/openai-fit/canvas-server/access.json`（环境变量 `CANVAS_SERVER_ACCESS` 可改；不进 git，字段见 server-setup.md 第 4 节）。脚本只读 host、port、user、key_file、known_hosts，不打印它们的值；host 不是 154.64.250.21 时拒绝执行。

两个放行开关，只在确实需要时加：

| 开关 | 放行什么 |
|---|---|
| `--allow-dirty` | 工作区有未提交的改动 |
| `--allow-older` | 线上在跑的提交不是这次提交的祖先（有意发旧提交，例如不用 `--switch`、从旧提交重新构建） |

## release.py 做了什么

1. 核对 git：工作区干净；本机配了远程 `gitea`，`git fetch gitea openai-fit` 成功，并且要发的提交已经在 `gitea/openai-fit` 上（内部 Gitea 查得到发出去的源码）。没配远程、Gitea 仓库还没建、连不上或者没推送，都拒绝发版，原因取 git 报错里 `fatal:` 开头的那一行。`--caddy` 也做这一步。发版和 `--package-only` 接着在设了 `FIT_REPO` 时跑 `bun run check:fit`（见「发版前」第 2 步）。
2. 本地 `git archive` 打源码包，核对包里 `COMMIT` 等于提交号。打包时用 `-c core.autocrlf=false -c core.eol=lf` 关掉换行转换，包里的内容和仓库里一字不差：Windows 上 `core.autocrlf=true` 时直接 `git archive` 会把 Dockerfile、Caddyfile、`*.py` 等转成 CRLF（`*.sh` 由 `.gitattributes` 固定为 LF），`deploy/test_release.py` 的 PackageLineEndingTest 会查这一点。`COMMIT` 和 `.gitattributes` 里的 `COMMIT export-subst` 没提交时，这一步会拒绝。然后过源码包闸门（`deploy/source_gate.py`，见下面「源码」一节）：报出问题就逐条列出、删掉这个包并拒绝，还没连服务器。`--package-only` 也过这道闸门。
3. 连服务器（只认 known_hosts 里固定的主机密钥），检查 `/opt/canvas/.env`、`/opt/canvas/data` 归 uid 1000、`docker compose` 可用。
4. 读线上在跑的版本：`.env` 里的 `CANVAS_TAG`，以及这个镜像的 `org.opencontainers.image.revision` 标签（读不到时用镜像标签末尾的 7 位提交号）。线上提交不是这次提交的祖先就拒绝，免得把线上已有的改动退掉；本地找不到线上提交，或者有 `CANVAS_TAG` 却取不到提交号（手工构建的标签、镜像上也没有 revision 标签），没法核对，同样拒绝。这几种都可以用 `--allow-older` 放行。
5. 上传源码包，核对 sha256，解压到 `/srv/canvas/build/<镜像标签>`，用它 `docker build`，并通过 `--build-arg NEXT_PUBLIC_SOURCE_COMMIT` 把提交号写进前端。同一标签的镜像已存在时跳过构建。
6. 源码包放进 `/srv/canvas/source/`，重写 `SHA256SUMS`；源码包里的 `docker-compose.yml` 存成 `/opt/canvas/compose/<镜像标签>.yml`，`deploy/backup.sh`、`deploy/disk-check.sh`（磁盘告警，见 server-setup.md 第 8 节）装到 `/opt/canvas/bin/`。
7. 切换：线上那一版的 compose 还没存档时，先把现在的 `/opt/canvas/docker-compose.yml` 存成 `compose/<线上标签>.yml`；再把 `compose/<新标签>.yml` 装成 `docker-compose.yml`，把 `.env` 里的 `CANVAS_TAG` 改成新标签，执行 `docker compose up -d`。
   目标镜像或 `compose/<新标签>.yml` 不在服务器上时，第 7 步在改动任何东西之前就停下（`--switch` 到一个已经清掉的标签就是这样），不做健康检查也不切回。
8. 健康检查：`127.0.0.1:8080/api/health` 回 `ok`，`127.0.0.1:3000` 能打开，跑着的确实是新镜像，最多等 120 秒。切换中途出错或健康检查不通过，就按第 7 步的做法连 compose 一起切回上一版，切回成功再对上一版做一次健康检查，然后以失败退出。提示分开说两步各自的结果：新版是「切换的过程中出错」还是「没有通过健康检查」；切回是「已切回，上一版健康检查通过」「已切回，但上一版也没通过健康检查」「切回失败，没有切回去」还是「切回的过程中出错」。后三种要马上人工处理。
9. 经 Caddy 访问 `/api/health` 和新源码包，只提示不拦（首发时 Caddy 还是占位站）。
10. 写发版记录 `/opt/canvas/releases.tsv`（UTC 时间、镜像标签、提交、源码包 sha256、上一版、结果）。失败时结果是 `FAILED not-switched`（切换前就停下，什么都没改）、`FAILED`（没有上一版可切）、`FAILED rolled-back`、`FAILED rollback-unhealthy` 或 `FAILED rollback-failed`（切回这一步本身失败）。
11. `fit-canvas` 镜像只留最近 3 个，当前和上一版总是保留，删掉的镜像连同它的 compose 存档一起删；清掉悬空层和 7 天前的构建缓存。

服务器上的文件：

| 路径 | 内容 |
|---|---|
| `/opt/canvas/.env` | 环境变量，0600，手工维护；只有 `CANVAS_TAG` 一行由 release.py 改 |
| `/opt/canvas/docker-compose.yml` | 正在跑的那一版的 compose，切换时从 `compose/` 装过来 |
| `/opt/canvas/compose/<镜像标签>.yml` | 每一版的 compose 存档（来自那一版的源码包） |
| `/opt/canvas/bin/backup.sh`、`disk-check.sh` | 每次发版从源码包更新 |
| `/opt/canvas/data/` | SQLite 数据库，归 uid 1000 |
| `/opt/canvas/releases.tsv` | 发版记录 |
| `/srv/canvas/source/` | 对外的 `/source/`：每个版本的源码包和 `SHA256SUMS` |
| `/srv/canvas/build/` | 构建临时目录，构建完就删 |
| `/etc/caddy/Caddyfile` | 本仓库的 `deploy/Caddyfile`（`--caddy` 安装，旧的留成 `Caddyfile.bak-<时间>`） |
| `/etc/caddy/canvas-admin-ips.caddy` | 后台 IP 白名单，只在服务器上 |

## 回滚

- 程序：`python -I deploy/release.py --switch <镜像标签>`，连同那一版的 compose 一起切回去，切完同样做健康检查，不过就再切回原来那一版。可用的标签看 `releases.tsv` 或 `docker image ls fit-canvas`（只留最近 3 个）。
- 手工做法：`cd /opt/canvas && install -m 0644 compose/<镜像标签>.yml docker-compose.yml`，改 `.env` 的 `CANVAS_TAG`，再 `docker compose up -d`。
- 数据库：程序启动时只会自动加表、加列。回滚前先看新版本有没有改表结构，改过的话先用备份演练一遍（见 server-setup.md 第 7 节）。
- Caddy：`cp -p /etc/caddy/Caddyfile.bak-<时间> /etc/caddy/Caddyfile && systemctl reload caddy`。新旧配置的管理地址不同时（例如退回到没有 `admin unix//run/caddy/admin.sock` 那行的版本）reload 会失败，改用 `systemctl restart caddy`。

## 源码（AGPL 第 13 条）

- 页面上的「源代码」入口都指向 `/source/`，Caddy 直接提供 `/srv/canvas/source/`。源码包就是提交的 `git archive`，镜像也是用同一个包构建的；包里的 `COMMIT` 文件是提交号。
- 正在运行的版本和可能回滚到的版本，它们的源码包都不要删；旧包每个十几 MB，默认全部保留。
- 除了 `.gitattributes` 里标了 `export-ignore` 的内部文档（`docs/fit/` 下的计划和验收清单、`docs/progress/` 的待办和待测清单），提交进仓库的东西（包括 `deploy/`）都会随源码包公开。新加内部文档要同样标上 `export-ignore`；源码和公开文档里不写供货方名字、渠道号、本机路径和内网地址。
- 源码包闸门：release.py 打好源码包后、连服务器之前，用 `deploy/source_gate.py` 按词表扫描整个包（词表在 `deploy/private/`，不进源码包，用法和词表格式见 `source_gate.py` 开头），命中就拒绝发版。`web/src/lib/fit-generate/` 同步副本在 `sync:fit` 时已按同一份词表删掉注释、改掉标识符名，同步结果还有命中会拒绝同步；副本禁止手改，要从 fit 那边改好再 `sync:fit`。新接供货方、下游客户或服务器时，先把名字加进词表，再重新 `sync:fit`（词表改了 `check:fit` 会要求重新同步）。可以先 `python -I deploy/release.py --package-only --dry-run` 看会命中什么。
- 3D 导演台已对外提供，源码包里只有上游的构建产物 `web/public/director/`（没有可修改的源代码），说明见 `MODIFICATIONS.md`；拿到作者源码后补进源码包。

## CSP（内容安全策略）

- 现在用 `Content-Security-Policy-Report-Only`，只报告不拦截。没有配上报地址，违规只出现在浏览器开发者工具的控制台（带 `[Report Only]`）。
- 上线后一周内，用 Chrome 和 Firefox 把主要流程各走一遍（首页、画布出图和出视频、播放成片、Codex 连接、后台、3D 导演台），看控制台。需要放行的来源补进 `deploy/Caddyfile`，提交后 `release.py --caddy`。
- 没有误报后，把 `deploy/Caddyfile` 里的 `Content-Security-Policy-Report-Only` 改成 `Content-Security-Policy`，提交，`release.py --caddy`。
- `connect-src` 里的 `https://fadacai-openai-fit.oss-cn-shenzhen.aliyuncs.com`：fit 的成片签名链接是 openai.fit 上的 `/v1/tasks/<任务>/artifacts/<名字>/content?access=…`，浏览器访问时会 302 到这个 OSS 桶的签名地址。fit 换桶、换地域或加 CDN 时，这里要跟着改。

## 成片签名链接和日志

- 浏览器先直接访问 openai.fit 和 fit 存成片的 OSS，不经过画布服务器。
- 直连失败或返回的不是 2xx 时，已登录用户会把原地址交给同源的 `/api/proxy-image?url=` 再取一次；这次请求带的是画布的登录令牌，不带 openai.fit 令牌。未登录用户不走代理，提示登录后再导入。这是对原计划的改动（原计划是签名链接一律不交给画布服务器）：成片的 `/content` 会 302 到 OSS 的签名地址，fit 的 OSS 桶没加跨域规则时浏览器读不到内容，截帧、下载和拿成片当参考素材都会失败。图片按地址导入和画布图片缩略图（`image-storage.ts` 的 `uploadImage`、`ensureImagePreview`）对 fit 的地址也是这样先直连、再走代理。
- 所以 fit 成片的签名链接（带 `access=`，单独就能看那条成片）会经过画布服务器。代理只转发、不存文件；会记下请求地址的三处日志都去掉了这些查询参数：
  - Go 的访问日志（也就是 `docker compose logs`）只记路径、不记查询串（`router/router.go`）。
  - Caddy 访问日志 `/var/log/caddy/canvas-access.log` 删掉 `url`、`access` 以及 `apiKey`、`apikey`、`key` 参数（`deploy/Caddyfile` 站点里的 `log` 段）。
  - Caddy 默认日志删掉同样的参数（`deploy/Caddyfile` 全局块的 `log default`）。它是 caddy.service 的 stderr，进 journald（Ubuntu 默认存盘在 `/var/log/journal`）。后端连不上时（发版时 `docker compose up -d` 重建容器、Go 挂掉）的错误日志，和客户端在代理途中断开时（关页面、取消下载）reverse_proxy 的警告，都带着请求地址，站点 `log` 段的过滤器管不到它们。
  - 例外：gin.Recovery 遇到 broken pipe 一类的网络错误 panic 时会打印带查询串的请求行（`APP_ENV=dev` 时其他 panic 也会），项目里没有会这样 panic 的代码。
- 改这几处日志的配置时要保持这一点；装上新的 Caddyfile 后按 server-setup.md 第 9 节在服务器上查一次日志里有没有签名链接（`access=` 或转义后的 `access%3D`）。
- 代理只连 80 和 443 端口（`service/ssrf.go` 的 `proxyStreamDialContext`，重定向过去的也算），fit 和它的 OSS 都是 443；别的端口直接 502、不建立连接，免得被人拿来探测端口。
- fit 的 OSS 桶加了允许 GET 的跨域规则之后，直连就能成功，基本不再走代理。

## 发版后

按 server-setup.md 第 9 节的冒烟检查走一遍（只读，不发生成请求）。
