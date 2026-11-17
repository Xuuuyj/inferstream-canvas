package service

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestIsBlockedProxyIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":       true,
		"10.0.0.1":        true,
		"172.16.0.1":      true,
		"192.168.1.1":     true,
		"169.254.169.254": true,
		"100.100.100.200": true,
		"0.0.0.0":         true,
		"::1":             true,
		"fc00::1":         true,
		"fe80::1":         true,
		"1.1.1.1":         false,
		"8.8.8.8":         false,
		// 新增的保留网段。
		"198.18.0.1":        true,
		"198.19.255.254":    true,
		"192.0.0.8":         true,
		"240.0.0.1":         true,
		"255.255.255.255":   true,
		"64:ff9b::a00:1":    true,
		"2002:a00:1::1":     true,
		"::ffff:198.18.0.1": true,
		"198.20.0.1":        false,
		"192.0.2.1":         false,
		"2606:4700::1111":   false,
	}
	for raw, expected := range cases {
		actual := isBlockedProxyIP(net.ParseIP(raw))
		if actual != expected {
			t.Fatalf(
				"isBlockedProxyIP(%q) = %v，期望 %v",
				raw,
				actual,
				expected,
			)
		}
	}
}

func TestSafeProxyHTTPClientRedirectLimit(t *testing.T) {
	client := SafeProxyHTTPClient()
	request, err := http.NewRequest(
		http.MethodGet,
		"https://example.com/image.png",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 5),
	); err != nil {
		t.Fatalf("第 5 次重定向不应被拒绝：%v", err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 6),
	); err == nil {
		t.Fatal("超过 5 次重定向应被拒绝")
	}
}

// /api/proxy-image 用的流式客户端只连 80、443 端口，免得被拿来探测任意端口；别的端口连拨号都不拨。普通代理客户端不受影响。
func TestSafeProxyStreamClientOnlyDialsWebPorts(t *testing.T) {
	var dialed []string
	restore := SetProxyDialContextForTest(func(ctx context.Context, network, address string) (net.Conn, error) {
		dialed = append(dialed, address)
		return nil, errors.New("test dial")
	})
	t.Cleanup(restore)
	get := func(client *http.Client, target string) error {
		request, _ := http.NewRequest(http.MethodGet, target, nil)
		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
		}
		return err
	}
	for _, target := range []string{"http://media.example:8080/a.png", "http://media.example:22/a.png", "https://[2001:db8::1]:8443/a.png"} {
		if err := get(SafeProxyStreamClient(), target); err == nil || !strings.Contains(err.Error(), "80 和 443") {
			t.Errorf("%s: err = %v，期望因端口被拒绝", target, err)
		}
	}
	if len(dialed) != 0 {
		t.Fatalf("非 80、443 端口不应拨号，实际拨了 %v", dialed)
	}
	for _, target := range []string{"https://media.example/a.png", "http://media.example/a.png", "https://media.example:443/a.png"} {
		_ = get(SafeProxyStreamClient(), target)
	}
	if want := "media.example:443 media.example:80 media.example:443"; strings.Join(dialed, " ") != want {
		t.Fatalf("80、443 端口应照常拨号，实际 %v", dialed)
	}
	dialed = nil
	_ = get(SafeProxyHTTPClient(), "http://media.example:8080/a.png")
	if len(dialed) != 1 || dialed[0] != "media.example:8080" {
		t.Fatalf("普通代理客户端不限端口，实际拨了 %v", dialed)
	}
}

// useProxySelfLookup 换掉本站域名的解析函数（顺带清空缓存），并记下每个域名被解析了几次。
func useProxySelfLookup(t *testing.T, answers map[string]string) map[string]int {
	t.Helper()
	previousCfg := config.Cfg
	lookups := map[string]int{}
	restore := SetProxySelfLookupForTest(func(ctx context.Context, host string) ([]net.IPAddr, error) {
		lookups[host]++
		if ip, ok := answers[host]; ok {
			return []net.IPAddr{{IP: net.ParseIP(ip)}}, nil
		}
		return nil, errors.New("no such host")
	})
	t.Cleanup(func() {
		restore()
		config.Cfg = previousCfg
	})
	return lookups
}

func TestProxySelfRefusesOwnHostsAndIPs(t *testing.T) {
	lookups := useProxySelfLookup(t, map[string]string{"canvas.example": "203.0.113.20", "front.example": "2001:db8::20"})
	config.Cfg.PublicHost = "canvas.example"
	config.Cfg.ServerPublicIPs = []string{"203.0.113.10"}
	ctx, err := WithProxySelf(context.Background(), "front.example:443", "", "198.51.100.30:8080")
	if err != nil {
		t.Fatal(err)
	}

	for _, host := range []string{"canvas.example", "CANVAS.example.", "front.example"} {
		if !IsProxySelfHost(ctx, host) {
			t.Errorf("%q 应算本站域名", host)
		}
	}
	if IsProxySelfHost(ctx, "openai.fit") || IsProxySelfHost(context.Background(), "canvas.example") {
		t.Fatal("别的域名、或没挂本站信息的 context 不应拦")
	}
	// 只解析 PUBLIC_HOST；请求带来的域名只按名字比对，不发 DNS 查询。
	if lookups["canvas.example"] != 1 || lookups["front.example"] != 0 {
		t.Fatalf("解析次数不对：%v", lookups)
	}
	// 拨号前按解析结果拦本站 IP：配置的公网 IP、PUBLIC_HOST 解析出的地址、请求里写成 IP 的 Host。直接写 IP 不经过 DNS。
	for _, address := range []string{"203.0.113.10:443", "203.0.113.20:80", "198.51.100.30:443"} {
		_, err := safeProxyDialContext(ctx, "tcp", address)
		if err == nil || !strings.Contains(err.Error(), "本站") {
			t.Errorf("拨号 %s 应因本站地址被拒绝，实际 %v", address, err)
		}
	}
	// 重定向到本站域名也要拦。
	redirect, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://Canvas.Example/a.png", nil)
	if err := SafeProxyStreamClient().CheckRedirect(redirect, nil); err == nil {
		t.Fatal("重定向到本站域名应被拒绝")
	}
	other, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://cdn.example/a.png", nil)
	if err := SafeProxyStreamClient().CheckRedirect(other, nil); err != nil {
		t.Fatalf("重定向到别的域名不应被拒绝：%v", err)
	}
	if SafeProxyStreamClient().Timeout != 0 || SafeProxyHTTPClient().Timeout == 0 {
		t.Fatal("流式代理客户端不应有整体超时，普通代理客户端保持原样")
	}
}

func TestResolvePublicHostCachesAndFailsClosed(t *testing.T) {
	answers := map[string]string{"canvas.example": "203.0.113.20"}
	lookups := useProxySelfLookup(t, answers)
	previousTTL, previousRetry := publicHostTTL, publicHostRetry
	t.Cleanup(func() { publicHostTTL, publicHostRetry = previousTTL, previousRetry })
	publicHostTTL, publicHostRetry = time.Hour, time.Hour
	config.Cfg.PublicHost = "canvas.example"

	for i := 0; i < 3; i++ {
		if _, err := WithProxySelf(context.Background(), "canvas.example"); err != nil {
			t.Fatal(err)
		}
	}
	if lookups["canvas.example"] != 1 {
		t.Fatalf("缓存期内只应解析一次，实际 %d 次", lookups["canvas.example"])
	}

	// 缓存过期后重新解析；这次解析失败，代理必须拒绝，而且失败结果也缓存，不会每个请求都卡在 DNS 上。
	publicHostMu.Lock()
	publicHostCache.expires = time.Now().Add(-time.Second)
	publicHostMu.Unlock()
	delete(answers, "canvas.example")
	for i := 0; i < 3; i++ {
		if _, err := WithProxySelf(context.Background()); err == nil || !strings.Contains(err.Error(), "PUBLIC_HOST") {
			t.Fatalf("PUBLIC_HOST 解析失败时应报错，实际 %v", err)
		}
	}
	if lookups["canvas.example"] != 2 {
		t.Fatalf("失败结果应缓存，实际解析 %d 次", lookups["canvas.example"])
	}

	// 失败缓存到期后再试，解析成功就恢复。
	publicHostMu.Lock()
	publicHostCache.expires = time.Now().Add(-time.Second)
	publicHostMu.Unlock()
	answers["canvas.example"] = "203.0.113.21"
	ctx, err := WithProxySelf(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if self := ctx.Value(proxySelfKey{}).(proxySelf); !self.hasIP(net.ParseIP("203.0.113.21")) || self.hasIP(net.ParseIP("203.0.113.20")) {
		t.Fatalf("重新解析后的本站 IP 不对：%v", self.ips)
	}

	// 换了 PUBLIC_HOST 立即重新解析；写成 IP 或不配时不查 DNS。
	config.Cfg.PublicHost = "other.example"
	if _, err := WithProxySelf(context.Background()); err == nil || lookups["other.example"] != 1 {
		t.Fatalf("新域名应立即解析（解析不出来就报错），实际 %v %v", err, lookups)
	}
	for _, host := range []string{"203.0.113.30", ""} {
		config.Cfg.PublicHost = host
		if _, err := WithProxySelf(context.Background()); err != nil {
			t.Fatalf("PUBLIC_HOST=%q 不应报错：%v", host, err)
		}
	}
	if len(lookups) != 2 {
		t.Fatalf("IP 或空的 PUBLIC_HOST 不应解析：%v", lookups)
	}
}
