package middleware

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/service"
	"golang.org/x/time/rate"
)

// KeyFunc 决定按什么维度限流，返回值相同的请求共用一个令牌桶。
type KeyFunc func(c *gin.Context) string

// RateLimit 令牌桶限流：每个 key 每分钟补 perMinute 个，最多攒 burst 个，用完返回 429。
// 每次调用都是一组独立的桶，要让几个路由共用额度就复用同一个返回值。name 只用于日志。
func RateLimit(name string, perMinute, burst int, key KeyFunc) gin.HandlerFunc {
	return rateLimit(name, rate.Limit(float64(perMinute)/60), burst, key)
}

// RateLimitFailuresPerHour 只给失败的请求记数（例如登录失败），成功的不消耗额度；额度用完后直接 429，不再执行后面的处理。
// 进处理函数前先占一个额度，失败才真正扣掉、成功就还回去，所以同时进来的请求加起来也超不过上限。
// 成功指 HTTP 200 且响应体是 {"code":0,...}。
func RateLimitFailuresPerHour(name string, perHour, burst int, key KeyFunc) gin.HandlerFunc {
	store := newRateLimitStore(rate.Limit(float64(perHour)/3600), burst)
	return func(c *gin.Context) {
		k := key(c)
		entry, wait := store.reserve(k, time.Now())
		if entry == nil {
			tooManyRequests(c, name, k, wait, "失败次数过多，请稍后再试")
			return
		}
		failed := true
		defer func() { store.settle(entry, time.Now(), failed) }()
		recorder := &resultRecorder{ResponseWriter: c.Writer}
		c.Writer = recorder
		c.Next()
		failed = !recorder.succeeded()
	}
}

// SuccessesPerWindow 只给成功的请求记数（例如注册成功的账号数）：同一个 key 在任意 window 时长内最多成功 limit 次，
// 用完直接 429 并返回 message，不再执行后面的处理；失败的请求不占额度。和 RateLimitFailuresPerHour 一样先占额度、
// 结束后结算，同时进来的请求加起来也超不过上限。计数只在内存里（单实例部署够用），进程重启清零。limit <= 0 时不限。
func SuccessesPerWindow(name string, limit int, window time.Duration, key KeyFunc, message string) gin.HandlerFunc {
	if limit <= 0 {
		return func(c *gin.Context) { c.Next() }
	}
	store := &windowStore{limit: limit, window: window, entries: map[string]*windowEntry{}}
	return func(c *gin.Context) {
		k := key(c)
		entry, wait := store.reserve(k, time.Now())
		if entry == nil {
			tooManyRequests(c, name, k, wait, message)
			return
		}
		succeeded := false
		defer func() { store.settle(entry, time.Now(), succeeded) }()
		recorder := &resultRecorder{ResponseWriter: c.Writer}
		c.Writer = recorder
		c.Next()
		succeeded = recorder.succeeded()
	}
}

// tooManyRequests 返回 429，Retry-After 写还要等几秒才有额度（至少 1 秒）。
func tooManyRequests(c *gin.Context, name, key string, wait time.Duration, message string) {
	log.Printf("rate limit hit name=%s key=%s", name, key)
	c.Header("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
	handler.FailWithStatus(c.Writer, http.StatusTooManyRequests, message)
	c.Abort()
}

// resultRecorder 记下响应体开头几个字节，用来判断业务结果是否成功。
type resultRecorder struct {
	gin.ResponseWriter
	head []byte
}

func (w *resultRecorder) Write(data []byte) (int, error) {
	if room := 16 - len(w.head); room > 0 {
		w.head = append(w.head, data[:min(room, len(data))]...)
	}
	return w.ResponseWriter.Write(data)
}

func (w *resultRecorder) WriteString(text string) (int, error) {
	return w.Write([]byte(text))
}

// succeeded 判断业务结果是否成功：HTTP 200 且响应体是 {"code":0,...}。
func (w *resultRecorder) succeeded() bool {
	return w.Status() == http.StatusOK && bytes.HasPrefix(w.head, []byte(`{"code":0,`))
}

// ByIP 按客户端 IP 限流；真实 IP 依赖 router 里 SetTrustedProxies 只信任本机反代。
// IPv6 按 /64 网段算一个 key：一台机器通常就能分到整个 /64，按单个地址限流等于没限。
func ByIP(c *gin.Context) string {
	raw := c.ClientIP()
	ip := net.ParseIP(raw)
	if ip == nil || ip.To4() != nil {
		return "ip:" + raw
	}
	return "ip:" + ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// ByUser 按登录用户限流，要挂在 UserAuth 之后；拿不到用户时退回按 IP。
func ByUser(c *gin.Context) string {
	if user, ok := service.UserFromContext(c.Request.Context()); ok && user.ID != "" {
		return "user:" + user.ID
	}
	return ByIP(c)
}

// ByUsername 按请求体 JSON 里的 username 限流（登录接口用），读完把请求体原样放回；没有用户名时退回按 IP。
func ByUsername(c *gin.Context) string {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 64<<10))
	c.Request.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), c.Request.Body))
	var payload struct {
		Username string `json:"username"`
	}
	if err == nil && json.Unmarshal(body, &payload) == nil && strings.TrimSpace(payload.Username) != "" {
		return "username:" + strings.ToLower(strings.TrimSpace(payload.Username))
	}
	return ByIP(c)
}

// ByIPAndUsername 按「IP + 用户名」限流：别人换 IP 刷错密码不会把真正的管理员锁在外面。
func ByIPAndUsername(c *gin.Context) string {
	return ByIP(c) + "|" + ByUsername(c)
}

type rateLimitEntry struct {
	limiter  *rate.Limiter
	seen     time.Time
	reserved int // reserve 占着、还没结算的额度
}

type rateLimitStore struct {
	limit   rate.Limit
	burst   int
	idle    time.Duration
	mu      sync.Mutex
	entries map[string]*rateLimitEntry
	swept   time.Time
}

func newRateLimitStore(limit rate.Limit, burst int) *rateLimitStore {
	// 闲置超过「从空桶补满」所需时间的桶和新建的一样，可以安全删掉，避免按 IP 的桶无限增长。
	idle := time.Hour
	if limit > 0 {
		idle = time.Duration(float64(burst) / float64(limit) * float64(time.Second))
	}
	return &rateLimitStore{limit: limit, burst: burst, idle: idle, entries: map[string]*rateLimitEntry{}}
}

func rateLimit(name string, limit rate.Limit, burst int, key KeyFunc) gin.HandlerFunc {
	store := newRateLimitStore(limit, burst)
	return func(c *gin.Context) {
		k := key(c)
		if ok, wait := store.allow(k, time.Now()); !ok {
			tooManyRequests(c, name, k, wait, "请求过于频繁，请稍后再试")
			return
		}
		c.Next()
	}
}

// allow 消耗一个额度；没有额度时返回 false 和还要等多久。
func (s *rateLimitStore) allow(key string, now time.Time) (bool, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	limiter := s.entry(key, now).limiter
	if limiter.AllowN(now, 1) {
		return true, 0
	}
	return false, s.waitFor(limiter.TokensAt(now))
}

// reserve 有空余额度（去掉别人占着的）时占一个，返回对应的桶，之后必须用 settle 结算；没有时返回 nil 和还要等多久。
func (s *rateLimitStore) reserve(key string, now time.Time) (*rateLimitEntry, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.entry(key, now)
	if available := entry.limiter.TokensAt(now) - float64(entry.reserved); available < 1 {
		return nil, s.waitFor(available)
	}
	entry.reserved++
	return entry, 0
}

// settle 结算 reserve 占的额度：失败就真正扣掉，成功就还回去。
func (s *rateLimitStore) settle(entry *rateLimitEntry, now time.Time, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.reserved--
	entry.seen = now
	if failed {
		entry.limiter.AllowN(now, 1)
	}
}

// waitFor 算桶里从 tokens 个额度攒到 1 个要多久。
func (s *rateLimitStore) waitFor(tokens float64) time.Duration {
	return time.Duration((1 - tokens) / float64(s.limit) * float64(time.Second))
}

// entry 取出（没有就新建）key 对应的桶，顺带每分钟清理一次闲置且没有占着额度的桶；调用方要持有锁。
func (s *rateLimitStore) entry(key string, now time.Time) *rateLimitEntry {
	if now.Sub(s.swept) > time.Minute {
		for k, entry := range s.entries {
			if entry.reserved == 0 && now.Sub(entry.seen) > s.idle {
				delete(s.entries, k)
			}
		}
		s.swept = now
	}
	entry, ok := s.entries[key]
	if !ok {
		entry = &rateLimitEntry{limiter: rate.NewLimiter(s.limit, s.burst)}
		s.entries[key] = entry
	}
	entry.seen = now
	return entry
}

// windowStore 给 SuccessesPerWindow 记数：每个 key 记下 window 内每次成功的时间，任意 window 时长内都不会超过 limit 次
// （令牌桶用完一批后在同一个 window 里还会慢慢攒回来，做不到这一点）。
type windowStore struct {
	limit   int
	window  time.Duration
	mu      sync.Mutex
	entries map[string]*windowEntry
	swept   time.Time
}

type windowEntry struct {
	times    []time.Time // window 内每次成功的时间，从早到晚
	reserved int         // reserve 占着、还没结算的额度
}

// prune 去掉 cutoff 及之前的成功记录。
func (e *windowEntry) prune(cutoff time.Time) {
	expired := 0
	for expired < len(e.times) && !e.times[expired].After(cutoff) {
		expired++
	}
	e.times = e.times[expired:]
}

// reserve 有空余额度（去掉别人占着的）时占一个，返回对应的记录，之后必须用 settle 结算；没有时返回 nil 和还要等多久。
// 顺带每分钟清理一次 window 内没有成功记录、也没占着额度的 key，避免按 IP 的记录无限增长。
func (s *windowStore) reserve(key string, now time.Time) (*windowEntry, time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := now.Add(-s.window)
	if now.Sub(s.swept) > time.Minute {
		for k, entry := range s.entries {
			entry.prune(cutoff)
			if entry.reserved == 0 && len(entry.times) == 0 {
				delete(s.entries, k)
			}
		}
		s.swept = now
	}
	entry, ok := s.entries[key]
	if !ok {
		entry = &windowEntry{}
		s.entries[key] = entry
	}
	entry.prune(cutoff)
	if len(entry.times)+entry.reserved < s.limit {
		entry.reserved++
		return entry, 0
	}
	// 等最早那次成功滑出 window；名额全被正在处理的请求占着时，过一秒再试。
	if len(entry.times) == 0 {
		return nil, time.Second
	}
	return nil, entry.times[0].Sub(cutoff)
}

// settle 结算 reserve 占的额度：成功就记下这次的时间，失败就还回去。
func (s *windowStore) settle(entry *windowEntry, now time.Time, succeeded bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry.reserved--
	if succeeded {
		entry.times = append(entry.times, now)
	}
}
