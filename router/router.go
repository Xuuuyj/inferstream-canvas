package router

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/handler"
	"github.com/tigerowo/infinite-canvas/middleware"
)

// accessLog 是不记查询串的访问日志。gin 默认的 Logger 会把查询串拼进路径打到 stdout（也就是 docker 日志），
// 而 /api/proxy-image?url= 里可能是 fit 成片的签名链接（带 access=，单独就能看那条成片）。
func accessLog() gin.HandlerFunc {
	return gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		return fmt.Sprintf("[GIN] %v | %3d | %13v | %15s | %-7s %#v\n%s",
			param.TimeStamp.Format("2006/01/02 - 15:04:05"), param.StatusCode, param.Latency,
			param.ClientIP, param.Method, param.Request.URL.Path, param.ErrorMessage)
	})
}

func New() *gin.Engine {
	router := gin.New()
	router.Use(accessLog(), gin.Recovery())
	router.RedirectTrailingSlash = false
	_ = router.SetTrustedProxies([]string{"127.0.0.1", "::1"})
	body8MB := middleware.BodyLimit(8 << 20)
	body32MB := middleware.BodyLimit(32 << 20)
	// 用户数据的写接口每个接口按用户再单独限流：每人每分钟 30 次（比 v1 整体的 300 次紧）。
	write := func(name string) gin.HandlerFunc {
		return middleware.RateLimit("write-"+name, 30, 30, middleware.ByUser)
	}
	// 画布项目有自动保存，写得勤：每人每分钟 120 次，最多连续 60 次。
	autosave := func(name string) gin.HandlerFunc {
		return middleware.RateLimit("write-"+name, 120, 60, middleware.ByUser)
	}
	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})
	// 注册：按 IP 每分钟 5 次；每个 IP 每 24 小时最多注册成功 REGISTER_DAILY_LIMIT_PER_IP 个账号（默认 10），
	// 免得一个 IP 刷出大批账号、每个都能写满配额，把硬盘撑满。计数在内存里，后端重启清零。
	registerDaily := config.Cfg.RegisterDailyLimitPerIP
	api.POST("/auth/register", middleware.RateLimit("register", 5, 5, middleware.ByIP),
		middleware.SuccessesPerWindow("register-daily", registerDaily, 24*time.Hour, middleware.ByIP,
			fmt.Sprintf("同一网络（IP）24 小时内最多注册 %d 个账号，已达上限，请稍后再试或登录已有账号", registerDaily)),
		body8MB, gin.WrapF(handler.Register))
	api.POST("/auth/login", middleware.RateLimit("login", 5, 5, middleware.ByIP), body8MB, gin.WrapF(handler.Login))
	// 用 openai.fit 登录：按 IP 每分钟 10 次；身份来自 fit（fit 注册要邮箱验证），不套用上面注册的每日上限。
	api.POST("/auth/inferstream/login", middleware.RateLimit("inferstream-login", 10, 10, middleware.ByIP), middleware.BodyLimit(4<<10), gin.WrapF(handler.InferStreamLogin))
	api.POST("/auth/fit/login", middleware.RateLimit("fit-login", 10, 10, middleware.ByIP), middleware.BodyLimit(4<<10), gin.WrapF(handler.FitLogin))
	api.GET("/auth/me", middleware.OptionalAuth, gin.WrapF(handler.CurrentUser))
	api.GET("/settings", gin.WrapF(handler.Settings))
	api.GET("/storage/config", gin.WrapF(handler.StorageConfig))
	api.GET("/files/:id", func(c *gin.Context) {
		handler.FileInfo(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/files/:id/content", func(c *gin.Context) {
		handler.FileContent(c.Writer, c.Request, c.Param("id"))
	})
	v1 := api.Group("/v1", middleware.UserAuth, middleware.RateLimit("v1", 300, 300, middleware.ByUser))
	v1.GET("/workflows", gin.WrapF(handler.UserWorkflows))
	v1.POST("/workflows", write("workflows"), body8MB, gin.WrapF(handler.SaveUserWorkflow))
	v1.DELETE("/workflows/:id", write("workflows-delete"), func(c *gin.Context) {
		handler.DeleteUserWorkflow(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/agent-skills", gin.WrapF(handler.UserAgentSkills))
	v1.POST("/agent-skills", write("agent-skills"), body8MB, gin.WrapF(handler.SaveUserAgentSkill))
	v1.DELETE("/agent-skills/:id", write("agent-skills-delete"), func(c *gin.Context) {
		handler.DeleteUserAgentSkill(c.Writer, c.Request, c.Param("id"))
	})
	v1.POST("/files", middleware.RateLimit("upload", 30, 30, middleware.ByUser), middleware.BodyLimit(200<<20), gin.WrapF(handler.UploadFile))
	v1.DELETE("/files/:id", write("files-delete"), func(c *gin.Context) {
		handler.DeleteFile(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-config", gin.WrapF(handler.UserConfig))
	v1.POST("/user-config/model", write("user-config"), body8MB, gin.WrapF(handler.SaveUserModelConfig))
	v1.GET("/canvas/projects", gin.WrapF(handler.UserCanvasProjects))
	v1.POST("/canvas/projects", autosave("canvas-projects"), body32MB, gin.WrapF(handler.SaveUserCanvasProject))
	v1.POST("/canvas/projects/sync", autosave("canvas-projects-sync"), body32MB, gin.WrapF(handler.SyncUserCanvasProjects))
	v1.POST("/canvas/projects/delete", write("canvas-projects-delete"), body32MB, gin.WrapF(handler.DeleteUserCanvasProjects))
	v1.GET("/user-data/image-history", gin.WrapF(handler.UserImageHistory))
	v1.POST("/user-data/image-history", write("image-history"), body8MB, gin.WrapF(handler.SaveUserImageHistory))
	v1.GET("/generation-logs/videos", gin.WrapF(handler.UserVideoGenerationLogs))
	v1.POST("/generation-logs/videos", write("video-logs"), body8MB, gin.WrapF(handler.SaveUserVideoGenerationLogs))
	v1.POST("/generation-logs/videos/delete", write("video-logs-delete"), body8MB, gin.WrapF(handler.DeleteUserVideoGenerationLogs))
	v1.DELETE("/generation-logs/videos/:id", write("video-log-delete"), func(c *gin.Context) {
		handler.DeleteUserVideoGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/generation-logs/images", gin.WrapF(handler.UserImageGenerationLogs))
	v1.POST("/generation-logs/images", write("image-logs"), body8MB, gin.WrapF(handler.SaveUserImageGenerationLogs))
	v1.POST("/generation-logs/images/delete", write("image-logs-delete"), body8MB, gin.WrapF(handler.DeleteUserImageGenerationLogs))
	v1.DELETE("/generation-logs/images/:id", write("image-log-delete"), func(c *gin.Context) {
		handler.DeleteUserImageGenerationLog(c.Writer, c.Request, c.Param("id"))
	})
	v1.GET("/user-data/assets", gin.WrapF(handler.UserAssetData))
	v1.POST("/user-data/assets", write("assets"), body8MB, gin.WrapF(handler.SaveUserAssetData))
	// 先限流再进 ProxyGuard，超频的请求不占并发名额；OptionalAuth 认出登录用户，没登录的只能代理图片。
	api.GET("/proxy-image", middleware.RateLimit("proxy-image", 120, 120, middleware.ByIP), middleware.ProxyGuard, middleware.OptionalAuth, gin.WrapF(handler.ProxyImage))
	api.GET("/fit/catalog", middleware.RateLimit("fit-catalog", 60, 60, middleware.ByIP), gin.WrapF(handler.FitCatalog))
	api.GET("/prompts", middleware.OptionalAuth, gin.WrapF(handler.Prompts))
	// 提示词库封面：本站缓存的图（第一次由服务器去同步来源的图床取），一页几十张、往下滚还会接着加载，额度给得宽。
	api.GET("/prompts/:id/cover", middleware.RateLimit("prompt-cover", 600, 300, middleware.ByIP), func(c *gin.Context) {
		handler.PromptCover(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/agent-skills", gin.WrapF(handler.AgentSkills))
	api.GET("/agent-skills/:id/file", func(c *gin.Context) {
		handler.AgentSkillFile(c.Writer, c.Request, c.Param("id"))
	})
	api.GET("/assets", middleware.OptionalAuth, gin.WrapF(handler.Assets))
	// 后台登录：按 IP 每分钟 5 次；同一 IP 同一用户名每小时只允许失败 10 次，成功不计。
	api.POST("/admin/login", middleware.RateLimit("admin-login", 5, 5, middleware.ByIP), body8MB, middleware.RateLimitFailuresPerHour("admin-login-failures", 10, 10, middleware.ByIPAndUsername), gin.WrapF(handler.AdminLogin))

	admin := api.Group("/admin", middleware.AdminAuth)
	admin.GET("/users", gin.WrapF(handler.AdminUsers))
	admin.POST("/users", gin.WrapF(handler.AdminSaveUser))
	admin.POST("/users/:id/credits", func(c *gin.Context) {
		handler.AdminAdjustUserCredits(c.Writer, c.Request, c.Param("id"))
	})
	admin.DELETE("/users/:id", func(c *gin.Context) {
		handler.AdminDeleteUser(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/credit-logs", gin.WrapF(handler.AdminCreditLogs))
	admin.POST("/credit-logs", gin.WrapF(handler.AdminSaveCreditLog))
	admin.DELETE("/credit-logs/:id", func(c *gin.Context) {
		handler.AdminDeleteCreditLog(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/ai-logs", gin.WrapF(handler.AdminAICallLogs))
	admin.DELETE("/ai-logs", gin.WrapF(handler.AdminDeleteAICallLogs))
	admin.GET("/settings", gin.WrapF(handler.AdminSettings))
	admin.POST("/settings", gin.WrapF(handler.AdminSaveSettings))
	admin.POST("/storage/measure", gin.WrapF(handler.AdminMeasureStorageProvider))
	admin.GET("/prompt-categories", gin.WrapF(handler.AdminPromptCategories))
	admin.POST("/prompt-categories/sync", gin.WrapF(handler.AdminSyncPromptCategories))
	admin.POST("/prompt-categories/sync-all", gin.WrapF(handler.AdminSyncAllPromptCategories))
	admin.GET("/prompts", gin.WrapF(handler.AdminPrompts))
	admin.POST("/prompts", gin.WrapF(handler.AdminSavePrompt))
	admin.POST("/prompts/batch-delete", gin.WrapF(handler.AdminDeletePrompts))
	admin.DELETE("/prompts/:id", func(c *gin.Context) {
		handler.AdminDeletePrompt(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/agent-skills", gin.WrapF(handler.AdminAgentSkills))
	admin.GET("/agent-skills/:id/files", func(c *gin.Context) {
		handler.AdminAgentSkillFiles(c.Writer, c.Request, c.Param("id"))
	})
	admin.POST("/agent-skills", gin.WrapF(handler.AdminSaveAgentSkill))
	admin.DELETE("/agent-skills/:id", func(c *gin.Context) {
		handler.AdminDeleteAgentSkill(c.Writer, c.Request, c.Param("id"))
	})
	admin.GET("/assets", gin.WrapF(handler.AdminAssets))
	admin.POST("/assets", gin.WrapF(handler.AdminSaveAsset))
	admin.DELETE("/assets/:id", func(c *gin.Context) {
		handler.AdminDeleteAsset(c.Writer, c.Request, c.Param("id"))
	})

	router.NoRoute(middleware.NotFoundJSON)

	return router
}
