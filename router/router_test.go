package router

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

// useMemoryDB 让本包测试共用一个内存 SQLite（repository.DB 全进程只初始化一次），并配好签登录令牌用的密钥。
func useMemoryDB(t *testing.T) {
	t.Helper()
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", JWTSecret: "router-test-secret-0123456789abcdef"}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
}

// registerUser 注册一个普通用户，返回登录令牌。
func registerUser(t *testing.T, username string) string {
	t.Helper()
	session, err := service.Register(username, "router-test-password")
	if err != nil {
		t.Fatalf("register %s: %v", username, err)
	}
	return session.Token
}

func TestRemovedRoutesReturnNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := New()
	for _, route := range [][2]string{
		{http.MethodPost, "/api/ai/direct-request"},
		{http.MethodPost, "/api/anonymous/files"},
		{http.MethodPost, "/api/v1/images/generations"},
		{http.MethodPost, "/api/v1/chat/completions"},
		{http.MethodPost, "/api/v1/videos"},
		{http.MethodGet, "/api/v1/videos/x/content"},
		{http.MethodPost, "/api/v1/workflows/agent-draft"},
		{http.MethodGet, "/api/auth/linux-do/authorize"},
		{http.MethodPost, "/api/bridge/comfy/heartbeat"},
		{http.MethodPost, "/api/admin/settings/channel-test"},
	} {
		t.Run(route[0]+" "+route[1], func(t *testing.T) {
			recorder := httptest.NewRecorder()
			engine.ServeHTTP(recorder, httptest.NewRequest(route[0], route[1], nil))
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", recorder.Code)
			}
		})
	}
}

func TestHealthAndKeptRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := New()
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", recorder.Code)
	}
	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}
	for _, route := range []string{
		"GET /api/fit/catalog",
		"GET /api/proxy-image",
		"GET /api/prompts/:id/cover",
		"POST /api/auth/register",
		"POST /api/v1/files",
		"DELETE /api/v1/files/:id",
		"GET /api/v1/user-config",
		"POST /api/v1/user-config/model",
		"POST /api/v1/canvas/projects/sync",
		"POST /api/admin/settings",
	} {
		if !registered[route] {
			t.Errorf("route %s is not registered", route)
		}
	}
}

func TestFitCatalogRouteIsWired(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.FitBaseURL = upstream.URL

	recorder := httptest.NewRecorder()
	New().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/fit/catalog", nil))
	var body struct {
		Code int `json:"code"`
	}
	if recorder.Code == http.StatusNotFound || json.Unmarshal(recorder.Body.Bytes(), &body) != nil || body.Code == 0 {
		t.Fatalf("status = %d body = %s, want handler failure envelope", recorder.Code, recorder.Body.String())
	}
}

func TestProxyImageRateLimitsByIPBeforeProxyGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := New()
	proxyImage := func(remoteAddr string, site string) int {
		request := httptest.NewRequest(http.MethodGet, "/api/proxy-image", nil)
		request.RemoteAddr = remoteAddr
		if site != "" {
			request.Header.Set("Sec-Fetch-Site", site)
		}
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		return recorder.Code
	}
	if code := proxyImage("198.51.100.1:5000", "cross-site"); code != http.StatusForbidden {
		t.Fatalf("cross-site status = %d, want 403", code)
	}
	for i := 1; i <= 120; i++ {
		if code := proxyImage("198.51.100.2:5000", ""); code == http.StatusTooManyRequests {
			t.Fatalf("request %d was rate limited too early", i)
		}
	}
	// 限流挂在 ProxyGuard 前面：超频的请求直接 429，不会走到 ProxyGuard（否则这里会是 403）。
	if code := proxyImage("198.51.100.2:5000", "cross-site"); code != http.StatusTooManyRequests {
		t.Fatalf("121st request status = %d, want 429 from the rate limit before ProxyGuard", code)
	}
	// IPv6 同一个 /64 共用额度。
	for i := 1; i <= 120; i++ {
		proxyImage("[2001:db8:7:7::"+strconv.FormatInt(int64(i), 16)+"]:5000", "")
	}
	if code := proxyImage("[2001:db8:7:7:ffff::1]:5000", ""); code != http.StatusTooManyRequests {
		t.Fatalf("another address in the same /64 status = %d, want 429", code)
	}
}

func TestAccessLogOmitsQueryString(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	previous := gin.DefaultWriter
	gin.DefaultWriter = &logs
	t.Cleanup(func() { gin.DefaultWriter = previous })
	engine := New()
	signed := "https://openai.fit/v1/tasks/task_1/artifacts/video/content?access=SIGNED-SECRET"
	request := httptest.NewRequest(http.MethodGet, "/api/proxy-image?url="+url.QueryEscape(signed), nil)
	request.RemoteAddr = "198.51.100.60:5000"
	// 跨站请求在 ProxyGuard 就被 403，不会真的去取这个地址。
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	engine.ServeHTTP(httptest.NewRecorder(), request)
	if strings.Contains(logs.String(), "SIGNED-SECRET") || strings.Contains(logs.String(), "access") {
		t.Fatalf("access log leaks the query string: %q", logs.String())
	}
	if !strings.Contains(logs.String(), `"/api/proxy-image"`) || !strings.Contains(logs.String(), " 403 ") {
		t.Fatalf("access log = %q, want one line with the path and status 403", logs.String())
	}
}

func TestFitCatalogRateLimitedByIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.FitBaseURL = upstream.URL
	engine := New()
	for i := 1; i <= 61; i++ {
		request := httptest.NewRequest(http.MethodGet, "/api/fit/catalog", nil)
		request.RemoteAddr = "198.51.100.30:5000"
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		if want := i > 60; (recorder.Code == http.StatusTooManyRequests) != want {
			t.Fatalf("catalog request %d status = %d, want 429=%v", i, recorder.Code, want)
		}
	}
}

func oversizedPost(path string, remoteAddr string, forwardedFor string, body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.ContentLength = 9 << 20
	request.RemoteAddr = remoteAddr
	if forwardedFor != "" {
		request.Header.Set("X-Forwarded-For", forwardedFor)
	}
	return request
}

func TestLoginBodyLimitAndRateLimitUseRealClientIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := New()
	for i := 1; i <= 6; i++ {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, oversizedPost("/api/auth/login", "127.0.0.1:5000", "203.0.113.7", `{}`))
		want := http.StatusRequestEntityTooLarge
		if i == 6 {
			want = http.StatusTooManyRequests
		}
		if recorder.Code != want {
			t.Fatalf("login request %d status = %d, want %d", i, recorder.Code, want)
		}
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, oversizedPost("/api/auth/login", "127.0.0.1:5000", "203.0.113.8", `{}`))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("another client behind the local proxy status = %d, want 413", recorder.Code)
	}
	for i := 1; i <= 6; i++ {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, oversizedPost("/api/auth/register", "198.51.100.9:5000", "203.0.113."+strconv.Itoa(i), `{}`))
		if want := i == 6; (recorder.Code == http.StatusTooManyRequests) != want {
			t.Fatalf("register request %d with spoofed X-Forwarded-For status = %d", i, recorder.Code)
		}
	}
}

// 每个 IP 每 24 小时注册成功的账号数有上限（REGISTER_DAILY_LIMIT_PER_IP）：失败的注册不占名额，超了回 429 和中文原因，别的 IP 不受影响。
func TestRegisterDailyLimitPerIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	config.Cfg.RegisterDailyLimitPerIP = 2
	engine := New()
	register := func(ip, username string) (int, string) {
		request := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(`{"username":"`+username+`","password":"router-test-password"}`))
		request.RemoteAddr = ip + ":5000"
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		var body struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		if recorder.Code == http.StatusOK && body.Code != 0 {
			return -1, body.Msg
		}
		return recorder.Code, body.Msg
	}
	if code, _ := register("198.51.100.70", "daily-one"); code != http.StatusOK {
		t.Fatalf("first registration = %d, want 200", code)
	}
	if code, msg := register("198.51.100.70", "daily-one"); code != -1 || msg != "用户名已存在" {
		t.Fatalf("duplicate registration = %d %q, want a business failure", code, msg)
	}
	if code, _ := register("198.51.100.70", "daily-two"); code != http.StatusOK {
		t.Fatalf("second registration = %d, want 200: failed registrations must not use up the daily quota", code)
	}
	code, msg := register("198.51.100.70", "daily-three")
	if code != http.StatusTooManyRequests || !strings.Contains(msg, "24 小时内最多注册 2 个账号") {
		t.Fatalf("third registration from the same IP = %d %q, want 429 with the daily limit message", code, msg)
	}
	if code, _ := register("198.51.100.71", "daily-three"); code != http.StatusOK {
		t.Fatalf("registration from another IP = %d, want 200", code)
	}
}

func TestAdminLoginOnlyThroughAdminEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	config.Cfg.AdminUsername, config.Cfg.AdminPassword = "fit-owner", "fit-owner-password-123"
	if err := service.EnsureDefaultAdmin(); err != nil {
		t.Fatal(err)
	}
	engine := New()
	login := func(path string, ip int, username, password string) (int, string) {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
		request.RemoteAddr = "198.51.100." + strconv.Itoa(ip) + ":5000"
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		var body struct {
			Code int    `json:"code"`
			Msg  string `json:"msg"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		if recorder.Code == http.StatusOK && body.Code != 0 {
			return -1, body.Msg
		}
		return recorder.Code, body.Msg
	}

	// 前台登录拒绝管理员账号，密码对不对都一样，不能用来试管理员密码。
	for _, password := range []string{"fit-owner-password-123", "wrong-password"} {
		if code, msg := login("/api/auth/login", 1, "fit-owner", password); code != http.StatusForbidden || msg != "请从后台登录" {
			t.Fatalf("admin via /api/auth/login = %d %q, want 403 请从后台登录", code, msg)
		}
	}
	if code, _ := login("/api/admin/login", 2, "fit-owner", "fit-owner-password-123"); code != http.StatusOK {
		t.Fatalf("admin via /api/admin/login = %d, want 200", code)
	}

	// 失败次数按「IP + 用户名」算：别的 IP 刷错密码不影响这个 IP；成功不计数。
	for ip := 10; ip < 22; ip++ {
		if code, _ := login("/api/admin/login", ip, "fit-owner", "wrong-password"); code == http.StatusTooManyRequests {
			t.Fatalf("failed admin login from fresh IP %d was limited; the failure budget must be per IP and username", ip)
		}
	}
	for i := 0; i < 3; i++ {
		if code, _ := login("/api/admin/login", 30, "fit-owner", "fit-owner-password-123"); code != http.StatusOK {
			t.Fatalf("successful admin login %d status = %d, want 200", i+1, code)
		}
	}
}

func TestUserDataWritesRateLimitedPerUser(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	engine := New()
	tokens := []string{registerUser(t, "writer-one"), registerUser(t, "writer-two")}
	saveAssets := func(token string) int {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/user-data/assets", strings.NewReader(`{"data":{"assets":[]}}`))
		request.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		return recorder.Code
	}
	for i := 1; i <= 31; i++ {
		if want := i > 30; (saveAssets(tokens[0]) == http.StatusTooManyRequests) != want {
			t.Fatalf("write %d: want 429=%v", i, want)
		}
	}
	if code := saveAssets(tokens[1]); code != http.StatusOK {
		t.Fatalf("another user status = %d, want 200", code)
	}
	listAssets := httptest.NewRequest(http.MethodGet, "/api/v1/user-data/assets", nil)
	listAssets.Header.Set("Authorization", "Bearer "+tokens[0])
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, listAssets)
	if recorder.Code != http.StatusOK {
		t.Fatalf("reads must not share the write budget, status = %d", recorder.Code)
	}
}

// bodyReadSpy 记下请求体有没有被读过。
type bodyReadSpy struct{ read bool }

func (b *bodyReadSpy) Read([]byte) (int, error) {
	b.read = true
	return 0, io.EOF
}

func TestDeleteFileDoesNotReadBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	engine := New()
	token := registerUser(t, "file-deleter")
	spy := &bodyReadSpy{}
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/files/file-missing", spy)
	request.ContentLength = 64 << 20
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || spy.read {
		t.Fatalf("DELETE /api/v1/files/:id status = %d, body read = %v; want 200 without reading the body", recorder.Code, spy.read)
	}
}

func TestCanvasProjectAutosaveRateLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	engine := New()
	token := registerUser(t, "autosaver")
	post := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		return recorder
	}
	// 自动保存每人每分钟 120 次、最多连续 60 次：前 60 次不能被限（普通写接口 30 次就限了）。
	for i := 1; i <= 60; i++ {
		if code := post("/api/v1/canvas/projects").Code; code == http.StatusTooManyRequests {
			t.Fatalf("autosave %d was rate limited, want a burst of 60", i)
		}
	}
	// 每秒补 2 个，连发下去很快就会被限；429 要带 Retry-After。
	limited := false
	for i := 0; i < 20 && !limited; i++ {
		recorder := post("/api/v1/canvas/projects")
		if recorder.Code == http.StatusTooManyRequests {
			limited = true
			if got := recorder.Header().Get("Retry-After"); got != "1" {
				t.Fatalf("Retry-After = %q, want 1", got)
			}
		}
	}
	if !limited {
		t.Fatal("autosave was never rate limited after the burst")
	}
	if code := post("/api/v1/canvas/projects/sync").Code; code == http.StatusTooManyRequests {
		t.Fatal("projects/sync must have its own budget")
	}
}

// 用 openai.fit 登录：身份来自 fit（fit 注册要邮箱验证），不占注册每日上限；fit-login 有自己的按 IP 限流和 4KB 请求体上限。
func TestFitLoginRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	useMemoryDB(t)
	var exchanges atomic.Int32
	fit := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exchanges.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"data":{"user_id":401,"username":"router-fit","display_name":""}}`))
	}))
	defer fit.Close()
	config.Cfg.FitConnectSecret = "router-fit-connect-secret-0123456789abcdef"
	config.Cfg.FitBaseURL = fit.URL
	config.Cfg.RegisterDailyLimitPerIP = 2
	engine := New()
	post := func(path, ip, body string) (int, int, string) {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.RemoteAddr = ip + ":5000"
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		var payload struct {
			Code int `json:"code"`
			Data struct {
				Token string `json:"token"`
			} `json:"data"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
		return recorder.Code, payload.Code, payload.Data.Token
	}
	for i, username := range []string{"fit-route-one", "fit-route-two", "fit-route-three"} {
		status, _, _ := post("/api/auth/register", "198.51.100.80", `{"username":"`+username+`","password":"router-test-password"}`)
		if want := i == 2; (status == http.StatusTooManyRequests) != want {
			t.Fatalf("registration %d status = %d, want 429=%v", i+1, status, want)
		}
	}
	login := `{"code":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC","codeVerifier":"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk","state":"SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"}`
	if status, code, token := post("/api/auth/fit/login", "198.51.100.80", login); status != http.StatusOK || code != 0 || token == "" {
		t.Fatalf("fit login after the daily registration limit = %d code %d token %q, want a new session", status, code, token)
	}
	if exchanges.Load() != 1 {
		t.Fatalf("fit exchanges = %d, want 1", exchanges.Load())
	}

	for i := 1; i <= 11; i++ {
		status, _, _ := post("/api/auth/fit/login", "198.51.100.81", `{}`)
		if want := i > 10; (status == http.StatusTooManyRequests) != want {
			t.Fatalf("fit login %d status = %d, want 429=%v", i, status, want)
		}
	}
	if exchanges.Load() != 1 {
		t.Fatal("malformed fit logins must be refused before calling fit")
	}
	if status, _, _ := post("/api/auth/login", "198.51.100.81", `{"username":"x","password":"y"}`); status == http.StatusTooManyRequests {
		t.Fatal("password login must not share the fit-login budget")
	}
	if status, _, _ := post("/api/auth/fit/login", "198.51.100.82", `{}`); status == http.StatusTooManyRequests {
		t.Fatal("another IP must have its own fit-login budget")
	}
	recorder := httptest.NewRecorder()
	big := httptest.NewRequest(http.MethodPost, "/api/auth/fit/login", strings.NewReader(`{}`))
	big.ContentLength = 5 << 10
	big.RemoteAddr = "198.51.100.83:5000"
	engine.ServeHTTP(recorder, big)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized fit login status = %d, want 413", recorder.Code)
	}
}
