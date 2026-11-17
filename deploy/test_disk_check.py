"""deploy/disk-check.sh（磁盘告警）的单测。在仓库根目录跑：
python -I -B -m unittest discover -s deploy -p "test_*.py"

文本断言总会跑。本机有 bash 时再 bash -n 查语法，并用假的 df、logger 把脚本实跑几遍（du、sort 等用真的）：
超过阈值才写 journald 和日志文件，根分区和 /opt/canvas 在同一个分区时只报一次。
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # 别在 deploy/ 下留 __pycache__
DEPLOY = Path(__file__).resolve().parent
SCRIPT = DEPLOY / "disk-check.sh"

FAKE_DF = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DF_ARGS"
echo 'Mounted on Use% Avail'
printf '%s\\n' "$FAKE_DF"
"""
FAKE_LOGGER = """#!/usr/bin/env bash
tag=""
while [ $# -gt 0 ]; do case "$1" in -t) tag="$2"; shift 2;; -p) shift 2;; *) break;; esac; done
if [ $# -gt 0 ]; then printf '%s: %s\\n' "$tag" "$*"; else sed "s/^/$tag: /"; fi >> "$FAKE_LOGGER_OUT"
"""


def find_bash():
    """能直接跑仓库脚本的 bash。Windows 上 PATH 里的 bash 可能是 System32 下的 WSL 启动器，改用 Git for Windows 的
    usr/bin/bash（它不改 PATH，假命令才能排在前面）。"""
    bash = shutil.which("bash")
    if bash and Path(bash).parent.name.lower() != "system32":
        return bash
    git = shutil.which("git")
    candidate = Path(git).resolve().parents[1] / "usr" / "bin" / "bash.exe" if git else None
    return str(candidate) if candidate and candidate.exists() else None


BASH = find_bash()


class DiskCheckTextTest(unittest.TestCase):
    def test_script_checks_root_and_canvas_partitions(self):
        raw = SCRIPT.read_bytes()
        self.assertNotIn(b"\r", raw, "脚本要是 LF 换行，CRLF 在服务器上跑不起来")
        text = raw.decode("utf-8")
        self.assertTrue(text.startswith("#!/usr/bin/env bash\n"))
        self.assertIn("set -euo pipefail", text)
        self.assertIn('THRESHOLD="${CANVAS_DISK_THRESHOLD:-80}"', text)
        self.assertIn('CANVAS_DIR="${CANVAS_DIR:-/opt/canvas}"', text)
        self.assertIn('DATA_DIR="${CANVAS_DATA_DIR:-$CANVAS_DIR/data}"', text)
        self.assertIn('LOG_FILE="${CANVAS_DISK_LOG:-/var/log/canvas-disk.log}"', text)
        self.assertRegex(text, r"df -h --output=target,pcent,avail \"\$\{paths\[@\]\}\"")
        self.assertRegex(text, r'du -ah --max-depth=1 "\$DATA_DIR"')
        # 告警一行、du 摘要一份，都用 canvas-disk 标签写进 journald（注释里的不算）。
        self.assertEqual(len(re.findall(r"(?m)^[^#\n]*logger -t canvas-disk -p user\.warning", text)), 2)

    def test_setup_documents_the_hourly_cron(self):
        # release.py 每次发版把脚本装到 /opt/canvas/bin/，见 test_release.py 的 BuildScriptTest。
        setup = (DEPLOY / "server-setup.md").read_text("utf-8")
        for needle in ("/etc/cron.d/canvas-disk-check", "journalctl -t canvas-disk", "/var/log/canvas-disk.log"):
            self.assertTrue(needle in setup, f"server-setup.md 没写 {needle}")
        self.assertTrue(re.search(r"(?m)^\d+ \* \* \* \* root /opt/canvas/bin/disk-check\.sh ", setup),
                        "server-setup.md 没有每小时跑 /opt/canvas/bin/disk-check.sh 的 cron 行")


@unittest.skipUnless(BASH, "本机没有 bash，只做上面的文本断言")
class DiskCheckRunTest(unittest.TestCase):
    def test_syntax(self):
        done = subprocess.run([BASH, "-n", SCRIPT.as_posix()], capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)

    def run_script(self, df_lines):
        """用假 df 输出 df_lines 跑一遍，返回 (退出码, 标准输出, 日志文件内容或 None, 假 logger 收到的内容, df 收到的参数)。"""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bin_dir, canvas = tmp / "bin", tmp / "canvas"
            bin_dir.mkdir()
            (canvas / "data").mkdir(parents=True)
            (canvas / "data" / "infinite-canvas.db").write_bytes(b"x" * 4096)
            for name, body in (("df", FAKE_DF), ("logger", FAKE_LOGGER)):
                (bin_dir / name).write_text(body, "utf-8", newline="\n")
                os.chmod(bin_dir / name, 0o755)
            log, logger, df_args = tmp / "canvas-disk.log", tmp / "logger.txt", tmp / "df-args.txt"
            env = dict(os.environ, PATH=os.pathsep.join([str(bin_dir), str(Path(BASH).parent), os.environ.get("PATH", "")]),
                       FAKE_DF="\n".join(df_lines), FAKE_DF_ARGS=df_args.as_posix(), FAKE_LOGGER_OUT=logger.as_posix(),
                       CANVAS_DIR=canvas.as_posix(), CANVAS_DISK_LOG=log.as_posix())
            done = subprocess.run([BASH, SCRIPT.as_posix()], env=env, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=60)
            read = lambda path: path.read_text("utf-8") if path.exists() else None
            self.assertEqual(done.stderr, "")
            return done.returncode, done.stdout, read(log), read(logger) or "", read(df_args) or ""

    def test_same_partition_over_threshold_alerts_once(self):
        code, out, log, logger, df_args = self.run_script(["/ 85% 20G", "/ 85% 20G"])
        self.assertEqual(code, 0)
        self.assertIn("--output=target,pcent,avail /", df_args)
        self.assertIn("/canvas", df_args)
        self.assertIn("/ 已用 85%，剩余 20G", out)
        self.assertEqual(re.findall(r"磁盘告警：.*", log), ["磁盘告警：/ 已用 85%，剩余 20G，超过 80%"])
        self.assertRegex(log, r"(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 磁盘告警")
        self.assertRegex(log, r"(?m)^  \S+\t\S*/canvas/data$")  # du 摘要
        self.assertEqual(logger.count("canvas-disk: 磁盘告警："), 1)
        self.assertRegex(logger, r"canvas-disk: \S*/canvas/data 占用：")
        self.assertIn("infinite-canvas.db", logger)

    def test_only_the_full_partition_alerts(self):
        _, _, log, logger, _ = self.run_script(["/ 50% 70G", "/opt/canvas 81% 5G"])
        self.assertEqual(re.findall(r"磁盘告警：.*", log), ["磁盘告警：/opt/canvas 已用 81%，剩余 5G，超过 80%"])
        self.assertEqual(logger.count("磁盘告警："), 1)

    def test_at_threshold_writes_nothing(self):
        code, out, log, logger, _ = self.run_script(["/ 80% 70G"])
        self.assertEqual(code, 0)
        self.assertIn("/ 已用 80%，剩余 70G", out)
        self.assertIn("infinite-canvas.db", out)
        self.assertIsNone(log)
        self.assertEqual(logger, "")


if __name__ == "__main__":
    unittest.main()
