package config

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/joho/godotenv"
)

func TestNormalizeDockerSQLiteDSNUsesMountedDataDir(t *testing.T) {
	previous := Cfg
	t.Cleanup(func() { Cfg = previous })
	root := t.TempDir()
	appDataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		t.Fatal(err)
	}
	Cfg = Config{StorageDriver: "sqlite", DatabaseDSN: "data/infinite-canvas.db?_pragma=busy_timeout(5000)"}

	normalizeDockerSQLiteDSN(appDataDir)

	want := filepath.Join(root, "data", "infinite-canvas.db") + "?_pragma=busy_timeout(5000)"
	if Cfg.DatabaseDSN != want {
		t.Fatalf("DatabaseDSN = %q, want %q", Cfg.DatabaseDSN, want)
	}
}

func TestNormalizeDockerSQLiteDSNLeavesLocalPathWithoutMountedDataDir(t *testing.T) {
	previous := Cfg
	t.Cleanup(func() { Cfg = previous })
	Cfg = Config{StorageDriver: "sqlite", DatabaseDSN: "data/infinite-canvas.db"}

	normalizeDockerSQLiteDSN(filepath.Join(t.TempDir(), "missing-data"))

	if Cfg.DatabaseDSN != "data/infinite-canvas.db" {
		t.Fatalf("DatabaseDSN = %q, want relative local path", Cfg.DatabaseDSN)
	}
}

func loadWithEnv(t *testing.T, values map[string]string) error {
	t.Helper()
	previous := Cfg
	t.Cleanup(func() { Cfg = previous })
	for _, key := range []string{"APP_ENV", "BIND_ADDR", "PORT", "FIT_BASE_URL", "FIT_CONNECT_SECRET", "PUBLIC_HOST", "SERVER_PUBLIC_IPS", "ADMIN_USERNAME", "ADMIN_PASSWORD", "JWT_SECRET", "JWT_EXPIRE_HOURS", "REGISTER_DAILY_LIMIT_PER_IP"} {
		value, ok := values[key]
		t.Setenv(key, value)
		if !ok {
			// 没给的键当作完全没设置（t.Setenv 负责测试结束后还原）。
			_ = os.Unsetenv(key)
		}
	}
	Cfg = Config{}
	return Load()
}

func TestLoadRejectsUnsafeProductionConfig(t *testing.T) {
	safe := map[string]string{
		"APP_ENV":           "production",
		"JWT_SECRET":        "0123456789abcdef0123456789abcdef",
		"ADMIN_USERNAME":    "fit-owner",
		"ADMIN_PASSWORD":    "a-strong-admin-pass",
		"PUBLIC_HOST":       "canvas.openai.fit",
		"SERVER_PUBLIC_IPS": "203.0.113.10",
	}
	cases := map[string]map[string]string{
		"jwt secret missing":        {"JWT_SECRET": ""},
		"jwt secret default":        {"JWT_SECRET": "infinite-canvas"},
		"jwt secret too short":      {"JWT_SECRET": "0123456789abcdef0123456789abcde"},
		"admin username is admin":   {"ADMIN_USERNAME": "admin"},
		"admin password default":    {"ADMIN_PASSWORD": "infinite-canvas"},
		"admin password short":      {"ADMIN_PASSWORD": "short-password1"},
		"public host missing":       {"PUBLIC_HOST": ""},
		"public host blank":         {"PUBLIC_HOST": "  "},
		"server public ips missing": {"SERVER_PUBLIC_IPS": ""},
		"public host placeholder":   {"PUBLIC_HOST": "<本站域名>"},
		"admin name placeholder":    {"ADMIN_USERNAME": "<管理员用户名>"},
		"jwt secret placeholder":    {"JWT_SECRET": "<a-placeholder-longer-than-32-bytes>"},
	}
	for name, override := range cases {
		t.Run(name, func(t *testing.T) {
			values := map[string]string{}
			for key, value := range safe {
				values[key] = value
			}
			for key, value := range override {
				values[key] = value
			}
			if err := loadWithEnv(t, values); err == nil {
				t.Fatal("Load() = nil, want production config error")
			}
		})
	}
}

func TestLoadAcceptsSafeProductionConfig(t *testing.T) {
	values := map[string]string{
		"APP_ENV":           "production",
		"JWT_SECRET":        "0123456789abcdef0123456789abcdef",
		"ADMIN_USERNAME":    "fit-owner",
		"ADMIN_PASSWORD":    "a-strong-admin-pass",
		"PUBLIC_HOST":       "canvas.openai.fit",
		"SERVER_PUBLIC_IPS": "203.0.113.10",
	}
	if err := loadWithEnv(t, values); err != nil {
		t.Fatalf("Load() = %v, want nil", err)
	}
	if Cfg.JWTSecret != values["JWT_SECRET"] || Cfg.AdminPassword != values["ADMIN_PASSWORD"] {
		t.Fatalf("Load() changed production secrets: %+v", Cfg)
	}
	values["ADMIN_PASSWORD"] = ""
	if err := loadWithEnv(t, values); err != nil {
		t.Fatalf("Load() with empty ADMIN_PASSWORD = %v, want nil", err)
	}
	if Cfg.AdminPassword != "" {
		t.Fatalf("AdminPassword = %q, want empty so the default admin is not created", Cfg.AdminPassword)
	}
}

// FIT_CONNECT_SECRET 不填就是关掉「用 openai.fit 登录」；填了就要够长，而且只能发往 https 的 FIT_BASE_URL。
func TestLoadFitConnectSecret(t *testing.T) {
	safe := map[string]string{
		"APP_ENV":           "production",
		"JWT_SECRET":        "0123456789abcdef0123456789abcdef",
		"ADMIN_USERNAME":    "fit-owner",
		"ADMIN_PASSWORD":    "a-strong-admin-pass",
		"PUBLIC_HOST":       "canvas.openai.fit",
		"SERVER_PUBLIC_IPS": "203.0.113.10",
	}
	with := func(override map[string]string) map[string]string {
		values := map[string]string{}
		for key, value := range safe {
			values[key] = value
		}
		for key, value := range override {
			values[key] = value
		}
		return values
	}
	secret := strings.Repeat("k", 48)
	if err := loadWithEnv(t, with(map[string]string{"FIT_BASE_URL": "http://127.0.0.1:3000"})); err != nil || Cfg.FitConnectSecret != "" {
		t.Fatalf("without FIT_CONNECT_SECRET: Load() = %v, secret = %q; want fit login off and no refusal", err, Cfg.FitConnectSecret)
	}
	if err := loadWithEnv(t, with(map[string]string{"FIT_CONNECT_SECRET": "  " + secret + " "})); err != nil || Cfg.FitConnectSecret != secret {
		t.Fatalf("with a good secret: Load() = %v, secret = %q; want the trimmed secret", err, Cfg.FitConnectSecret)
	}
	for name, override := range map[string]map[string]string{
		"secret too short":   {"FIT_CONNECT_SECRET": strings.Repeat("k", 31)},
		"secret padded":      {"FIT_CONNECT_SECRET": " " + strings.Repeat("k", 31) + " "},
		"secret over http":   {"FIT_CONNECT_SECRET": secret, "FIT_BASE_URL": "http://openai.fit"},
		"secret placeholder": {"FIT_CONNECT_SECRET": "<openssl rand -base64 48 生成，和 openai.fit 的 CANVAS_CONNECT_SECRET 相同>"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := loadWithEnv(t, with(override)); err == nil {
				t.Fatal("Load() = nil, want refusal")
			}
		})
	}
}

func TestLoadDefaultsToProduction(t *testing.T) {
	err := loadWithEnv(t, nil)
	if Cfg.AppEnv != "production" {
		t.Fatalf("AppEnv = %q, want production when APP_ENV is not set", Cfg.AppEnv)
	}
	if err == nil {
		t.Fatal("Load() = nil, want refusal: production with the default JWT secret and admin")
	}
}

func TestLoadDevDefaults(t *testing.T) {
	if err := loadWithEnv(t, map[string]string{"APP_ENV": "dev"}); err != nil {
		t.Fatalf("Load() = %v", err)
	}
	if Cfg.AppEnv != "dev" || Cfg.BindAddr != "127.0.0.1" || Cfg.FitBaseURL != "https://openai.fit" || Cfg.JWTExpireHours != 72 || Cfg.RegisterDailyLimitPerIP != 10 {
		t.Fatalf("unexpected defaults: %+v", Cfg)
	}
	if err := loadWithEnv(t, map[string]string{"APP_ENV": "dev", "REGISTER_DAILY_LIMIT_PER_IP": "3"}); err != nil || Cfg.RegisterDailyLimitPerIP != 3 {
		t.Fatalf("REGISTER_DAILY_LIMIT_PER_IP=3: Load() = %v, limit = %d", err, Cfg.RegisterDailyLimitPerIP)
	}
	if Cfg.AdminPassword != defaultSecret || Cfg.JWTSecret == defaultSecret || Cfg.JWTSecret == "" {
		t.Fatalf("dev secrets not initialised: admin=%q jwt=%q", Cfg.AdminPassword, Cfg.JWTSecret)
	}
}

func TestLoadRejectsUnknownAppEnv(t *testing.T) {
	for _, value := range []string{"development", "Dev", "DEV", " dev", "dev ", "prod", "Production", "test", "staging"} {
		t.Run(value, func(t *testing.T) {
			if err := loadWithEnv(t, map[string]string{"APP_ENV": value}); err == nil {
				t.Fatalf("APP_ENV=%q: Load() = nil, want refusal", value)
			}
		})
	}
}

func TestLoadServerPublicIPs(t *testing.T) {
	values := map[string]string{"APP_ENV": "dev", "PUBLIC_HOST": "canvas.openai.fit", "SERVER_PUBLIC_IPS": "203.0.113.10,2001:db8::10"}
	if err := loadWithEnv(t, values); err != nil {
		t.Fatalf("Load() = %v", err)
	}
	if Cfg.PublicHost != "canvas.openai.fit" || len(Cfg.ServerPublicIPs) != 2 || Cfg.ServerPublicIPs[1] != "2001:db8::10" {
		t.Fatalf("PublicHost=%q ServerPublicIPs=%q", Cfg.PublicHost, Cfg.ServerPublicIPs)
	}
	values["SERVER_PUBLIC_IPS"] = "203.0.113.10,canvas.openai.fit"
	if err := loadWithEnv(t, values); err == nil {
		t.Fatal("Load() = nil, want error for a non-IP entry in SERVER_PUBLIC_IPS")
	}
}

// .env.example 原样复制成 .env 不能启动；取消「本机开发」段的注释后以 dev 启动。
func TestEnvExampleBlocks(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", ".env.example"))
	if err != nil {
		t.Fatal(err)
	}
	production, err := godotenv.UnmarshalBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if production["APP_ENV"] != "production" {
		t.Fatalf("生产段的 APP_ENV = %q，期望 production", production["APP_ENV"])
	}
	if err := loadWithEnv(t, production); err == nil {
		t.Fatal("生产段的占位符没换掉时不应能启动")
	}

	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	index := strings.Index(text, "# 本机开发")
	if index < 0 {
		t.Fatal(".env.example 缺少「本机开发」段")
	}
	devText := text[:index] + regexp.MustCompile(`(?m)^# ([A-Z_]+=.*)$`).ReplaceAllString(text[index:], "$1")
	dev, err := godotenv.Unmarshal(devText)
	if err != nil {
		t.Fatal(err)
	}
	if err := loadWithEnv(t, dev); err != nil {
		t.Fatalf("取消开发段注释后 Load() = %v", err)
	}
	if Cfg.AppEnv != "dev" || Cfg.PublicHost != "" || len(Cfg.ServerPublicIPs) != 0 {
		t.Fatalf("开发段没有盖住生产段的占位符：%+v", Cfg)
	}
}
