package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// RFC 7636 附录 B 的 verifier；code、state 只要格式对就行。
const (
	testFitSecret   = "fit-connect-test-secret-0123456789abcdef"
	testFitCode     = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
	testFitVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	testFitState    = "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS"
)

// useFakeFit 起一个假的 openai.fit（只有 /api/canvas/exchange），并把画布配成用它登录。
func useFakeFit(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	useMemoryDB(t)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	config.Cfg.JWTSecret = "fit-login-test-jwt-secret-0123456789abcdef"
	config.Cfg.FitConnectSecret = testFitSecret
	config.Cfg.FitBaseURL = server.URL
	return server
}

func writeFitIdentity(w http.ResponseWriter, id int, username, displayName string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = fmt.Fprintf(w, `{"success":true,"data":{"user_id":%d,"username":%q,"display_name":%q}}`, id, username, displayName)
}

func loginAsFit() (model.AuthSession, error) {
	return LoginWithFit(testFitCode, testFitVerifier, testFitState)
}

func safeMessage(err error) string {
	var safe interface{ SafeMessage() string }
	if errors.As(err, &safe) {
		return safe.SafeMessage()
	}
	return ""
}

func TestLoginWithFitCreatesThenReusesAccount(t *testing.T) {
	var requests atomic.Int32
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		want := map[string]string{"code": testFitCode, "code_verifier": testFitVerifier, "state": testFitState}
		if r.Method != http.MethodPost || r.URL.Path != "/api/canvas/exchange" || r.Header.Get("X-Canvas-Connect-Secret") != testFitSecret ||
			!strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") || fmt.Sprint(body) != fmt.Sprint(want) {
			t.Errorf("exchange request = %s %s secret=%q body=%v", r.Method, r.URL.Path, r.Header.Get("X-Canvas-Connect-Secret"), body)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		writeFitIdentity(w, 301, "fituser301", "Fit 三百零一")
	})

	session, err := loginAsFit()
	if err != nil {
		t.Fatalf("first fit login: %v", err)
	}
	user, ok, err := repository.GetUserByID(session.User.ID)
	if err != nil || !ok {
		t.Fatalf("created user not found: ok=%v err=%v", ok, err)
	}
	if user.FitUserID == nil || *user.FitUserID != 301 || user.Password != "" || user.Username != "fituser301" || user.DisplayName != "Fit 三百零一" ||
		user.Role != model.UserRoleUser || user.Status != model.UserStatusActive || user.LastLoginAt == "" {
		t.Fatalf("created user = %+v (fit id %v)", user, user.FitUserID)
	}
	if claims, err := ParseToken(session.Token); err != nil || claims.UserID != user.ID {
		t.Fatalf("session token claims = %+v, %v", claims, err)
	}

	again, err := loginAsFit()
	if err != nil || again.User.ID != user.ID {
		t.Fatalf("second fit login = %+v, %v; want the same account %s", again.User, err, user.ID)
	}
	if requests.Load() != 2 {
		t.Fatalf("exchange requests = %d, want 2", requests.Load())
	}

	// fit 建出来的账号没有密码，不能用密码登录。
	for _, password := range []string{"", "any-password-123"} {
		if _, err := UserLogin("fituser301", password); safeMessage(err) != "用户名或密码错误" {
			t.Fatalf("password login with %q = %v, want 用户名或密码错误", password, err)
		}
	}
}

func TestLoginWithFitUsernameCandidates(t *testing.T) {
	var identity struct {
		id                    int
		username, displayName string
	}
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		writeFitIdentity(w, identity.id, identity.username, identity.displayName)
	})
	if _, err := Register("taken-name", "taken-password-123"); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		id                    int
		username, displayName string
		want                  string
		wantDisplay           string
	}{
		{311, "taken-name", "", "taken-name-311", "taken-name"},
		{312, "张三", "", `fit-312-\d{4}`, "张三"},
		{313, "a b!c", "ABC", "abc", "ABC"},
		{314, strings.Repeat("x", 40), "", strings.Repeat("x", 28) + "-314", strings.Repeat("x", 40)},
		{315, "ab", "", "ab-315", "ab"},
		{316, "", strings.Repeat("长", 70), `fit-316-\d{4}`, strings.Repeat("长", 64)},
	}
	for _, tc := range cases {
		identity.id, identity.username, identity.displayName = tc.id, tc.username, tc.displayName
		session, err := loginAsFit()
		if err != nil {
			t.Fatalf("fit %d login: %v", tc.id, err)
		}
		if !regexp.MustCompile(`^`+tc.want+`$`).MatchString(session.User.Username) || session.User.DisplayName != tc.wantDisplay {
			t.Errorf("fit %d (%q) → username %q display %q, want %s / %q", tc.id, tc.username, session.User.Username, session.User.DisplayName, tc.want, tc.wantDisplay)
		}
	}
}

func TestLoginWithFitRejectsBannedAndAdminAccounts(t *testing.T) {
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		writeFitIdentity(w, 321, "fit-banned", "")
	})
	session, err := loginAsFit()
	if err != nil {
		t.Fatal(err)
	}
	user, _, _ := repository.GetUserByID(session.User.ID)
	user.Status = model.UserStatusBan
	if _, err := repository.SaveUser(user); err != nil {
		t.Fatal(err)
	}
	if _, err := loginAsFit(); safeMessage(err) != "账号已被禁用" {
		t.Fatalf("banned account login = %v, want 账号已被禁用", err)
	}
	user.Status, user.Role = model.UserStatusActive, model.UserRoleAdmin
	if _, err := repository.SaveUser(user); err != nil {
		t.Fatal(err)
	}
	if _, err := loginAsFit(); !errors.Is(err, ErrAdminLoginRequired) {
		t.Fatalf("admin account login = %v, want ErrAdminLoginRequired", err)
	}
}

func TestLoginWithFitMapsFitFailuresToSafeMessages(t *testing.T) {
	var status atomic.Int32
	var body atomic.Value
	server := useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte(body.Load().(string)))
	})
	var logs bytes.Buffer
	previousLog := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousLog) })
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{http.StatusBadRequest, `{"success":false,"code":"CANVAS_CODE_INVALID"}`, "openai.fit 授权已失效（可能已用过或超时），请重新点「用 openai.fit 登录」"},
		{http.StatusUnauthorized, `{"success":false,"code":"CANVAS_SECRET_INVALID"}`, "openai.fit 登录暂不可用，请稍后再试或用画布账号密码登录"},
		{http.StatusServiceUnavailable, `{"success":false,"code":"CANVAS_CONNECT_DISABLED"}`, "openai.fit 登录暂不可用，请稍后再试或用画布账号密码登录"},
		{http.StatusForbidden, `{"success":false,"code":"CANVAS_USER_DISABLED"}`, "openai.fit 账号已被禁用"},
		{http.StatusTooManyRequests, ``, "登录太频繁，请稍后再试"},
		{http.StatusInternalServerError, `{"success":false}`, "连接 openai.fit 失败，请稍后重试"},
		{http.StatusBadGateway, `<html>`, "连接 openai.fit 失败，请稍后重试"},
		{http.StatusOK, `{"success":false}`, "连接 openai.fit 失败，请稍后重试"},
		{http.StatusOK, `{"success":true,"data":{"user_id":0}}`, "连接 openai.fit 失败，请稍后重试"},
		{http.StatusOK, `not json`, "连接 openai.fit 失败，请稍后重试"},
	}
	for _, tc := range cases {
		status.Store(int32(tc.status))
		body.Store(tc.body)
		if _, err := loginAsFit(); safeMessage(err) != tc.want {
			t.Errorf("fit %d %s → %v, want %q", tc.status, tc.body, err, tc.want)
		}
	}
	server.Close()
	if _, err := loginAsFit(); safeMessage(err) != "连接 openai.fit 失败，请稍后重试" {
		t.Errorf("fit unreachable → %v, want 连接失败", err)
	}
	for _, secret := range []string{testFitSecret, testFitCode, testFitVerifier, testFitState} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("log leaks %q: %s", secret, logs.String())
		}
	}
	if !strings.Contains(logs.String(), "CANVAS_SECRET_INVALID") {
		t.Fatalf("log should name fit's error code for 401/503, got: %s", logs.String())
	}
}

func TestLoginWithFitDoesNotFollowRedirects(t *testing.T) {
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.Add(1)
		writeFitIdentity(w, 331, "redirected", "")
	}))
	defer other.Close()
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/api/canvas/exchange", http.StatusFound)
	})
	if _, err := loginAsFit(); safeMessage(err) != "连接 openai.fit 失败，请稍后重试" {
		t.Fatalf("redirected exchange → %v, want 连接失败", err)
	}
	if elsewhere.Load() != 0 {
		t.Fatal("the redirect was followed: the secret header reached another server")
	}
}

func TestLoginWithFitRefusesWithoutSecretOrWithMalformedInput(t *testing.T) {
	var requests atomic.Int32
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		writeFitIdentity(w, 341, "never", "")
	})
	config.Cfg.FitConnectSecret = ""
	if _, err := loginAsFit(); safeMessage(err) != "openai.fit 登录未开启" {
		t.Fatalf("without secret → %v, want 未开启", err)
	}
	config.Cfg.FitConnectSecret = testFitSecret
	for _, input := range [][3]string{
		{testFitCode[:42], testFitVerifier, testFitState},
		{testFitCode + "C", testFitVerifier, testFitState},
		{testFitCode, "short", testFitState},
		{testFitCode, testFitVerifier, "bad state with spaces and more than forty-three chars"},
		{testFitCode, testFitVerifier, strings.Repeat("s", 129)},
		{"", "", ""},
	} {
		if _, err := LoginWithFit(input[0], input[1], input[2]); safeMessage(err) == "" {
			t.Errorf("LoginWithFit(%q, %q, %q) = %v, want a safe refusal", input[0], input[1], input[2], err)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("fit was called %d times for refused input", requests.Load())
	}
}

func TestSaveUserKeepsFitUserID(t *testing.T) {
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		writeFitIdentity(w, 351, "fit-admin-edit", "")
	})
	session, err := loginAsFit()
	if err != nil {
		t.Fatal(err)
	}
	// 后台编辑用户提交的表单里没有 fitUserId，保存后关联不能丢。
	if _, err := SaveUser(model.User{ID: session.User.ID, Username: "fit-admin-edit", DisplayName: "改个名", Role: model.UserRoleUser, Status: model.UserStatusActive}, ""); err != nil {
		t.Fatal(err)
	}
	user, _, _ := repository.GetUserByID(session.User.ID)
	if user.FitUserID == nil || *user.FitUserID != 351 || user.DisplayName != "改个名" {
		t.Fatalf("after admin save: fit id %v display %q", user.FitUserID, user.DisplayName)
	}
	if again, err := loginAsFit(); err != nil || again.User.ID != session.User.ID {
		t.Fatalf("fit login after admin save = %+v, %v; want the same account", again.User, err)
	}
}

// 同一个 fit 用户并发首登：后到的请求建号时撞上 fit_user_id 唯一索引，改用先建好的账号。
func TestCreateFitUserReusesAccountCreatedConcurrently(t *testing.T) {
	useFakeFit(t, func(w http.ResponseWriter, r *http.Request) {
		writeFitIdentity(w, 361, "fit-first", "")
	})
	session, err := loginAsFit()
	if err != nil {
		t.Fatal(err)
	}
	user, err := createFitUser(fitIdentity{UserID: 361, Username: "fit-second"})
	if err != nil || user.ID != session.User.ID {
		t.Fatalf("createFitUser for an already linked fit user = %s, %v; want %s", user.ID, err, session.User.ID)
	}
	if _, taken, _ := repository.GetUserByUsername("fit-second"); taken {
		t.Fatal("a second account was created for the same fit user")
	}
}

func TestPublicSettingsFitLoginFollowsConfig(t *testing.T) {
	useMemoryDB(t)
	stored := model.Settings{}
	stored.Public.Auth.FitLogin = true // 后台存进去的值不算数，只看 FIT_CONNECT_SECRET
	if _, err := repository.SaveSettings(stored, now()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = repository.SaveSettings(model.Settings{}, now()) })
	config.Cfg.FitConnectSecret = ""
	if settings, err := PublicSettings(); err != nil || settings.Auth.FitLogin {
		t.Fatalf("without secret fitLogin = %v, %v; want false", settings.Auth.FitLogin, err)
	}
	config.Cfg.FitConnectSecret = testFitSecret
	if settings, err := PublicSettings(); err != nil || !settings.Auth.FitLogin {
		t.Fatalf("with secret fitLogin = %v, %v; want true", settings.Auth.FitLogin, err)
	}
}
