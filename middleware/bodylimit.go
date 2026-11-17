package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/tigerowo/infinite-canvas/handler"
)

// BodyLimit 限制请求体大小：声明的长度超限直接返回 413，没声明长度的读到上限就报错。
// 要按路由单独挂：嵌套挂载时外层更小的上限会盖住里层。
func BodyLimit(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > maxBytes {
			handler.FailWithStatus(c.Writer, http.StatusRequestEntityTooLarge, "请求内容过大")
			c.Abort()
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		c.Next()
	}
}
