# canvas.openai.fit 服务器准备（一次性）

以下每一步都要业主授权后再做。本文件随源码包公开，不写白名单 IP、密钥和密码。日常发版见 [RELEASING.md](RELEASING.md)。

## 现状（已经做好的）

- 154.64.250.21：Ubuntu 24.04，8 vCPU、15 GiB 内存、155 GB 硬盘。
- SSH 只允许密钥登录；ufw 只放行 22、80、443；fail2ban 已装。
- Caddy 2.11（官方 apt 源）。`/etc/caddy/Caddyfile` 现在是 canvas.openai.fit 的占位站（根目录 `/srv/canvas/placeholder`），Let's Encrypt 证书已签好，说明 DNS 已经指到这台机器。
- 2026-11-01 按第 1、2 节做完：
  - Docker 29.9.2、docker compose v5.6.1、sqlite3、age、rclone 1.60.1。
  - caddy.service 已加 `RuntimeDirectory=caddy` 的 drop-in（`/run/caddy` 要等 Caddy 下次启动才建出来，第一次 `--caddy` 会 restart）。
  - `/opt/canvas` 等目录已建，`/opt/canvas/data` 归 1000:1000。
  - 已加 4G swap。
- 还没做：`/opt/canvas/.env`（第 2 节的表）、后台白名单（第 3 节）、首发（第 5 节）、备份（第 7 节，等业主给 age 公钥和 RAM 子账号）、监控和磁盘告警（第 8 节）。

SSH 先留在 22 端口，不按计划换：已经只认密钥、fail2ban 封爆破来源，换端口只能少一些日志里的扫描记录，不增加实际的安全性，却要多改防火墙、fail2ban 和登录信息。以后要换，按第 1 节最后一条做。

下面的命令都以 root 执行。

## 1. 补装软件

已做（见上面「现状」）。命令留着，重建服务器时照做。

```bash
apt-get update
apt-get install -y unattended-upgrades sqlite3 age rclone curl
systemctl status unattended-upgrades --no-pager   # 确认自动安全更新在跑

# Docker 官方源：docker-ce、buildx、compose 插件
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Caddy 管理接口只开 unix socket（deploy/Caddyfile 顶部的 admin unix//run/caddy/admin.sock）。
# 让 systemd 启动 Caddy 时建好 /run/caddy（归 caddy:caddy，停止时删掉），caddy 用户才能在里面建 socket。
install -d /etc/systemd/system/caddy.service.d
printf '[Service]\nRuntimeDirectory=caddy\n' > /etc/systemd/system/caddy.service.d/admin-socket.conf
systemctl daemon-reload
systemctl show -p RuntimeDirectory caddy   # 应输出 RuntimeDirectory=caddy
```

- 容器用 host 网络，两个进程只听 127.0.0.1:3000 和 127.0.0.1:8080，不发布端口，所以不会出现 Docker 绕过 ufw 的问题；ufw 规则不用改。
- Caddy 默认的管理接口 localhost:2019 没有鉴权，容器用 host 网络时里面的进程也连得到，所以改成 unix socket。容器看不到宿主机的 `/run/caddy`，连不到管理接口。上面这几行只加配置，不影响正在跑的占位站：`/run/caddy` 要等 Caddy 下次启动才建出来。第一次 `release.py --caddy` 装上带 `admin` 那行的 Caddyfile 时，脚本会 restart 一次 Caddy（这时 reload 连不上新地址）；之后 `systemctl reload caddy` 会从 Caddyfile 读出 socket 地址，照常可用。
- 内存够在本机构建镜像；为了留余量加了 4G swap（已做）：`fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab`。
- 以后要把 SSH 换到别的端口（下面用 2222 举例）：
  1. 在 `/etc/ssh/sshd_config.d/` 下加一个文件，同时写 `Port 22` 和 `Port 2222`，然后 `systemctl daemon-reload && systemctl restart ssh.socket`（Ubuntu 24.04 的 sshd 默认由 ssh.socket 按需启动，端口以它为准；没用 ssh.socket 的机器改成 `systemctl restart ssh`）。
  2. `ufw allow 2222/tcp`；fail2ban 的 `[sshd]` 段写 `port = 22,2222`，`systemctl restart fail2ban`。
  3. 另开一个终端，确认 `ssh -p 2222` 能登录。
  4. 去掉 `Port 22`，重复第 1 步的重启；`ufw delete allow 22/tcp`；fail2ban 改成 `port = 2222`。
  5. 工作站登录信息里的 `port` 改成 2222，并用 `ssh-keyscan -p 2222 -t ed25519 154.64.250.21` 重新生成 known_hosts（非 22 端口的条目写成 `[154.64.250.21]:2222`，旧条目对不上）。

## 2. 目录和 .env

目录已建（见上面「现状」），命令留着重建时用；`.env` 还没建。

```bash
install -d -m 0755 /opt/canvas /opt/canvas/bin /opt/canvas/compose /srv/canvas /srv/canvas/source /srv/canvas/build
install -d -m 0750 -o 1000 -g 1000 /opt/canvas/data   # 容器里的 node 用户是 uid 1000
install -d -m 0700 /var/backups/canvas
install -d -o caddy -g caddy /var/log/caddy             # Caddy 访问日志（Caddy 官方包一般已建好）
```

`/opt/canvas` 要保持 0755：备份脚本以数据库属主（uid 1000）的身份读库，需要能进这个目录。`/opt/canvas/compose/` 放每一版的 compose 存档，由 release.py 维护。

`.env`：把仓库里要发的那个提交的 `.env.example` 传上去，改成 `/opt/canvas/.env`，然后 `chmod 600 /opt/canvas/.env`。要填的值：

| 变量 | 值 |
|---|---|
| `APP_ENV` | `production` |
| `PUBLIC_HOST` | `canvas.openai.fit` |
| `SERVER_PUBLIC_IPS` | `154.64.250.21` |
| `ADMIN_USERNAME` | 不能是 `admin` |
| `ADMIN_PASSWORD` | `openssl rand -hex 16` 生成（32 位） |
| `JWT_SECRET` | `openssl rand -hex 32` 生成 |
| `JWT_EXPIRE_HOURS` | `72` |
| `STORAGE_DRIVER` / `DATABASE_DSN` | `sqlite` / `/app/data/infinite-canvas.db` |
| `REGISTER_DAILY_LIMIT_PER_IP` | 不写就是 `10`：每个 IP 每 24 小时最多注册成功 10 个账号（失败的不算），填 `0` 不限。计数只在后端内存里，重启或发版后清零。「用 openai.fit 登录」自动建的账号不占这个名额 |
| `FIT_CONNECT_SECRET` | 「用 openai.fit 账号自动登录画布」的共享密钥，`openssl rand -base64 48` 生成，和 openai.fit 服务器上的 `CANVAS_CONNECT_SECRET` 填同一个值。画布浏览器从 openai.fit 桥接页拿一次性登录码，后端带这个密钥换用户身份。不写就不自动登录画布账号（登录页不显示「用 openai.fit 登录」，取令牌不受影响）；写了就至少 32 字节，`FIT_BASE_URL` 必须是 `https://`，否则拒绝启动 |

- 用十六进制随机串，值里就不会出现 `$`（docker compose 会把没加引号的 `$` 当变量展开）。`openssl rand -base64` 的输出也不含 `$`。
- `FIT_CONNECT_SECRET` 两边必须一字不差。轮换：两边同时换成新值，然后两边都重启；换的那几分钟里自动登录会提示暂不可用，用户名密码登录和取令牌不受影响。上线顺序：先发 openai.fit（桥接页 `/canvas/bridge`、登录码和换取接口，同时写入 `CANVAS_CONNECT_SECRET`），再发画布（带上 `FIT_CONNECT_SECRET`）；画布先上的话桥接页还不存在，画布 10 秒后显示「暂时连不上 openai.fit」，不出错，只是没法自动登录和自动选令牌。
- `CANVAS_TAG` 不用写，release.py 会维护这一行。
- 用全新的数据库，不要拷本机的 `data/infinite-canvas.db`，里面可能有明文密钥。
- 生产模式下弱密钥、`admin` 用户名、占位符没换都会拒绝启动，首发健康检查不过时先看 `docker compose logs`。

## 3. 后台 IP 白名单

`/admin` 和 `/api/admin/*` 只对白名单开放，其他来源 404。白名单写在 `/etc/caddy/canvas-admin-ips.caddy`（0644），只有一行：

```text
remote_ip 203.0.113.7 198.51.100.0/24
```

多个 IP 或网段用空格隔开。业主没有固定 IP 时写 `remote_ip 127.0.0.1`（公网一律 404），用 SSH 隧道进后台：

```bash
ssh -L 3000:127.0.0.1:3000 root@154.64.250.21
# 然后在本机浏览器打开 http://127.0.0.1:3000/admin
```

改完白名单：`runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`。

## 4. 工作站上的登录信息

`~/.config/openai-fit/canvas-server/access.json`（Windows 上就是 `%USERPROFILE%\.config\openai-fit\canvas-server\access.json`；环境变量 `CANVAS_SERVER_ACCESS` 可以指到别的文件），不进 git。release.py 只读下面几个字段，不打印它们的值：

| 字段 | 内容 |
|---|---|
| `host` | `154.64.250.21`，不是这个地址时脚本拒绝执行 |
| `port` | SSH 端口，不写就是 22 |
| `user` | 登录用户（写成 `username` 也认）；不是 root 时要能免密 `sudo -n` |
| `key_file` | 私钥文件 |
| `known_hosts` | 固定服务器主机密钥的 known_hosts 文件 |

- `key_file`、`known_hosts` 可以写绝对路径、`~/` 开头的路径，或者相对 access.json 所在目录的路径（例如和它放在同一个目录的 `id_ed25519`、`known_hosts`）。
- 文件里的其他字段 release.py 一概不读。服务器只允许密钥登录，脚本也不会拿密码去登录。
- `known_hosts` 用 `ssh-keyscan -t ed25519 154.64.250.21 > known_hosts` 生成，并和服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的指纹核对一致。

## 5. 首发

先确认：本机配好了远程 `gitea`（内部 Gitea 仓库，地址见 deploy/private/README.md），要发的提交已经 `git push gitea openai-fit`，工作区没有未提交的改动。release.py 会核对这几条，不满足就拒绝（`--dry-run` 只警告）。

```bash
python -I deploy/release.py --dry-run
python -I deploy/release.py            # 构建、上线、健康检查（此时 Caddy 还是占位站）
python -I deploy/release.py --caddy    # 占位站换成 deploy/Caddyfile（这一次会 restart Caddy，见第 1 节）
```

`--caddy` 会先以 caddy 用户校验新配置，通过后才替换并 reload，旧配置留成 `/etc/caddy/Caddyfile.bak-<时间>`。之后可以删掉 `/srv/canvas/placeholder`。

## 6. 后台初始化

1. 从白名单 IP（或第 3 节的隧道）登录 `/admin`。
2. 系统设置：存储模式 `local_indexeddb`；autoSyncAllAssets 关；AllowUserProvider 关；开放注册（登录注册接口按 IP 每分钟 5 次，注册另有每 IP 每 24 小时 10 个账号的上限，见第 2 节的 `REGISTER_DAILY_LIMIT_PER_IP`）；提示词同步关。
3. 在后台改掉管理员密码；然后把 `.env` 的 `ADMIN_PASSWORD` 改成空（`ADMIN_PASSWORD=`），执行 `cd /opt/canvas && docker compose up -d --force-recreate`。

## 7. 备份

`/opt/canvas/bin/backup.sh`（发版时从源码包装上）每天一次：sqlite3 在线备份 → 完整性检查 → gzip → age 加密 → rclone 推到 fit 的 OSS 桶 `fadacai-openai-fit` 下的 `canvas-backup/daily/`，每周日（UTC）再存一份到 `canvas-backup/weekly/`。脚本从不删 OSS 上的文件，旧备份由桶的生命周期规则按天数删除；本机 `/var/backups/canvas` 留 7 天。

OSS 上的对象名是 `canvas-<UTC 时间>-<32 位随机后缀>.db.gz.age`。随机后缀每次上传现生成，不落盘、不写日志；本机文件和 `/var/log/canvas-backup.log` 里只有 `canvas-<UTC 时间>.db.gz.age`（rclone 报错时带出的对象名，后缀也换成了 `<随机后缀>`）。

**age 密钥**：在业主自己的电脑上 `age-keygen -o canvas-backup-key.txt`。私钥文件由业主离线保管，不放服务器；服务器上只放它打印出来的公钥（`age1` 开头）。

**OSS 账号**：不要把 fit 主站的 AccessKey 放到这台机器上。在阿里云 RAM 建一个子账号，只授予往 `canvas-backup/` 下写文件的权限，不能读、不能列目录、不能删：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject"],
      "Resource": ["acs:oss:*:*:fadacai-openai-fit/canvas-backup/*"]
    }
  ]
}
```

服务器失守时，攻击者拿这把密钥删不掉、也列不出异地备份。PutObject 能覆盖同名对象，所以对象名带随机后缀：本机文件名和日志里都没有后缀，拿到服务器也推不出旧备份在 OSS 上叫什么，覆盖不了它们，只能往 `canvas-backup/` 下多写垃圾文件。剩下的风险：

- 失守之后的备份不可信：攻击者能改 backup.sh，也能在上传时看到对象名。恢复时以失守之前的备份为准。
- 让 OSS 自己拒绝覆盖，走请求头这条路不通：上传时带 `x-oss-forbid-overwrite: true` 才会拒绝覆盖，但 rclone 的 S3 后端不认这个头（`--header-upload` 会把它丢掉，还会在日志里报错并带出对象名），所以 backup.sh 没带；阿里云 OSS 授权语法的条件键列表里也没有 `oss:x-oss-forbid-overwrite`，能不能在 RAM 策略里要求它**未确认**，上面的策略没加这个条件（加了而上传不带这个头，备份会全部被拒）。
- 可选（业主决定，未实测）：在 fit 桶上加一条只对 `canvas-backup/` 前缀生效的「禁止覆盖写」规则（OSS 的 PutBucketOverwriteConfig，按前缀匹配，不影响 fit 自己的文件；控制台菜单名没核对）。它对 rclone 走的 S3 兼容接口是否生效也未确认，配好后在服务器上把同一个文件传两次：`rclone copyto --no-check-dest --s3-no-head /etc/hostname fitoss:fadacai-openai-fit/canvas-backup/daily/overwrite-test`，第二次应被拒（409 FileAlreadyExists）；这个测试文件 14 天后由生命周期删掉。
- 要彻底防住（覆盖、提前删除都防），得给备份单独建一个开了版本控制或合规保留（WORM）的桶；这两项整桶生效，在 fit 主桶上开会影响 fit 自己的文件，所以这里没做，由业主决定。

**生命周期规则**：在阿里云控制台配，服务器上的子账号读不到也改不了。打开 OSS 控制台 → Bucket 列表 → `fadacai-openai-fit` → 数据管理 → 生命周期 → 创建规则，建两条：

| 规则 | 匹配方式 | 前缀 | 文件过期策略 |
|---|---|---|---|
| canvas-backup-daily | 按前缀 | `canvas-backup/daily/` | 按天数：最后修改 14 天后删除 |
| canvas-backup-weekly | 按前缀 | `canvas-backup/weekly/` | 按天数：最后修改 56 天后删除 |

- 建之前先看一眼已有的规则。fit 的成片等文件也靠生命周期删除，那些规则必须都带着自己的前缀；如果有作用于整个桶（前缀为空）的规则，`canvas-backup/` 也会按那条规则的天数被删。
- 规则只看天数，不看还剩几份：备份停了 14 天，daily/ 会被删空；停了 56 天，weekly/ 也会删空。所以要按第 8 节每周看一次备份日志。
- 生命周期每天执行一次，过期文件可能晚一天才删，OSS 上偶尔多一两份是正常的。

**rclone**：`/root/.config/rclone/rclone.conf`（0600）

```ini
[fitoss]
type = s3
provider = Alibaba
endpoint = oss-cn-shenzhen.aliyuncs.com
access_key_id = <子账号 AccessKey ID>
secret_access_key = <子账号 AccessKey Secret>
no_check_bucket = true
```

- 不写 `acl`：文件跟随桶本身的私有权限。写了 `acl` 会在上传时多带一个设置文件权限的请求头，可能还要额外的权限。
- 子账号没有读权限，backup.sh 上传时带 `--no-check-dest --s3-no-head`，不先查目标、传完也不再 HEAD 核对。

**备份配置**：`/etc/canvas-backup.env`（0600）

```bash
AGE_RECIPIENT=age1<业主的公钥>
RCLONE_DEST=fitoss:fadacai-openai-fit/canvas-backup
# 下面两项一般不用改
# CANVAS_DB=/opt/canvas/data/infinite-canvas.db
# LOCAL_DIR=/var/backups/canvas
```

**定时**：`/etc/cron.d/canvas-backup`

```text
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 19 * * * root /opt/canvas/bin/backup.sh >> /var/log/canvas-backup.log 2>&1
```

时间按服务器时区算，服务器是 UTC 时 19:17 就是北京时间 03:17。装好后手动跑一次 `/opt/canvas/bin/backup.sh`，看到最后一行「备份完成」，再到 OSS 控制台的 `canvas-backup/daily/` 下确认文件已上传（子账号不能列目录，服务器上 `rclone lsf` 会被拒）。

**找备份**：服务器上的子账号读不了、也列不出备份，本机和日志里也没有 OSS 上的完整对象名。到 OSS 控制台打开 `fadacai-openai-fit` 的 `canvas-backup/daily/`（更早的到 `weekly/`），按日期前缀搜：例如搜 `canvas-20261101` 能找到 2026-11-01（UTC）那天的备份。按名字里的时间挑一份下载，末尾的随机后缀不用管。

**恢复演练**（不碰线上库，在业主自己的电脑上做，私钥不上服务器）：

```bash
# 先按上面「找备份」从 OSS 控制台下载一份
age -d -i canvas-backup-key.txt canvas-<时间>-<随机后缀>.db.gz.age | gunzip > restore.db
sqlite3 restore.db 'PRAGMA integrity_check; SELECT count(*) FROM users;'
```

**真要恢复时**：按上面解密出 `restore.db`，`scp restore.db root@154.64.250.21:/tmp/restore.db`；然后在服务器上 `cd /opt/canvas && docker compose stop`；把 `data/` 下的 `infinite-canvas.db`、`infinite-canvas.db-wal`、`infinite-canvas.db-shm` 三个文件一起挪走（只换主文件、留着旧的 `-wal` 会把库写坏）；`install -o 1000 -g 1000 -m 0644 /tmp/restore.db data/infinite-canvas.db && rm /tmp/restore.db`；`docker compose up -d`。

## 8. 监控

- 外部用 uptime 服务每 5 分钟探测 `https://canvas.openai.fit/api/health`，返回体是 `ok`。
- 每周看一眼 `tail /var/log/canvas-backup.log`（每天都应有一行「备份完成」；连续失败超过 14 天，OSS 上的 daily/ 会被生命周期删空）、`docker compose -f /opt/canvas/docker-compose.yml ps`（应为 healthy）和下面的磁盘告警。

**磁盘告警**：SQLite、Docker 日志、Caddy 日志和 journald 都在这块 155 GB 的盘上，写满了全都会失败。每个账号最多能写约 768MB（画布项目 512MB，生成记录、素材、工作流合计 256MB），注册虽有每 IP 每天 10 个的上限，换 IP 还是能多注册。`/opt/canvas/bin/disk-check.sh`（每次发版由 release.py 从源码包装上，所以首发之后才有）每小时看一次根分区和 `/opt/canvas` 所在分区，占用超过 80% 时：

- 用 `logger -t canvas-disk` 写进 journald，一条告警加 `/opt/canvas/data` 的 du 摘要（数据库等各占多少）；
- 同样的内容追加到 `/var/log/canvas-disk.log`：告警一行一条、开头是 UTC 时间，下面缩进两格是 du 摘要。

没超过时什么都不记。阈值用环境变量 `CANVAS_DISK_THRESHOLD` 改（写在 cron 行里，例如 `CANVAS_DISK_THRESHOLD=70 /opt/canvas/bin/disk-check.sh`）。

安装：首发之后建 `/etc/cron.d/canvas-disk-check`（0644）：

```text
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
7 * * * * root /opt/canvas/bin/disk-check.sh >/dev/null 2>>/var/log/canvas-disk.log
```

脚本平时打印的现状丢掉，只有脚本自己出错时的报错进日志文件。装好后手动跑一次 `/opt/canvas/bin/disk-check.sh`，会打印各分区的占用和 data 目录的 du 摘要。

查看：

```bash
journalctl -t canvas-disk --since '7 days ago'   # 最近 7 天的告警，没有输出就是没超过
tail -n 50 /var/log/canvas-disk.log              # 告警、du 摘要和脚本自己的报错；文件不存在说明从没超过也没出过错
/opt/canvas/bin/disk-check.sh                    # 现在的占用
du -sh /opt/canvas/data /var/lib/docker /var/log/journal /var/log/caddy   # 超了之后看是谁占的
```

告警了就先看 du 摘要：是数据库涨（用户数据），还是 Docker 镜像和构建缓存、日志涨。用户数据涨得快时考虑在后台关注册，或调低 `REGISTER_DAILY_LIMIT_PER_IP`。
- 日志里没有 `/api/proxy-image` 的 `url` 参数：已登录用户直连 fit 成片失败时，会把签名链接（带 `access=`，单独就能看那条成片）交给这个代理再取一次（原因见 RELEASING.md「成片签名链接和日志」）。`docker compose logs` 里 Go 的访问日志只有路径；`/var/log/caddy/canvas-access.log`（Caddy 访问日志）和 `journalctl -u caddy`（Caddy 默认日志：后端连不上时的错误、客户端中途断开时反向代理的警告）都删掉了 `url`、`access`、`apiKey`、`apikey`、`key` 参数。第 9 节的冒烟检查里有核对命令。

## 9. 冒烟检查（只读，不发生成请求）

```bash
curl -sI https://canvas.openai.fit | grep -iE 'strict-transport-security|x-content-type-options|content-security-policy-report-only'
curl -s https://canvas.openai.fit/api/health                    # ok
curl -s -o /dev/null -w '%{http_code}\n' -H 'Sec-Fetch-Site: cross-site' 'https://canvas.openai.fit/api/proxy-image?url=https://openai.fit/favicon.ico'   # 403
curl -s -o /dev/null -w '%{http_code}\n' https://canvas.openai.fit/admin             # 非白名单 IP：404
curl -s -o /dev/null -w '%{http_code}\n' https://canvas.openai.fit/api/admin/users   # 非白名单 IP：404
curl -s -o /dev/null -w '%{http_code}\n' https://canvas.openai.fit/source/           # 200，列出源码包
curl -s -o /dev/null -w '%{http_code}\n' https://canvas.openai.fit/director/index.html   # 200，3D 导演台
curl -s -o /dev/null -w '%{http_code}\n' 'https://canvas.openai.fit/api/proxy-image?url=https://openai.fit:8443/favicon.ico'   # 502，代理只连 80 和 443 端口
```

服务器上 `ss -tlnp`：对外（0.0.0.0 / [::]）只有 22、80、443；3000、8080 只在 127.0.0.1；没有 2019，Caddy 管理接口只在 `/run/caddy/admin.sock`（`ls -l /run/caddy/` 能看到）。

服务器上查日志里有没有成片签名链接，三条都应为 0。签名链接在 `/api/proxy-image?url=` 里是转义过的，`access=` 写成了 `access%3D`，所以两种写法都要搜：

```bash
journalctl -u caddy --since today | grep -ciE 'access(=|%3d)'                  # Caddy 默认日志（错误、反向代理警告）
grep -ciE 'access(=|%3d)' /var/log/caddy/canvas-access.log                     # Caddy 访问日志
docker compose -f /opt/canvas/docker-compose.yml logs | grep -ciE 'access(=|%3d)'   # Go 的访问日志
```

`grep -c` 没有命中时打印 0、退出码为 1，这是正常的。
