"""source_gate.py 的单测：python -I deploy/test_source_gate.py（用 unittest discover 跑时加 -B，免得在 deploy/ 下留 __pycache__）。

用的是假词表，词不能和 deploy/private/source-redactions.json 里的重名，否则本文件自己就会被闸门拦下。
"""
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True  # 别在 deploy/ 下留 __pycache__
_spec = importlib.util.spec_from_file_location("source_gate", Path(__file__).with_name("source_gate.py"))
source_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(source_gate)

REPO = Path(__file__).resolve().parents[1]
FAKE = {"words": ["acme7", "示例供货"], "patterns": [r"lane\s*#?\s*\d+"], "allow": ["lane 0"], "renames": {}}


class SourceGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.redactions = self.root / "redactions.json"
        self.redactions.write_text(json.dumps(FAKE, ensure_ascii=False), "utf-8")

    def tearDown(self):
        self.dir.cleanup()

    def tar(self, files):
        path = self.root / "pkg.tar.gz"
        with tarfile.open(path, "w:gz") as tar:
            for name, data in files.items():
                data = data.encode("utf-8") if isinstance(data, str) else data
                info = tarfile.TarInfo(f"pkg/{name}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return str(path)

    def scan(self, files):
        return source_gate.scan_tarball(self.tar(files), str(self.redactions))

    def test_clean_package_passes(self):
        files = {"README.md": "# 无限画布\nkokoro acme70 xacme7 lane 0\n", "web/a.ts": "export const a = 1\n"}
        self.assertEqual(self.scan(files), [])

    def test_hits_are_rejected_with_file_line_and_word(self):
        problems = self.scan({"web/a.ts": "const x = 1\nconst seedanceAcme7 = 2 // lane #35\n", "docs/b.md": "经示例供货商\n"})
        self.assertEqual(problems, ["pkg/web/a.ts:2：命中「Acme7」", "pkg/web/a.ts:2：命中「lane #35」", "pkg/docs/b.md:1：命中「示例供货」"])

    def test_file_names_are_scanned(self):
        self.assertEqual(self.scan({"plugins/acme7-video.js": "x"}), ["pkg/plugins/acme7-video.js：文件名命中「acme7」"])

    def test_private_directory_is_rejected(self):
        problems = self.scan({"deploy/private/source-redactions.json": "{}", "web/a.ts": "ok\n"})
        self.assertEqual(len(problems), 1)
        self.assertIn("pkg/deploy/private/source-redactions.json", problems[0])
        self.assertIn("deploy/private/", problems[0])

    def test_binary_and_non_utf8_files_are_skipped(self):
        self.assertEqual(self.scan({"public/a.png": b"acme7", "public/b.dat": b"\xff\xfeacme7", "public/c.bin": b"acme7\0"}), [])

    def test_missing_redactions_is_a_problem(self):
        problems = source_gate.scan_tarball(self.tar({"a.md": "ok"}), str(self.root / "missing.json"))
        self.assertEqual(len(problems), 1)
        self.assertIn("词表缺失", problems[0])

    def test_cli_exit_codes(self):
        def run(files):
            gate = Path(__file__).with_name("source_gate.py")
            return subprocess.run([sys.executable, "-I", str(gate), self.tar(files), "--redactions", str(self.redactions)],
                                  capture_output=True, text=True, encoding="utf-8")
        passed = run({"a.md": "ok"})
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertIn("源码包检查通过", passed.stdout)
        failed = run({"a.md": "acme7"})
        self.assertEqual(failed.returncode, 1, failed.stderr)
        self.assertIn("pkg/a.md:1：命中「acme7」", failed.stdout)

    @unittest.skipUnless(source_gate.DEFAULT_REDACTIONS.is_file() and (REPO / ".git").exists(), "词表只在内部仓库里，源码包里没有")
    def test_working_tree_passes_with_real_redactions(self):
        """工作区（含未提交改动，去掉 export-ignore 的内部文件）按真词表打包也要过闸门，不用等到发版才发现。"""
        def git(*args, stdin=None):
            return subprocess.run(["git", "-C", str(REPO), *args], input=stdin, capture_output=True, check=True).stdout.decode("utf-8")
        names = [n for n in git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0") if n]
        attrs = git("check-attr", "-z", "--stdin", "export-ignore", stdin="\0".join(names).encode("utf-8")).split("\0")
        ignored = {attrs[i] for i in range(0, len(attrs) - 2, 3) if attrs[i + 2] == "set"}
        path = self.root / "tree.tar"
        with tarfile.open(path, "w") as tar:
            for name in names:
                if name not in ignored and (REPO / name).is_file():
                    tar.add(REPO / name, arcname=f"pkg/{name}")
        self.assertEqual(source_gate.scan_tarball(str(path)), [])


if __name__ == "__main__":
    sys.stderr.reconfigure(encoding="utf-8")  # python -I 会忽略 PYTHONIOENCODING
    unittest.main()
