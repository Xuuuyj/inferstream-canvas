/**
 * 把 openai.fit 在线生成台的纯函数、价格提示（ModelPriceHint）和它用的模型广场价格库同步到 src/lib/fit-generate。副本禁止手改，只能由本脚本更新。
 *
 *   bun run sync:fit --repo <fit 检出目录>   同步那个检出的 HEAD；要同步的源文件有未提交改动时拒绝
 *   bun run check:fit [--repo <fit 仓库>]    核对 SOURCE.json 的哈希和词表，给了仓库再按源文件重新生成、逐字节比对，最后用项目 tsconfig 类型检查一遍
 *
 * 同步哪个提交：给线上 openai.fit 二进制的源码提交（fit 仓库 deploy/RELEASE.md 最新一条发版记录）建一个干净的检出，用 --repo 指过来。
 * --repo 也可以用环境变量 FIT_REPO；check 两者都没给时只核对哈希和词表，并给出警告。
 *
 * 副本会随 /source/ 的源码包公开，fit 线上的 JS 是压缩过的，注释和局部名不会露出来，副本不能比它露得更多：
 * 复制时删掉 .ts/.tsx 里除文件头 AGPL 版权注释以外的全部注释（代码 token 一个不动），再按词表的 renames 给标识符改名；
 * 同步结果（含 JSON 副本）里还有词表命中就拒绝。词表是 deploy/private/source-redactions.json，只在内部仓库里、不进源码包，
 * 没有它同步和核对都拒绝；匹配规则和 deploy/source_gate.py 一致。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(WEB, "src/lib/fit-generate");
export const REDACTIONS = path.resolve(WEB, "../deploy/private/source-redactions.json");
const SOURCE_JSON = "SOURCE.json";
const MESSAGES = "messages.zh.json";
const ZH = "web/src/i18n/locales/zh.json";
const HAND_WRITTEN = ["shims/", "__tests__/"];
const NOTICE = "// 由 sync-fit-generate 生成（已删去原注释），勿手改；更新用 bun run sync:fit，来源见 SOURCE.json\n";
const LICENSE_MARK = "GNU Affero General Public License";
/** 影响编译的指令注释照留。 */
const DIRECTIVE = /^\/\/\/?\s*(@ts-|<reference\s)/;
const TRANSPORT = "@/services/api/fit/transport";
const BUILDERS_IMPORT = "from './request-builders'\n";
const WITH_FIT_FETCH = `${BUILDERS_IMPORT}import { fitFetch as fetch } from '${TRANSPORT}'\n`;
const LIB = ["canonical-capabilities", "capability-feed", "model-profiles", "request-builders", "validate-submission", "prompt-length", "prompt-mentions", "hosting-plan", "reference-ratio", "image-downscale", "relay-client", "upload-client"];
/** 生成台价格提示（ModelPriceHint）和它用到的模型广场价格库，副本放在 pricing/ 下，路径和 fit 的 features/pricing/ 一一对应。 */
const PRICING = [
    "types.ts",
    "constants.ts",
    ...["dynamic-price", "billing-expr", "model-helpers", "plugin-pricing", "task-expr", "price"].map((name) => `lib/${name}.ts`),
    ...["display", "parser", "runtime", "structure", "types"].map((name) => `lib/billing-expression/${name}.ts`),
];
const CURRENCY = "'../../shared/currency'";

/** 副本路径（相对 src/lib/fit-generate）→ fit 仓库里的源路径。 */
const FILES: Record<string, string> = Object.fromEntries([
    ...["types.ts", "constants.ts", "model-capabilities.json", "components/model-price-hint.tsx", ...LIB.map((name) => `lib/${name}.ts`)].map((file) => [file, `web/src/features/generate/${file}`]),
    ...PRICING.map((file) => [`pricing/${file}`, `web/src/features/pricing/${file}`]),
    ["shared/currency.ts", "web/src/lib/currency.ts"],
    ["testdata/studio-declared-entries.golden.json", "model/testdata/studio-declared-entries.golden.json"],
]);

/** 只有这些字面替换（把 fit 的 @/ 引用改指到副本或垫片），每处必须恰好命中 1 次。 */
const EDITS: Record<string, Array<[from: string, to: string]>> = {
    "types.ts": [["'@/features/pricing/types'", "'./shims/pricing-types'"]],
    "lib/model-profiles.ts": [
        ["'@/features/pricing/types'", "'../shims/pricing-types'"],
        ["'@/features/pricing/lib/filters'", "'../shims/pricing-filters'"],
    ],
    "lib/relay-client.ts": [[BUILDERS_IMPORT, WITH_FIT_FETCH]],
    "lib/upload-client.ts": [[BUILDERS_IMPORT, WITH_FIT_FETCH]],
    "components/model-price-hint.tsx": [
        ["'react-i18next'", "'../shims/i18n'"],
        ...["lib/dynamic-price", "lib/model-helpers", "lib/price", "types"].map((name): [string, string] => [`'@/features/pricing/${name}'`, `'../pricing/${name}'`]),
        ["'@/lib/utils'", "'../shims/utils'"],
    ],
    "pricing/constants.ts": [["'i18next'", "'../shims/i18n'"]],
    "pricing/lib/dynamic-price.ts": [["'@/lib/currency'", CURRENCY]],
    "pricing/lib/price.ts": [["'@/lib/currency'", CURRENCY]],
    "shared/currency.ts": [["'@/stores/system-config-store'", "'../shims/system-config-store'"]],
};
const isScript = (file: string) => /\.tsx?$/.test(file);

type SourceRecord = { notice: string; commit: string; redactionsSha256: string; files: Record<string, { source: string; sourceSha256: string; sha256: string }> };
export type Redactions = { words: string[]; patterns: RegExp[]; allow: Set<string>; renames: Record<string, string>; sha256: string };
type Token = { kind: ts.SyntaxKind; start: number; end: number };

/** 拒绝同步或核对不通过；命令行入口打印说明后以 1 退出，测试里能直接断言。 */
class SyncError extends Error {}

function fail(message: string): never {
    throw new SyncError(message);
}

function git(repo: string, ...args: string[]) {
    return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function sha256(text: string) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 只把 A-Z 转小写，长度不变，命中位置能直接对回原文。 */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
const isAlnum = (ch = "") => /^[A-Za-z0-9]$/.test(ch);

export function loadRedactions(file = REDACTIONS): Redactions {
    if (!existsSync(file)) fail(`找不到词表 ${file}（只在内部仓库里，不进源码包）。没有词表就没法保证副本里不带供货方名字和渠道号，拒绝同步和核对。`);
    return parseRedactions(readFileSync(file, "utf8"));
}

export function parseRedactions(raw: string): Redactions {
    const text = raw.replace(/\r\n/g, "\n");
    const data = JSON.parse(text);
    return {
        words: data.words.map(asciiLower),
        patterns: data.patterns.map((pattern: string) => new RegExp(pattern, "gi")),
        allow: new Set((data.allow ?? []).map(asciiLower)),
        renames: data.renames ?? {},
        sha256: sha256(text),
    };
}

/** 词表命中 [行号, 命中文字]：词不分大小写，词首尾是字母数字时那一侧不能紧贴字母数字（驼峰处的大写字母算边界），中文按子串；patterns 是正则；allow 里的放行。 */
export function redactionHits(text: string, { words, patterns, allow }: Redactions) {
    const lower = asciiLower(text);
    const found: Array<[number, string]> = [];
    for (const word of words) {
        for (let start = lower.indexOf(word); start >= 0; start = lower.indexOf(word, start + 1)) {
            const end = start + word.length;
            const [before, after] = [text[start - 1], text[end]];
            const left = !isAlnum(text[start]) || !isAlnum(before) || (/[a-z0-9]/.test(before) && /[A-Z]/.test(text[start]));
            const right = !isAlnum(text[end - 1]) || !isAlnum(after) || /[A-Z]/.test(after);
            if (left && right) found.push([start, text.slice(start, end)]);
        }
    }
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push([match.index, match[0]]);
    return found
        .filter(([, hit]) => !allow.has(asciiLower(hit)))
        .sort(([a], [b]) => a - b)
        .map(([start, hit]) => [text.slice(0, start).split("\n").length, hit] as const);
}

function applyEdits(file: string, text: string) {
    for (const [from, to] of EDITS[file] ?? []) {
        const hits = text.split(from).length - 1;
        if (hits !== 1) fail(`${file}：${JSON.stringify(from)} 应恰好命中 1 处，实际 ${hits} 处。fit 源码变了，先核对再改 sync-fit-generate 的替换规则。`);
        text = text.replace(from, () => to);
    }
    return text;
}

const isComment = (kind: ts.SyntaxKind) => kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia;

/** 用扫描器切出全部 token（含注释，不含空白）。扫描器自己分不清 / 是除号还是正则、} 后面是不是模板续段、是不是 JSX 文字，按 AST 在这些位置重扫，免得把正则、模板或 JSX 文字里的 // 当成注释。 */
function scanTokens(file: string, text: string) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const regex = new Set<number>();
    const template = new Set<number>();
    const jsxText = new Set<number>();
    const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) regex.add(node.getStart(source));
        else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) template.add(node.getStart(source));
        else if (ts.isJsxText(node) && !node.containsOnlyTriviaWhiteSpaces) jsxText.add(node.getStart(source));
        ts.forEachChild(node, visit);
    };
    visit(source);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, file.endsWith(".tsx") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
    const tokens: Token[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        const start = scanner.getTokenStart();
        if (regex.has(start)) kind = scanner.reScanSlashToken();
        else if (template.has(start)) kind = scanner.reScanTemplateToken(false);
        else if (jsxText.has(start)) kind = scanner.reScanJsxToken();
        if (kind !== ts.SyntaxKind.WhitespaceTrivia && kind !== ts.SyntaxKind.NewLineTrivia) tokens.push({ kind, start, end: scanner.getTokenEnd() });
    }
    return { source, tokens };
}

/** 代码 token 的指纹：种类、和上一个代码 token 之间有没有换行（管自动补分号）和原文，改名的位置换成新名字。第一个代码 token 前面没有别的代码，记成没有换行（文件开头的注释删掉后它前面的换行也没了）。 */
function codeTokens(file: string, text: string, renamed = new Map<number, string>()) {
    let previous = -1;
    return scanTokens(file, text)
        .tokens.filter(({ kind }) => !isComment(kind))
        .map(({ kind, start, end }) => {
            const lineBreak = previous >= 0 && text.slice(previous, start).includes("\n");
            previous = end;
            return `${kind}${lineBreak ? "\n" : " "}${renamed.get(start) ?? text.slice(start, end)}`;
        });
}

/** 删掉 [start, end) 这段注释时怎么处理周围空白：独占的行整行删（在文件开头、上下都是空行、或上一行以 { ( [ 结尾时连带删掉下面的空行，下一行是 } ) ] 时删掉上面的空行），行尾注释连同前面的空格删，夹在代码中间的只留一个空格、也不让两边粘在一起。 */
function commentEdit(text: string, start: number, end: number): [number, number, string] {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end);
    const before = text.slice(lineStart, start);
    const after = text.slice(end, lineEnd);
    if (!before.trim() && !after.trim()) {
        const prevStart = lineStart ? text.lastIndexOf("\n", lineStart - 2) + 1 : -1;
        const prev = lineStart ? text.slice(prevStart, lineStart - 1) : null;
        const nextEnd = text.indexOf("\n", lineEnd + 1) < 0 ? text.length : text.indexOf("\n", lineEnd + 1);
        const next = lineEnd + 1 < text.length ? text.slice(lineEnd + 1, nextEnd) : null;
        if (next !== null && !next.trim() && (prev === null || !prev.trim() || /[{([]\s*$/.test(prev))) return [lineStart, Math.min(nextEnd + 1, text.length), ""];
        if (prev !== null && !prev.trim() && next !== null && /^\s*[})\]]/.test(next)) return [prevStart, Math.min(lineEnd + 1, text.length), ""];
        return [lineStart, Math.min(lineEnd + 1, text.length), ""];
    }
    const lead = before.length - before.trimEnd().length;
    const trail = after.length - after.trimStart().length;
    if (!after.trim()) return [start - lead, end, ""];
    if (!before.trim()) return [start, end + trail, ""];
    if (lead) return trail ? [start, end + trail, ""] : [start - lead, end, ""];
    return [start, end, trail ? "" : " "];
}

/**
 * 标识符在会成为属性名或对外名字的位置时返回位置说明，纯局部的名字（局部变量、函数、类、参数、解构出的局部变量）和对它的引用返回 null。
 * 这些位置改名会悄悄改掉读写的属性、对象的键或别处的引用，不改又会把原名留在副本里，所以改名表碰到就拒绝同步。
 */
function memberPosition(node: ts.Identifier) {
    const parent = node.parent;
    const isName = "name" in parent && parent.name === node;
    if ((ts.isPropertyAccessExpression(parent) && isName) || (ts.isQualifiedName(parent) && parent.right === node)) return "属性访问的属性名（a.X、A.X）";
    if (isName && (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isEnumMember(parent))) return "对象、类、类型的属性名或枚举成员";
    if (isName && (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent))) return "方法名或 get/set 访问器名";
    if (ts.isShorthandPropertyAssignment(parent) && isName) return "对象简写键（{ X }）";
    if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent) && (parent.propertyName === node || (isName && !parent.propertyName))) return "解构读取的属性名（{ X: v } 或 { X }）";
    if (ts.isParameter(parent) && isName && ts.isParameterPropertyDeclaration(parent, parent.parent)) return "构造函数的参数属性（会成为类的属性）";
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isExportAssignment(parent) || ts.isNamespaceExport(parent)) return "导入名或导出名（import { A as X }、export { X as Y }、export default X）";
    if (isName && (ts.getCombinedModifierFlags(parent as ts.Node as ts.Declaration) & ts.ModifierFlags.Export) !== 0) return "导出名";
    return null;
}

/** 删掉除文件头 AGPL 版权注释和编译指令以外的全部注释，再按词表 renames 给标识符改名（只改纯局部的名字和对它的引用，碰到属性名、导出名等位置直接拒绝，见 memberPosition）。前后代码 token 必须一致。 */
export function redact(file: string, text: string, { renames }: Redactions) {
    const { source, tokens } = scanTokens(file, text);
    const edits: Array<[number, number, string]> = [];
    const removable = (token: Token | undefined) =>
        !!token && isComment(token.kind) && !(token.start === 0 && text.slice(token.start, token.end).includes(LICENSE_MARK)) && !DIRECTIVE.test(text.slice(token.start, token.end));
    for (let i = 0; i < tokens.length; i++) {
        if (!removable(tokens[i])) continue;
        // 连着的几段注释一起删；行尾注释只和同一行的连起来，免得把它下面的空行一起吞掉
        const lineLeading = !text.slice(text.lastIndexOf("\n", tokens[i].start - 1) + 1, tokens[i].start).trim();
        let last = i;
        while (removable(tokens[last + 1]) && (lineLeading || !text.slice(tokens[last].end, tokens[last + 1].start).includes("\n"))) last++;
        edits.push(commentEdit(text, tokens[i].start, tokens[last].end));
        i = last;
    }
    const renamed = new Map<number, string>();
    const names = new Set<string>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            names.add(node.text);
            if (Object.hasOwn(renames, node.text)) {
                const position = memberPosition(node);
                const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                if (position) fail(`${file}:${line}：改名表里的 ${node.text} 在这里是${position}。改名会改掉读写的属性或别处的引用，不改又会把原名留在副本里，拒绝同步；改名表只能改纯局部的名字，这里要在 fit 源码里换成中性的名字。`);
                renamed.set(node.getStart(source), renames[node.text]);
                edits.push([node.getStart(source), node.end, renames[node.text]]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    for (const to of new Set(renamed.values())) if (names.has(to)) fail(`${file}：改名表把标识符改成 ${to}，但文件里已经有这个名字，拒绝同步。`);
    let out = text;
    for (const [start, end, to] of edits.sort(([a], [b]) => b - a)) out = out.slice(0, start) + to + out.slice(end);
    if (codeTokens(file, text, renamed).join("\n") !== codeTokens(file, out).join("\n")) fail(`${file}：删注释、改名后代码 token 变了（sync-fit-generate 的问题），拒绝同步。`);
    return out;
}

function collectStrings(value: unknown, into: Set<string>) {
    if (typeof value === "string") into.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, into));
}

/** 副本代码和能力清单里出现过、fit 的 zh.json 有译文的英文键（校验提示、控件标签、说明），按键排序。 */
function messagesFor(outputs: Map<string, string>, translation: Record<string, unknown>) {
    const used = new Set<string>();
    for (const [file, text] of outputs) {
        if (isScript(file)) {
            const visit = (node: ts.Node): void => {
                if (ts.isStringLiteralLike(node)) used.add(node.text);
                ts.forEachChild(node, visit);
            };
            visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
        } else if (file === "model-capabilities.json") collectStrings(JSON.parse(text), used);
    }
    const keys = [...used].filter((key) => typeof translation[key] === "string").sort();
    return JSON.stringify(Object.fromEntries(keys.map((key) => [key, translation[key]])), null, 2) + "\n";
}

/** 副本只能引用同步范围内的文件、手写垫片和 fit/transport；fit 新加了依赖就在这里报错，不让它悄悄缺文件。 */
function checkImports(outputs: Map<string, string>) {
    for (const [file, text] of outputs) {
        if (!isScript(file)) continue;
        for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
            if (spec === TRANSPORT) continue;
            const target = spec.startsWith(".") ? path.posix.join(path.posix.dirname(file), spec) : "";
            const found = target && [target, `${target}.ts`, `${target}.tsx`].some((name) => outputs.has(name) || (name.startsWith("shims/") && existsSync(path.join(OUT, name))));
            if (!found) fail(`${file} 引用了 ${spec}，它不在同步范围里。先确认 fit 的新依赖，再把它加进 sync-fit-generate 的文件清单或垫片。`);
        }
    }
}

/** 按提交号从 fit 仓库读源文件，生成脱敏后的全部副本、messages.zh.json 和 SOURCE.json（键是相对 src/lib/fit-generate 的路径）；结果里还有词表命中就拒绝。 */
function build(repo: string, commit: string, redactions: Redactions) {
    const outputs = new Map<string, string>();
    const files: SourceRecord["files"] = {};
    const add = (file: string, source: string, raw: string, text: string) => {
        outputs.set(file, text);
        files[file] = { source, sourceSha256: sha256(raw), sha256: sha256(text) };
    };
    for (const [file, source] of Object.entries(FILES)) {
        const raw = git(repo, "show", `${commit}:${source}`);
        add(file, source, raw, isScript(file) ? NOTICE + redact(file, applyEdits(file, raw), redactions) : raw);
    }
    const zh = git(repo, "show", `${commit}:${ZH}`);
    add(MESSAGES, ZH, zh, messagesFor(outputs, JSON.parse(zh).translation ?? {}));
    checkImports(outputs);
    const record: SourceRecord = {
        notice: "本目录除 shims/、__tests__/ 外都由 web/scripts/sync-fit-generate.ts 生成，勿手改（JSON 副本没法加注释，同样不许改）；.ts/.tsx 副本删去了 fit 源码里除版权头以外的注释，个别标识符按内部词表改过名，请求体和价格显示和 fit 源码一致；更新用 bun run sync:fit，核对用 bun run check:fit",
        commit,
        redactionsSha256: redactions.sha256,
        files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    outputs.set(SOURCE_JSON, JSON.stringify(record, null, 2) + "\n");
    const hits = [...outputs].flatMap(([file, text]) => redactionHits(text, redactions).map(([line, hit]) => `${file}:${line} ${hit}`));
    if (hits.length) fail(`同步结果里还有词表命中，拒绝同步（删注释、改名表管不到的地方，要在 fit 源码里改成中性说法）：\n${hits.join("\n")}`);
    return outputs;
}

/** 读副本；git 在 Windows 上可能把换行检出成 CRLF，比对前统一成 LF。 */
function readCopy(file: string) {
    const full = path.join(OUT, file);
    return existsSync(full) ? readFileSync(full, "utf8").replace(/\r\n/g, "\n") : null;
}

function readRecord(): SourceRecord | null {
    const text = readCopy(SOURCE_JSON);
    return text ? JSON.parse(text) : null;
}

function listFiles(dir: string, prefix = ""): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => (statSync(path.join(dir, name)).isDirectory() ? listFiles(path.join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

function sync(repo: string) {
    const redactions = loadRedactions();
    const commit = git(repo, "rev-parse", "HEAD").trim();
    const dirty = git(repo, "status", "--porcelain", "--", ...Object.values(FILES), ZH).trim();
    if (dirty) fail(`fit 仓库 ${repo} 里要同步的文件有未提交改动，拒绝同步：\n${dirty}`);
    const outputs = build(repo, commit, redactions);
    for (const file of Object.keys(readRecord()?.files ?? {})) if (!outputs.has(file)) rmSync(path.join(OUT, file), { force: true });
    for (const [file, text] of outputs) {
        mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
        writeFileSync(path.join(OUT, file), text);
    }
    console.log(`已从 fit ${commit} 同步 ${outputs.size} 个文件到 src/lib/fit-generate（注释已删，按词表脱敏）`);
}

/** 用项目 tsconfig 只编译 fit-generate 下的文件（连同它们引用到的文件），返回全部报错。 */
function typeErrors() {
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic: ts.Diagnostic) => fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")) };
    const config = ts.getParsedCommandLineOfConfigFile(path.join(WEB, "tsconfig.json"), { noEmit: true, incremental: false }, host);
    if (!config) fail("读不了 tsconfig.json");
    const roots = listFiles(OUT)
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => path.join(OUT, file));
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, config.options));
    const format = { getCanonicalFileName: (name: string) => name, getCurrentDirectory: () => WEB, getNewLine: () => "\n" };
    return diagnostics.map((diagnostic) => ts.formatDiagnostic(diagnostic, format).trim());
}

function check(repo: string | undefined) {
    const redactions = loadRedactions();
    const record = readRecord();
    if (!record) fail("src/lib/fit-generate/SOURCE.json 不存在，先运行 bun run sync:fit --repo <fit 检出目录>");
    const problems: string[] = [];
    if (record.redactionsSha256 !== redactions.sha256) problems.push("词表 deploy/private/source-redactions.json 和 SOURCE.json 记的不是同一份，副本还是按旧词表脱敏的：重新 bun run sync:fit --repo <fit 检出目录>");
    for (const [file, { sha256: expected }] of Object.entries(record.files)) {
        const text = readCopy(file);
        if (text == null) problems.push(`${file} 不见了`);
        else if (sha256(text) !== expected) problems.push(`${file} 和 SOURCE.json 记的哈希不一致（被手改过）`);
    }
    for (const file of listFiles(OUT)) {
        if (file !== SOURCE_JSON && !record.files[file] && !HAND_WRITTEN.some((dir) => file.startsWith(dir))) problems.push(`${file} 不是同步产物，也不在 shims/、__tests__/ 里`);
        for (const [line, hit] of redactionHits(readCopy(file) ?? "", redactions)) problems.push(`${file}:${line} 命中词表「${hit}」`);
    }
    if (repo) {
        let hasCommit = false;
        try {
            hasCommit = git(repo, "cat-file", "-t", record.commit).trim() === "commit";
        } catch {}
        if (!hasCommit) problems.push(`${repo} 里找不到 fit 提交 ${record.commit}，没法按源文件重新生成比对`);
        else for (const [file, text] of build(repo, record.commit, redactions)) if (readCopy(file) !== text) problems.push(`${file} 和 fit ${record.commit.slice(0, 7)} 的源文件脱敏同步出来的结果不一致`);
    } else {
        console.warn("警告：没给 --repo 或 FIT_REPO，这次只核对了 SOURCE.json 里的哈希和词表，没有按 fit 源文件重新生成比对。");
    }
    problems.push(...typeErrors());
    if (problems.length) fail(`check:fit 不通过：\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    console.log(`check:fit 通过：${Object.keys(record.files).length} 个副本与 fit ${record.commit.slice(0, 7)} 一致${repo ? "（已按源文件脱敏重新生成、逐字节比对）" : ""}，词表 0 命中，类型检查 0 个错误`);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
    try {
        const { values } = parseArgs({ options: { repo: { type: "string" }, check: { type: "boolean" } } });
        const repo = values.repo ?? process.env.FIT_REPO;
        if (values.check) check(repo ? path.resolve(repo) : undefined);
        else if (repo) sync(path.resolve(repo));
        else fail("用法：bun run sync:fit --repo <fit 检出目录>（或设 FIT_REPO）。检出要停在线上 openai.fit 二进制的源码提交上，并且没有未提交改动。");
    } catch (error) {
        if (!(error instanceof SyncError)) throw error;
        console.error(error.message);
        process.exit(1);
    }
}
