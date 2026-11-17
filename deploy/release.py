"""canvas.openai.fit 发版脚本（系统 python + paramiko，用 python -I 运行）。

发版流程：核对 git（工作区干净、提交已推到 gitea/openai-fit）→ 设了 FIT_REPO 时跑 check:fit 核对 fit 生成库副本
→ git archive 打源码包（关掉换行转换），核对包里 COMMIT 等于提交号
→ 源码包闸门（deploy/source_gate.py 按不进仓库的词表扫描，有不能公开的内容就拒绝）
→ 连服务器，要求线上在跑的提交是这次提交的祖先 → 上传 → 用同一份源码包 docker build
→ 源码包放进 /srv/canvas/source（Caddy 对外提供 /source/，满足 AGPL 第 13 条），这一版的 compose 按标签存进 /opt/canvas/compose/
→ 装上这一版的 compose、改 /opt/canvas/.env 的 CANVAS_TAG → docker compose up -d → 本机健康检查，不过就连 compose 一起切回上一版
→ 镜像只留最近 3 个 → 写 /opt/canvas/releases.tsv。

用法（在仓库根目录）：
  python -I deploy/release.py --dry-run             只打印计划和要在服务器上跑的命令，不连服务器（git 核对和源码包闸门只警告；
                                                    源码包只在本机临时目录打一次来过闸门，扫完就删）
  python -I deploy/release.py --package-only        只在本地打源码包、核对 COMMIT 并过源码包闸门，不连服务器
  python -I deploy/release.py [--ref <提交>]        发版，默认 HEAD
  python -I deploy/release.py --switch <镜像标签>   切到服务器上已有的镜像和它那一版的 compose（回滚用），标签见 releases.tsv
  python -I deploy/release.py --caddy [--ref <提交>]  把该提交里的 deploy/Caddyfile 校验后装到 /etc/caddy 并 reload
以上都可以加 --dry-run 先看计划。发版和 --caddy 要求工作区干净（--allow-dirty 放行）、提交已推到 gitea/openai-fit；
发版还要求线上在跑的提交是这次提交的祖先（有意发旧提交时加 --allow-older）。
发版和 --package-only 在设了环境变量 FIT_REPO（fit 仓库）时先跑 bun run check:fit，不通过就拒绝；没设只提醒。

登录信息：~/.config/openai-fit/canvas-server/access.json（环境变量 CANVAS_SERVER_ACCESS 可改），不进 git。
只读 host、port、user（或 username）、key_file（私钥）、known_hosts（固定主机密钥）这几个字段，key_file、known_hosts
是相对路径时按 access.json 所在目录解析；password 等其他字段一概不用（服务器只允许密钥登录），也不打印任何字段的值。
用户名不是 root 时，服务器命令都经 sudo -n 执行。细节见 deploy/RELEASING.md。
"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True  # 按路径加载 source_gate.py 时不在 deploy/ 下留 __pycache__（工作区会变脏，下次发版被拒）
REPO = Path(__file__).resolve().parents[1]
GATE = Path(__file__).with_name("source_gate.py")
ACCESS_PATH = Path(os.environ.get("CANVAS_SERVER_ACCESS") or Path.home() / ".config/openai-fit/canvas-server/access.json")
EXPECTED_HOST = os.environ.get("CANVAS_EXPECTED_HOST", "154.64.250.21")
GITEA, BRANCH = "gitea", "openai-fit"
SITE = "canvas.openai.fit"
APP_DIR = "/opt/canvas"
COMPOSE_DIR = f"{APP_DIR}/compose"
SOURCE_DIR = "/srv/canvas/source"
BUILD_DIR = "/srv/canvas/build"
IMAGE = "fit-canvas"
REVISION_LABEL = "org.opencontainers.image.revision"
KEEP_IMAGES = 3
TAG_PATTERN = r"v[0-9A-Za-z.]+(-[0-9A-Za-z.]+)*"
VIA_CADDY = f"curl -fsS --max-time 10 --resolve {SITE}:443:127.0.0.1 https://{SITE}"


def git(*args):
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout


def resolve(ref):
    commit = git("rev-parse", "--verify", f"{ref}^{{commit}}").strip()
    version = git("show", f"{commit}:VERSION").strip()
    if not re.fullmatch(TAG_PATTERN, version):
        sys.exit(f"VERSION 的内容 {version!r} 不像版本号（例如 v0.8.3-fit.1）")
    tag = f"{version}-{commit[:7]}"
    return commit, version, tag, f"infinite-canvas-{tag}"


def is_ancestor(older, newer):
    """git merge-base --is-ancestor 的退出码：0 是祖先（或同一个提交），1 不是，其他是本地找不到提交等错误。"""
    return subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", older, newer],
                          capture_output=True).returncode


def fetch_gitea():
    """git fetch gitea openai-fit；成功返回 None，失败返回拒绝原因。不弹密码框。
    git 的报错有好几行，最后一行常是「and the repository exists.」这类套话，所以取 fatal: 开头的那一行。"""
    if subprocess.run(["git", "-C", str(REPO), "remote", "get-url", GITEA], capture_output=True).returncode:
        return f"本机没配远程 {GITEA}（内部 Gitea 上的本仓库），按 deploy/RELEASING.md「发版前」第 4 步加上再发"
    try:
        done = subprocess.run(["git", "-C", str(REPO), "fetch", "--quiet", GITEA, BRANCH], capture_output=True,
                              text=True, encoding="utf-8", errors="replace", timeout=90,
                              env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"})
    except subprocess.TimeoutExpired:
        reason = "90 秒没有响应"
    else:
        if not done.returncode:
            return None
        lines = [line.strip() for line in done.stderr.splitlines() if line.strip()]
        reason = next((line for line in lines if line.startswith("fatal:")), lines[-1] if lines else f"退出码 {done.returncode}")
    return (f"git fetch {GITEA} {BRANCH} 失败（{reason}）：内部 Gitea 仓库还没建好、还没推过 {BRANCH} 分支，或者连不上。"
            f"建好仓库并 git push {GITEA} {BRANCH} 之后再发")


def git_problems(commit, allow_dirty):
    """发版前的本地核对，返回拒绝的原因（空列表表示通过）：工作区干净，提交已推到 gitea/openai-fit。"""
    problems = []
    if not allow_dirty and git("status", "--porcelain").strip():
        problems.append("工作区有未提交的改动。源码包和镜像只来自提交，先提交或收好这些改动；确实要带着它们发就加 --allow-dirty")
    failed = fetch_gitea()
    if failed:
        problems.append(failed)
    elif is_ancestor(commit, f"refs/remotes/{GITEA}/{BRANCH}"):
        problems.append(f"提交 {commit[:12]} 还没推到 {GITEA}/{BRANCH}：先 git push {GITEA} {BRANCH}，内部 Gitea 上要查得到发出去的源码")
    return problems


def fit_copy_problem(run=None):
    """web/src/lib/fit-generate 是 openai.fit 生成台的脱敏副本。设了 FIT_REPO（fit 仓库）就在 web/ 下跑一次
    bun run check:fit：按 SOURCE.json 记的提交号读 fit 源文件、脱敏重新生成后逐字节比对。不通过返回拒绝原因，通过返回 None。
    没设 FIT_REPO 时只提醒：不带它的 check:fit 只核对哈希，手改副本再把 SOURCE.json 里的哈希一起改掉就能通过。
    核对的是本机工作区里的副本；--ref 指别的提交或加了 --allow-dirty 时，和源码包里的不一定是同一份。"""
    repo = os.environ.get("FIT_REPO")
    if not repo:
        print("提醒：没设 FIT_REPO，这次没核对 fit 生成库副本；发版前要在 web/ 下跑 FIT_REPO=<fit 仓库> bun run check:fit"
              "（见 deploy/RELEASING.md「发版前」），或者设好 FIT_REPO 再跑本脚本")
        return None
    print("\n== 核对 fit 生成库副本：cd web && FIT_REPO=<fit 仓库> bun run check:fit", flush=True)
    try:
        code = (run or subprocess.run)(["bun", "run", "check:fit"], cwd=str(REPO / "web"),
                                       env={**os.environ, "FIT_REPO": repo}).returncode
    except FileNotFoundError:
        return "找不到 bun，没法跑 check:fit 核对 fit 生成库副本"
    if code:
        return (f"check:fit 不通过（退出码 {code}，原因见上面的输出）：web/src/lib/fit-generate 的副本和 fit 源码脱敏同步出来的不一致，"
                "或者词表命中、类型报错。副本禁止手改，按 AGENTS.md 用 bun run sync:fit 重新同步后再发")
    return None


def online_problem(tag, online, commit):
    """线上在跑的提交要是这次提交的祖先，否则发出去会把线上已有的改动退掉。返回拒绝原因，没问题返回 None。
    tag 是线上的 CANVAS_TAG（首发前为空）；有标签却取不到提交号时没法核对，和本地找不到线上提交一样拒绝。"""
    if not tag:
        return None
    if not online:
        return (f"线上的镜像 {tag} 取不到提交号（镜像上没有 {REVISION_LABEL} 标签，标签末尾也没有 7 位提交号，"
                f"可能是手工构建的），没法确认这次不会退掉线上的改动")
    code = is_ancestor(online, commit)
    if code == 0:
        return None
    if code == 1:
        return f"线上在跑的提交 {online[:12]} 不是 {commit[:12]} 的祖先，发出去会把线上已有的改动退掉；先把它合进来再发"
    return f"本地找不到线上在跑的提交 {online[:12]}（已 git fetch {GITEA}），没法确认这次不会退掉线上的改动"


def parse_online(output):
    """从服务器输出里取线上的镜像标签和提交号。镜像上读不到完整提交号时，退到标签末尾的 7 位短号。"""
    found = dict(re.findall(r"^(CANVAS_TAG|REVISION)=(.*)$", output, re.M))
    tag, revision = found.get("CANVAS_TAG", "").strip(), found.get("REVISION", "").strip()
    if tag and not re.fullmatch(TAG_PATTERN, tag):
        sys.exit(f"服务器 {APP_DIR}/.env 里的 CANVAS_TAG={tag!r} 不像镜像标签，先人工核对")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        short = re.search(r"-([0-9a-f]{7})$", tag)
        revision = short.group(1) if short else ""
    return tag, revision


def load_access(path):
    """读登录信息里发版要用的字段。password 在解析时就丢掉：服务器只允许密钥登录，脚本不碰密码，也不打印任何值。"""
    access = json.loads(path.read_text(encoding="utf-8"),
                        object_pairs_hook=lambda pairs: {k: v for k, v in pairs if k != "password"})
    user = access.get("user") or access.get("username")
    missing = [key for key in ("host", "key_file", "known_hosts") if not access.get(key)] + ([] if user else ["user"])
    if missing:
        sys.exit(f"{path} 缺字段：{'、'.join(missing)}")

    def local(value):
        file = Path(value).expanduser()
        return file if file.is_absolute() else path.parent / file

    result = {"host": access["host"], "port": int(access.get("port") or 22), "user": user,
              "key_file": local(access["key_file"]), "known_hosts": local(access["known_hosts"])}
    for key in ("key_file", "known_hosts"):
        if not result[key].is_file():
            sys.exit(f"{path} 里 {key} 指向的文件不存在")
    return result


def package(commit, name, dry=False):
    """git archive 打源码包到临时目录，核对包里的 COMMIT。dry 时 COMMIT 不对只警告（这个包只用来过闸门，过完就删）。"""
    out = Path(tempfile.mkdtemp(prefix="canvas-release-")) / f"{name}.tar.gz"
    # git archive 会按 core.autocrlf 转换换行；Windows 上默认转成 CRLF，这里关掉，源码包和镜像都用仓库里的原样内容。
    git("-c", "core.autocrlf=false", "-c", "core.eol=lf", "archive", "--format=tar.gz", f"--prefix={name}/",
        "-o", str(out), commit)
    try:
        with tarfile.open(out) as tar:
            stamped = tar.extractfile(f"{name}/COMMIT").read().decode().strip()
    except KeyError:
        stamped = "（没有 COMMIT 文件）"
    if stamped != commit:
        problem = f"源码包里的 COMMIT 是 {stamped}，应为 {commit}：COMMIT 和 .gitattributes（COMMIT export-subst）要先提交"
        if not dry:
            sys.exit(problem)
        print(f"警告（真发版会拒绝）：{problem}")
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"源码包 {out}（{out.stat().st_size // 1024} KB，sha256 {digest}），包里 COMMIT = {stamped}")
    return out, digest


def source_problems(tarball):
    """源码包闸门 deploy/source_gate.py：按不进仓库的词表扫描源码包，返回问题列表，空列表表示可以公开。
    release.py 用 python -I 跑，deploy/ 不在 sys.path 上，所以按文件路径加载。"""
    if not GATE.is_file():
        return [f"缺 deploy/{GATE.name}（源码包闸门），没法确认源码包里没有不能公开的内容"]
    spec = importlib.util.spec_from_file_location("source_gate", GATE)
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    return gate.scan_tarball(str(tarball))


def gate_source(tarball, dry):
    """源码包会经 /source/ 公开：闸门报出问题就逐条列出并拒绝（顺手删掉这个包），dry 时只警告。"""
    problems = source_problems(tarball)
    if problems and not dry:
        shutil.rmtree(tarball.parent)
        sys.exit("拒绝：源码包里有不能公开的内容（包会经 /source/ 公开）：\n" + "\n".join(f"- {p}" for p in problems))
    for problem in problems:
        print(f"警告（真发版会拒绝）：{problem}")


class Server:
    def __init__(self, dry):
        self.dry, self.user = dry, "root"
        if dry:
            note = "" if ACCESS_PATH.exists() else "，这个文件还不存在"
            print(f"服务器 {EXPECTED_HOST}（登录信息 {ACCESS_PATH}{note}）；--dry-run 不连接")
            return
        import paramiko
        access = load_access(ACCESS_PATH)
        if access["host"] != EXPECTED_HOST:
            sys.exit(f"拒绝：{ACCESS_PATH} 的 host 不是画布服务器 {EXPECTED_HOST}")
        self.user = access["user"]
        self.ssh = paramiko.SSHClient()
        self.ssh.load_host_keys(str(access["known_hosts"]))
        self.ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
        self.ssh.connect(access["host"], port=access["port"], username=self.user, key_filename=str(access["key_file"]),
                         look_for_keys=False, allow_agent=False, timeout=25)
        self.ssh.get_transport().set_keepalive(30)
        print(f"已连接画布服务器 {EXPECTED_HOST}")

    def run(self, title, script, timeout=900, check=True):
        print(f"\n== {title}", flush=True)
        if self.dry:
            print("".join(f"   $ {line}\n" for line in script.strip().splitlines()), end="")
            return 0, ""
        command = "bash -c " + shlex.quote("set -euo pipefail\n" + script)
        if self.user != "root":
            command = "sudo -n " + command
        channel = self.ssh.get_transport().open_session()
        channel.set_combine_stderr(True)
        channel.settimeout(timeout)
        channel.exec_command(command)
        lines = []
        for raw in channel.makefile("rb"):
            lines.append(raw.decode("utf-8", "replace").rstrip())
            print("   | " + lines[-1], flush=True)
        code = channel.recv_exit_status()
        if check and code:
            sys.exit(f"失败：{title}（退出码 {code}）")
        return code, "\n".join(lines)

    def upload(self, local, remote):
        print(f"\n== 上传 {Path(local).name} → {remote}", flush=True)
        if not self.dry:
            sftp = self.ssh.open_sftp()
            try:
                sftp.put(str(local), remote)
            finally:
                sftp.close()

    def online(self):
        """线上在跑的镜像标签和它的提交号；首发前都是空串。"""
        _, out = self.run("读线上的 CANVAS_TAG 和镜像上记的提交号", ONLINE_SCRIPT)
        return ("<上一版标签>", "") if self.dry else parse_online(out)


ONLINE_SCRIPT = f"""
tag=$(sed -n 's/^CANVAS_TAG=//p' {APP_DIR}/.env | tail -n 1)
echo "CANVAS_TAG=$tag"
[ -z "$tag" ] || echo "REVISION=$(docker image inspect -f '{{{{index .Config.Labels "{REVISION_LABEL}"}}}}' "{IMAGE}:$tag" 2>/dev/null || true)"
"""

PREFLIGHT = f"""
test -f {APP_DIR}/.env || {{ echo '缺 {APP_DIR}/.env，先按 deploy/server-setup.md 准备'; exit 1; }}
test "$(stat -c %u {APP_DIR}/data)" = 1000 || {{ echo '{APP_DIR}/data 要存在并归 uid 1000（容器里的 node 用户）'; exit 1; }}
docker compose version
mkdir -p {SOURCE_DIR} {BUILD_DIR} {APP_DIR}/bin {COMPOSE_DIR}
df -h / | tail -n 1
"""


def build_script(commit, version, tag, name, digest):
    image, tar, ctx = f"{IMAGE}:{tag}", f"/tmp/{name}.tar.gz", f"{BUILD_DIR}/{tag}"
    return f"""
echo '{digest}  {tar}' | sha256sum -c -
rm -rf {ctx} && mkdir -p {ctx}
tar -xzf {tar} -C {ctx} --strip-components=1
if docker image inspect {image} >/dev/null 2>&1; then
  echo '镜像 {image} 已存在，不重复构建'
else
  docker build --progress=plain -t {image} --build-arg NEXT_PUBLIC_SOURCE_COMMIT={commit} \\
    --label {REVISION_LABEL}={commit} --label org.opencontainers.image.version={version} {ctx}
fi
install -m 0644 {tar} {SOURCE_DIR}/{name}.tar.gz
cd {SOURCE_DIR} && sha256sum -- *.tar.gz > SHA256SUMS
install -m 0644 {ctx}/docker-compose.yml {COMPOSE_DIR}/{tag}.yml
install -m 0755 {ctx}/deploy/backup.sh {APP_DIR}/bin/backup.sh
install -m 0755 {ctx}/deploy/disk-check.sh {APP_DIR}/bin/disk-check.sh
rm -rf {ctx} {tar}
"""


UNCHANGED = 3  # switch_script 在改动任何东西之前就退出的退出码：目标镜像或它的 compose 存档不在服务器上


def switch_script(tag, current):
    """切到 tag：装上它那一版的 compose，再改 CANVAS_TAG、up -d。线上 current 的 compose 还没按标签存档时先存一份。
    目标镜像或 compose 存档不在时以 UNCHANGED 退出，什么都没改。"""
    return f"""
cd {APP_DIR}
mkdir -p {COMPOSE_DIR}
docker image inspect {IMAGE}:{tag} >/dev/null 2>&1 || {{ echo '没有镜像 {IMAGE}:{tag}，不切换'; exit {UNCHANGED}; }}
test -f {COMPOSE_DIR}/{tag}.yml || {{ echo '没有 {COMPOSE_DIR}/{tag}.yml（{tag} 的 compose 存档），不切换'; exit {UNCHANGED}; }}
if [ -n '{current}' ] && [ ! -f {COMPOSE_DIR}/{current}.yml ] && [ -f docker-compose.yml ]; then
  cp -p docker-compose.yml {COMPOSE_DIR}/{current}.yml && echo '线上 {current} 的 compose 已存档'
fi
install -m 0644 {COMPOSE_DIR}/{tag}.yml docker-compose.yml
[ -z "$(tail -c 1 .env)" ] || echo >> .env
sed -i '/^CANVAS_TAG=/d' .env
echo 'CANVAS_TAG={tag}' >> .env
docker compose up -d --remove-orphans
"""


def health_script(tag):
    return f"""
cd {APP_DIR}
for i in $(seq 1 60); do
  if [ "$(curl -fsS --max-time 5 http://127.0.0.1:8080/api/health 2>/dev/null || true)" = ok ] &&
     curl -fsS --max-time 10 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null &&
     docker compose ps --format '{{{{.Image}}}}' | grep -xF '{IMAGE}:{tag}' >/dev/null; then
    echo "本机健康检查通过（第 $i 次）"; exit 0
  fi
  sleep 2
done
echo '120 秒内健康检查没通过：'
docker compose ps || true
docker compose logs --tail 80 || true
exit 1
"""


def record_script(tag, commit, digest, previous, note):
    line = "\t".join([tag, commit, digest, previous or "-", note])
    return f"""
printf '%s\\t%s\\n' "$(date -u +%FT%TZ)" {shlex.quote(line)} >> {APP_DIR}/releases.tsv
tail -n 3 {APP_DIR}/releases.tsv
"""


def prune_script(keep):
    keep = " ".join(sorted({tag for tag in keep if tag}))
    return f"""
n=0
for t in $(docker image ls {IMAGE} --format '{{{{.Tag}}}}'); do
  [ "$t" = '<none>' ] && continue
  n=$((n + 1))
  case ' {keep} ' in *" $t "*) continue ;; esac
  [ "$n" -le {KEEP_IMAGES} ] && continue
  docker image rm "{IMAGE}:$t"
  rm -f "{COMPOSE_DIR}/$t.yml"
done
docker image prune -f
docker builder prune -f --filter until=168h
docker image ls {IMAGE}
"""


def failure_verdict(tag, previous, switched, back):
    """新版没起来之后的结论：(写进 releases.tsv 的结果, 退出信息)。
    switched 是切到 tag 那一步的退出码：0 是切过去了、健康检查没过；UNCHANGED 是切换前就停了，什么都没改；其他是切到一半出错。
    back 是自动切回 previous 的 (切换退出码, 健康检查退出码)，切回没成功时健康检查是 None；没有切回时 back 是 None。"""
    manual = f"马上人工处理（cd {APP_DIR} && grep CANVAS_TAG .env && docker compose ps && docker compose logs --tail 200）"
    if switched == UNCHANGED:
        return ("FAILED not-switched",
                f"失败：没有切到 {tag}（它的镜像或 compose 存档不在服务器上），什么都没改，线上仍是 {previous or '原来的状态'}")
    first = f"切换到 {tag} 的过程中出错（没做健康检查）" if switched else f"{tag} 没有通过健康检查"
    if back is None:
        return "FAILED", f"失败：{first}，也没有可切回的上一版"
    back_switched, back_healthy = back
    if back_switched == UNCHANGED:
        return ("FAILED rollback-failed",
                f"失败：{first}；切回 {previous} 失败（它的镜像或 compose 存档不在了），没有切回去，线上仍是 {tag}，{manual}")
    if back_switched:
        return "FAILED rollback-failed", f"失败：{first}；切回 {previous} 的过程中出错，线上现在是哪一版要人工确认，{manual}"
    if back_healthy:
        return "FAILED rollback-unhealthy", f"失败：{first}；已切回 {previous}，但上一版也没通过健康检查，站点可能挂着，{manual}"
    return "FAILED rolled-back", f"失败：{first}；已切回 {previous}，上一版健康检查通过"


def switch(srv, tag, previous, commit="-", digest="-", note="release"):
    switched, _ = srv.run(f"切换到 {IMAGE}:{tag}：装上它的 compose、改 .env 的 CANVAS_TAG、docker compose up -d",
                          switch_script(tag, previous), check=False)
    healthy = None
    if not switched:
        healthy, _ = srv.run("健康检查：8080/api/health 回 ok、3000 能打开、跑的是这个镜像（最多等 120 秒）",
                             health_script(tag), check=False)
    if srv.dry:
        print(f"\n== （切换出错或健康检查不过时）连同 compose 切回 {previous or '上一版'} 再做一次健康检查，按两步各自的结果报错退出；"
              "目标镜像或 compose 存档不在时什么都不改、不切回")
    if switched or healthy:
        back = None
        if switched != UNCHANGED and previous and previous != tag:
            back_switched, _ = srv.run(f"自动切回上一版 {previous}（连同它的 compose）", switch_script(previous, tag), check=False)
            back_healthy = None
            if not back_switched:
                back_healthy, _ = srv.run(f"上一版 {previous} 健康检查", health_script(previous), check=False)
            back = (back_switched, back_healthy)
        result, message = failure_verdict(tag, previous, switched, back)
        srv.run("写发版记录", record_script(tag, commit, digest, previous, f"{note} {result}"), check=False)
        sys.exit(message)
    srv.run("经 Caddy 访问（不通只提示：首发时 Caddy 可能还是占位页，装好 Caddyfile 后再看）", f"""
{VIA_CADDY}/api/health && echo || echo '经 Caddy 访问 /api/health 不通'
{VIA_CADDY}/source/infinite-canvas-{tag}.tar.gz -I -o /dev/null && echo '/source/ 能下载源码包' || echo '/source/ 下载源码包不通'
""", check=False)
    srv.run("写发版记录", record_script(tag, commit, digest, previous, note))


# Caddy 的管理接口在 unix socket /run/caddy/admin.sock（见 deploy/Caddyfile 顶部），这个目录由 caddy.service 的
# RuntimeDirectory=caddy 建出来。第一次从默认的 localhost:2019 换成 socket 时 reload 连不上新地址，要 restart 一次。
CADDY_SCRIPT = f"""
test -f /etc/caddy/canvas-admin-ips.caddy || {{ echo '缺 /etc/caddy/canvas-admin-ips.caddy（后台白名单），格式见 deploy/server-setup.md'; exit 1; }}
systemctl show -p RuntimeDirectory caddy | grep -qw caddy || {{ echo 'caddy.service 还没配 RuntimeDirectory=caddy（管理接口的 socket 目录），先按 deploy/server-setup.md 第 1 节加上'; exit 1; }}
install -m 0644 /tmp/canvas.Caddyfile /etc/caddy/Caddyfile.new && rm -f /tmp/canvas.Caddyfile
runuser -u caddy -- caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile
backup=/etc/caddy/Caddyfile.bak-$(date -u +%Y%m%dT%H%M%SZ)
cp -p /etc/caddy/Caddyfile "$backup"
mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
if [ -S /run/caddy/admin.sock ]; then how=reload; else how=restart; fi
if ! systemctl "$how" caddy; then
  cp -p "$backup" /etc/caddy/Caddyfile
  systemctl restart caddy || true
  echo "$how 失败，已恢复 $backup 并重启 Caddy"; exit 1
fi
echo "已启用（$how），旧配置备份在 $backup"
sleep 2
test -S /run/caddy/admin.sock && echo '管理接口在 /run/caddy/admin.sock' || echo '注意：没看到 /run/caddy/admin.sock'
ss -Hltn 'sport = :2019' | grep -q . && echo '注意：2019 端口还在监听' || echo '2019 端口已关闭'
{VIA_CADDY}/api/health && echo || echo '经 Caddy 访问 /api/health 不通（程序还没发版时正常）'
curl -sSI --max-time 10 --resolve {SITE}:443:127.0.0.1 https://{SITE}/ | grep -iE '^(HTTP/|strict-transport-security:|x-content-type-options:|x-frame-options:|referrer-policy:|content-security-policy-report-only:)' || true
"""


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")  # python -I 不读 PYTHONIOENCODING，Windows 控制台打印中文会崩
    parser = argparse.ArgumentParser(description="canvas.openai.fit 发版（说明见文件开头和 deploy/RELEASING.md）")
    parser.add_argument("--ref", default="HEAD", help="要发的提交，默认 HEAD")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不连服务器；git 核对和源码包闸门只警告")
    parser.add_argument("--allow-dirty", action="store_true", help="工作区有未提交的改动也照发（它们不会进源码包）")
    parser.add_argument("--allow-older", action="store_true", help="线上在跑的提交不是这次提交的祖先也照发（有意发旧提交）")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--package-only", action="store_true", help="只在本地打源码包并过源码包闸门")
    mode.add_argument("--switch", metavar="TAG", help="切到服务器上已有的镜像标签和它的 compose（回滚）")
    mode.add_argument("--caddy", action="store_true", help="安装该提交里的 deploy/Caddyfile")
    args = parser.parse_args()

    if args.switch:
        if not re.fullmatch(TAG_PATTERN, args.switch):
            sys.exit(f"镜像标签 {args.switch!r} 不对，应形如 v0.8.3-fit.1-a8401c6")
        srv = Server(args.dry_run)
        switch(srv, args.switch, srv.online()[0], note="switch")
        return

    commit, version, tag, name = resolve(args.ref)
    print(f"提交 {commit}  版本 {version}  镜像 {IMAGE}:{tag}")
    if not args.package_only:
        problems = git_problems(commit, args.allow_dirty)
        if problems and not args.dry_run:
            sys.exit("拒绝：\n" + "\n".join(f"- {problem}" for problem in problems))
        for problem in problems:
            print(f"警告（真发版会拒绝）：{problem}")

    if args.caddy:
        try:
            content = git("show", f"{commit}:deploy/Caddyfile")
        except subprocess.CalledProcessError:
            sys.exit(f"提交 {commit[:12]} 里没有 deploy/Caddyfile")
        local = Path(tempfile.mkdtemp(prefix="canvas-caddy-")) / "Caddyfile"
        local.write_text(content, encoding="utf-8", newline="\n")
        srv = Server(args.dry_run)
        srv.upload(local, "/tmp/canvas.Caddyfile")
        srv.run("以 caddy 用户 validate，通过后替换 /etc/caddy/Caddyfile 并 reload（失败自动恢复）", CADDY_SCRIPT)
        shutil.rmtree(local.parent)
        return

    if problem := fit_copy_problem():
        if not args.dry_run:
            sys.exit(f"拒绝：{problem}")
        print(f"警告（真发版会拒绝）：{problem}")

    print(f"\n== 本地 git archive {commit[:12]} → {name}.tar.gz（前缀 {name}/），核对包里 COMMIT 等于提交号，过源码包闸门")
    tarball, digest = package(commit, name, args.dry_run)
    gate_source(tarball, args.dry_run)
    if args.dry_run:
        shutil.rmtree(tarball.parent)
        tarball, digest = Path(f"{name}.tar.gz"), "<源码包 sha256>"
    if args.package_only:
        print("--package-only：没有连服务器" + ("，源码包过完闸门已删掉。" if args.dry_run else "，源码包留在上面的临时目录。"))
        return

    srv = Server(args.dry_run)
    srv.run("检查服务器：.env、data 目录属主、docker compose、目录", PREFLIGHT)
    previous, online = srv.online()
    if args.dry_run:
        print(f"\n== 核对：线上在跑的提交要是 {commit[:12]} 的祖先（--allow-older 放行）")
    elif problem := online_problem(previous, online, commit):
        if not args.allow_older:
            sys.exit(f"拒绝：{problem}。确实要发就加 --allow-older")
        print(f"注意（--allow-older）：{problem}")
    srv.upload(tarball, f"/tmp/{name}.tar.gz")
    srv.run(f"用同一份源码包构建 {IMAGE}:{tag}，源码包放进 {SOURCE_DIR}，compose 存成 {COMPOSE_DIR}/{tag}.yml，更新备份脚本",
            build_script(commit, version, tag, name, digest), timeout=3600)
    if not args.dry_run:
        shutil.rmtree(tarball.parent)
    switch(srv, tag, previous, commit, digest)
    srv.run(f"镜像只留最近 {KEEP_IMAGES} 个（当前和上一版总是保留），清理悬空层和 7 天前的构建缓存",
            prune_script([tag, previous]))
    if args.dry_run:
        print("\n--dry-run：以上只是计划，没有连服务器；源码包只在本机打来过闸门，已删掉。")
        return
    print(f"\n发版完成：{IMAGE}:{tag}（上一版 {previous or '无'}；回滚：python -I deploy/release.py --switch {previous or '<标签>'}）")


if __name__ == "__main__":
    main()
