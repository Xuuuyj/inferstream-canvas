#!/usr/bin/env bash
# canvas.openai.fit 数据库备份：sqlite3 .backup 在线备份 → 完整性检查 → gzip → age 公钥加密 → rclone 推到 OSS 私有目录。
# 每天一份进 OSS 的 daily/，每周日（UTC）再存一份进 weekly/；本机留 7 天。脚本从不删 OSS 上的文件：旧备份由桶的生命周期规则
# 按天数删除（daily/ 14 天、weekly/ 56 天）；服务器上的子账号只有 PutObject 权限，不能删除也不能列目录。
# OSS 上的对象名是本机文件名加一段每次现生成的随机后缀，后缀不落盘、不写日志（见 upload）。
# 服务器上由 release.py 装到 /opt/canvas/bin/backup.sh，cron 每天跑一次（见 deploy/server-setup.md）。
# 配置读 /etc/canvas-backup.env（可用 CANVAS_BACKUP_ENV 指定别的文件），必填 AGE_RECIPIENT、RCLONE_DEST。
# 只放 age 公钥在服务器上；私钥由业主离线保管，恢复步骤见 deploy/server-setup.md。
set -euo pipefail

CONFIG="${CANVAS_BACKUP_ENV:-/etc/canvas-backup.env}"
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi
CANVAS_DB="${CANVAS_DB:-/opt/canvas/data/infinite-canvas.db}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/canvas}"
: "${AGE_RECIPIENT:?$CONFIG 里没有 AGE_RECIPIENT（age 公钥，age1 开头）}"
: "${RCLONE_DEST:?$CONFIG 里没有 RCLONE_DEST（例如 fitoss:fadacai-openai-fit/canvas-backup）}"
RCLONE_DEST="${RCLONE_DEST%/}"

umask 077
exec 9>"${LOCK_FILE:-/run/canvas-backup.lock}"
flock -n 9 || { echo "上一次备份还没结束" >&2; exit 1; }

[ -f "$CANVAS_DB" ] || { echo "找不到数据库 $CANVAS_DB" >&2; exit 1; }
mkdir -p "$LOCAL_DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 数据库是 WAL 模式、归容器里的 node 用户（uid 1000）。用 root 打开可能留下 root 的 -wal/-shm，
# 程序重启后就写不了库，所以 sqlite3 切到数据库文件的属主再跑，备份先写进它能写的临时目录。
uid="$(stat -c %u "$CANVAS_DB")"
gid="$(stat -c %g "$CANVAS_DB")"
chown "$uid:$gid" "$work"
setpriv --reuid="$uid" --regid="$gid" --clear-groups \
  sqlite3 "$CANVAS_DB" ".timeout 30000" ".backup '$work/canvas.db'"

check="$(sqlite3 "$work/canvas.db" "PRAGMA integrity_check;")"
[ "$check" = "ok" ] || { echo "备份副本完整性检查没通过：$check" >&2; exit 1; }

name="canvas-$(date -u +%Y%m%dT%H%M%SZ).db.gz.age"
gzip -c "$work/canvas.db" | age -r "$AGE_RECIPIENT" -o "$work/$name"
mv "$work/$name" "$LOCAL_DIR/$name"

# 子账号只有 PutObject：--no-check-dest 不先查目标是否存在，--s3-no-head 传完不再 HEAD 核对（这两步都要读权限）。
# PutObject 能覆盖同名对象，所以 OSS 上的名字带随机后缀：服务器失守后，从本机文件名和日志里推不出旧备份的对象名，
# 也就覆盖不了它们。rclone 报错时会带上对象名，写进日志前把后缀换成 <随机后缀>。
upload() {
  local tag
  tag="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  rclone copyto --no-check-dest --s3-no-head "$LOCAL_DIR/$name" "$RCLONE_DEST/$1/${name%.db.gz.age}-$tag.db.gz.age" 2>&1 |
    sed "s/$tag/<随机后缀>/g" >&2
}
upload daily
if [ "$(date -u +%u)" = 7 ]; then
  upload weekly
fi
find "$LOCAL_DIR" -maxdepth 1 -name 'canvas-*.db.gz.age' -mtime +6 -delete

echo "$(date -u +%FT%TZ) 备份完成 $name $(stat -c %s "$LOCAL_DIR/$name") 字节"
