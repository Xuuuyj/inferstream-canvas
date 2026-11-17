package service

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// 提示词库封面：同步来源图床上的封面换成本站地址，第一次请求时由服务器取回存本地，以后不再连图床；
// 失效的图床（截图里 HuggingFace 回 401 的那批）和不是图片的地址记下来，promptCoverRetry 内直接回不可用。
func TestPromptCoverCachesSourceHostsAndRemembersFailures(t *testing.T) {
	useMemoryDB(t)
	dir := t.TempDir()
	config.Cfg.PromptCoverDir = dir
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte("x"), 64)...)
	hits := map[string]*atomic.Int32{}
	for _, name := range []string{"/ok.png", "/again.png", "/gone.png", "/page.png"} {
		hits[name] = &atomic.Int32{}
	}
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if counter := hits[r.URL.Path]; counter != nil {
			counter.Add(1)
		}
		switch r.URL.Path {
		case "/ok.png":
			_, _ = w.Write(png)
		case "/again.png":
			<-release
			_, _ = w.Write(png)
		case "/gone.png":
			http.Error(w, "Error: Failed to fetch from HuggingFace - 401", http.StatusUnauthorized)
		default:
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<html>not an image</html>"))
		}
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(SetProxyDialContextForTest(func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}))

	prompts := []model.Prompt{
		{ID: "cover-test-ok", CoverURL: "http://raw.githubusercontent.com/ok.png"},
		{ID: "cover-test-again", CoverURL: "http://pbs.twimg.com/again.png"},
		{ID: "cover-test-gone", CoverURL: "http://upload.maynor1024.live/gone.png"},
		{ID: "cover-test-page", CoverURL: "http://cdn.imgedify.com/page.png"},
		{ID: "cover-test-other", CoverURL: "http://example.com/ok.png"},
		{ID: "cover-test-port", CoverURL: "http://raw.githubusercontent.com:8080/ok.png"},
		{ID: "cover-test-empty"},
	}
	ids := []string{}
	for _, item := range prompts {
		item.Category = "system"
		if _, err := repository.SavePrompt(item); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, item.ID)
	}
	t.Cleanup(func() { _ = repository.DeletePrompts(ids) })

	// 后台列表（service.ListPrompts，后台编辑表单读它）保持原地址，只有对外的列表接口换成本站地址。
	for i := range prompts {
		prompts[i].Title = "cover-test " + prompts[i].ID
	}
	for _, item := range prompts {
		item.Category = "system"
		if _, err := repository.SavePrompt(item); err != nil {
			t.Fatal(err)
		}
	}
	admin, err := ListPrompts(model.Query{Keyword: "cover-test cover-test-ok", PageSize: 10})
	if err != nil || len(admin.Items) != 1 || admin.Items[0].CoverURL != "http://raw.githubusercontent.com/ok.png" {
		t.Fatalf("admin list = %+v, %v; want the original cover link", admin.Items, err)
	}
	listed := append([]model.Prompt(nil), prompts...)
	LocalPromptCovers(listed)
	for i, want := range []string{"/api/prompts/cover-test-ok/cover", "/api/prompts/cover-test-again/cover", "/api/prompts/cover-test-gone/cover",
		"/api/prompts/cover-test-page/cover", "http://example.com/ok.png", "http://raw.githubusercontent.com:8080/ok.png", ""} {
		if listed[i].CoverURL != want {
			t.Errorf("%s listed cover = %q, want %q", prompts[i].ID, listed[i].CoverURL, want)
		}
	}

	file, err := PromptCover("cover-test-ok")
	if err != nil || file.ContentType != "image/png" || file.ETag == "" {
		t.Fatalf("ok cover = %+v, %v", file, err)
	}
	if data, _ := os.ReadFile(file.Path); !bytes.Equal(data, png) || filepath.Dir(file.Path) != dir {
		t.Fatalf("cached file %s does not hold the picture", file.Path)
	}
	if _, err := PromptCover("cover-test-ok"); err != nil || hits["/ok.png"].Load() != 1 {
		t.Fatalf("second request: err %v, fetched %d times, want 1", err, hits["/ok.png"].Load())
	}

	for _, id := range []string{"cover-test-gone", "cover-test-page", "cover-test-other", "cover-test-port", "cover-test-empty", "cover-test-missing"} {
		if _, err := PromptCover(id); !errors.Is(err, ErrPromptCoverUnavailable) {
			t.Errorf("%s: err = %v, want unavailable", id, err)
		}
	}
	if _, err := PromptCover("cover-test-gone"); !errors.Is(err, ErrPromptCoverUnavailable) || hits["/gone.png"].Load() != 1 {
		t.Fatalf("a failed cover is fetched again within the retry window (%d fetches)", hits["/gone.png"].Load())
	}
	fails, _ := filepath.Glob(filepath.Join(dir, "*.fail"))
	if len(fails) != 2 {
		t.Fatalf("fail markers = %v, want gone and page", fails)
	}
	old := time.Now().Add(-promptCoverRetry - time.Minute)
	for _, path := range fails {
		_ = os.Chtimes(path, old, old)
	}
	_, _ = PromptCover("cover-test-gone")
	if hits["/gone.png"].Load() != 2 {
		t.Fatalf("after the retry window the cover is not fetched again (%d fetches)", hits["/gone.png"].Load())
	}

	// 同一张封面同时被很多人请求，只去图床取一次。
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := PromptCover("cover-test-again")
			errs <- err
		}()
	}
	time.Sleep(200 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if hits["/again.png"].Load() != 1 {
		t.Fatalf("concurrent requests fetched %d times, want 1", hits["/again.png"].Load())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "*.tmp")); len(leftovers) != 0 {
		t.Fatalf("temporary files left behind: %v", leftovers)
	}
}
