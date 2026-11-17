import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { REDACTIONS, loadRedactions, parseRedactions, redact, redactionHits } from "../../../../scripts/sync-fit-generate";

const OUT = fileURLToPath(new URL("..", import.meta.url));
const WEB = fileURLToPath(new URL("../../../..", import.meta.url));
/** 假词表。真词表在 deploy/private，不进源码包；这里的词不能和它重名，否则本文件自己就会被 check:fit 和发版闸门拦下。 */
const FAKE = parseRedactions(JSON.stringify({ words: ["acme7", "acmeapi", "示例供货"], patterns: ["lane\\s*#?\\s*\\d+"], allow: ["lane 0"], renames: { seedanceAcme7: "seedanceArray" } }));
const HEADER = "/*\nCopyright (C) 2023-2026 QuantumNous\n\nGNU Affero General Public License\n*/\n";

function listFiles(dir: string, prefix = ""): string[] {
    return readdirSync(dir).flatMap((name) => (statSync(path.join(dir, name)).isDirectory() ? listFiles(path.join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** 不经同步脚本的扫描器，直接用 TypeScript 的注释区间 API 找出文件里的全部注释。 */
function commentsIn(file: string, text: string) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found = new Map<number, string>();
    const visit = (node: ts.Node): void => {
        for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) found.set(range.pos, text.slice(range.pos, range.end));
        node.getChildren(source).forEach(visit);
    };
    visit(source);
    return [...found.values()];
}

test("词表匹配：不分大小写，驼峰处算边界，不误伤更长的词，中文按子串，allow 放行", () => {
    const text = "const seedanceAcme7 = 1 // ACMEAPI 和 validateAcmeApiRequest\nacme7x acme70 xacme7 lane #12 lane 0 经示例供货商";
    assert.deepEqual(redactionHits(text, FAKE), [
        [1, "Acme7"],
        [1, "ACMEAPI"],
        [1, "AcmeApi"],
        [2, "lane #12"],
        [2, "示例供货"],
    ]);
});

test("redact 只删注释：版权头、编译指令和字符串、正则、模板里的 // /* 原样保留，删完不留空行堆积", () => {
    const source = [
        "import { x } from './x' // acme7 1.0",
        "",
        "/** 说明 acme7 */",
        "export const URL_RE = /^https:\\/\\//i // 行尾注释",
        "// @ts-expect-error 指令要留",
        "const a = `x ${1 /* 内 */} // 不是注释 ${'/* 也不是 */'}`",
        "",
        "// 段落注释",
        "",
        "function f() {",
        "  // 开头注释",
        "",
        "  return a /* 中间 */ + x",
        "}",
        "",
    ];
    assert.equal(
        redact("x.ts", HEADER + source.join("\n"), FAKE),
        HEADER +
            [
                "import { x } from './x'",
                "",
                "export const URL_RE = /^https:\\/\\//i",
                "// @ts-expect-error 指令要留",
                "const a = `x ${1} // 不是注释 ${'/* 也不是 */'}`",
                "",
                "function f() {",
                "  return a + x",
                "}",
                "",
            ].join("\n"),
    );
});

test("redact 处理 .tsx：JSX 文字和属性里的 // 不当注释，{' '} 原样保留，代码里的注释照删", () => {
    const source = ["export function A() {", "  // 说明 acme7", "  return <a href='https://x' title=\"a // b\">见 https://openai.fit /{' '}{1 /* 内 */}</a>", "}", ""];
    assert.equal(redact("x.tsx", source.join("\n"), FAKE), [source[0], source[2].replace(" /* 内 */", ""), "}", ""].join("\n"));
});

test("redact 删注释会改变换行（自动补分号）时拒绝，不悄悄改坏代码", () => {
    assert.throws(() => redact("x.ts", "function f() {\n  return /*\n  */ 1\n}\n", FAKE), /代码 token 变了/);
});

test("redact 删掉文件开头的 // 和 /** */ 注释，输出从 import 开始", () => {
    const body = "import { x } from './x'\nexport const y = x\n";
    for (const head of ["// 文件说明 acme7\n", "/**\n * 文件说明 acme7\n */\n", "// 文件说明\n\n", "/** 说明 */ "]) assert.equal(redact("x.ts", head + body, FAKE), body, JSON.stringify(head));
});

test("redact 按改名表只改纯局部的名字和对它的引用，字符串不动", () => {
    const source = [
        "const seedanceAcme7 = (n: number) => ({ seconds: n })",
        "const { seconds: total = seedanceAcme7(0).seconds } = seedanceAcme7(1)",
        "function f({ seconds: seedanceAcme7 }: { seconds: number }, [first] = [seedanceAcme7]) { return seedanceAcme7 + first }",
        "const table = { lane: seedanceAcme7(5), 'seedanceAcme7': 1, [String(seedanceAcme7)]: 2 }",
        "export const used = table.lane.seconds + total + f({ seconds: 1 }) + `${'seedanceAcme7'}`",
        "",
    ];
    assert.equal(redact("x.ts", source.join("\n"), FAKE), source.join("\n").replace(/(?<!')seedanceAcme7/g, "seedanceArray"));
});

test("redact 改名表碰到属性名、导出名这类位置一律拒绝同步并说明位置，不悄悄改名也不跳过", () => {
    const local = "const seedanceAcme7 = 1\n";
    const cases: Array<[string, RegExp]> = [
        ["const o = { a: 1 }\nconst { seedanceAcme7: v } = o\n", /解构读取的属性名/],
        ["const o = { a: 1 }\nconst { seedanceAcme7 } = o\n", /解构读取的属性名/],
        ["const o = { get seedanceAcme7() { return 1 } }\n", /访问器名/],
        ["const o = { set seedanceAcme7(v: number) {} }\n", /访问器名/],
        ["class A { get seedanceAcme7() { return 1 } }\n", /访问器名/],
        ["class A { static set seedanceAcme7(v: number) {} }\n", /访问器名/],
        ["class A { seedanceAcme7() {} }\n", /方法名/],
        ["const o = { seedanceAcme7() {} }\n", /方法名/],
        ["interface I { seedanceAcme7(): void }\n", /方法名/],
        ["class A { seedanceAcme7 = 1 }\n", /属性名/],
        ["const o = { seedanceAcme7: 1 }\n", /属性名/],
        ["type T = { seedanceAcme7: number }\n", /属性名/],
        ["enum E { seedanceAcme7 }\n", /枚举成员/],
        ["const o = { a: 1 }\nconst v = (o as any)?.seedanceAcme7\n", /属性访问/],
        ["namespace N { export type X = 1 }\nlet v: N.seedanceAcme7\n", /属性访问/],
        ["class A { constructor(private seedanceAcme7: number) {} }\n", /参数属性/],
        [local + "export const o = { seedanceAcme7 }\n", /对象简写键/],
        [local + "export { seedanceAcme7 as other }\n", /导入名或导出名/],
        ["import { other as seedanceAcme7 } from './x'\n", /导入名或导出名/],
        [local + "export default seedanceAcme7\n", /导入名或导出名/],
        ["export const seedanceAcme7 = 1\n", /导出名/],
        ["export function seedanceAcme7() {}\n", /导出名/],
    ];
    for (const [code, position] of cases) {
        assert.throws(() => redact("x.ts", code, FAKE), position, code);
        assert.throws(() => redact("x.ts", code, FAKE), /x\.ts:\d+：改名表里的 seedanceAcme7 .*拒绝同步/, code);
    }
    assert.throws(() => redact("x.ts", "const seedanceAcme7 = 1\nconst seedanceArray = 2\n", FAKE), /已经有这个名字/);
});

test("没有词表时拒绝同步和核对", () => {
    assert.throws(() => loadRedactions(path.join(OUT, "__tests__", "no-such-redactions.json")), /找不到词表/);
});

test("同步副本里只剩生成说明和 AGPL 版权头两种注释", () => {
    const { files } = JSON.parse(readFileSync(path.join(OUT, "SOURCE.json"), "utf8")) as { files: Record<string, unknown> };
    for (const file of Object.keys(files).filter((name) => /\.tsx?$/.test(name))) {
        const extra = commentsIn(file, readFileSync(path.join(OUT, file), "utf8")).filter((comment) => !comment.startsWith("// 由 sync-fit-generate 生成") && !comment.includes("GNU Affero General Public License"));
        assert.deepEqual(extra, [], file);
    }
});

test("同步副本（含 JSON、垫片和测试）对内部词表 0 命中，SOURCE.json 记的是当前词表", { skip: !existsSync(REDACTIONS) && "词表只在内部仓库里，源码包里没有" }, () => {
    const redactions = loadRedactions();
    assert.equal(JSON.parse(readFileSync(path.join(OUT, "SOURCE.json"), "utf8")).redactionsSha256, redactions.sha256);
    for (const file of listFiles(OUT)) assert.deepEqual(redactionHits(readFileSync(path.join(OUT, file), "utf8"), redactions), [], file);
});

test("check:fit 没给 --repo 也不给 FIT_REPO 时不去猜本机路径，只核对哈希和词表并警告", { skip: !existsSync(REDACTIONS) && "词表只在内部仓库里，源码包里没有" }, () => {
    const env = { ...process.env };
    delete env.FIT_REPO;
    const result = spawnSync(process.execPath, ["scripts/sync-fit-generate.ts", "--check"], { cwd: WEB, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /没给 --repo 或 FIT_REPO/);
});
