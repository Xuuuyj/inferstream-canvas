import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

// 这个转发只给本地开发和本机部署用；线上由 Caddy 把 /api/* 直接转给 Go，不经过这里。
// 客户端自带的 X-Forwarded-For / X-Real-IP / Forwarded 一律去掉：路由里拿不到真实的 TCP 对端
// （Next 只在客户端没带 X-Forwarded-For 时才用 socket 地址补上，这个值不可信），原样透传就等于让客户端伪造 IP 绕过按 IP 的限流。
// 去掉后 Go 看到的客户端就是本机这一跳（127.0.0.1）。
function proxyHeaders(request: NextRequest) {
    const headers = new Headers(request.headers);
    for (const name of ["host", "content-length", "connection", "expect", "x-forwarded-for", "x-real-ip", "forwarded"]) {
        headers.delete(name);
    }
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    return headers;
}

function responseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
        const response = await fetch(target, {
            method: request.method,
            headers: proxyHeaders(request),
            body: hasBody ? request.body : undefined,
            duplex: hasBody ? "half" : undefined,
            redirect: "manual",
            signal: request.headers.get("X-Canvas-Node-Request") === "true" ? request.signal : undefined,
        } as RequestInit & { duplex?: "half" });

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response),
        });
    } catch (error) {
        console.error("Failed to proxy", target, error);
        return Response.json({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }, { status: 502 });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
