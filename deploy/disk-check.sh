#!/usr/bin/env bash
# canvas.openai.fit 磁盘告警：根分区或 /opt/canvas 所在分区的占用超过阈值（默认 80%）时，用 logger -t canvas-disk 写进 journald，
# 并追加到 /var/log/canvas-disk.log，同时记下 /opt/canvas/data 的 du 摘要（数据库等各占多少）。没超过时什么都不记。
# 每次都把各分区的占用和 du 摘要打印到标准输出，手动跑一次就能看现状。
# 服务器上由 release.py 装到 /opt/canvas/bin/disk-check.sh，/etc/cron.d/canvas-disk-check 每小时跑一次（见 deploy/server-setup.md 第 8 节）。
# 盘满了 SQLite、Docker 日志、Caddy 日志和 journald 都会写失败；每个账号最多能写约 768MB，注册另有每 IP 每天的上限。
# 可用环境变量改：CANVAS_DISK_THRESHOLD（百分比）、CANVAS_DIR、CANVAS_DATA_DIR、CANVAS_DISK_LOG。
set -euo pipefail

THRESHOLD="${CANVAS_DISK_THRESHOLD:-80}"
CANVAS_DIR="${CANVAS_DIR:-/opt/canvas}"
DATA_DIR="${CANVAS_DATA_DIR:-$CANVAS_DIR/data}"
LOG_FILE="${CANVAS_DISK_LOG:-/var/log/canvas-disk.log}"

paths=(/)
[ -d "$CANVAS_DIR" ] && paths+=("$CANVAS_DIR")
alerts=()
# 根分区和 /opt/canvas 在同一个分区时 df 输出两行一样的，sort -u 只留一行。
while read -r mount used avail; do
  echo "$mount 已用 $used，剩余 $avail"
  if [ "${used%\%}" -gt "$THRESHOLD" ]; then
    alerts+=("$mount 已用 $used，剩余 $avail，超过 ${THRESHOLD}%")
  fi
done < <(df -h --output=target,pcent,avail "${paths[@]}" | tail -n +2 | sort -u)

# data 目录合计和里面最大的几项，按大小从大到小。
summary="$(du -ah --max-depth=1 "$DATA_DIR" 2>&1 | sort -rh | head -n 8 || true)"
echo "$DATA_DIR 占用："
echo "$summary"

[ "${#alerts[@]}" -gt 0 ] || exit 0
for alert in "${alerts[@]}"; do
  logger -t canvas-disk -p user.warning "磁盘告警：$alert"
  printf '%s 磁盘告警：%s\n' "$(date -u +%FT%TZ)" "$alert" >> "$LOG_FILE"
done
printf '%s 占用：\n%s\n' "$DATA_DIR" "$summary" | logger -t canvas-disk -p user.warning
printf '%s\n' "$summary" | sed 's/^/  /' >> "$LOG_FILE"
