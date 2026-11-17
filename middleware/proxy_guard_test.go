package middleware

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func proxyGuardRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/api/proxy-image", ProxyGuard, func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	return router
}

func TestProxyGuardSecFetchSite(t *testing.T) {
	router := proxyGuardRouter()
	cases := map[string]int{
		"cross-site":  http.StatusForbidden,
		"same-site":   http.StatusForbidden,
		"same-origin": http.StatusOK,
		"none":        http.StatusOK,
		"":            http.StatusOK,
	}
	for site, want := range cases {
		request := httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=x", nil)
		if site != "" {
			request.Header.Set("Sec-Fetch-Site", site)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Fatalf("Sec-Fetch-Site=%q 返回 %d，期望 %d", site, recorder.Code, want)
		}
	}
	if len(proxyGuardSlots) != 0 || len(proxyGuardIPs) != 0 {
		t.Fatalf("请求结束后并发名额没有归还：全站 %d，按 IP %d", len(proxyGuardSlots), len(proxyGuardIPs))
	}
}

func TestProxyGuardConcurrencyLimit(t *testing.T) {
	previousWait := proxyGuardWait
	proxyGuardWait = 20 * time.Millisecond
	for i := 0; i < cap(proxyGuardSlots); i++ {
		proxyGuardSlots <- struct{}{}
	}
	t.Cleanup(func() {
		for i := 0; i < cap(proxyGuardSlots); i++ {
			<-proxyGuardSlots
		}
		proxyGuardWait = previousWait
	})
	recorder := httptest.NewRecorder()
	proxyGuardRouter().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/proxy-image?url=x", nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("并发名额用完时返回 %d，期望 503", recorder.Code)
	}
}

func TestProxyGuardPerIPConcurrencyLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousWait := proxyGuardWait
	proxyGuardWait = 50 * time.Millisecond
	t.Cleanup(func() { proxyGuardWait = previousWait })
	entered := make(chan struct{}, 16)
	release := make(chan struct{})
	router := gin.New()
	router.GET("/api/proxy-image", ProxyGuard, func(c *gin.Context) {
		if c.Query("block") == "1" {
			entered <- struct{}{}
			<-release
		}
		c.String(http.StatusOK, "ok")
	})
	send := func(remoteAddr, query string) int {
		request := httptest.NewRequest(http.MethodGet, "/api/proxy-image?"+query, nil)
		request.RemoteAddr = remoteAddr
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}

	var wg sync.WaitGroup
	for i := 0; i < proxyGuardPerIP; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			send("[2001:db8:1:2::10]:5000", "block=1")
		}()
	}
	for i := 0; i < proxyGuardPerIP; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("前 4 个请求没有拿到名额")
		}
	}
	if code := send("[2001:db8:1:2:ffff::99]:5001", "url=x"); code != http.StatusTooManyRequests {
		t.Fatalf("同一个 /64 的第 5 个并发请求返回 %d，期望 429", code)
	}
	if code := send("[2001:db8:1:3::10]:5000", "url=x"); code != http.StatusOK {
		t.Fatalf("另一个 /64 返回 %d，期望 200", code)
	}
	if code := send("198.51.100.7:5000", "url=x"); code != http.StatusOK {
		t.Fatalf("另一个 IPv4 返回 %d，期望 200", code)
	}
	close(release)
	wg.Wait()
	if code := send("[2001:db8:1:2::10]:5000", "url=x"); code != http.StatusOK {
		t.Fatalf("名额归还后返回 %d，期望 200", code)
	}
	if len(proxyGuardIPs) != 0 || len(proxyGuardSlots) != 0 {
		t.Fatalf("名额没有归还：按 IP %d，全站 %d", len(proxyGuardIPs), len(proxyGuardSlots))
	}
}

// 浏览器发了请求却一直不收数据：写超时让处理函数在总时长内返回，并发名额也要归还。
// 用原始 TCP 连接发请求、之后一个字节都不读，上游一直往外送数据，直到把两边的缓冲区塞满。
func TestProxyImageClientNeverReads(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := map[string]struct{ idle, total time.Duration }{
		"idle timeout":  {300 * time.Millisecond, 2 * time.Second},
		"total timeout": {10 * time.Second, 800 * time.Millisecond},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			t.Cleanup(handler.SetProxyTimeoutsForTest(item.idle, item.total))
			chunk := bytes.Repeat([]byte{0x00, 0x1b}, 32<<10)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/octet-stream")
				for {
					if _, err := w.Write(chunk); err != nil {
						return
					}
				}
			}))
			t.Cleanup(upstream.Close)
			t.Cleanup(service.SetProxyDialContextForTest(func(ctx context.Context, network, _ string) (net.Conn, error) {
				var dialer net.Dialer
				return dialer.DialContext(ctx, network, upstream.Listener.Addr().String())
			}))

			returned := make(chan time.Duration, 1)
			router := gin.New()
			router.Use(gin.Recovery())
			router.GET("/api/proxy-image", ProxyGuard, func(c *gin.Context) {
				start := time.Now()
				defer func() { returned <- time.Since(start) }()
				c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), model.AuthUser{ID: "user-1", Role: model.UserRoleUser}))
				handler.ProxyImage(c.Writer, c.Request)
			})
			proxy := httptest.NewServer(router)
			t.Cleanup(proxy.Close)

			conn, err := net.Dial("tcp", proxy.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if _, err := io.WriteString(conn, "GET /api/proxy-image?url="+url.QueryEscape("http://media.test/clip.mp4")+" HTTP/1.1\r\nHost: canvas.test\r\n\r\n"); err != nil {
				t.Fatal(err)
			}

			select {
			case elapsed := <-returned:
				if elapsed > item.total+500*time.Millisecond {
					t.Fatalf("处理函数用了 %v 才返回，超过总时长 %v", elapsed, item.total)
				}
			case <-time.After(item.total + 3*time.Second):
				t.Fatal("浏览器不收数据时处理函数一直没有返回")
			}
			deadline := time.Now().Add(2 * time.Second)
			for {
				proxyGuardMu.Lock()
				held := len(proxyGuardSlots) + len(proxyGuardIPs)
				proxyGuardMu.Unlock()
				if held == 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("处理函数返回后并发名额没有归还：全站 %d，按 IP %d", len(proxyGuardSlots), len(proxyGuardIPs))
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}
