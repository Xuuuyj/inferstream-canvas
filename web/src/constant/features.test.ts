import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasDirectorNodePanel } from "@/app/(user)/canvas/components/canvas-director-node-panel";
import { CanvasToolbar } from "@/app/(user)/canvas/components/canvas-toolbar";
import { DIRECTOR_ENABLED } from "./features";
import { HOME_BANNERS } from "./promo";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const noop = () => {};

/** web/src 下的页面源码（不含测试和 fit 生成库同步副本）。 */
function sourceFiles(dir = SRC): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return path.endsWith(join("lib", "fit-generate")) ? [] : sourceFiles(path);
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
}

test("3D 导演台开着（业主 2026-11-02）", () => {
    assert.equal(DIRECTOR_ENABLED, true);
});

test("导演台的构建产物不读令牌、不请求外部地址（和画布同源，换新产物要重新审）", () => {
    const dir = fileURLToPath(new URL("../../public/director/assets/", import.meta.url));
    const bundle = readdirSync(dir)
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFileSync(join(dir, name), "utf8"))
        .join("\n");
    assert.doesNotMatch(bundle, /apiKey|baseUrl|openai\.fit/i);
    // 出现的 http(s) 地址只能是许可证、文档和 XML 命名空间这类字面量
    const hosts = new Set([...bundle.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1].toLowerCase()));
    const known = ["www.w3.org", "101arrowz.github.io", "docs.pmnd.rs", "github.com", "jcgt.org", "localforage.github.io", "mozilla.github.io", "reactjs.org"];
    assert.deepEqual([...hosts].filter((host) => !known.includes(host)), []);
});

test("首页功能演示有导演台那张", () => {
    assert.ok(HOME_BANNERS.some((banner) => /3ddirector/.test(banner.imageUrl)));
});

test("画布工具栏有导演台按钮；导演台节点给「打开导演台」", () => {
    const toolbar = renderToStaticMarkup(
        createElement(CanvasToolbar, {
            selectedCount: 0,
            canvasTool: "select",
            canUndo: false,
            canRedo: false,
            backgroundMode: "dots",
            showImageInfo: false,
            onAddImage: noop,
            onAddVideo: noop,
            onAddAudio: noop,
            onAddText: noop,
            onAddPanorama: noop,
            onAddDirector: noop,
            onAddConfig: noop,
            onUndo: noop,
            onRedo: noop,
            onUpload: noop,
            onDelete: noop,
            onClear: noop,
            onCanvasToolChange: noop,
            onBackgroundModeChange: noop,
            onShowImageInfoChange: noop,
            onOpenAssetLibrary: noop,
            onOpenMyAssets: noop,
        }),
    );
    assert.match(toolbar, /aria-label="全景图"/);
    assert.match(toolbar, /导演/);
    const node = renderToStaticMarkup(createElement(CanvasDirectorNodePanel, { onOpen: noop }));
    assert.match(node, /打开导演台/);
    assert.doesNotMatch(node, /3D 导演台暂未开放/);
});

test("其余入口（bun 导入画布页太慢，按源码查）：添加节点菜单、连线菜单、导演台弹层、侧栏筛选都挂在 DIRECTOR_ENABLED 上，别处没有新入口", () => {
    const page = read("app/(user)/canvas/[id]/canvas-client-page.tsx");
    const creates = page.split("\n").filter((line) => line.includes("onCreate(CanvasNodeType.Director)"));
    assert.equal(creates.length, 2);
    for (const line of creates) assert.match(line, /^\s+\{DIRECTOR_ENABLED \? <ConnectionCreateOption .*title="3D 导演台".* : null\}\r?$/);
    assert.match(page, /\{DIRECTOR_ENABLED && openDirectorNode\?\.type === CanvasNodeType\.Director \? \(\r?\n\s+<CanvasDirector\r?\n/);
    assert.equal(page.match(/setOpenDirectorNodeId\(contentNode\.id\)/g)?.length, 1);
    assert.match(read("app/(user)/canvas/components/canvas-side-panel.tsx"), /\.\.\.\(DIRECTOR_ENABLED \? \[\{ label: "导演台", value: CanvasNodeType\.Director \}\] : \[\]\),/);
    // 打开导演台（iframe /director/index.html）、新建导演台节点只在这几个文件里
    const owners = (pattern: RegExp) =>
        sourceFiles()
            .filter((path) => pattern.test(readFileSync(path, "utf8")))
            .map((path) => path.slice(SRC.length).replaceAll("\\", "/"))
            .sort();
    assert.deepEqual(owners(/["'`]\/director/), ["app/(user)/canvas/components/canvas-director.tsx"]);
    assert.deepEqual(owners(/<CanvasDirector\b/), ["app/(user)/canvas/[id]/canvas-client-page.tsx"]);
    assert.deepEqual(owners(/onAddDirector|tool-director|(createNode|onCreate)\(CanvasNodeType\.Director\)/), ["app/(user)/canvas/[id]/canvas-client-page.tsx", "app/(user)/canvas/components/canvas-toolbar.tsx"]);
    assert.deepEqual(owners(/^\s+打开导演台\r?$/m), ["app/(user)/canvas/components/canvas-director-node-panel.tsx"]);
});
