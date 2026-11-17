package middleware

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
	"golang.org/x/time/rate"
)

func rateLimitRouter(limit gin.HandlerFunc) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Any("/limited", limit, func(c *gin.Context) {
		body, _ := io.ReadAll(c.Request.Body)
		c.String(http.StatusOK, string(body))
	})
	return router
}

func TestRateLimitByIPRejectsAfterBurst(t *testing.T) {
	router := rateLimitRouter(RateLimit("test-ip", 3, 3, ByIP))
	send := func(ip string) int {
		request := httptest.NewRequest(http.MethodGet, "/limited", nil)
		request.RemoteAddr = ip + ":1234"
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	for i := 0; i < 3; i++ {
		if code := send("203.0.113.1"); code != http.StatusOK {
			t.Fatalf("第 %d 次请求返回 %d，期望 200", i+1, code)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/limited", nil)
	request.RemoteAddr = "203.0.113.1:1234"
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	// 每分钟 3 个，也就是 20 秒攒一个。
	if recorder.Code != http.StatusTooManyRequests || recorder.Header().Get("Retry-After") != "20" {
		t.Fatalf("第 4 次请求返回 %d、Retry-After=%q，期望 429、20", recorder.Code, recorder.Header().Get("Retry-After"))
	}
	if code := send("203.0.113.2"); code != http.StatusOK {
		t.Fatalf("另一个 IP 返回 %d，期望 200", code)
	}
}

func TestRateLimitByUser(t *testing.T) {
	router := rateLimitRouter(RateLimit("test-user", 2, 2, ByUser))
	send := func(userID string) int {
		request := httptest.NewRequest(http.MethodGet, "/limited", nil)
		request = request.WithContext(service.WithUser(request.Context(), model.AuthUser{ID: userID, Role: model.UserRoleUser}))
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	send("user-a")
	send("user-a")
	if code := send("user-a"); code != http.StatusTooManyRequests {
		t.Fatalf("同一用户第 3 次请求返回 %d，期望 429", code)
	}
	if code := send("user-b"); code != http.StatusOK {
		t.Fatalf("同一 IP 的另一个用户返回 %d，期望 200", code)
	}
}

func TestRateLimitByUsernameKeepsBody(t *testing.T) {
	router := rateLimitRouter(RateLimit("test-username", 10, 2, ByUsername))
	send := func(username string) *httptest.ResponseRecorder {
		body := `{"username":"` + username + `","password":"secret"}`
		request := httptest.NewRequest(http.MethodPost, "/limited", strings.NewReader(body))
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code == http.StatusOK && recorder.Body.String() != body {
			t.Fatalf("限流读过的请求体没有放回：%q", recorder.Body.String())
		}
		return recorder
	}
	send("Admin")
	send("admin")
	if code := send("ADMIN").Code; code != http.StatusTooManyRequests {
		t.Fatalf("同一用户名第 3 次登录返回 %d，期望 429", code)
	}
	if code := send("other").Code; code != http.StatusOK {
		t.Fatalf("另一个用户名返回 %d，期望 200", code)
	}
}

func TestRateLimitStoreDropsIdleEntries(t *testing.T) {
	store := &rateLimitStore{limit: rate.Limit(1), burst: 1, idle: time.Second, entries: map[string]*rateLimitEntry{}}
	start := time.Now()
	store.allow("old", start)
	store.allow("new", start.Add(2*time.Minute))
	if _, ok := store.entries["old"]; ok || len(store.entries) != 1 {
		t.Fatalf("闲置的桶没有被清理：%v", store.entries)
	}
}

func TestByIPGroupsIPv6By64(t *testing.T) {
	gin.SetMode(gin.TestMode)
	key := func(remoteAddr string) string {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
		c.Request.RemoteAddr = remoteAddr
		return ByIP(c)
	}
	if got := key("203.0.113.9:1234"); got != "ip:203.0.113.9" {
		t.Fatalf("IPv4 key = %q，期望原样", got)
	}
	a, b := key("[2001:db8:1:2:aaaa::1]:1234"), key("[2001:db8:1:2:bbbb:cccc:dddd:eeee]:80")
	if a != "ip:2001:db8:1:2::/64" || a != b {
		t.Fatalf("同一个 /64 的两个地址 key 不同或格式不对：%q %q", a, b)
	}
	if c := key("[2001:db8:1:3::1]:1234"); c == a {
		t.Fatalf("不同 /64 的 key 相同：%q", c)
	}
	if got := key("[::ffff:203.0.113.9]:1234"); got != "ip:203.0.113.9" {
		t.Fatalf("IPv4 映射地址 key = %q，期望按 IPv4 处理", got)
	}
}

func TestRateLimitFailuresPerHourCountsOnlyFailures(t *testing.T) {
	gin.SetMode(gin.TestMode)
	calls := 0
	router := gin.New()
	router.POST("/login", RateLimitFailuresPerHour("test-failures", 10, 3, ByIPAndUsername), func(c *gin.Context) {
		calls++
		var payload struct {
			Password string `json:"password"`
		}
		_ = c.ShouldBindJSON(&payload)
		if payload.Password == "right" {
			c.JSON(http.StatusOK, gin.H{"code": 0, "data": "token", "msg": "ok"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 1, "data": nil, "msg": "用户名或密码错误"})
	})
	send := func(ip, username, password string) int {
		request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
		request.RemoteAddr = ip + ":5000"
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}
	for i := 0; i < 5; i++ {
		if code := send("203.0.113.1", "owner", "right"); code != http.StatusOK {
			t.Fatalf("成功登录第 %d 次返回 %d，成功不应消耗额度", i+1, code)
		}
	}
	for i := 0; i < 3; i++ {
		send("203.0.113.1", "owner", "wrong")
	}
	before := calls
	if code := send("203.0.113.1", "Owner", "right"); code != http.StatusTooManyRequests || calls != before {
		t.Fatalf("同一 IP 同一用户名失败 3 次后返回 %d（处理函数多跑了 %d 次），期望直接 429", code, calls-before)
	}
	if code := send("203.0.113.2", "owner", "right"); code != http.StatusOK {
		t.Fatalf("换一个 IP 的同一用户名返回 %d，期望不受影响", code)
	}
	if code := send("203.0.113.1", "someone", "wrong"); code == http.StatusTooManyRequests {
		t.Fatal("同一 IP 的另一个用户名应有自己的额度")
	}
}

// 同时进来的登录请求先各自占一个额度，失败才扣、成功退回：并发再多，失败次数也超不过上限。
func TestRateLimitFailuresPerHourReservesBeforeHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var entered atomic.Int32
	release := make(chan struct{})
	router := gin.New()
	router.POST("/login", RateLimitFailuresPerHour("test-reserve", 10, 10, ByIP), func(c *gin.Context) {
		entered.Add(1)
		<-release
		if c.Query("ok") == "1" {
			c.JSON(http.StatusOK, gin.H{"code": 0, "data": "token", "msg": "ok"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 1, "data": nil, "msg": "用户名或密码错误"})
	})
	send := func(ip, query string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/login?"+query, nil)
		request.RemoteAddr = ip + ":5000"
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	// burst 个请求同时卡在处理函数里，第 burst+1 个必须直接 429，不能进处理函数。
	concurrent := func(ip, query string) []int {
		entered.Store(0)
		release = make(chan struct{})
		codes := make(chan int, 15)
		var wg sync.WaitGroup
		for i := 0; i < 15; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				codes <- send(ip, query).Code
			}()
		}
		var rejected []int
		for len(rejected) < 5 {
			select {
			case code := <-codes:
				rejected = append(rejected, code)
			case <-time.After(5 * time.Second):
				t.Fatalf("超出额度的请求没有直接返回，已返回 %v，进入处理函数 %d 个", rejected, entered.Load())
			}
		}
		if entered.Load() != 10 {
			t.Fatalf("同时进入处理函数 %d 个，期望 10", entered.Load())
		}
		close(release)
		wg.Wait()
		close(codes)
		for code := range codes {
			rejected = append(rejected, code)
		}
		return rejected
	}

	codes := concurrent("203.0.113.1", "")
	for i, code := range codes {
		if want := map[bool]int{true: http.StatusTooManyRequests, false: http.StatusOK}[i < 5]; code != want {
			t.Fatalf("并发失败请求的状态码 %v，期望前 5 个 429、其余 200", codes)
		}
	}
	recorder := send("203.0.113.1", "ok=1")
	if recorder.Code != http.StatusTooManyRequests || recorder.Header().Get("Retry-After") == "" {
		t.Fatalf("10 次失败用完额度后返回 %d、Retry-After=%q，期望 429 且带 Retry-After", recorder.Code, recorder.Header().Get("Retry-After"))
	}

	// 成功的请求占的额度会退回：并发成功之后还能接着登录。
	concurrent("203.0.113.2", "ok=1")
	for i := 0; i < 10; i++ {
		if code := send("203.0.113.2", "ok=1").Code; code != http.StatusOK {
			t.Fatalf("成功登录后第 %d 次返回 %d，成功不应消耗额度", i+1, code)
		}
	}
}

// 只数成功的请求：失败不占额度；任意 window 时长内最多成功 limit 次，超了直接 429、不进处理函数，Retry-After 是最早那次成功滑出 window 的时间。
func TestSuccessesPerWindowCountsOnlySuccesses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	calls := 0
	router := gin.New()
	router.POST("/register", SuccessesPerWindow("test-daily", 2, 24*time.Hour, ByIP, "今天注册太多了"), func(c *gin.Context) {
		calls++
		if c.Query("ok") == "1" {
			c.JSON(http.StatusOK, gin.H{"code": 0, "data": "token", "msg": "ok"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"code": 1, "data": nil, "msg": "用户名已存在"})
	})
	send := func(ip, query string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/register?"+query, nil)
		request.RemoteAddr = ip + ":5000"
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	for i := 0; i < 5; i++ {
		send("203.0.113.1", "")
	}
	for i := 0; i < 2; i++ {
		if code := send("203.0.113.1", "ok=1").Code; code != http.StatusOK {
			t.Fatalf("失败过 5 次后第 %d 次成功返回 %d，失败不应占额度", i+1, code)
		}
	}
	before := calls
	recorder := send("203.0.113.1", "ok=1")
	if recorder.Code != http.StatusTooManyRequests || calls != before || !strings.Contains(recorder.Body.String(), "今天注册太多了") {
		t.Fatalf("成功 2 次后返回 %d %s（处理函数多跑了 %d 次），期望直接 429 和给定的提示", recorder.Code, recorder.Body.String(), calls-before)
	}
	if retry, _ := strconv.Atoi(recorder.Header().Get("Retry-After")); retry < 86000 || retry > 86400 {
		t.Fatalf("Retry-After = %q，期望约 24 小时", recorder.Header().Get("Retry-After"))
	}
	if code := send("203.0.113.2", "ok=1").Code; code != http.StatusOK {
		t.Fatalf("另一个 IP 返回 %d，期望不受影响", code)
	}
}

// 按滑动窗口算：用完之后要等最早那次成功滑出 window 才放行一个，不会像令牌桶那样在同一个 window 里慢慢攒回来。
func TestWindowStoreSlides(t *testing.T) {
	store := &windowStore{limit: 2, window: 24 * time.Hour, entries: map[string]*windowEntry{}}
	start := time.Now()
	succeed := func(at time.Time) {
		entry, _ := store.reserve("ip:a", at)
		if entry == nil {
			t.Fatalf("%v 时应有额度", at.Sub(start))
		}
		store.settle(entry, at, true)
	}
	succeed(start)
	succeed(start.Add(time.Hour))
	for _, at := range []time.Duration{2 * time.Hour, 23*time.Hour + 59*time.Minute} {
		if entry, wait := store.reserve("ip:a", start.Add(at)); entry != nil || wait != 24*time.Hour-at {
			t.Fatalf("%v 时 entry=%v wait=%v，期望没有额度、等到第一次成功满 24 小时", at, entry, wait)
		}
	}
	succeed(start.Add(24*time.Hour + time.Second))
	if entry, _ := store.reserve("ip:a", start.Add(24*time.Hour+2*time.Second)); entry != nil {
		t.Fatal("第二次成功还没满 24 小时，不应再有额度")
	}
	// 失败的结算把额度还回去。
	entry, _ := store.reserve("ip:b", start)
	store.settle(entry, start, false)
	for i := 0; i < 2; i++ {
		if entry, _ := store.reserve("ip:b", start); entry == nil {
			t.Fatalf("失败结算后第 %d 次占额度失败", i+1)
		}
	}
	// window 内没有成功记录、也没占着额度的 key 会被清掉。
	store.reserve("ip:c", start.Add(50*time.Hour))
	if _, ok := store.entries["ip:a"]; ok {
		t.Fatalf("过期的记录没有被清理：%v", store.entries)
	}
	if _, ok := store.entries["ip:b"]; !ok {
		t.Fatal("还占着额度的记录不应被清理")
	}
}

func TestSuccessesPerWindowZeroMeansNoLimit(t *testing.T) {
	router := rateLimitRouter(SuccessesPerWindow("test-off", 0, time.Hour, ByIP, "不该出现"))
	for i := 0; i < 20; i++ {
		request := httptest.NewRequest(http.MethodPost, "/limited", nil)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("limit 为 0 时第 %d 次返回 %d，期望不限", i+1, recorder.Code)
		}
	}
}
