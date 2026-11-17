package middleware

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestBodyLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/upload", BodyLimit(8), func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.String(http.StatusRequestEntityTooLarge, "too large")
			return
		}
		c.String(http.StatusOK, string(body))
	})
	send := func(body string, chunked bool) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/upload", strings.NewReader(body))
		if chunked {
			request.ContentLength = -1
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder
	}
	if recorder := send("12345678", false); recorder.Code != http.StatusOK || recorder.Body.String() != "12345678" {
		t.Fatalf("上限以内返回 %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder := send("123456789", false); recorder.Code != http.StatusRequestEntityTooLarge || strings.Contains(recorder.Body.String(), "too large") {
		t.Fatalf("声明长度超限应由中间件直接返回 413，实际 %d %q", recorder.Code, recorder.Body.String())
	}
	if recorder := send("123456789", true); recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("没声明长度的超限请求体读取应报错，实际 %d", recorder.Code)
	}
}
