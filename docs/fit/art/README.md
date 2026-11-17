# 横幅与图标的生成脚本

P1-ART 素材（logo、图标、OG 图、模型广场横幅、「令牌一键接入」动画）都由这里的脚本生成，不是手画的。要改文案、换模型名或重出尺寸时照下面的步骤重跑。

| 文件 | 作用 |
| --- | --- |
| `make_static.py` | 出 logo.svg、icon.png、apple-icon.png、opengraph-image.png、fit-models-1280x720.webp，并复制 fit 的 favicon.ico |
| `token_connect.html` | 「令牌一键接入」动画页面，`render(t)` 画出第 t 秒的画面，总长 `T = 14.5` 秒 |
| `capture.mjs` | 用 Chrome DevTools 协议逐帧截 `token_connect.html`，也能只截某一秒 |

## 准备

- Python 3 + Pillow，Node.js 22+，本机 Chrome（路径写死在 `make_static.py` 和 `capture.mjs` 的 `CHROME` 常量里，不同机器要改），ffmpeg。
- 脚本会在自己旁边写 HTML、PNG、`out/`、`frames/`、`chrome-profile/`，所以先把三个文件复制到一个临时目录再跑，不要在仓库里直接跑。
- 同一目录放好三个输入文件：
  - `pricing.json`：`GET https://openai.fit/api/pricing` 的原样返回（公开接口，只读，不需要令牌）。
  - `caps.json`：`GET https://openai.fit/api/model-capabilities` 的原样返回。
  - `geist-latin-wght-normal.woff2`：从 fit 仓库 `web/src/assets/fonts/` 复制（Geist 字体，OFL 授权）。
- `make_static.py` 从 fit 仓库检出的 `web/public/favicon.ico` 复制 favicon，仓库路径用第一个参数或环境变量 `FIT_REPO` 给。

## 静态素材

```bash
python -X utf8 make_static.py <openai.fit 仓库检出目录>
```

- 先校验横幅上的模型名：`MODELS` 里每个名字都要在价目表里；图片、视频还要在能力目录里是 `available` 且类型对得上；文本要带「文本生成」标签。不通过就直接退出，换模型改 `MODELS`。
- 横幅有溢出检查（名字超出列宽会退出），webp 会自动降质量压到 150KB 以内。
- 产物在 `out/`：`logo.svg`、`favicon.ico`、`icon.png`、`apple-icon.png`、`opengraph-image.png`、`fit-models-1280x720.webp`。

## 「令牌一键接入」动画

```bash
node capture.mjs 30 frames            # 30 fps 逐帧截图，共 435 帧，每帧 2560x1440
node capture.mjs 30 frames 11.9 poster.png   # 只截第 11.9 秒，做封面
```

原来转码的命令没有存下来，下面是按成品参数（ffprobe 读出）反推的写法，体积可能和原件略有出入，`-crf` / `-q:v` 按体积调：

```bash
# mp4：H.264 High、yuv420p、30 fps、1280x720、14.5 秒，原件约 454KB
ffmpeg -framerate 30 -i frames/f_%04d.png -vf scale=1280:720:flags=lanczos -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 30 -movflags +faststart out/fit-token-connect-720p.mp4

# webp 动图：720x405、约 9 fps（原件 132 帧）、无限循环，原件约 282KB
ffmpeg -framerate 30 -i frames/f_%04d.png -vf "fps=9,scale=720:-2:flags=lanczos" -c:v libwebp -q:v 70 -loop 0 out/fit-token-connect-720p.webp

# 封面：1280x720 JPEG
python -c "from PIL import Image; Image.open('poster.png').convert('RGB').resize((1280, 720), Image.LANCZOS).save('out/fit-token-connect-720p-poster.jpg', quality=85, optimize=True)"
```

- 动画里的令牌是打码的假值，整段动画不发任何真实请求。
- 动画还没有画出「导入前确认」弹窗：现在从链接导入令牌前会先弹窗显示打码令牌、名称和到期时间，重做动画时要在 `token_connect.html` 里补上这一步。

## 放回仓库

| 产物 | 放到 |
| --- | --- |
| `fit-models-1280x720.webp`、`fit-token-connect-720p.{mp4,webp}`、`fit-token-connect-720p-poster.jpg` | `web/public/banners/` |
| `logo.svg` | `web/public/logo.svg` |
| `favicon.ico`、`icon.png`、`apple-icon.png`、`opengraph-image.png` | `web/src/app/` |
