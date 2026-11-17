import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_LOGIN_REQUIRED, isAdminRedirect, loginForRedirect } from "./auth";
import { ApiError } from "./request";

function recorder(userResult: () => Promise<string>) {
    const calls: string[] = [];
    return {
        calls,
        asUser: () => {
            calls.push("user");
            return userResult();
        },
        asAdmin: () => {
            calls.push("admin");
            return Promise.resolve("admin-session");
        },
    };
}

test("redirects into the admin area log in through /api/admin/login only", async () => {
    for (const redirect of ["/admin", "/admin/users", "/admin?tab=1", "/admin#x"]) {
        const r = recorder(() => Promise.resolve("user-session"));
        assert.equal(await loginForRedirect(redirect, r.asUser, r.asAdmin), "admin-session", redirect);
        assert.deepEqual(r.calls, ["admin"], redirect);
    }
});

test("other redirects use the normal login and never touch the admin endpoint on success", async () => {
    for (const redirect of ["/", "/canvas", "/administrator", "/canvas?next=/admin"]) {
        assert.equal(isAdminRedirect(redirect), false, redirect);
        const r = recorder(() => Promise.resolve("user-session"));
        assert.equal(await loginForRedirect(redirect, r.asUser, r.asAdmin), "user-session", redirect);
        assert.deepEqual(r.calls, ["user"], redirect);
    }
});

test("a 403 请从后台登录 from the normal login retries the same credentials through the admin login", async () => {
    const r = recorder(() => Promise.reject(new ApiError(ADMIN_LOGIN_REQUIRED, 403)));
    assert.equal(await loginForRedirect("/", r.asUser, r.asAdmin), "admin-session");
    assert.deepEqual(r.calls, ["user", "admin"]);
});

test("any other login failure is rethrown without trying the admin login", async () => {
    for (const error of [new ApiError("用户名或密码错误", 400), new ApiError("请求过于频繁，请稍后再试", 429), new ApiError(ADMIN_LOGIN_REQUIRED, 429), new Error(ADMIN_LOGIN_REQUIRED)]) {
        const r = recorder(() => Promise.reject(error));
        await assert.rejects(loginForRedirect("/", r.asUser, r.asAdmin), (thrown) => thrown === error);
        assert.deepEqual(r.calls, ["user"], error.message);
    }
});
