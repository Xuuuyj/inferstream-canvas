package middleware

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
)

// proxyGuardSlots 是全站同时进行的代理下载名额，proxyGuardPerIP 是同一个 IP（IPv6 按 /64）的名额，
// proxyGuardWait 是排队等名额的最长时间。
var (
	proxyGuardSlots = make(chan struct{}, 64)
	proxyGuardPerIP = 4
	proxyGuardWait  = 10 * time.Second
	proxyGuardMu    sync.Mutex
	proxyGuardIPs   = map[string]*proxyGuardIP{}
)

// proxyGuardIP 是一个 IP 的名额；users 是正在用或在排队的请求数，归零就从表里删掉。
type proxyGuardIP struct {
	slots chan struct{}
	users int
}

// ProxyGuard 挡住其他网站盗用 /api/proxy-image：Sec-Fetch-Site 为 cross-site 或 same-site 时返回 403；
// same-origin、none 和没带这个头的放行（按 IP 的限流挂在它前面）。
// 同一个 IP 最多同时 4 个、全站最多同时 64 个，超出的排队等名额，等不到时分别返回 429 和 503。
func ProxyGuard(c *gin.Context) {
	switch strings.ToLower(strings.TrimSpace(c.GetHeader("Sec-Fetch-Site"))) {
	case "cross-site", "same-site":
		handler.FailWithStatus(c.Writer, http.StatusForbidden, "不允许其他网站引用")
		c.Abort()
		return
	}
	key := ByIP(c)
	ip := acquireProxyGuardIP(key)
	defer releaseProxyGuardIP(key, ip)
	timer := time.NewTimer(proxyGuardWait)
	defer timer.Stop()
	select {
	case ip.slots <- struct{}{}:
		defer func() { <-ip.slots }()
	case <-c.Request.Context().Done():
		c.Abort()
		return
	case <-timer.C:
		handler.FailWithStatus(c.Writer, http.StatusTooManyRequests, "同时代理的请求过多，请稍后再试")
		c.Abort()
		return
	}
	select {
	case proxyGuardSlots <- struct{}{}:
		defer func() { <-proxyGuardSlots }()
		c.Next()
	case <-c.Request.Context().Done():
		c.Abort()
	case <-timer.C:
		handler.FailWithStatus(c.Writer, http.StatusServiceUnavailable, "代理繁忙，请稍后再试")
		c.Abort()
	}
}

func acquireProxyGuardIP(key string) *proxyGuardIP {
	proxyGuardMu.Lock()
	defer proxyGuardMu.Unlock()
	ip := proxyGuardIPs[key]
	if ip == nil {
		ip = &proxyGuardIP{slots: make(chan struct{}, proxyGuardPerIP)}
		proxyGuardIPs[key] = ip
	}
	ip.users++
	return ip
}

func releaseProxyGuardIP(key string, ip *proxyGuardIP) {
	proxyGuardMu.Lock()
	defer proxyGuardMu.Unlock()
	ip.users--
	if ip.users == 0 {
		delete(proxyGuardIPs, key)
	}
}
