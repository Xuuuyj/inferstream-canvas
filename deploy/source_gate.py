"""源码包闸门：发版前扫一遍 git archive 打出的源码包，命中内部敏感词或带进了 deploy/private/ 就不许发布。

  python -I deploy/source_gate.py <源码包.tar.gz> [--redactions <词表>]

词表默认是 deploy/private/source-redactions.json（.gitattributes 设了 export-ignore，只在内部仓库里，不进源码包），
缺失时直接判不通过。匹配规则和 web/scripts/sync-fit-generate.ts 的 redactionHits 一致：words 不分大小写，
词的开头或结尾是英文字母、数字时，那一侧不能紧贴英文字母或数字（驼峰处的大写字母算边界），中文按子串；
patterns 是不分大小写的正则；命中文字在 allow 里的放行。
文本文件按扩展名和能否按 UTF-8 解码判断，图片、音视频、字体、压缩包不扫；文件名也扫。
"""
import argparse
import json
import re
import sys
import tarfile
from pathlib import Path

DEFAULT_REDACTIONS = Path(__file__).resolve().parent / "private" / "source-redactions.json"
PRIVATE = re.compile(r"(^|/)deploy/private(/|$)")
BINARY = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".mp4", ".webm", ".mov", ".mp3", ".wav",
          ".ogg", ".m4a", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".zip", ".gz", ".tgz", ".pdf", ".glb", ".wasm",
          ".db", ".sqlite"}
ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def load_redactions(path):
    """返回 (words, patterns, allow)：词和放行文字都按 ASCII 转小写。"""
    data = json.loads(Path(path).read_text("utf-8"))
    return ([word.translate(ASCII_LOWER) for word in data["words"]], [re.compile(p, re.I) for p in data["patterns"]],
            {text.translate(ASCII_LOWER) for text in data.get("allow", [])})


def _alnum(ch):
    return ch.isascii() and ch.isalnum()


def hits(text, words, patterns, allow=()):
    """返回 [(行号, 命中的文字)]，按出现位置排序；命中文字在 allow 里的不算。"""
    lower = text.translate(ASCII_LOWER)
    found = []
    for word in words:
        start = lower.find(word)
        while start >= 0:
            end = start + len(word)
            before, after = text[start - 1] if start else "", text[end] if end < len(text) else ""
            left = not _alnum(text[start]) or not _alnum(before) or (before.islower() or before.isdigit()) and text[start].isupper()
            right = not _alnum(text[end - 1]) or not _alnum(after) or after.isupper()
            if left and right:
                found.append((start, text[start:end]))
            start = lower.find(word, start + 1)
    for pattern in patterns:
        found += [(m.start(), m.group(0)) for m in pattern.finditer(text)]
    return [(text.count("\n", 0, pos) + 1, word) for pos, word in sorted(found)
            if word.translate(ASCII_LOWER) not in allow]


def scan_tarball(tar_path: str, redactions_path: str | None = None) -> list[str]:
    """返回问题列表，空列表表示可以发布。release.py 打包后调用它，命中就拒绝发版。"""
    path = Path(redactions_path) if redactions_path else DEFAULT_REDACTIONS
    if not path.is_file():
        return [f"词表缺失：{path}（内部仓库的 deploy/private/source-redactions.json），没法检查源码包"]
    try:
        redactions = load_redactions(path)
    except (ValueError, KeyError, re.error) as error:
        return [f"词表读不了：{path}：{error}"]
    problems = []
    with tarfile.open(tar_path) as tar:
        for member in tar:
            name = member.name
            if PRIVATE.search(name):
                problems.append(f"{name}：deploy/private/ 不许进源码包（.gitattributes 要给 deploy/private 设 export-ignore）")
                continue
            problems += [f"{name}：文件名命中「{word}」" for _, word in hits(name, *redactions)]
            if not member.isfile() or Path(name).suffix.lower() in BINARY:
                continue
            try:
                text = tar.extractfile(member).read().decode("utf-8")
            except UnicodeDecodeError:
                continue
            if "\0" not in text:
                problems += [f"{name}:{line}：命中「{word}」" for line, word in hits(text, *redactions)]
    return problems


def main(argv=None):
    # python -I 会忽略 PYTHONIOENCODING，Windows 控制台打印中文前先改成 utf-8
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="发版前检查源码包里有没有内部敏感信息")
    parser.add_argument("tar", help="git archive 打出的源码包（.tar 或 .tar.gz）")
    parser.add_argument("--redactions", help=f"词表路径，默认 {DEFAULT_REDACTIONS}")
    args = parser.parse_args(argv)
    problems = scan_tarball(args.tar, args.redactions)
    if problems:
        print(f"源码包不能发布，{len(problems)} 处问题：")
        print("\n".join(f"- {problem}" for problem in problems))
        return 1
    print(f"源码包检查通过：{args.tar}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
