package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// 提示词库的封面是同步来源里的外链，大多在 GitHub、推特等国内打不开的图床上。列表把这些图床的封面换成本站地址
// /api/prompts/<id>/cover，由本站服务器取一次、存在 PROMPT_COVER_DIR，以后都从本地给；取不到的（图床失效、不是图片、太大）
// 记一个 .fail，promptCoverRetry 内直接回 404，前端显示占位图。只认这些同步来源的图床，管理员手填的其他地址原样返回。
var promptCoverHosts = map[string]bool{
	"raw.githubusercontent.com": true,
	"github.com":                true,
	"cms-assets.youmind.com":    true,
	"pbs.twimg.com":             true,
	"cdn.imgedify.com":          true,
	"upload.maynor1024.live":    true,
}

var promptCoverExtensions = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif"}

const (
	promptCoverMaxBytes int64 = 20 << 20
	promptCoverTimeout        = 60 * time.Second
	promptCoverRetry          = 6 * time.Hour
)

// ErrPromptCoverUnavailable 表示这条提示词没有可代取的封面，或者原图床取不到。
var ErrPromptCoverUnavailable = errors.New("封面不可用")

var promptCoverFetches singleflight.Group

// PromptCoverFile 是本地缓存的封面文件。
type PromptCoverFile struct {
	Path        string
	ContentType string
	ModTime     time.Time
	ETag        string
}

func promptCoverAllowed(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Port() == "" && promptCoverHosts[strings.ToLower(u.Hostname())]
}

// LocalPromptCovers 把对外列表里能代取的封面换成本站地址。后台列表不换，免得编辑保存时把本站地址存进库里。
func LocalPromptCovers(items []model.Prompt) {
	for i := range items {
		if promptCoverAllowed(items[i].CoverURL) {
			items[i].CoverURL = "/api/prompts/" + url.PathEscape(items[i].ID) + "/cover"
		}
	}
}

// PromptCover 返回提示词封面的本地文件，第一次请求时从原图床取回。
func PromptCover(id string) (PromptCoverFile, error) {
	item, ok, err := repository.GetPrompt(id)
	if err != nil {
		return PromptCoverFile{}, err
	}
	if !ok || !promptCoverAllowed(item.CoverURL) {
		return PromptCoverFile{}, ErrPromptCoverUnavailable
	}
	source := strings.TrimSpace(item.CoverURL)
	sum := sha256.Sum256([]byte(source))
	key := hex.EncodeToString(sum[:])
	dir := config.Cfg.PromptCoverDir
	if file, ok := cachedPromptCover(dir, key); ok {
		return file, nil
	}
	if info, err := os.Stat(filepath.Join(dir, key+".fail")); err == nil && time.Since(info.ModTime()) < promptCoverRetry {
		return PromptCoverFile{}, ErrPromptCoverUnavailable
	}
	// 同一张封面同时被多人请求时只取一次；取图不跟某个请求的连接走，那个人关了页面也照样存下来。
	_, err, _ = promptCoverFetches.Do(key, func() (any, error) {
		if _, ok := cachedPromptCover(dir, key); ok {
			return nil, nil
		}
		if err := fetchPromptCover(source, dir, key); err != nil {
			log.Printf("prompt cover %s: %v", id, err)
			if err := os.MkdirAll(dir, 0o755); err == nil {
				_ = os.WriteFile(filepath.Join(dir, key+".fail"), nil, 0o644)
			}
			return nil, ErrPromptCoverUnavailable
		}
		_ = os.Remove(filepath.Join(dir, key+".fail"))
		return nil, nil
	})
	if err != nil {
		return PromptCoverFile{}, err
	}
	if file, ok := cachedPromptCover(dir, key); ok {
		return file, nil
	}
	return PromptCoverFile{}, ErrPromptCoverUnavailable
}

func cachedPromptCover(dir, key string) (PromptCoverFile, bool) {
	for contentType, extension := range promptCoverExtensions {
		path := filepath.Join(dir, key+extension)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return PromptCoverFile{Path: path, ContentType: contentType, ModTime: info.ModTime(), ETag: `"` + key[:32] + `"`}, true
		}
	}
	return PromptCoverFile{}, false
}

func fetchPromptCover(source, dir, key string) error {
	ctx, cancel := context.WithTimeout(context.Background(), promptCoverTimeout)
	defer cancel()
	// 拨号照 /api/proxy-image：只连 80/443、不连内网和本站自己。
	ctx, err := WithProxySelf(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/*,*/*;q=0.8")
	resp, err := SafeProxyStreamClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > promptCoverMaxBytes {
		return errors.New("文件太大")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, promptCoverMaxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > promptCoverMaxBytes {
		return errors.New("文件太大")
	}
	extension, ok := promptCoverExtensions[SniffContentType(data)]
	if !ok || len(data) == 0 {
		return errors.New("不是图片")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// 先写临时文件再改名，别人不会读到写了一半的图。
	temp, err := os.CreateTemp(dir, key+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), filepath.Join(dir, key+extension))
}
