import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteCredits } from "@/components/layout/github-link";
import { DIRECTOR_ENABLED } from "./features";
import { ANNOUNCEMENTS, FOOTER_LINKS, HOME_BANNERS, HOME_CTA, LICENSE_URL, PRIOR_PROJECTS, SOURCE_URL, UPSTREAM_PROJECT } from "./promo";

const UPSTREAM_CDN = /^https:\/\/gcore\.jsdelivr\.net\/gh\/tigerowo\/cdn-tdeh@v\d+(\.\d+)*\/img\/infinite-canvas\//;
const promoLinks = [
    ...ANNOUNCEMENTS.map((item) => item.url),
    ...HOME_BANNERS.flatMap((banner) => [banner.linkUrl]).filter((url): url is string => Boolean(url)),
    HOME_CTA.url,
    ...FOOTER_LINKS.map((item) => item.url),
];

test("every promotional link points at InferStream", () => {
    assert.ok(promoLinks.length >= 3);
    for (const url of promoLinks) assert.equal(new URL(url).hostname, "www.inferstream.cn", url);
});

test("feature demos stay on the upstream author's pinned CDN", () => {
    for (const banner of HOME_BANNERS) {
        for (const url of [banner.imageUrl, banner.videoUrl].filter((value): value is string => Boolean(value))) assert.match(url, UPSTREAM_CDN);
        assert.equal(banner.linkUrl, undefined);
    }
});

test("slide media never repeat and every slide has a meaningful alt", () => {
    const media = HOME_BANNERS.flatMap((banner) => [banner.imageUrl, banner.videoUrl].filter(Boolean));
    assert.equal(new Set(media).size, media.length);
    // 3D 导演台关着时少它那张（见 features.test）
    assert.equal(HOME_BANNERS.length, DIRECTOR_ENABLED ? 3 : 2);
    for (const banner of HOME_BANNERS) assert.ok(banner.alt.length >= 6, banner.alt);
});

test("站点署名包含 InferStream 和开源链接", () => {
    assert.deepEqual(FOOTER_LINKS, [{ label: "InferStream", url: "https://www.inferstream.cn" }]);
    const credits = renderToStaticMarkup(createElement(SiteCredits));
    assert.doesNotMatch(credits, /用户协议|隐私政策|user-agreement|privacy-policy/);
    assert.doesNotMatch(credits, /href=""/);
    assert.equal(credits.match(/<a /g)?.length, 4);
    for (const path of ["../app/(user)/page.tsx", "../app/(user)/login/page.tsx"]) {
        const page = readFileSync(new URL(path, import.meta.url), "utf8");
        assert.match(page, /<SiteCredits /, path);
        assert.doesNotMatch(page, /user-agreement|privacy-policy|用户协议|服务协议|隐私|同意|agreement|Checkbox/i, path);
    }
});

test("promotional copy carries no prices", () => {
    const copy = JSON.stringify({ ANNOUNCEMENTS, HOME_BANNERS, HOME_CTA, FOOTER_LINKS });
    assert.doesNotMatch(copy, /[¥￥]\d|元\/|\$\d/);
});

test("attribution links are only the upstream projects and the license text", () => {
    assert.equal(new URL(LICENSE_URL).hostname, "www.gnu.org");
    for (const project of [UPSTREAM_PROJECT, ...PRIOR_PROJECTS]) assert.match(project.url, /^https:\/\/github\.com\/[\w-]+\/infinite-canvas$/);
    assert.equal(SOURCE_URL, process.env.NEXT_PUBLIC_SOURCE_URL || "/source/");
});
