import { isFitBaseUrl, normalizeFitApiKey } from "@/lib/fit-config";

/**
 * fit 令牌列表的「聊天」链接：https://canvas.openai.fit/#apiKey={key}&baseUrl={address}。只认 # 后面的参数，这样令牌不会发到画布服务器。
 * apiKey 为空表示不导入；keyInQuery 表示令牌放在了 ? 参数里（已经随请求发到服务器），一律不导入；
 * foreignBaseUrl 非空表示链接指向别家，令牌被忽略；cleanUrl 是抹掉这几个参数（# 和 ? 里的都抹）后的地址。
 */
export type FitTokenLink = { apiKey: string; foreignBaseUrl: string; keyInQuery: boolean; cleanUrl: string };

const keyNames = ["apiKey", "apikey"];
const baseUrlNames = ["baseUrl", "baseurl"];
const linkNames = [...keyNames, ...baseUrlNames];

export function parseFitTokenLink(href: string): FitTokenLink | null {
    const url = new URL(href);
    const hash = new URLSearchParams(url.hash.slice(1));
    const search = url.searchParams;
    const hashTouched = linkNames.some((name) => hash.has(name));
    if (!hashTouched && !linkNames.some((name) => search.has(name))) return null;
    const read = (names: string[]) => names.map((name) => hash.get(name)?.trim() || "").find(Boolean) || "";
    const rawKey = read(keyNames);
    const baseUrl = read(baseUrlNames);
    const keyInQuery = keyNames.some((name) => search.has(name));
    for (const params of [hash, search]) for (const name of linkNames) params.delete(name);
    if (hashTouched) url.hash = hash.toString();
    url.search = search.toString();
    const foreign = !keyInQuery && Boolean(baseUrl) && !isFitBaseUrl(baseUrl);
    return { apiKey: keyInQuery || foreign ? "" : normalizeFitApiKey(rawKey), foreignBaseUrl: foreign ? baseUrl : "", keyInQuery, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}

/**
 * #apiKey= 链接导入确认框里的提醒：链接可能是别人发来的，令牌也可能是别人的（攻击者能借它看到你用它生成的东西）。
 * 浏览器正登录着 openai.fit 时说得更直白：这把不是从你自己的账号里选的。
 */
export function fitTokenLinkWarning(fitLoggedIn: boolean) {
    const owner = "用它生成的内容（提示词、参考图、成片）令牌主人都能看到，只导入你自己的令牌。";
    return fitLoggedIn ? `这把令牌不是从你登录的 openai.fit 账号里选的：${owner}` : `请确认这是你自己的令牌：${owner}`;
}

export function maskFitApiKey(apiKey: string) {
    return `sk-…${apiKey.slice(-4)}`;
}
