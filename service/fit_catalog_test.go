package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

const fakeFitCapabilities = `{"schemaVersion":1,"revision":"r1","models":[{"id":"seedance 2.0 fast cheap","kind":"video"}]}`

// fakeFitPricing 带上计价字段：按次、按 token 两种计价，插件变体里混进 fit 只给管理员的插件名和图标，description 和顶层 usable_group 也不该转发。
const fakeFitPricing = `{"success":true,"group_ratio":{"default":1,"vip":0.8},"usable_group":{"default":"默认"},"data":[` +
	`{"model_name":"seedance 2.0 fast cheap","description":"secret-ish upstream copy","quota_type":0,"model_ratio":37.5,"completion_ratio":1,"model_price":0,"enable_groups":["default","vip"],"tags":"视频生成,Seedance","supported_endpoint_types":["openai-video"],"billing_mode":"tiered_expr","billing_expr":"tier(\"按次\", 0.27)","billing_usage_schema":{"seconds":{"type":"number"}},"billing_usage_examples":[{"label":"5 秒","facts":{"seconds":5}}],"billing_plugin_variants":[{"plugin_key":"vendor-x","plugin_name":"Vendor X","icon":"x.svg","billing_mode":"tiered_expr","billing_expr":"tier(\"a\", 0.2)","billing_usage_schema":{"seconds":{"type":"number"}},"billing_usage_examples":[{"label":"5 秒","facts":{"seconds":5}}]}]},` +
	`{"model_name":"gpt-5","quota_type":1,"model_price":0.0068,"tags":"","supported_endpoint_types":["openai"]}]}`

// fakeFitStatus 里除了币种字段还有别的配置，只有币种那几个该转发。
const fakeFitStatus = `{"success":true,"message":"","data":{"price":7.3,"usd_exchange_rate":7.3,"quota_display_type":"CNY","display_in_currency":true,"quota_per_unit":500000,"custom_currency_symbol":"¤","custom_currency_exchange_rate":1,"turnstile_site_key":"site-key","system_name":"openai.fit","version":"v1"}}`

type fakeFit struct {
	mu          sync.Mutex
	requests    []string
	ifNoneMatch []string
	fail        bool
	failStatus  bool
	// hold 非空时价目表请求先往 arrived 发信号，再等 hold 关闭才回，用来模拟上游很慢。
	hold    chan struct{}
	arrived chan struct{}
}

func (f *fakeFit) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, r.URL.RequestURI())
	fail, failStatus, hold, arrived := f.fail, f.failStatus, f.hold, f.arrived
	if r.URL.Path == "/api/model-capabilities" {
		f.ifNoneMatch = append(f.ifNoneMatch, r.Header.Get("If-None-Match"))
	}
	f.mu.Unlock()
	if hold != nil && r.URL.Path == "/api/pricing" {
		arrived <- struct{}{}
		<-hold
	}
	if fail || (failStatus && r.URL.Path == "/api/status") {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}
	switch r.URL.Path {
	case "/api/pricing":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fakeFitPricing))
	case "/api/status":
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fakeFitStatus))
	case "/api/model-capabilities":
		if r.Header.Get("If-None-Match") == `"r1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"r1"`)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fakeFitCapabilities))
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeFit) setFail(fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = fail
}

func (f *fakeFit) setFailStatus(fail bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failStatus = fail
}

// holdPricing 让之后的价目表请求卡住，返回「请求已到达」的信号和放行函数；测试失败时也会放行，免得关服务时卡死。
func (f *fakeFit) holdPricing(t *testing.T) (<-chan struct{}, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hold, f.arrived = make(chan struct{}), make(chan struct{}, 8)
	hold := f.hold
	var once sync.Once
	release := func() { once.Do(func() { close(hold) }) }
	t.Cleanup(release)
	return f.arrived, release
}

func (f *fakeFit) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeFit) snapshot() ([]string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.requests...), append([]string(nil), f.ifNoneMatch...)
}

func setupFitCatalog(t *testing.T) (*fakeFit, *time.Time) {
	t.Helper()
	fit := &fakeFit{}
	server := httptest.NewServer(fit)
	t.Cleanup(server.Close)
	previousCfg, previousNow := config.Cfg, fitCatalogNow
	clock := time.Unix(1_800_000_000, 0)
	config.Cfg.FitBaseURL = server.URL + "/"
	resetFitCatalog()
	fitCatalogNow = func() time.Time { return clock }
	t.Cleanup(func() {
		config.Cfg, fitCatalogNow = previousCfg, previousNow
		resetFitCatalog()
	})
	return fit, &clock
}

func resetFitCatalog() {
	fitCatalogCache, fitCatalogETag, fitCatalogCheckedAt = nil, "", time.Time{}
	fitCatalogErr, fitCatalogFailedAt, fitCatalogFetching = nil, time.Time{}, nil
}

func TestFitCatalogCachesForSixtySeconds(t *testing.T) {
	fit, clock := setupFitCatalog(t)
	first, err := FitCatalog()
	if err != nil {
		t.Fatalf("first FitCatalog: %v", err)
	}
	*clock = clock.Add(59 * time.Second)
	second, err := FitCatalog()
	if err != nil {
		t.Fatalf("second FitCatalog: %v", err)
	}
	requests, _ := fit.snapshot()
	sort.Strings(requests)
	if want := []string{"/api/model-capabilities", "/api/pricing", "/api/status"}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("upstream requests = %v, want %v", requests, want)
	}
	if !reflect.DeepEqual(first, second) || first.Stale {
		t.Fatalf("cached result differs or is stale: %+v vs %+v", first, second)
	}
	if first.FetchedAt != time.Unix(1_800_000_000, 0).UnixMilli() {
		t.Fatalf("fetchedAt = %d", first.FetchedAt)
	}
}

func TestFitCatalogRevalidatesCapabilitiesWithETag(t *testing.T) {
	fit, clock := setupFitCatalog(t)
	if _, err := FitCatalog(); err != nil {
		t.Fatal(err)
	}
	*clock = clock.Add(61 * time.Second)
	data, err := FitCatalog()
	if err != nil {
		t.Fatal(err)
	}
	_, ifNoneMatch := fit.snapshot()
	if want := []string{"", `"r1"`}; !reflect.DeepEqual(ifNoneMatch, want) {
		t.Fatalf("If-None-Match = %q, want %q", ifNoneMatch, want)
	}
	if string(data.Capabilities) != fakeFitCapabilities || data.Stale {
		t.Fatalf("capabilities after 304 = %s stale=%v", data.Capabilities, data.Stale)
	}
}

func TestFitCatalogServesStaleCopyWhenUpstreamFails(t *testing.T) {
	fit, clock := setupFitCatalog(t)
	fresh, err := FitCatalog()
	if err != nil {
		t.Fatal(err)
	}
	fit.setFail(true)
	*clock = clock.Add(61 * time.Second)
	stale, err := FitCatalog()
	if err != nil {
		t.Fatalf("FitCatalog with failing upstream: %v", err)
	}
	if !stale.Stale || !reflect.DeepEqual(stale.Pricing, fresh.Pricing) || string(stale.Capabilities) != string(fresh.Capabilities) || stale.FetchedAt != fresh.FetchedAt {
		t.Fatalf("stale result = %+v, want previous data with stale=true", stale)
	}
}

func TestFitCatalogFailsWhenFirstFetchFails(t *testing.T) {
	fit, _ := setupFitCatalog(t)
	fit.setFail(true)
	if _, err := FitCatalog(); err == nil {
		t.Fatal("expected error without any cached catalog")
	}
}

func TestFitCatalogOutputsOnlyContractFields(t *testing.T) {
	fit, _ := setupFitCatalog(t)
	data, err := FitCatalog()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Pricing      []map[string]json.RawMessage `json:"pricing"`
		Capabilities json.RawMessage              `json:"capabilities"`
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	if got := sortedKeys(top); !reflect.DeepEqual(got, []string{"capabilities", "fetchedAt", "groupRatio", "pricing", "stale", "status"}) {
		t.Fatalf("data keys = %v", got)
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Pricing) != 2 {
		t.Fatalf("pricing length = %d", len(decoded.Pricing))
	}
	// 按次计价的条目只有上游给了的字段；没给的计价字段不输出，前五个字段照旧（没有时为 null）。
	wantKeys := [][]string{
		{"billing_expr", "billing_mode", "billing_plugin_variants", "billing_usage_examples", "billing_usage_schema", "completion_ratio", "enable_groups", "model_name", "model_price", "model_ratio", "quota_type", "supported_endpoint_types", "tags"},
		{"billing_usage_schema", "enable_groups", "model_name", "model_price", "quota_type", "supported_endpoint_types", "tags"},
	}
	for i, item := range decoded.Pricing {
		if got := sortedKeys(item); !reflect.DeepEqual(got, wantKeys[i]) {
			t.Fatalf("pricing item %d keys = %v", i, got)
		}
	}
	// enable_groups 原样透传：画布按它算每个令牌分组里有哪些视频、图片、文本模型。计价字段逐字节透传。
	first := decoded.Pricing[0]
	if string(first["billing_usage_schema"]) != `{"seconds":{"type":"number"}}` || string(first["tags"]) != `"视频生成,Seedance"` || string(first["enable_groups"]) != `["default","vip"]` {
		t.Fatalf("pricing item = %s", raw)
	}
	if string(first["billing_expr"]) != `"tier(\"按次\", 0.27)"` || string(first["model_ratio"]) != `37.5` || string(first["billing_usage_examples"]) != `[{"label":"5 秒","facts":{"seconds":5}}]` || string(decoded.Pricing[1]["model_price"]) != `0.0068` || string(decoded.Pricing[1]["quota_type"]) != `1` {
		t.Fatalf("pricing fields = %s", raw)
	}
	// 插件变体只留计价字段，插件名、key、图标不转发
	if string(first["billing_plugin_variants"]) != `[{"billing_expr":"tier(\"a\", 0.2)","billing_mode":"tiered_expr","billing_usage_schema":{"seconds":{"type":"number"}},"billing_usage_examples":[{"label":"5 秒","facts":{"seconds":5}}]}]` {
		t.Fatalf("plugin variants = %s", first["billing_plugin_variants"])
	}
	if string(top["groupRatio"]) != `{"default":1,"vip":0.8}` {
		t.Fatalf("groupRatio = %s", top["groupRatio"])
	}
	if string(top["status"]) != `{"price":7.3,"usd_exchange_rate":7.3,"quota_display_type":"CNY","display_in_currency":true,"quota_per_unit":500000,"custom_currency_symbol":"¤","custom_currency_exchange_rate":1}` {
		t.Fatalf("status = %s, want only the currency fields", top["status"])
	}
	if string(decoded.Capabilities) != fakeFitCapabilities {
		t.Fatalf("capabilities = %s, want upstream body verbatim", decoded.Capabilities)
	}
	requests, _ := fit.snapshot()
	sort.Strings(requests)
	if want := []string{"/api/model-capabilities", "/api/pricing", "/api/status"}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("upstream requests = %v, want exactly %v", requests, want)
	}
}

func TestFitCatalogTreatsStatusFailureAsRefreshFailure(t *testing.T) {
	fit, clock := setupFitCatalog(t)
	fresh, err := FitCatalog()
	if err != nil {
		t.Fatal(err)
	}
	fit.setFailStatus(true)
	*clock = clock.Add(61 * time.Second)
	stale, err := FitCatalog()
	if err != nil || !stale.Stale || stale.FetchedAt != fresh.FetchedAt || !reflect.DeepEqual(stale.Status, fresh.Status) {
		t.Fatalf("status failure should serve the previous catalog with stale=true, got %+v %v", stale, err)
	}
	resetFitCatalog()
	if _, err := FitCatalog(); err == nil {
		t.Fatal("expected an error when the first refresh cannot read the currency settings")
	}
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func TestFitCatalogCachesFailureForTenSeconds(t *testing.T) {
	fit, clock := setupFitCatalog(t)
	fit.setFail(true)
	if _, err := FitCatalog(); err == nil {
		t.Fatal("expected error without any cached catalog")
	}
	*clock = clock.Add(9 * time.Second)
	if _, err := FitCatalog(); err == nil {
		t.Fatal("expected cached failure")
	}
	if got := fit.requestCount(); got != 1 {
		t.Fatalf("upstream requests within 10s of a failure = %d, want 1", got)
	}
	fit.setFail(false)
	*clock = clock.Add(2 * time.Second)
	if _, err := FitCatalog(); err != nil {
		t.Fatalf("FitCatalog after the failure expired: %v", err)
	}
}

// waitFitCatalog 在 1 秒内拿到结果，否则说明请求在排队等上游。
func waitFitCatalog(t *testing.T) (FitCatalogData, error) {
	t.Helper()
	type result struct {
		data FitCatalogData
		err  error
	}
	done := make(chan result, 1)
	go func() {
		data, err := FitCatalog()
		done <- result{data, err}
	}()
	select {
	case item := <-done:
		return item.data, item.err
	case <-time.After(time.Second):
		t.Fatal("FitCatalog blocked behind the in-flight refresh")
		return FitCatalogData{}, nil
	}
}

func TestFitCatalogAnswersFastWhileRefreshing(t *testing.T) {
	t.Run("previous failure and no cache", func(t *testing.T) {
		fit, clock := setupFitCatalog(t)
		fit.setFail(true)
		if _, err := FitCatalog(); err == nil {
			t.Fatal("expected first failure")
		}
		*clock = clock.Add(11 * time.Second)
		arrived, release := fit.holdPricing(t)
		refreshed := make(chan error, 1)
		go func() {
			_, err := FitCatalog()
			refreshed <- err
		}()
		<-arrived
		if _, err := waitFitCatalog(t); err == nil {
			t.Fatal("expected the previous error while the retry is in flight")
		}
		release()
		if err := <-refreshed; err == nil {
			t.Fatal("expected the in-flight retry to fail too")
		}
	})
	t.Run("stale cache", func(t *testing.T) {
		fit, clock := setupFitCatalog(t)
		fresh, err := FitCatalog()
		if err != nil {
			t.Fatal(err)
		}
		*clock = clock.Add(61 * time.Second)
		arrived, release := fit.holdPricing(t)
		refreshed := make(chan error, 1)
		go func() {
			_, err := FitCatalog()
			refreshed <- err
		}()
		<-arrived
		data, err := waitFitCatalog(t)
		if err != nil || data.FetchedAt != fresh.FetchedAt {
			t.Fatalf("expected the cached catalog while refreshing, got %+v %v", data, err)
		}
		release()
		if err := <-refreshed; err != nil {
			t.Fatalf("refresh: %v", err)
		}
	})
	t.Run("cold start shares the first fetch", func(t *testing.T) {
		fit, _ := setupFitCatalog(t)
		arrived, release := fit.holdPricing(t)
		results := make(chan error, 2)
		go func() {
			_, err := FitCatalog()
			results <- err
		}()
		<-arrived
		go func() {
			_, err := FitCatalog()
			results <- err
		}()
		time.Sleep(50 * time.Millisecond)
		release()
		for i := 0; i < 2; i++ {
			if err := <-results; err != nil {
				t.Fatalf("cold start caller %d: %v", i+1, err)
			}
		}
		requests, _ := fit.snapshot()
		pricing := 0
		for _, item := range requests {
			if item == "/api/pricing" {
				pricing++
			}
		}
		if pricing != 1 {
			t.Fatalf("pricing fetched %d times on cold start, want 1", pricing)
		}
	})
}
