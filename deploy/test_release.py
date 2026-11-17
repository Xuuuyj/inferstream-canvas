"""release.py 的单测：不连服务器、不碰网络；git、bun 都换成假的，只有 PackageLineEndingTest 用本仓库的 git 在本机打一次包。
在仓库根目录跑：
python -I -B -m unittest discover -s deploy -p "test_*.py"
（-B 不在 deploy/ 下留 __pycache__，否则工作区变脏，发版会拒绝。）"""
import importlib.util
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)

COMMIT = "c" * 40
TAG, PREVIOUS = "v0.8.3-fit.2-ccccccc", "v0.8.3-fit.1-bbbbbbb"
NAME = f"infinite-canvas-{TAG}"

# 假的源码包闸门：包里有文件含 SUPPLIER 就报一条，用来测 release.py 的接线，不依赖真闸门的实现。
FAKE_GATE = '''
import tarfile

def scan_tarball(tar_path, redactions_path=None):
    with tarfile.open(tar_path) as tar:
        return [f"{m.name}: 有不能公开的词" for m in tar.getmembers() if m.isfile() and b"SUPPLIER" in tar.extractfile(m).read()]
'''


class FakeServer:
    """按脚本内容认出是切换、健康检查还是写发版记录，退出码按 (动作, 标签) 查表，表里没有的都是 0。"""
    dry, user = False, "root"

    def __init__(self, codes):
        self.codes, self.calls = codes, []

    def run(self, title, script, timeout=900, check=True):
        if found := re.search(r"echo 'CANVAS_TAG=(\S+)' >> \.env", script):
            call = ("switch", found.group(1))
        elif found := re.search(rf"grep -xF '{release.IMAGE}:(\S+)'", script):
            call = ("health", found.group(1))
        elif found := re.search(r"\t([^\t']+)' >> \S*releases\.tsv", script):
            call = ("record", found.group(1))
        else:
            call = ("other", title)
        self.calls.append(call)
        return self.codes.get(call, 0), ""


class SwitchTest(unittest.TestCase):
    def switch(self, codes, tag=TAG, previous=PREVIOUS, note="release"):
        srv = FakeServer(codes)
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as failed:
            release.switch(srv, tag, previous, COMMIT, "digest", note)
        return str(failed.exception.code), srv.calls

    def test_rollback_switch_unchanged_does_not_claim_rolled_back(self):
        message, calls = self.switch({("health", TAG): 1, ("switch", PREVIOUS): release.UNCHANGED})
        self.assertIn(f"切回 {PREVIOUS} 失败", message)
        self.assertIn(f"线上仍是 {TAG}", message)
        self.assertNotIn("已切回", message)
        self.assertNotIn(("health", PREVIOUS), calls)
        self.assertIn(("record", "release FAILED rollback-failed"), calls)

    def test_rollback_switch_error_midway_asks_to_check(self):
        message, calls = self.switch({("health", TAG): 1, ("switch", PREVIOUS): 1})
        self.assertIn(f"切回 {PREVIOUS} 的过程中出错", message)
        self.assertNotIn("已切回", message)
        self.assertIn(("record", "release FAILED rollback-failed"), calls)

    def test_switch_to_missing_tag_changes_nothing(self):
        missing = "v9.9.9-fit.1-deadbee"
        message, calls = self.switch({("switch", missing): release.UNCHANGED}, tag=missing, note="switch")
        self.assertNotIn("健康检查", message)
        self.assertIn(f"没有切到 {missing}", message)
        self.assertIn(f"线上仍是 {PREVIOUS}", message)
        self.assertEqual(calls, [("switch", missing), ("record", "switch FAILED not-switched")])

    def test_switch_error_rolls_back_without_blaming_health(self):
        message, calls = self.switch({("switch", TAG): 1})
        self.assertIn(f"切换到 {TAG} 的过程中出错", message)
        self.assertNotIn(f"{TAG} 没有通过健康检查", message)
        self.assertIn(f"已切回 {PREVIOUS}，上一版健康检查通过", message)
        self.assertNotIn(("health", TAG), calls)
        self.assertIn(("health", PREVIOUS), calls)

    def test_unhealthy_release_rolls_back(self):
        message, calls = self.switch({("health", TAG): 1})
        self.assertIn(f"{TAG} 没有通过健康检查；已切回 {PREVIOUS}，上一版健康检查通过", message)
        self.assertIn(("record", "release FAILED rolled-back"), calls)

    def test_rollback_still_unhealthy(self):
        message, calls = self.switch({("health", TAG): 1, ("health", PREVIOUS): 1})
        self.assertIn(f"已切回 {PREVIOUS}，但上一版也没通过健康检查", message)
        self.assertIn(("record", "release FAILED rollback-unhealthy"), calls)

    def test_first_release_has_nothing_to_roll_back_to(self):
        message, calls = self.switch({("health", TAG): 1}, previous="")
        self.assertIn("也没有可切回的上一版", message)
        self.assertIn(("record", "release FAILED"), calls)

    def test_healthy_switch_records_release(self):
        srv = FakeServer({})
        with redirect_stdout(io.StringIO()):
            release.switch(srv, TAG, PREVIOUS, COMMIT, "digest")
        self.assertEqual(srv.calls[-1], ("record", "release"))


class OnlineProblemTest(unittest.TestCase):
    def test_tag_without_commit_is_refused(self):
        tag, online = release.parse_online("CANVAS_TAG=v0.8.3-fit.1\nREVISION=\n")
        self.assertEqual((tag, online), ("v0.8.3-fit.1", ""))
        problem = release.online_problem(tag, online, COMMIT)
        self.assertIsNotNone(problem)
        self.assertIn("取不到提交号", problem)

    def test_short_commit_from_tag(self):
        self.assertEqual(release.parse_online("CANVAS_TAG=v0.8.3-fit.1-abcdef1\nREVISION=\n"),
                         ("v0.8.3-fit.1-abcdef1", "abcdef1"))

    def test_first_release_passes(self):
        self.assertIsNone(release.online_problem("", "", COMMIT))

    def test_ancestry(self):
        for code, expected in [(0, None), (1, "不是"), (128, "本地找不到")]:
            with mock.patch.object(release, "is_ancestor", return_value=code):
                problem = release.online_problem(PREVIOUS, "b" * 40, COMMIT)
            if expected is None:
                self.assertIsNone(problem)
            else:
                self.assertIn(expected, problem)


class BuildScriptTest(unittest.TestCase):
    def test_installs_backup_and_disk_check_from_the_package(self):
        script = release.build_script(COMMIT, "v0.8.3-fit.2", TAG, NAME, "d" * 64)
        for name in ("backup.sh", "disk-check.sh"):
            self.assertIn(f"install -m 0755 /srv/canvas/build/{TAG}/deploy/{name} /opt/canvas/bin/{name}\n", script)
        self.assertLess(script.index("disk-check.sh"), script.rindex(f"rm -rf /srv/canvas/build/{TAG}"))


class SourceGateTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="release-test-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        gate = self.dir / "source_gate.py"
        gate.write_text(FAKE_GATE, encoding="utf-8")
        patcher = mock.patch.object(release, "GATE", gate)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tarball(self, content):
        """像 package() 一样把包放进一个单独的临时目录，返回包的路径。"""
        path = Path(tempfile.mkdtemp(dir=self.dir)) / f"{NAME}.tar.gz"
        data = content.encode()
        with tarfile.open(path, "w:gz") as tar:
            info = tarfile.TarInfo(f"{NAME}/web/constants.ts")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        return path

    def main(self, *argv, content="SUPPLIER", fit_repo=None, check_fit=0):
        """跑 release.main()：git、打包、bun 换成假的，Server 一被真连就报错。fit_repo 是 FIT_REPO 环境变量（None 表示没设），
        check_fit 是假 bun run check:fit 的退出码。返回 (退出信息, 输出, 打出的包, 跑过的子进程)。"""
        packed, ran = [], []

        def package(commit, name, dry=False):
            packed.append(self.tarball(content))
            return packed[-1], "digest"

        def connect(dry):
            if not dry:
                raise AssertionError("源码包闸门没过之前不该连服务器")
            return real_server(dry)

        def run(args, **kwargs):
            ran.append((args, kwargs))
            return subprocess.CompletedProcess(args, check_fit)

        real_server = release.Server
        env = {key: value for key, value in os.environ.items() if key != "FIT_REPO"}
        if fit_repo:
            env["FIT_REPO"] = fit_repo
        out = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        with mock.patch.object(sys, "argv", ["release.py", *argv]), mock.patch.object(sys, "stdout", out), \
                mock.patch.dict(os.environ, env, clear=True), mock.patch.object(release.subprocess, "run", run), \
                mock.patch.object(release, "resolve", return_value=(COMMIT, "v0.8.3-fit.2", TAG, NAME)), \
                mock.patch.object(release, "git_problems", return_value=[]), \
                mock.patch.object(release, "package", side_effect=package), \
                mock.patch.object(release, "Server", side_effect=connect):
            try:
                release.main()
                code = None
            except SystemExit as stop:
                code = stop.code
            out.flush()
            return code, out.buffer.getvalue().decode("utf-8"), packed, ran

    def test_gate_refuses_and_removes_the_package(self):
        tarball = self.tarball("SUPPLIER")
        with self.assertRaises(SystemExit) as failed:
            release.gate_source(tarball, dry=False)
        self.assertIn("拒绝", str(failed.exception.code))
        self.assertIn(f"{NAME}/web/constants.ts", str(failed.exception.code))
        self.assertFalse(tarball.parent.exists())

    def test_gate_dry_run_only_warns(self):
        output = io.StringIO()
        with redirect_stdout(output):
            release.gate_source(self.tarball("SUPPLIER"), dry=True)
        self.assertIn("警告（真发版会拒绝）", output.getvalue())

    def test_clean_package_passes(self):
        output = io.StringIO()
        with redirect_stdout(output):
            release.gate_source(self.tarball("clean"), dry=False)
        self.assertEqual(output.getvalue(), "")

    def test_missing_gate_is_a_problem(self):
        with mock.patch.object(release, "GATE", self.dir / "missing.py"):
            self.assertEqual(len(release.source_problems(self.tarball("clean"))), 1)

    def test_package_only_runs_the_gate(self):
        code, _, packed, _ = self.main("--package-only")
        self.assertIn("拒绝", str(code))
        self.assertFalse(packed[0].exists())

    def test_release_runs_the_gate_before_connecting(self):
        code, _, _, _ = self.main()
        self.assertIn("拒绝", str(code))
        self.assertIn("web/constants.ts", str(code))

    def test_dry_run_warns_scans_and_deletes_the_package(self):
        code, output, packed, _ = self.main("--dry-run")
        self.assertIsNone(code)
        self.assertIn("警告（真发版会拒绝）", output)
        self.assertIn("--dry-run：以上只是计划", output)
        self.assertFalse(packed[0].parent.exists())

    def test_check_fit_failure_refuses_before_packaging(self):
        for argv in ([], ["--package-only"]):
            code, _, packed, ran = self.main(*argv, content="clean", fit_repo="X:/fit", check_fit=1)
            self.assertIn("拒绝：check:fit 不通过（退出码 1", str(code), argv)
            self.assertEqual(packed, [], argv)
            self.assertEqual(len(ran), 1, argv)

    def test_check_fit_failure_only_warns_on_dry_run(self):
        code, output, packed, _ = self.main("--dry-run", content="clean", fit_repo="X:/fit", check_fit=1)
        self.assertIsNone(code)
        self.assertIn("警告（真发版会拒绝）：check:fit 不通过", output)
        self.assertEqual(len(packed), 1)

    def test_check_fit_passes_with_fit_repo(self):
        code, output, packed, ran = self.main("--package-only", content="clean", fit_repo="X:/fit")
        self.assertIsNone(code)
        self.assertEqual(len(packed), 1)
        (args, kwargs), = ran
        self.assertEqual(args, ["bun", "run", "check:fit"])
        self.assertEqual(Path(kwargs["cwd"]), release.REPO / "web")
        self.assertEqual(kwargs["env"]["FIT_REPO"], "X:/fit")

    def test_without_fit_repo_only_reminds(self):
        code, output, packed, ran = self.main("--package-only", content="clean")
        self.assertIsNone(code)
        self.assertEqual(ran, [])
        self.assertIn("没设 FIT_REPO", output)
        self.assertIn("FIT_REPO=<fit 仓库> bun run check:fit", output)

    def test_missing_bun_is_a_problem(self):
        def run(args, **kwargs):
            raise FileNotFoundError(args[0])
        with mock.patch.dict(os.environ, {"FIT_REPO": "X:/fit"}), redirect_stdout(io.StringIO()):
            self.assertIn("找不到 bun", release.fit_copy_problem(run))


class FetchGiteaTest(unittest.TestCase):
    """git 换成假的：remote get-url 的退出码和 fetch 的结果按参数给。"""

    def fetch(self, has_remote=True, code=0, stderr="", timeout=False):
        calls = []

        def run(args, **kwargs):
            calls.append(args[3:5])
            if args[3:5] == ["remote", "get-url"]:
                return subprocess.CompletedProcess(args, 0 if has_remote else 2, b"", b"error: No such remote 'gitea'\n")
            if timeout:
                raise subprocess.TimeoutExpired(args, 90)
            return subprocess.CompletedProcess(args, code, "", stderr)

        with mock.patch.object(release.subprocess, "run", run):
            return release.fetch_gitea(), calls

    def test_missing_remote_is_reported_without_fetching(self):
        problem, calls = self.fetch(has_remote=False)
        self.assertIn("本机没配远程 gitea", problem)
        self.assertIn("deploy/RELEASING.md", problem)
        self.assertEqual(calls, [["remote", "get-url"]])

    def test_fatal_line_is_the_reason(self):
        stderr = ("fatal: 'gitea' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\n"
                  "Please make sure you have the correct access rights\nand the repository exists.\n")
        problem, _ = self.fetch(code=128, stderr=stderr)
        self.assertIn("（fatal: 'gitea' does not appear to be a git repository）", problem)
        self.assertNotIn("and the repository exists", problem)

    def test_repository_not_found(self):
        problem, _ = self.fetch(code=128, stderr="remote: Not found.\nfatal: repository 'http://gitea.test/x.git/' not found\n")
        self.assertIn("（fatal: repository 'http://gitea.test/x.git/' not found）：内部 Gitea 仓库还没建好", problem)

    def test_without_fatal_line_uses_the_last_line(self):
        problem, _ = self.fetch(code=1, stderr="warning: one\nerror: two\n\n")
        self.assertIn("（error: two）", problem)

    def test_timeout_and_success(self):
        self.assertIn("（90 秒没有响应）", self.fetch(timeout=True)[0])
        self.assertIsNone(self.fetch()[0])

    def test_git_problems_lists_the_reason(self):
        with mock.patch.object(release, "git", return_value=""), \
                mock.patch.object(release, "fetch_gitea", return_value="本机没配远程 gitea（…）"):
            self.assertEqual(release.git_problems(COMMIT, allow_dirty=False), ["本机没配远程 gitea（…）"])


@unittest.skipUnless((release.REPO / ".git").exists() and shutil.which("git"), "要在本仓库的 git 检出里跑")
class PackageLineEndingTest(unittest.TestCase):
    def test_package_keeps_repository_bytes_under_autocrlf(self):
        """Windows 上 core.autocrlf=true 时 git archive 默认把文本文件转成 CRLF，服务器上的 sh 脚本会坏。
        package() 关掉了转换：在强制 autocrlf=true 的环境里打 HEAD 的包，包里的文件要和仓库里的 blob 一字不差。"""
        commit = release.git("rev-parse", "HEAD").strip()
        forced = {"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "core.autocrlf", "GIT_CONFIG_VALUE_0": "true",
                  "GIT_CONFIG_KEY_1": "core.eol", "GIT_CONFIG_VALUE_1": "crlf"}
        with mock.patch.dict(os.environ, forced), redirect_stdout(io.StringIO()):
            tarball, _ = release.package(commit, "pkg", dry=True)
        self.addCleanup(shutil.rmtree, tarball.parent, True)
        crlf = {}
        with tarfile.open(tarball) as tar:
            for member in tar:
                data = tar.extractfile(member).read() if member.isfile() else b""
                if b"\r\n" in data:
                    crlf[member.name.removeprefix("pkg/")] = data
        server_side = ("Dockerfile", "docker-entrypoint.sh", "deploy/backup.sh", "deploy/Caddyfile", "deploy/release.py")
        self.assertEqual([name for name in server_side if name in crlf], [])
        # 剩下带 CRLF 的只能是仓库里本来就是 CRLF 的文件（上游的图片、视频和个别 html）；只报文件名，不把内容打出来
        changed = [name for name, data in crlf.items() if data != subprocess.run(
            ["git", "-C", str(release.REPO), "cat-file", "blob", f"{commit}:{name}"], capture_output=True, check=True).stdout]
        self.assertEqual(changed, [])


if __name__ == "__main__":
    unittest.main()
