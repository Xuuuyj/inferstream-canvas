"""Build the static P1-ART files (logo, icons, OG image, model-square banner).

HTML is laid out here and exported with headless Chrome; webp/png post-processing uses Pillow.
Model names come from https://openai.fit/api/pricing (pricing.json, read-only GET) and image/video
names must also be `available` in /api/model-capabilities (caps.json).
Run: python -X utf8 make_static.py <openai.fit repo checkout> (or set FIT_REPO); favicon.ico is copied from its web/public.
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
FIT_REPO = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FIT_REPO")

# The two F\ paths from openai.fit's web/src/assets/logo.tsx (viewBox 0 0 100 100).
F_PATH = "M20.0 29.62H47.17V37.09H27.47V45.92H41.74V53.39H27.47V70.38H20.0Z"
SLASH_PATH = "M53.96 29.62H62.33L80.0 70.38H71.63Z"
GLYPH_VIEWBOX = "20 29.62 60 40.76"  # tight box around the two glyphs (60 x 40.76)

MODELS = {
    "视频": ["seedance-2.5-omni", "wan3.0-video", "minimax H3"],
    "图像": ["gpt-image-2", "gemini-nano-banana-2.1", "gemini-3-pro-image-preview"],
    "文本": ["gpt-6-astra", "claude-opus-5-5", "deepseek-v4-pro"],
}
KIND = {"视频": "video", "图像": "image"}


def check_models():
    pricing = {m["model_name"]: m for m in json.loads((HERE / "pricing.json").read_text("utf-8"))["data"]}
    caps = {m["id"]: m for m in json.loads((HERE / "caps.json").read_text("utf-8"))["models"]}
    problems = []
    for label, names in MODELS.items():
        for name in names:
            if name not in pricing:
                problems.append(f"{name}: not in /api/pricing")
            elif label in KIND:
                cap = caps.get(name)
                if not cap or not cap.get("available") or cap.get("kind") != KIND[label]:
                    problems.append(f"{name}: not an available {KIND[label]} model in /api/model-capabilities")
            elif "文本生成" not in (pricing[name].get("tags") or ""):
                problems.append(f"{name}: not tagged 文本生成")
    if problems:
        sys.exit("model check failed:\n" + "\n".join(problems))
    print("model names OK:", sum(len(v) for v in MODELS.values()))


def glyph_svg(height, color="#fff"):
    width = round(height * 60 / 40.76, 2)
    return (f'<svg viewBox="{GLYPH_VIEWBOX}" width="{width}" height="{height}" fill="{color}" aria-hidden="true">'
            f'<path d="{F_PATH}"/><path d="{SLASH_PATH}"/></svg>')


BASE_CSS = """
@font-face { font-family: Geist; src: url(geist-latin-wght-normal.woff2) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { font-family: Geist, "Noto Sans SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
"""


def page(name, body, css, w, h):
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{name}</title>
<style>{BASE_CSS}{css}</style></head><body style="width:{w}px;height:{h}px">{body}</body></html>"""
    path = HERE / f"{name}.html"
    path.write_text(html, "utf-8")
    return path


def shoot(html_path, png_path, w, h, scale=1):
    subprocess.run([
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
        "--default-background-color=00000000", f"--force-device-scale-factor={scale}",
        f"--window-size={w},{h}", "--virtual-time-budget=3000",
        f"--screenshot={png_path}", html_path.as_uri(),
    ], check=True, capture_output=True)
    im = Image.open(png_path)
    assert im.size == (w * scale, h * scale), (png_path, im.size)
    return im


def make_logo():
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="64" height="64">'
           f'<title>openai.fit</title><path d="{F_PATH}"/><path d="{SLASH_PATH}"/></svg>\n')
    (OUT / "logo.svg").write_text(svg, "utf-8")


def make_icons():
    shutil.copyfile(Path(FIT_REPO) / "web" / "public" / "favicon.ico", OUT / "favicon.ico")
    for name, size in (("icon", 512), ("apple-icon", 180)):
        body = (f'<svg viewBox="0 0 100 100" width="{size}" height="{size}" fill="#141413" style="display:block">'
                f'<path d="{F_PATH}"/><path d="{SLASH_PATH}"/></svg>')
        html = page(name, body, "body { background: #fff; }", size, size)
        im = shoot(html, OUT / f"{name}.png", size, size).convert("RGB")
        im.save(OUT / f"{name}.png", optimize=True)


def make_og():
    w, h = 1200, 630
    css = """
body { background: #0a0a0a; color: #fafafa; position: relative; }
.grid { position: absolute; inset: 0; background-image: radial-gradient(rgba(250,250,250,.22) 1.4px, transparent 1.2px);
        background-size: 28px 28px; background-position: 14px 14px;
        mask-image: linear-gradient(100deg, transparent 0%, transparent 42%, #000 100%); }
.wrap { position: absolute; inset: 0; padding: 76px 84px; display: flex; flex-direction: column; }
h1 { margin-top: 64px; font-size: 104px; line-height: 1.05; font-weight: 500; letter-spacing: -0.02em; }
p { margin-top: 28px; font-size: 34px; line-height: 1.45; color: #a3a3a3; font-weight: 400; }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: baseline;
        font-size: 24px; color: #737373; letter-spacing: 0.01em; }
.foot b { color: #fafafa; font-weight: 500; }
"""
    body = f"""<div class="grid"></div><div class="wrap">
{glyph_svg(46)}
<h1>无限画布</h1>
<p>openai.fit 出品的 AI 无限画布<br>文本、图片、视频一站创作</p>
<div class="foot"><span><b>canvas.openai.fit</b></span><span>用 openai.fit 令牌即可创作</span></div>
</div>"""
    html = page("opengraph-image", body, css, w, h)
    im = shoot(html, HERE / "opengraph-image@2x.png", w, h, 2).convert("RGB")
    im.resize((w, h), Image.LANCZOS).save(OUT / "opengraph-image.png", optimize=True)


def make_models_banner():
    w, h = 1280, 720
    css = """
body { background: #0a0a0a; color: #fafafa; }
.wrap { position: absolute; inset: 0; padding: 72px 88px 60px; display: flex; flex-direction: column; }
.top { display: flex; justify-content: space-between; align-items: center; }
.cta { font-size: 21px; color: #a3a3a3; letter-spacing: 0.01em; }
.cta b { color: #fafafa; font-weight: 500; }
h1 { margin-top: 58px; font-size: 82px; line-height: 1.14; font-weight: 500; letter-spacing: -0.02em; }
.sub { margin-top: 26px; font-size: 29px; line-height: 1.4; color: #a3a3a3; }
.models { margin-top: auto; border-top: 1px solid #2a2a2a; padding-top: 26px;
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); column-gap: 40px; }
.label { font-size: 19px; color: #737373; letter-spacing: 0.08em; margin-bottom: 10px; }
.name { font-size: 25px; line-height: 1.5; color: #e5e5e5; white-space: nowrap; letter-spacing: -0.005em; }
"""
    cols = "".join(
        f'<div><div class="label">{label}</div>' + "".join(f'<div class="name">{n}</div>' for n in names) + "</div>"
        for label, names in MODELS.items()
    )
    body = f"""<div class="wrap">
<div class="top">{glyph_svg(44)}<span class="cta">模型广场 <b>openai.fit/pricing</b> →</span></div>
<h1>一个接口，<br>接入生成式 AI</h1>
<p class="sub">视频、图像与文本模型，OpenAI 兼容格式，按量计费</p>
<div class="models">{cols}</div>
</div>"""
    # overflow guard: every name must fit its column (checked in the browser via a title marker)
    body += """<script>
document.fonts.ready.then(() => {
  const bad = [...document.querySelectorAll('.name')].filter(e => e.scrollWidth > e.parentElement.clientWidth);
  document.title = bad.length ? 'OVERFLOW ' + bad.map(e => e.textContent).join(',') : 'OK';
});
</script>"""
    html = page("fit-models-banner", body, css, w, h)
    dump = subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--virtual-time-budget=3000",
                           f"--window-size={w},{h}", "--dump-dom", html.as_uri()],
                          check=True, capture_output=True, text=True, encoding="utf-8").stdout
    if "<title>OK</title>" not in dump:
        sys.exit("banner layout check failed: " + dump[dump.find("<title>"):dump.find("</title>") + 8])
    im = shoot(html, HERE / "fit-models@2x.png", w, h, 2).convert("RGB").resize((w, h), Image.LANCZOS)
    im.save(HERE / "fit-models-1280x720.png")
    for q in (90, 86, 82, 78, 74, 70):
        target = OUT / "fit-models-1280x720.webp"
        im.save(target, "WEBP", quality=q, method=6)
        if target.stat().st_size <= 150 * 1024:
            print("banner webp quality", q, target.stat().st_size, "bytes")
            break
    else:
        sys.exit("banner webp still over 150KB")


if __name__ == "__main__":
    if not FIT_REPO:
        sys.exit("usage: python -X utf8 make_static.py <openai.fit repo checkout> (or set FIT_REPO)")
    check_models()
    make_logo()
    make_icons()
    make_og()
    make_models_banner()
    for p in sorted(OUT.iterdir()):
        print(p.name, p.stat().st_size)
