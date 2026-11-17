package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
)

const (
	fitCatalogTTL        = 60 * time.Second
	fitCatalogFailureTTL = 10 * time.Second
	fitCatalogBodyLimit  = 32 << 20
	fitStatusBodyLimit   = 1 << 20
)

type FitCatalogModel struct {
	ModelName              string          `json:"model_name"`
	SupportedEndpointTypes json.RawMessage `json:"supported_endpoint_types"`
	Tags                   json.RawMessage `json:"tags"`
	BillingUsageSchema     json.RawMessage `json:"billing_usage_schema"`
	// EnableGroups 原样透传：画布按它算用户每个令牌分组里有哪些视频、图片、文本模型，给三把令牌自动预选；fit 的价格库也按它取最低分组倍率。
	EnableGroups json.RawMessage `json:"enable_groups"`
	// 以下是 fit 模型广场、生成台算价格要读的字段，原样透传（上游没有就不输出），画布用 fit 自己的价格代码显示价格。
	QuotaType             json.RawMessage           `json:"quota_type,omitempty"`
	ModelRatio            json.RawMessage           `json:"model_ratio,omitempty"`
	CompletionRatio       json.RawMessage           `json:"completion_ratio,omitempty"`
	ModelPrice            json.RawMessage           `json:"model_price,omitempty"`
	BillingMode           json.RawMessage           `json:"billing_mode,omitempty"`
	BillingExpr           json.RawMessage           `json:"billing_expr,omitempty"`
	BillingUsageExamples  json.RawMessage           `json:"billing_usage_examples,omitempty"`
	BillingPluginVariants []FitCatalogPluginVariant `json:"billing_plugin_variants,omitempty"`
}

// FitCatalogPluginVariant 只留计价字段；插件名、图标这类能看出供货方的字段（fit 只给管理员）一律不转发。
type FitCatalogPluginVariant struct {
	BillingExpr          json.RawMessage `json:"billing_expr,omitempty"`
	BillingMode          json.RawMessage `json:"billing_mode,omitempty"`
	BillingUsageSchema   json.RawMessage `json:"billing_usage_schema,omitempty"`
	BillingUsageExamples json.RawMessage `json:"billing_usage_examples,omitempty"`
}

// FitCatalogStatus 是 fit /api/status 里显示价格要用的字段（fit 前端 use-pricing-data 和 mapStatusDataToConfig 读的那几个），其余字段不转发。
type FitCatalogStatus struct {
	Price                      json.RawMessage `json:"price,omitempty"`
	USDExchangeRate            json.RawMessage `json:"usd_exchange_rate,omitempty"`
	QuotaDisplayType           json.RawMessage `json:"quota_display_type,omitempty"`
	DisplayInCurrency          json.RawMessage `json:"display_in_currency,omitempty"`
	QuotaPerUnit               json.RawMessage `json:"quota_per_unit,omitempty"`
	CustomCurrencySymbol       json.RawMessage `json:"custom_currency_symbol,omitempty"`
	CustomCurrencyExchangeRate json.RawMessage `json:"custom_currency_exchange_rate,omitempty"`
}

type FitCatalogData struct {
	Pricing []FitCatalogModel `json:"pricing"`
	// GroupRatio 是 /api/pricing 顶层的 group_ratio（各分组倍率），fit 前端把它挂到每个模型上算价格。
	GroupRatio   json.RawMessage  `json:"groupRatio"`
	Status       FitCatalogStatus `json:"status"`
	Capabilities json.RawMessage  `json:"capabilities"`
	FetchedAt    int64            `json:"fetchedAt"`
	Stale        bool             `json:"stale"`
}

type fitPricingPayload struct {
	Success    bool              `json:"success"`
	Data       []FitCatalogModel `json:"data"`
	GroupRatio json.RawMessage   `json:"group_ratio"`
}

var (
	fitCatalogMu        sync.Mutex
	fitCatalogCache     *FitCatalogData
	fitCatalogETag      string
	fitCatalogCheckedAt time.Time
	fitCatalogErr       error         // 最近一次刷新失败的原因，刷新成功后清空
	fitCatalogFailedAt  time.Time     // 最近一次刷新失败的时间
	fitCatalogFetching  chan struct{} // 有刷新正在进行时非空，刷新结束时关闭
	fitCatalogClient    = &http.Client{Timeout: 15 * time.Second}
	fitCatalogNow       = time.Now
)

// FitCatalog 返回 openai.fit 公开价目表（裁剪后）、能力目录和 /api/status 里币种设置的镜像。
// 成功缓存 60 秒；刷新失败缓存 10 秒，期间有旧数据就回旧数据（stale=true），没有就直接报错，不再打上游。
// 同一时间只有一个请求去刷新，其他请求不排队等上游：有旧数据回旧数据，上次已经失败过就直接报错；
// 只有冷启动第一次拉取时，并发的请求才等它的结果。
func FitCatalog() (FitCatalogData, error) {
	fitCatalogMu.Lock()
	for fitCatalogFetching != nil && fitCatalogCache == nil && fitCatalogErr == nil {
		wait := fitCatalogFetching
		fitCatalogMu.Unlock()
		<-wait
		fitCatalogMu.Lock()
	}
	now := fitCatalogNow()
	if fitCatalogFetching != nil ||
		(fitCatalogCache != nil && now.Sub(fitCatalogCheckedAt) < fitCatalogTTL) ||
		(fitCatalogErr != nil && now.Sub(fitCatalogFailedAt) < fitCatalogFailureTTL) {
		defer fitCatalogMu.Unlock()
		return fitCatalogResult()
	}
	done := make(chan struct{})
	fitCatalogFetching = done
	etag, previous := fitCatalogETag, fitCatalogCache
	fitCatalogMu.Unlock()

	pricing, err := fetchFitPricing()
	var capabilities json.RawMessage
	var status FitCatalogStatus
	if err == nil {
		capabilities, etag, err = fetchFitCapabilities(etag, previous)
	}
	if err == nil {
		status, err = fetchFitStatus()
	}

	fitCatalogMu.Lock()
	defer fitCatalogMu.Unlock()
	fitCatalogFetching = nil
	close(done)
	now = fitCatalogNow()
	if err != nil {
		log.Printf("fit catalog refresh failed: %v", err)
		fitCatalogErr, fitCatalogFailedAt = err, now
		if fitCatalogCache != nil {
			fitCatalogCache.Stale = true
		}
		return fitCatalogResult()
	}
	fitCatalogErr = nil
	fitCatalogETag, fitCatalogCheckedAt = etag, now
	fitCatalogCache = &FitCatalogData{Pricing: pricing.Data, GroupRatio: pricing.GroupRatio, Status: status, Capabilities: capabilities, FetchedAt: now.UnixMilli()}
	return *fitCatalogCache, nil
}

// fitCatalogResult 有缓存就回缓存，没有就回最近一次的错误；调用方要持有锁。
func fitCatalogResult() (FitCatalogData, error) {
	if fitCatalogCache != nil {
		return *fitCatalogCache, nil
	}
	if fitCatalogErr != nil {
		return FitCatalogData{}, fitCatalogErr
	}
	return FitCatalogData{}, errors.New("fit catalog is loading")
}

func fetchFitPricing() (fitPricingPayload, error) {
	var payload fitPricingPayload
	response, err := fitCatalogClient.Get(fitCatalogURL("/api/pricing"))
	if err != nil {
		return payload, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return payload, fmt.Errorf("fit pricing status %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, fitCatalogBodyLimit)).Decode(&payload); err != nil {
		return payload, err
	}
	if !payload.Success {
		return payload, errors.New("fit pricing returned success=false")
	}
	return payload, nil
}

// fetchFitStatus 拉 /api/status，只留 FitCatalogStatus 的几个币种字段。
func fetchFitStatus() (FitCatalogStatus, error) {
	var payload struct {
		Success bool             `json:"success"`
		Data    FitCatalogStatus `json:"data"`
	}
	response, err := fitCatalogClient.Get(fitCatalogURL("/api/status"))
	if err != nil {
		return payload.Data, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return payload.Data, fmt.Errorf("fit status status %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, fitStatusBodyLimit)).Decode(&payload); err != nil {
		return payload.Data, err
	}
	if !payload.Success {
		return payload.Data, errors.New("fit status returned success=false")
	}
	return payload.Data, nil
}

// fetchFitCapabilities 拉能力目录；有上一份时带 If-None-Match，304 就沿用上一份。返回目录和新的 ETag。
func fetchFitCapabilities(etag string, previous *FitCatalogData) (json.RawMessage, string, error) {
	request, err := http.NewRequest(http.MethodGet, fitCatalogURL("/api/model-capabilities"), nil)
	if err != nil {
		return nil, "", err
	}
	if previous != nil && etag != "" {
		request.Header.Set("If-None-Match", etag)
	}
	response, err := fitCatalogClient.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified && previous != nil {
		return previous.Capabilities, etag, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("fit model capabilities status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, fitCatalogBodyLimit))
	if err != nil {
		return nil, "", err
	}
	if !json.Valid(body) {
		return nil, "", errors.New("fit model capabilities returned invalid JSON")
	}
	return body, response.Header.Get("ETag"), nil
}

func fitCatalogURL(path string) string {
	return strings.TrimRight(strings.TrimSpace(config.Cfg.FitBaseURL), "/") + path
}
