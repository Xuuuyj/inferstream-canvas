"""deploy/Caddyfile 的单测（日志过滤、3D 导演台不拦）。在仓库根目录跑：
python -I -B -m unittest discover -s deploy -p "test_*.py"

/api/proxy-image?url= 可能带 fit 成片的签名链接（access=），不能进 Caddy 的任何日志：站点里的 log 段只管访问日志，
Caddy 自己的默认日志（后端连不上时的错误日志、客户端中途断开时 reverse_proxy 的警告，进 journald）要靠全局块的
log default 同样过滤。3D 导演台业主 2026-11-02 开放，/director 不再回 404。
本机有 caddy 时用 caddy adapt 看实际生效的配置，没有 caddy 时只有文本断言。
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # 别在 deploy/ 下留 __pycache__
CADDYFILE = Path(__file__).with_name("Caddyfile")
# code、state 只走请求体（openai.fit 自动登录的一次性登录码），这里兜底：万一有人放进 ? 参数也不落日志。
DROPPED = {"apiKey", "apikey", "key", "url", "access", "code", "state"}


def adapt():
    """caddy adapt 出实际生效的 JSON 配置。"""
    with tempfile.TemporaryDirectory() as tmp:
        # 后台白名单只在服务器上，这里换成一个本机文件，adapt 才不会因为 import 找不到文件而失败
        ips = Path(tmp, "admin-ips.caddy")
        ips.write_text("remote_ip 127.0.0.1\n", "utf-8")
        config = Path(tmp, "Caddyfile")
        config.write_text(CADDYFILE.read_text("utf-8").replace("/etc/caddy/canvas-admin-ips.caddy", ips.as_posix()),
                          "utf-8", newline="\n")
        done = subprocess.run(["caddy", "adapt", "--config", str(config), "--adapter", "caddyfile"],
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


class CaddyDirectorTest(unittest.TestCase):
    """3D 导演台已开放（业主 2026-11-02）：/director 不再被拦，由兜底转给前端。"""

    def test_director_is_not_blocked(self):
        text = CADDYFILE.read_text("utf-8")
        self.assertNotRegex(text, r"(?m)^\t@director ")
        self.assertNotIn("handle @director", text)

    @unittest.skipUnless(shutil.which("caddy"), "本机没有 caddy，只做上面的文本断言")
    def test_adapted_config_has_no_director_route(self):
        site = adapt()["apps"]["http"]["servers"]["srv0"]["routes"][0]["handle"][0]["routes"]
        self.assertNotIn("/director", json.dumps(site))


class CaddyCspTest(unittest.TestCase):
    """画布页面里有一个隐藏的 openai.fit 桥接页（https://openai.fit/canvas/bridge），CSP 的 frame-src 要放行它。"""

    def test_frame_src_allows_the_fit_bridge(self):
        text = CADDYFILE.read_text("utf-8")
        csp = re.search(r'Content-Security-Policy(?:-Report-Only)? "([^"]+)"', text)
        self.assertIsNotNone(csp, "Caddyfile 里没有 CSP")
        frame = re.search(r"(?:^|;\s*)frame-src ([^;]+)", csp.group(1))
        self.assertIsNotNone(frame, "CSP 里没有 frame-src")
        self.assertEqual(frame.group(1).split(), ["'self'", "https://openai.fit"])


class CaddyLogTest(unittest.TestCase):
    def test_global_default_log_drops_query_params(self):
        text = CADDYFILE.read_text("utf-8")
        options = re.search(r"^\{\n(.*?)^\}", text, re.M | re.S)
        self.assertIsNotNone(options, "Caddyfile 开头没有全局选项块")
        default = re.search(r"^\tlog default \{\n(.*?)^\t\}", options.group(1), re.M | re.S)
        self.assertIsNotNone(default, "全局选项块里没有 log default")
        self.assertRegex(default.group(1), r"format filter \{\s*request>uri query \{")
        self.assertEqual(set(re.findall(r"delete (\S+)", default.group(1))), DROPPED)

    def test_site_access_log_drops_query_params(self):
        text = CADDYFILE.read_text("utf-8")
        site = re.search(r"^canvas\.openai\.fit \{\n(.*?)^\}", text, re.M | re.S)
        self.assertIsNotNone(site, "Caddyfile 里没有 canvas.openai.fit 站点块")
        access = re.search(r"^\tlog \{\n(.*?)^\t\}", site.group(1), re.M | re.S)
        self.assertIsNotNone(access, "站点块里没有 log 段")
        self.assertRegex(access.group(1), r"format filter \{\s*request>uri query \{")
        self.assertEqual(set(re.findall(r"delete (\S+)", access.group(1))), DROPPED)

    @unittest.skipUnless(shutil.which("caddy"), "本机没有 caddy，只做上面的文本断言")
    def test_adapted_logs_all_filter_the_uri_query(self):
        logs = adapt()["logging"]["logs"]
        self.assertIn("default", logs)
        for name, log in logs.items():
            with self.subTest(log=name):
                encoder = log.get("encoder", {})
                self.assertEqual(encoder.get("format"), "filter")
                uri = encoder.get("fields", {}).get("request>uri", {})
                self.assertEqual(uri.get("filter"), "query")
                self.assertEqual({(a["type"], a["parameter"]) for a in uri.get("actions", [])}, {("delete", p) for p in DROPPED})


if __name__ == "__main__":
    unittest.main()
