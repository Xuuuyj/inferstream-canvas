package handler

import (
	"errors"
	"net/http"
	"os"

	"github.com/tigerowo/infinite-canvas/service"
)

// PromptCover 返回本站缓存的提示词封面（service.PromptCover）；没有封面或原图床失效时回 404，前端显示占位图。
func PromptCover(w http.ResponseWriter, r *http.Request, id string) {
	file, err := service.PromptCover(id)
	if errors.Is(err, service.ErrPromptCoverUnavailable) {
		FailWithStatus(w, http.StatusNotFound, "封面不可用")
		return
	}
	if err != nil {
		FailError(w, err)
		return
	}
	content, err := os.Open(file.Path)
	if err != nil {
		FailWithStatus(w, http.StatusNotFound, "封面不可用")
		return
	}
	defer content.Close()
	w.Header().Set("Content-Type", file.ContentType)
	w.Header().Set("ETag", file.ETag)
	w.Header().Set("Cache-Control", "public, max-age=604800")
	setSafeMediaHeaders(w)
	http.ServeContent(w, r, "", file.ModTime, content)
}

func Prompts(w http.ResponseWriter, r *http.Request) {
	result, err := service.ListPrompts(parseQuery(r))
	if err != nil {
		FailError(w, err)
		return
	}
	service.LocalPromptCovers(result.Items)
	OK(w, result)
}
