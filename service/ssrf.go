package service

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

var safeProxyHTTPClient = newSafeProxyHTTPClient()

// safeProxyStreamClient 给 /api/proxy-image 用：拨号检查和重定向规则同 safeProxyHTTPClient，另外只连 80 和 443 端口
// （proxyStreamDialContext），所以单独一个连接池；不设整体超时，/api/proxy-image 自己用 context 控制空闲超时和总时长。
var safeProxyStreamClient = func() *http.Client {
	client := *safeProxyHTTPClient
	transport := client.Transport.(*http.Transport).Clone()
	transport.DialContext = proxyStreamDialContext
	client.Transport = transport
	client.Timeout = 0
	return &client
}()

func SafeProxyHTTPClient() *http.Client {
	return safeProxyHTTPClient
}

// SafeProxyStreamClient 给流式代理用，调用方必须给请求带上有截止时间的 context。
func SafeProxyStreamClient() *http.Client {
	return safeProxyStreamClient
}
func newSafeProxyHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return proxyDialContext(ctx, network, address)
	}
	return &http.Client{
		Transport: transport,
		Timeout:   5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 {
				return errors.New("重定向次数过多")
			}
			scheme := strings.ToLower(req.URL.Scheme)
			if scheme != "http" && scheme != "https" {
				return errors.New("重定向地址无效")
			}
			if IsProxySelfHost(req.Context(), req.URL.Hostname()) {
				return errors.New("禁止代理本站地址")
			}
			return nil
		},
	}
}

// proxyDialContext 是代理客户端实际使用的拨号函数，测试可以换成直连 httptest 的拨号。
var proxyDialContext = safeProxyDialContext

// SetProxyDialContextForTest 替换代理客户端的拨号函数，只给测试用；返回恢复函数。
func SetProxyDialContextForTest(dial func(ctx context.Context, network, address string) (net.Conn, error)) func() {
	previous := proxyDialContext
	proxyDialContext = dial
	safeProxyHTTPClient.CloseIdleConnections()
	safeProxyStreamClient.CloseIdleConnections()
	return func() {
		proxyDialContext = previous
		safeProxyHTTPClient.CloseIdleConnections()
		safeProxyStreamClient.CloseIdleConnections()
	}
}

// proxyStreamDialContext 只放行 80 和 443 端口，再交给 proxyDialContext 拦内网和本站地址。/api/proxy-image 对外开放
// （没登录也能代理图片），放行任意端口的话，别人能拿 502 和 415 的区别探测公网主机的端口开没开；重定向到别的端口同样在这里拦下。
func proxyStreamDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if _, port, err := net.SplitHostPort(address); err != nil || (port != "80" && port != "443") {
		return nil, errors.New("只能代理 80 和 443 端口的地址")
	}
	return proxyDialContext(ctx, network, address)
}

func safeProxyDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("无法解析目标地址")
	}
	self, _ := ctx.Value(proxySelfKey{}).(proxySelf)
	for _, item := range ips {
		if isBlockedProxyIP(item.IP) {
			return nil, errors.New("禁止访问本地或内网地址")
		}
		if self.hasIP(item.IP) {
			return nil, errors.New("禁止代理本站地址")
		}
	}
	dialer := net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	var lastErr error
	for _, item := range ips {
		conn, err := dialer.DialContext(
			ctx,
			network,
			net.JoinHostPort(item.String(), port),
		)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("无法连接目标地址: %w", lastErr)
}

func isBlockedProxyIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() {
		return true
	}
	for _, network := range blockedProxyNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// blockedProxyNetworks 是标准库判断之外还要拦的保留网段：
// 0.0.0.0/8、100.64.0.0/10（含部分云平台 metadata 地址）、198.18.0.0/15、192.0.0.0/24、240.0.0.0/4，
// 以及能映射到内网 IPv4 的 NAT64（64:ff9b::/96）和 6to4（2002::/16）。
var blockedProxyNetworks = func() []*net.IPNet {
	var networks []*net.IPNet
	for _, cidr := range []string{"0.0.0.0/8", "100.64.0.0/10", "198.18.0.0/15", "192.0.0.0/24", "240.0.0.0/4", "64:ff9b::/96", "2002::/16"} {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}()

// proxySelf 是本站自己的域名和 IP。挂在代理请求的 context 上，检查重定向目标和拨号地址，防止代理绕回本站。
type proxySelf struct {
	hosts map[string]bool
	ips   []net.IP
}

type proxySelfKey struct{}

// proxySelfLookup 解析本站域名，测试用 SetProxySelfLookupForTest 替换。
var proxySelfLookup = net.DefaultResolver.LookupIPAddr

// PUBLIC_HOST 的解析结果缓存 publicHostTTL；解析失败的结果缓存 publicHostRetry，期间直接报错，不反复卡在 DNS 上。
var (
	publicHostTTL   = 5 * time.Minute
	publicHostRetry = 15 * time.Second
	publicHostMu    sync.Mutex
	publicHostCache publicHostEntry
)

type publicHostEntry struct {
	host    string
	ips     []net.IP
	err     error
	expires time.Time
}

// ResolvePublicHost 返回 PUBLIC_HOST 解析出的地址（带缓存），启动时调用一次预热。没配 PUBLIC_HOST 时返回空；
// 解析失败或解析不出地址时返回错误，代理据此拒绝请求（失败即关闭）。
func ResolvePublicHost() ([]net.IP, error) {
	host := normalizeProxyHost(config.Cfg.PublicHost)
	if host == "" {
		return nil, nil
	}
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	publicHostMu.Lock()
	defer publicHostMu.Unlock()
	current := time.Now()
	if publicHostCache.host == host && current.Before(publicHostCache.expires) {
		return publicHostCache.ips, publicHostCache.err
	}
	// 不用请求的 context：一个请求中途取消不能让解析失败、连累后面的请求。
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	addresses, err := proxySelfLookup(ctx, host)
	if err == nil && len(addresses) == 0 {
		err = errors.New("没有解析出地址")
	}
	if err != nil {
		publicHostCache = publicHostEntry{host: host, err: fmt.Errorf("无法解析 PUBLIC_HOST %s：%w", host, err), expires: current.Add(publicHostRetry)}
		return nil, publicHostCache.err
	}
	ips := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		ips = append(ips, address.IP)
	}
	publicHostCache = publicHostEntry{host: host, ips: ips, expires: current.Add(publicHostTTL)}
	return ips, nil
}

// SetProxySelfLookupForTest 替换解析本站域名的函数并清空缓存，只给测试用；返回恢复函数。
func SetProxySelfLookupForTest(lookup func(ctx context.Context, host string) ([]net.IPAddr, error)) func() {
	publicHostMu.Lock()
	defer publicHostMu.Unlock()
	previous := proxySelfLookup
	proxySelfLookup, publicHostCache = lookup, publicHostEntry{}
	return func() {
		publicHostMu.Lock()
		defer publicHostMu.Unlock()
		proxySelfLookup, publicHostCache = previous, publicHostEntry{}
	}
}

// WithProxySelf 收集本站域名（传入的请求 Host、X-Forwarded-Host 加上 PUBLIC_HOST）和本站 IP
// （SERVER_PUBLIC_IPS、写成 IP 的域名，加上缓存的 PUBLIC_HOST 解析结果），挂到 context 上给代理检查用。
// 请求带来的域名只按名字比对，不做 DNS 解析；PUBLIC_HOST 解析失败时返回错误，调用方要拒绝代理。
func WithProxySelf(ctx context.Context, hosts ...string) (context.Context, error) {
	publicIPs, err := ResolvePublicHost()
	if err != nil {
		return ctx, err
	}
	self := proxySelf{hosts: map[string]bool{}, ips: append([]net.IP(nil), publicIPs...)}
	for _, raw := range append(hosts, config.Cfg.PublicHost) {
		if host := normalizeProxyHost(raw); host != "" {
			self.hosts[host] = true
			if ip := net.ParseIP(host); ip != nil {
				self.ips = append(self.ips, ip)
			}
		}
	}
	for _, raw := range config.Cfg.ServerPublicIPs {
		if ip := net.ParseIP(strings.TrimSpace(raw)); ip != nil {
			self.ips = append(self.ips, ip)
		}
	}
	return context.WithValue(ctx, proxySelfKey{}, self), nil
}

// IsProxySelfHost 判断域名是不是本站自己的（大小写、末尾的点、端口都不影响）。
func IsProxySelfHost(ctx context.Context, host string) bool {
	self, _ := ctx.Value(proxySelfKey{}).(proxySelf)
	host = normalizeProxyHost(host)
	return host != "" && self.hosts[host]
}

func (s proxySelf) hasIP(ip net.IP) bool {
	for _, item := range s.ips {
		if item.Equal(ip) {
			return true
		}
	}
	return false
}

func normalizeProxyHost(raw string) string {
	host := strings.TrimSpace(raw)
	host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
	host = strings.TrimRight(host, "/")
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
}
