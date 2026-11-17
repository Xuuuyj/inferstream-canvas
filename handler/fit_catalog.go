package handler

import (
	"log"
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func FitCatalog(w http.ResponseWriter, r *http.Request) {
	data, err := service.FitCatalog()
	if err != nil {
		log.Printf("fit catalog failed: %v", err)
		Fail(w, "openai.fit 模型目录暂时不可用，请稍后重试")
		return
	}
	OK(w, data)
}
