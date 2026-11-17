package main

import (
	"log"
	"net"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/router"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	if err := config.Load(); err != nil {
		log.Fatal(err)
	}
	if config.Cfg.AppEnv != "dev" {
		gin.SetMode(gin.ReleaseMode)
	}
	// 启动时解析一次 PUBLIC_HOST 并缓存；解析不出来不影响启动，但 /api/proxy-image 会拒绝代理，直到解析成功。
	if _, err := service.ResolvePublicHost(); err != nil {
		log.Printf("warning: %v; /api/proxy-image refuses requests until it resolves", err)
	}
	if err := service.EnsureDefaultAdmin(); err != nil {
		log.Fatal(err)
	}
	if err := service.EnsureDefaultAgentSkills(); err != nil {
		log.Fatal(err)
	}
	service.StartPromptSyncScheduler()
	service.StartCanvasProjectCleanupScheduler()
	server := &http.Server{
		Addr:              net.JoinHostPort(config.Cfg.BindAddr, config.Cfg.Port),
		Handler:           router.New(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Fatal(server.ListenAndServe())
}
