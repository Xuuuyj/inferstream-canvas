package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	mathrand "math/rand/v2"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// 「用 openai.fit 账号自动登录画布」：浏览器从页面里隐藏的 openai.fit 桥接页（https://openai.fit/canvas/bridge）拿到一次性 code，
// 画布后端带共享密钥和 PKCE verifier 去 openai.fit 换回 fit 用户身份，按 fit_user_id 找到或新建画布账号。
// openai.fit 只返回身份、不返回令牌，令牌只在浏览器里。

const (
	fitExchangePath         = "/api/canvas/exchange"
	fitExchangeSecretHeader = "X-Canvas-Connect-Secret"
	fitExchangeMaxBody      = 64 << 10
)

var (
	fitConnectTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
	fitConnectCodePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	fitErrorCodePattern    = regexp.MustCompile(`^[A-Z_]{1,64}$`)
	fitUsernameDisallowed  = regexp.MustCompile(`[^A-Za-z0-9_-]`)

	// 不跟随跳转：跳转后共享密钥的请求头可能被带到别的地址。
	fitExchangeClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	errFitLoginDisabled = safeMessageError{message: "openai.fit 登录未开启"}
	errFitLoginInvalid  = safeMessageError{message: "登录请求无效，请重新点「用 openai.fit 登录」"}
	errFitCodeExpired   = safeMessageError{message: "openai.fit 授权已失效（可能已用过或超时），请重新点「用 openai.fit 登录」"}
	errFitUnavailable   = safeMessageError{message: "openai.fit 登录暂不可用，请稍后再试或用画布账号密码登录"}
	errFitUserDisabled  = safeMessageError{message: "openai.fit 账号已被禁用"}
	errFitTooMany       = safeMessageError{message: "登录太频繁，请稍后再试"}
	errFitUnreachable   = safeMessageError{message: "连接 openai.fit 失败，请稍后重试"}
)

type fitIdentity struct {
	UserID      int    `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// LoginWithFit 用 openai.fit 桥接页发的一次性 code 登录：不套用「是否开放注册」和每 IP 每日注册上限，身份来自 fit（fit 注册要邮箱验证）。
func LoginWithFit(code, verifier, state string) (model.AuthSession, error) {
	if config.Cfg.FitConnectSecret == "" {
		return model.AuthSession{}, errFitLoginDisabled
	}
	if !fitConnectCodePattern.MatchString(code) || !fitConnectTokenPattern.MatchString(verifier) || !fitConnectTokenPattern.MatchString(state) {
		return model.AuthSession{}, errFitLoginInvalid
	}
	identity, err := exchangeFitCode(code, verifier, state)
	if err != nil {
		return model.AuthSession{}, err
	}
	return loginWithLinkedIdentity(identity, repository.GetUserByFitUserID, createFitUser)
}

type identityLookup func(int) (model.User, bool, error)

func loginWithLinkedIdentity(identity fitIdentity, find identityLookup, create func(fitIdentity) (model.User, error)) (model.AuthSession, error) {
	user, ok, err := find(identity.UserID)
	if err != nil {
		return model.AuthSession{}, err
	}
	if !ok {
		if user, err = create(identity); err != nil {
			return model.AuthSession{}, err
		}
	}
	if user.Status == model.UserStatusBan {
		return model.AuthSession{}, safeMessageError{message: "账号已被禁用"}
	}
	if user.Role == model.UserRoleAdmin {
		return model.AuthSession{}, ErrAdminLoginRequired
	}
	normalizeUserDefaults(&user)
	user.LastLoginAt = now()
	user.UpdatedAt = now()
	if user, err = repository.SaveUser(user); err != nil {
		return model.AuthSession{}, err
	}
	return newSession(user)
}

// exchangeFitCode 带共享密钥用 code 换 fit 用户身份。日志里不写 code、verifier、state、密钥和响应体。
func exchangeFitCode(code, verifier, state string) (fitIdentity, error) {
	return exchangeCanvasCode(config.Cfg.FitBaseURL, config.Cfg.FitConnectSecret, code, verifier, state)
}

func exchangeCanvasCode(baseURL, secret, code, verifier, state string) (fitIdentity, error) {
	body, _ := json.Marshal(map[string]string{"code": code, "code_verifier": verifier, "state": state})
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(baseURL, "/")+fitExchangePath, bytes.NewReader(body))
	if err != nil {
		log.Printf("fit exchange: bad FIT_BASE_URL: %v", err)
		return fitIdentity{}, errFitUnreachable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(fitExchangeSecretHeader, secret)
	response, err := fitExchangeClient.Do(request)
	if err != nil {
		log.Printf("fit exchange failed: %v", err)
		return fitIdentity{}, errFitUnreachable
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, fitExchangeMaxBody))
	var payload struct {
		Success bool        `json:"success"`
		Code    string      `json:"code"`
		Data    fitIdentity `json:"data"`
	}
	decoded := json.Unmarshal(raw, &payload) == nil
	switch response.StatusCode {
	case http.StatusOK:
		if decoded && payload.Success && payload.Data.UserID > 0 {
			return payload.Data, nil
		}
		log.Printf("fit exchange: unexpected 200 response")
		return fitIdentity{}, errFitUnreachable
	case http.StatusBadRequest:
		return fitIdentity{}, errFitCodeExpired
	case http.StatusUnauthorized, http.StatusServiceUnavailable:
		errorCode := ""
		if fitErrorCodePattern.MatchString(payload.Code) {
			errorCode = payload.Code
		}
		log.Printf("fit exchange rejected: status=%d code=%s", response.StatusCode, errorCode)
		return fitIdentity{}, errFitUnavailable
	case http.StatusForbidden:
		return fitIdentity{}, errFitUserDisabled
	case http.StatusTooManyRequests:
		return fitIdentity{}, errFitTooMany
	default:
		log.Printf("fit exchange failed: status=%d", response.StatusCode)
		return fitIdentity{}, errFitUnreachable
	}
}

// createFitUser 给第一次用 openai.fit 登录的 fit 用户建画布账号。账号没有密码（bcrypt 比较必然失败），只能经 fit 登录。
func createFitUser(identity fitIdentity) (model.User, error) {
	return createLinkedUser(identity, repository.GetUserByFitUserID, func(user *model.User, id int) { user.FitUserID = &id })
}

func createLinkedUser(identity fitIdentity, find identityLookup, link func(*model.User, int)) (model.User, error) {
	fitID := identity.UserID
	displayName := strings.TrimSpace(identity.DisplayName)
	if displayName == "" {
		displayName = strings.TrimSpace(identity.Username)
	}
	if utf8.RuneCountInString(displayName) > 64 {
		displayName = string([]rune(displayName)[:64])
	}
	for _, username := range fitUsernameCandidates(identity.Username, fitID) {
		if _, taken, err := repository.GetUserByUsername(username); err != nil {
			return model.User{}, err
		} else if taken {
			continue
		}
		candidate := model.User{
			ID:          newID("user"),
			Username:    username,
			DisplayName: displayName,
			Role:        model.UserRoleUser,
			Status:      model.UserStatusActive,
			CreatedAt:   now(),
			UpdatedAt:   now(),
		}
		link(&candidate, fitID)
		user, err := repository.SaveUser(candidate)
		if err == nil {
			return user, nil
		}
		// 多半是撞了唯一索引：同一个 fit 用户并发首登时，另一个请求已经建好了账号，直接用它；用户名刚被别人占了就试下一个。
		if existing, ok, findErr := find(fitID); findErr == nil && ok {
			return existing, nil
		}
		if _, taken, findErr := repository.GetUserByUsername(username); findErr != nil || !taken {
			return model.User{}, err
		}
	}
	return model.User{}, safeMessageError{message: "openai.fit 登录建号失败，请稍后重试"}
}

// fitUsernameCandidates：fit 用户名去掉画布用户名不允许的字符后，3–32 位就先用它；再试「截断 + -fitID」；最后是 fit-<fitID>-<4 位随机>。
func fitUsernameCandidates(fitUsername string, fitID int) []string {
	base := fitUsernameDisallowed.ReplaceAllString(fitUsername, "")
	suffix := "-" + strconv.Itoa(fitID)
	candidates := []string{}
	if len(base) >= 3 && len(base) <= 32 {
		candidates = append(candidates, base)
	}
	if base != "" {
		candidates = append(candidates, base[:min(len(base), 32-len(suffix))]+suffix)
	}
	return append(candidates, fmt.Sprintf("fit-%d-%04d", fitID, mathrand.IntN(10000)))
}
