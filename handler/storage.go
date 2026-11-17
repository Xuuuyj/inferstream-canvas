package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

// StorageConfig 返回公开存储配置。
func StorageConfig(w http.ResponseWriter, r *http.Request) {
	config, err := service.PublicStorageConfig()
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// SaveUserStorageProvider 保存用户配置的存储提供商。
func SaveUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.UserStorageProviders `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	config, err := service.SaveCurrentUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, config)
}

// MeasureUserStorageProvider 统计用户存储提供商的已用容量。
func MeasureUserStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Provider service.StorageObjectProviderInput `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureUserStorageProvider(r.Context(), request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// UploadFile 上传文件到对象存储。先确认存储可用再读请求体，不白收整个文件。
func UploadFile(w http.ResponseWriter, r *http.Request) {
	active, err := service.HasActiveCloudStorage(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	if !active {
		Fail(w, "服务端对象存储未启用")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要上传的文件")
		return
	}
	defer file.Close()
	data, err := io.ReadAll(file)
	if err != nil {
		FailError(w, err)
		return
	}
	contentType := header.Header.Get("Content-Type")
	if strings.TrimSpace(contentType) == "" {
		contentType = http.DetectContentType(data)
	}
	var provider *service.StorageObjectProviderInput
	if raw := strings.TrimSpace(r.FormValue("provider")); raw != "" {
		var parsed service.StorageObjectProviderInput
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			Fail(w, "用户对象存储配置格式错误")
			return
		}
		provider = &parsed
	}
	object, err := service.UploadStorageObjectWithProvider(r.Context(), header.Filename, contentType, data, provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// RegisterDirectFile 登记浏览器已直传至用户 WebDAV 的文件。
func RegisterDirectFile(w http.ResponseWriter, r *http.Request) {
	var request service.DirectStorageObjectInput
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "文件信息格式错误")
		return
	}
	object, err := service.RegisterDirectStorageObject(r.Context(), request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// DeleteFile 删除文件。不读请求体：画布站不允许用户自带对象存储，请求体里的 provider 没有用处。
func DeleteFile(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteStorageObject(r.Context(), id, nil); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// DeleteDirectFileRecord 删除浏览器已直接删除的 WebDAV 文件索引。
func DeleteDirectFileRecord(w http.ResponseWriter, r *http.Request, id string) {
	if err := service.DeleteDirectStorageObjectRecord(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, true)
}

// FileContent 获取文件内容。
func FileContent(w http.ResponseWriter, r *http.Request, id string) {
	download, err := service.DownloadStorageObject(id, r.Header.Get("Range"))
	if err != nil {
		FailError(w, err)
		return
	}
	defer download.Stream.Close()
	w.Header().Set("Content-Type", download.Object.MimeType)
	setSafeMediaHeaders(w)
	if !inlineMediaType(download.Object.MimeType) {
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	if download.AcceptRanges {
		w.Header().Set("Accept-Ranges", "bytes")
	}
	if download.ContentRange != "" {
		w.Header().Set("Content-Range", download.ContentRange)
	}
	if download.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(download.ContentLength, 10))
	}
	if download.StatusCode != 0 {
		w.WriteHeader(download.StatusCode)
	}
	_, _ = io.Copy(w, download.Stream)
}

// FileInfo 获取文件元数据。
func FileInfo(w http.ResponseWriter, r *http.Request, id string) {
	object, err := service.StorageObjectInfo(id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, object)
}

// AdminMeasureStorageProvider 管理员统计存储容量。
func AdminMeasureStorageProvider(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Index    int                    `json:"index"`
		Provider *model.StorageProvider `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "配置内容格式错误")
		return
	}
	result, err := service.MeasureAdminStorageProvider(request.Index, request.Provider)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}

// 代理下载的大小上限，超过就中断；没登录的只能代理图片，上限更小。
// proxyIdleTimeout 内一个字节都没传就中断，proxyTotalTimeout 是单次代理的总时长上限。写成变量是为了测试。
var (
	proxyImageMaxBytes     int64 = 30 << 20
	proxyAnonImageMaxBytes int64 = 20 << 20
	proxyMediaMaxBytes     int64 = 200 << 20
	proxyIdleTimeout             = 30 * time.Second
	proxyTotalTimeout            = 10 * time.Minute
)

var proxyImageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true, "image/avif": true}

// proxyMediaExtensions 是嗅探不出类型（octet-stream）时，按 URL 后缀放行的音视频。
var proxyMediaExtensions = map[string]string{
	".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
}

// ProxyImage 代理远程图片和音视频（解决跨域和机器人检测问题）。
// 只放行按内容嗅探确认的图片、视频、音频，其余返回 415；没登录的只放行图片（401）；
// 目标是本站自己的域名或 IP 时返回 403，PUBLIC_HOST 解析不出来时返回 503；上游失败、超时、浏览器不收数据一律 502 或直接断开。
func ProxyImage(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		Fail(w, "url 参数不能为空")
		return
	}
	if !strings.HasPrefix(targetURL, "http://") && !strings.HasPrefix(targetURL, "https://") {
		Fail(w, "无效的 url")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	loggedIn := ok && user.ID != ""
	ctx, cancel := context.WithTimeout(r.Context(), proxyTotalTimeout)
	defer cancel()
	// 本站域名解析失败时宁可不代理，也不放过绕回本站的请求。
	ctx, err := service.WithProxySelf(ctx, r.Host, r.Header.Get("X-Forwarded-Host"))
	if err != nil {
		log.Printf("proxy-image refused: %v", err)
		FailWithStatus(w, http.StatusServiceUnavailable, "暂时无法确认本站地址，请稍后再试")
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil || req.URL.Hostname() == "" {
		Fail(w, "无效的 url")
		return
	}
	if service.IsProxySelfHost(ctx, req.URL.Hostname()) {
		FailWithStatus(w, http.StatusForbidden, "不能代理本站地址")
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/*,video/*,audio/*,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Cache-Control", "no-cache")
	req.Header.Set("Pragma", "no-cache")

	// 从发请求开始计时：等响应头、读响应体、等浏览器收走数据，任何一段 proxyIdleTimeout 内没有进展都中断。
	idle := time.AfterFunc(proxyIdleTimeout, cancel)
	defer idle.Stop()
	resp, err := service.SafeProxyStreamClient().Do(req)
	if err != nil {
		FailWithStatus(w, http.StatusBadGateway, "代理请求失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		FailWithStatus(w, http.StatusBadGateway, "代理请求失败: "+resp.Status)
		return
	}
	body := idleTimeoutReader{reader: resp.Body, timer: idle, timeout: proxyIdleTimeout}
	head := make([]byte, 512)
	n, err := io.ReadFull(body, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		FailWithStatus(w, http.StatusBadGateway, "代理请求失败")
		return
	}
	head = head[:n]
	contentType, limit, ok := proxyMediaType(head, req.URL.Path, resp.Request.URL.Path)
	if !ok {
		FailWithStatus(w, http.StatusUnsupportedMediaType, "只支持代理图片、视频和音频")
		return
	}
	if !loggedIn {
		if !proxyImageTypes[contentType] {
			FailWithStatus(w, http.StatusUnauthorized, "登录后才能代理视频和音频")
			return
		}
		limit = min(limit, proxyAnonImageMaxBytes)
	}
	if resp.ContentLength > limit {
		FailWithStatus(w, http.StatusBadGateway, "文件超过代理大小上限")
		return
	}
	w.Header().Set("Content-Type", contentType)
	setSafeMediaHeaders(w)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	if resp.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(resp.ContentLength, 10))
	}
	// 写超时设在连接上，传完就关连接，免得留给同一连接上的下一个请求。
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusOK)
	deadline, _ := ctx.Deadline()
	if err := writeProxyBody(w, io.MultiReader(bytes.NewReader(head), body), limit, deadline); err != nil {
		abortProxyResponse(w)
	}
}

// writeProxyBody 把上游数据转给浏览器，超过 limit 算失败。每次写之前都设写超时（proxyIdleTimeout 和总截止时间取早的）：
// 浏览器一直不收数据时写会超时报错，调用方据此断开连接，不会卡在写上一直占着并发名额。
func writeProxyBody(w http.ResponseWriter, body io.Reader, limit int64, deadline time.Time) error {
	controller := http.NewResponseController(w)
	buffer := make([]byte, 32<<10)
	var written int64
	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			if written += int64(n); written > limit {
				return errors.New("文件超过代理大小上限")
			}
			writeDeadline := time.Now().Add(proxyIdleTimeout)
			if writeDeadline.After(deadline) {
				writeDeadline = deadline
			}
			if err := controller.SetWriteDeadline(writeDeadline); err != nil {
				return err
			}
			if _, err := w.Write(buffer[:n]); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// SetProxyTimeoutsForTest 临时改代理的空闲超时和总时长，只给测试用；返回恢复函数。
func SetProxyTimeoutsForTest(idle, total time.Duration) func() {
	previousIdle, previousTotal := proxyIdleTimeout, proxyTotalTimeout
	proxyIdleTimeout, proxyTotalTimeout = idle, total
	return func() { proxyIdleTimeout, proxyTotalTimeout = previousIdle, previousTotal }
}

// idleTimeoutReader 每读到数据就把空闲计时器往后推；计时器到点会取消代理请求的 context。
type idleTimeoutReader struct {
	reader  io.Reader
	timer   *time.Timer
	timeout time.Duration
}

func (r idleTimeoutReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	if n > 0 {
		r.timer.Reset(r.timeout)
	}
	return n, err
}

// proxyMediaType 按内容嗅探决定下发的类型和大小上限，不是图片、视频、音频时 ok 为 false。
func proxyMediaType(head []byte, paths ...string) (string, int64, bool) {
	contentType := service.SniffContentType(head)
	switch {
	case proxyImageTypes[contentType]:
		return contentType, proxyImageMaxBytes, true
	case strings.HasPrefix(contentType, "video/"), strings.HasPrefix(contentType, "audio/"):
		return contentType, proxyMediaMaxBytes, true
	case contentType == "application/octet-stream":
		for _, item := range paths {
			if mediaType, ok := proxyMediaExtensions[strings.ToLower(path.Ext(item))]; ok {
				return mediaType, proxyMediaMaxBytes, true
			}
		}
	}
	return "", 0, false
}

// abortProxyResponse 直接断开连接，让浏览器知道文件没传完，而不是收到一个被截断却像是完整的文件。
// gin 的 Recovery 会吞掉 http.ErrAbortHandler，所以先绕过 gin 的包装去劫持底层连接。
func abortProxyResponse(w http.ResponseWriter) {
	for {
		inner, ok := w.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			break
		}
		w = inner.Unwrap()
	}
	if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
		_ = conn.Close()
		return
	}
	panic(http.ErrAbortHandler)
}

// setSafeMediaHeaders 让浏览器不猜类型，并且即使被当成页面打开也不能执行脚本。
func setSafeMediaHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
}

// inlineMediaType 判断能否在浏览器里直接展示；SVG 可以带脚本，不算。
func inlineMediaType(contentType string) bool {
	contentType = strings.ToLower(contentType)
	if strings.HasPrefix(contentType, "image/") {
		return !strings.Contains(contentType, "svg")
	}
	return strings.HasPrefix(contentType, "video/") || strings.HasPrefix(contentType, "audio/")
}
