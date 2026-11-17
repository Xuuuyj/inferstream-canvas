package handler

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func testPNG(size int) []byte {
	return append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, size-8)...)
}

// proxyUpstream 让代理客户端的所有拨号都连到这个假上游，URL 里的域名随便写。
func proxyUpstream(t *testing.T, upstream http.HandlerFunc) {
	t.Helper()
	server := httptest.NewServer(upstream)
	restore := service.SetProxyDialContextForTest(func(ctx context.Context, network, _ string) (net.Conn, error) {
		var dialer net.Dialer
		return dialer.DialContext(ctx, network, server.Listener.Addr().String())
	})
	t.Cleanup(func() {
		restore()
		server.Close()
	})
}

// newProxyServer 和线上一样经过 gin（带 Recovery），确认中断连接在 gin 包装下也生效。
// loggedIn 为 true 时模拟 OptionalAuth 已经认出登录用户。
func newProxyServer(t *testing.T, loggedIn bool) *httptest.Server {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(gin.Recovery())
	router.GET("/api/proxy-image", func(c *gin.Context) {
		if loggedIn {
			c.Request = c.Request.WithContext(service.WithUser(c.Request.Context(), model.AuthUser{ID: "user-1", Role: model.UserRoleUser}))
		}
		ProxyImage(c.Writer, c.Request)
	})
	proxy := httptest.NewServer(router)
	t.Cleanup(proxy.Close)
	return proxy
}

// proxyGet 以登录用户身份代理；anonymousProxyGet 不带登录。
func proxyGet(t *testing.T, target string) (*http.Response, []byte, error) {
	t.Helper()
	return proxyGetAs(t, true, target)
}

func anonymousProxyGet(t *testing.T, target string) (*http.Response, []byte, error) {
	t.Helper()
	return proxyGetAs(t, false, target)
}

func proxyGetAs(t *testing.T, loggedIn bool, target string) (*http.Response, []byte, error) {
	t.Helper()
	proxy := newProxyServer(t, loggedIn)
	response, err := proxy.Client().Get(proxy.URL + "/api/proxy-image?url=" + url.QueryEscape(target))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, readErr := io.ReadAll(response.Body)
	return response, body, readErr
}

// proxyGetError 以登录用户身份代理，返回连接或读响应体时的错误。超时中断时写超时已过，
// 连响应头都可能发不出去，所以收不到响应头和响应体读到一半断开都算中断。
func proxyGetError(t *testing.T, target string) error {
	t.Helper()
	proxy := newProxyServer(t, true)
	response, err := proxy.Client().Get(proxy.URL + "/api/proxy-image?url=" + url.QueryEscape(target))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, err = io.ReadAll(response.Body)
	return err
}

// setProxyTimeouts 临时缩短空闲超时和总时长。
func setProxyTimeouts(t *testing.T, idle, total time.Duration) {
	t.Helper()
	t.Cleanup(SetProxyTimeoutsForTest(idle, total))
}

func waitClosed(t *testing.T, done <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal(message)
	}
}

func TestProxyImageRejectsNonMedia(t *testing.T) {
	cases := map[string]struct{ contentType, body string }{
		"html": {"text/html", "<!DOCTYPE html><html><script>alert(1)</script></html>"},
		"svg":  {"image/svg+xml", `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`},
		"json": {"application/json", `{"ok":true}`},
	}
	for name, item := range cases {
		t.Run(name, func(t *testing.T) {
			proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", item.contentType)
				_, _ = io.WriteString(w, item.body)
			})
			response, _, _ := proxyGet(t, "http://media.test/file."+name)
			if response.StatusCode != http.StatusUnsupportedMediaType {
				t.Fatalf("%s 返回 %d，期望 415", name, response.StatusCode)
			}
		})
	}
}

func TestProxyImageServesPNGWithSafeHeaders(t *testing.T) {
	png := testPNG(2048)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write(png)
	})
	response, body, err := proxyGet(t, "http://media.test/image.png")
	if err != nil || response.StatusCode != http.StatusOK || !bytes.Equal(body, png) {
		t.Fatalf("png 代理失败：%d %v", response.StatusCode, err)
	}
	want := map[string]string{
		"Content-Type":            "image/png",
		"X-Content-Type-Options":  "nosniff",
		"Content-Security-Policy": "sandbox; default-src 'none'",
		"Cache-Control":           "private, max-age=86400",
	}
	for key, value := range want {
		if got := response.Header.Get(key); got != value {
			t.Fatalf("%s = %q，期望 %q", key, got, value)
		}
	}
	// 写超时设在连接上，代理完必须关连接，不能留给下一个请求。
	if !response.Close {
		t.Fatal("代理响应应带 Connection: close")
	}
}

func TestProxyImageOctetStreamByExtension(t *testing.T) {
	data := bytes.Repeat([]byte{0x00, 0x1b}, 400)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(data)
	})
	response, body, err := proxyGet(t, "http://media.test/clip.mp4?sign=1")
	if err != nil || response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "video/mp4" || !bytes.Equal(body, data) {
		t.Fatalf(".mp4 后缀的 octet-stream 应放行：%d %q %v", response.StatusCode, response.Header.Get("Content-Type"), err)
	}
	if response, _, _ := proxyGet(t, "http://media.test/file.bin"); response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("其他后缀的 octet-stream 返回 %d，期望 415", response.StatusCode)
	}
}

func TestProxyImageAbortsOversizedImage(t *testing.T) {
	previous := proxyImageMaxBytes
	proxyImageMaxBytes = 1024
	t.Cleanup(func() { proxyImageMaxBytes = previous })
	png := testPNG(4096)

	t.Run("declared length", func(t *testing.T) {
		proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(len(png)))
			_, _ = w.Write(png)
		})
		if response, _, _ := proxyGet(t, "http://media.test/big.png"); response.StatusCode != http.StatusBadGateway {
			t.Fatalf("声明长度超限返回 %d，期望 502", response.StatusCode)
		}
	})
	t.Run("chunked", func(t *testing.T) {
		proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(png[:600])
			w.(http.Flusher).Flush()
			_, _ = w.Write(png[600:])
		})
		_, body, err := proxyGet(t, "http://media.test/big.png")
		if err == nil {
			t.Fatalf("超限时应断开连接，却收到了完整响应（%d 字节）", len(body))
		}
	})
}

func TestProxyImageUpstreamNotFound(t *testing.T) {
	proxyUpstream(t, http.NotFound)
	if response, _, _ := proxyGet(t, "http://media.test/missing.png"); response.StatusCode != http.StatusBadGateway {
		t.Fatalf("上游 404 返回 %d，期望 502", response.StatusCode)
	}
}

func TestProxyImageCancelsUpstreamWhenClientLeaves(t *testing.T) {
	started := make(chan struct{})
	closed := make(chan struct{})
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(testPNG(600))
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-r.Context().Done():
			close(closed)
		case <-time.After(10 * time.Second):
		}
	})
	proxy := newProxyServer(t, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, proxy.URL+"/api/proxy-image?url="+url.QueryEscape("http://media.test/slow.png"), nil)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		if response, err := proxy.Client().Do(request); err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	waitClosed(t, started, "上游没有收到请求")
	cancel()
	waitClosed(t, closed, "用户取消后上游连接没有关闭")
}

func TestProxyMediaType(t *testing.T) {
	avif := append([]byte("\x00\x00\x00\x1cftypavif"), bytes.Repeat([]byte{0}, 64)...)
	if contentType, limit, ok := proxyMediaType(avif); !ok || contentType != "image/avif" || limit != proxyImageMaxBytes {
		t.Fatalf("avif 识别错误：%q %d %v", contentType, limit, ok)
	}
	if contentType, limit, ok := proxyMediaType([]byte{0x00, 0x01}, "/a/b", "/signed/clip.MOV"); !ok || contentType != "video/quicktime" || limit != proxyMediaMaxBytes {
		t.Fatalf("重定向后的 .mov 应放行：%q %d %v", contentType, limit, ok)
	}
	if proxyMediaMaxBytes != 200<<20 || proxyImageMaxBytes != 30<<20 || proxyAnonImageMaxBytes != 20<<20 {
		t.Fatalf("大小上限不对：音视频 %d，图片 %d，未登录图片 %d", proxyMediaMaxBytes, proxyImageMaxBytes, proxyAnonImageMaxBytes)
	}
	if proxyIdleTimeout != 30*time.Second || proxyTotalTimeout != 10*time.Minute {
		t.Fatalf("超时不对：空闲 %v，总时长 %v", proxyIdleTimeout, proxyTotalTimeout)
	}
	if _, _, ok := proxyMediaType(nil); ok {
		t.Fatal("空内容不应放行")
	}
}

func TestProxyImageAnonymousOnlyImages(t *testing.T) {
	video := bytes.Repeat([]byte{0x00, 0x1b}, 400)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".mp4") {
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write(video)
			return
		}
		_, _ = w.Write(testPNG(2048))
	})
	if response, _, _ := anonymousProxyGet(t, "http://media.test/clip.mp4"); response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未登录代理视频返回 %d，期望 401", response.StatusCode)
	}
	if response, body, err := anonymousProxyGet(t, "http://media.test/a.png"); err != nil || response.StatusCode != http.StatusOK || len(body) != 2048 {
		t.Fatalf("未登录代理图片应放行：%d %v", response.StatusCode, err)
	}
	if response, body, err := proxyGet(t, "http://media.test/clip.mp4"); err != nil || response.StatusCode != http.StatusOK || !bytes.Equal(body, video) {
		t.Fatalf("登录后代理视频应放行：%d %v", response.StatusCode, err)
	}
}

func TestProxyImageAnonymousImageSizeLimit(t *testing.T) {
	previousAnon, previousImage := proxyAnonImageMaxBytes, proxyImageMaxBytes
	proxyAnonImageMaxBytes, proxyImageMaxBytes = 1024, 8192
	t.Cleanup(func() { proxyAnonImageMaxBytes, proxyImageMaxBytes = previousAnon, previousImage })
	png := testPNG(4096)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(png)))
		_, _ = w.Write(png)
	})
	if response, _, _ := anonymousProxyGet(t, "http://media.test/big.png"); response.StatusCode != http.StatusBadGateway {
		t.Fatalf("未登录超过图片上限返回 %d，期望 502", response.StatusCode)
	}
	if response, body, err := proxyGet(t, "http://media.test/big.png"); err != nil || response.StatusCode != http.StatusOK || len(body) != len(png) {
		t.Fatalf("登录用户在自己的上限内应放行：%d %v", response.StatusCode, err)
	}
}

// usePublicHost 把 PUBLIC_HOST 设成 host，解析结果由 answers 决定（没有的域名解析失败）。
func usePublicHost(t *testing.T, host string, answers map[string]string) *int {
	t.Helper()
	previous := config.Cfg
	config.Cfg.PublicHost = host
	lookups := 0
	restore := service.SetProxySelfLookupForTest(func(ctx context.Context, name string) ([]net.IPAddr, error) {
		lookups++
		if ip, ok := answers[name]; ok {
			return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
		}
		return nil, errors.New("no such host")
	})
	t.Cleanup(func() {
		restore()
		config.Cfg = previous
	})
	return &lookups
}

func TestProxyImageRefusesOwnHost(t *testing.T) {
	usePublicHost(t, "canvas.example", map[string]string{"canvas.example": "203.0.113.20"})
	upstreamHits := 0
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_, _ = w.Write(testPNG(600))
	})
	proxy := newProxyServer(t, true)
	proxyHost := strings.TrimPrefix(proxy.URL, "http://")
	for _, target := range []string{
		"https://canvas.example/api/proxy-image?url=x",
		"https://CANVAS.example./a.png",
		"http://" + proxyHost + "/api/health",
		"http://front.example/a.png",
	} {
		request, _ := http.NewRequest(http.MethodGet, proxy.URL+"/api/proxy-image?url="+url.QueryEscape(target), nil)
		request.Header.Set("X-Forwarded-Host", "front.example")
		response, err := proxy.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("代理本站地址 %s 返回 %d，期望 403", target, response.StatusCode)
		}
	}
	if upstreamHits != 0 {
		t.Fatalf("本站地址不应发出请求，实际 %d 次", upstreamHits)
	}
	if response, _, _ := proxyGet(t, "http://cdn.example/a.png"); response.StatusCode != http.StatusOK {
		t.Fatalf("别的域名返回 %d，期望 200", response.StatusCode)
	}
}

// 只代理 80、443 端口：别的端口（包括重定向过去的）一律 502、不发请求，没法拿来探测端口开没开。
func TestProxyImageOnlyWebPorts(t *testing.T) {
	upstreamHits := 0
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if r.URL.Path == "/moved.png" {
			http.Redirect(w, r, "http://media.test:8080/a.png", http.StatusFound)
			return
		}
		_, _ = w.Write(testPNG(600))
	})
	for _, target := range []string{"http://media.test:8080/a.png", "http://media.test:22/a.png"} {
		if response, _, _ := anonymousProxyGet(t, target); response.StatusCode != http.StatusBadGateway {
			t.Fatalf("%s 返回 %d，期望 502", target, response.StatusCode)
		}
	}
	if upstreamHits != 0 {
		t.Fatalf("非 80、443 端口不应发出请求，实际 %d 次", upstreamHits)
	}
	if response, _, _ := proxyGet(t, "http://media.test/moved.png"); response.StatusCode != http.StatusBadGateway || upstreamHits != 1 {
		t.Fatalf("重定向到 8080 端口返回 %d、上游收到 %d 次，期望 502、只有重定向那一次", response.StatusCode, upstreamHits)
	}
	for _, target := range []string{"http://media.test:443/a.png", "http://media.test:80/a.png"} {
		if response, _, _ := anonymousProxyGet(t, target); response.StatusCode != http.StatusOK {
			t.Fatalf("%s 返回 %d，期望 200", target, response.StatusCode)
		}
	}
}

func TestProxyImageAbortsWhenUpstreamStalls(t *testing.T) {
	setProxyTimeouts(t, 150*time.Millisecond, time.Minute)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(testPNG(600))
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	start := time.Now()
	if err := proxyGetError(t, "http://media.test/stall.png"); err == nil {
		t.Fatal("上游停住不发数据时应中断，却收到了完整响应")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("空闲超时没有生效，用了 %v", elapsed)
	}
}

func TestProxyImageNoResponseHeadersTimesOut(t *testing.T) {
	setProxyTimeouts(t, 150*time.Millisecond, time.Minute)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	start := time.Now()
	if response, _, _ := proxyGet(t, "http://media.test/silent.png"); response.StatusCode != http.StatusBadGateway {
		t.Fatalf("上游一直不回响应头时返回 %d，期望 502", response.StatusCode)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("空闲超时没有生效，用了 %v", elapsed)
	}
}

func TestProxyImageTotalTimeout(t *testing.T) {
	setProxyTimeouts(t, time.Second, 400*time.Millisecond)
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(testPNG(600))
		w.(http.Flusher).Flush()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for i := 0; i < 100; i++ {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if _, err := w.Write([]byte{0}); err != nil {
					return
				}
				w.(http.Flusher).Flush()
			}
		}
	})
	start := time.Now()
	if err := proxyGetError(t, "http://media.test/trickle.png"); err == nil {
		t.Fatal("一直有数据但超过总时长时应中断")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("总时长上限没有生效，用了 %v", elapsed)
	}
}

func TestProxyImageFailsClosedWhenPublicHostDoesNotResolve(t *testing.T) {
	lookups := usePublicHost(t, "canvas.example", nil)
	upstreamHits := 0
	proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		_, _ = w.Write(testPNG(600))
	})
	for i := 0; i < 3; i++ {
		if response, _, _ := proxyGet(t, "http://cdn.example/a.png"); response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("PUBLIC_HOST 解析失败时返回 %d，期望 503", response.StatusCode)
		}
	}
	if upstreamHits != 0 || *lookups != 1 {
		t.Fatalf("解析失败时不应发出代理请求、也不应每个请求都重新解析：上游 %d 次，解析 %d 次", upstreamHits, *lookups)
	}
}
