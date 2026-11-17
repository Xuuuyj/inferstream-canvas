package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

const defaultSecret = "infinite-canvas"

type Config struct {
	AppEnv              string   `env:"APP_ENV" envDefault:"production"`
	BindAddr            string   `env:"BIND_ADDR" envDefault:"127.0.0.1"`
	Port                string   `env:"PORT" envDefault:"8080"`
	FitBaseURL          string   `env:"FIT_BASE_URL" envDefault:"https://openai.fit"`
	PublicHost          string   `env:"PUBLIC_HOST"`
	ServerPublicIPs     []string `env:"SERVER_PUBLIC_IPS" envSeparator:","`
	AdminUsername       string   `env:"ADMIN_USERNAME" envDefault:"admin"`
	AdminPassword       string   `env:"ADMIN_PASSWORD"`
	JWTSecret           string   `env:"JWT_SECRET" envDefault:"infinite-canvas"`
	JWTExpireHours      int      `env:"JWT_EXPIRE_HOURS" envDefault:"72"`
	StorageDriver       string   `env:"STORAGE_DRIVER" envDefault:"sqlite"`
	DatabaseDSN         string   `env:"DATABASE_DSN" envDefault:"data/infinite-canvas.db"`
	LinuxDoAuthorizeURL string   `env:"LINUX_DO_AUTHORIZE_URL" envDefault:"https://connect.linux.do/oauth2/authorize"`
	LinuxDoTokenURL     string   `env:"LINUX_DO_TOKEN_URL" envDefault:"https://connect.linux.do/oauth2/token"`
	LinuxDoUserInfoURL  string   `env:"LINUX_DO_USERINFO_URL" envDefault:"https://connect.linux.do/api/user"`
	AILogDir            string   `env:"AI_LOG_DIR" envDefault:"data/logs/ai-calls"`
	// 提示词库封面的本地缓存（service/prompt_cover.go），容器里在挂载的 /app/data 下。
	PromptCoverDir string `env:"PROMPT_COVER_DIR" envDefault:"data/prompt-covers"`

	// 每个 IP 每 24 小时最多注册成功几个账号，0 表示不限。计数只在内存里（单实例），后端重启清零。
	RegisterDailyLimitPerIP int `env:"REGISTER_DAILY_LIMIT_PER_IP" envDefault:"10"`

	// 「用 openai.fit 登录」的共享密钥，和 openai.fit 的 CANVAS_CONNECT_SECRET 相同；为空表示关闭 fit 登录。只写在服务器 .env，不进仓库。
	InferStreamSSOSecret string `env:"CANVAS_SSO_SECRET"`
	FitConnectSecret     string `env:"FIT_CONNECT_SECRET"`
}

var Cfg Config

func Load() error {
	_ = godotenv.Load()
	if err := env.Parse(&Cfg); err != nil {
		return err
	}
	normalizeDockerSQLiteDSN("/app/data")
	Cfg.FitConnectSecret = strings.TrimSpace(Cfg.FitConnectSecret)
	for _, raw := range Cfg.ServerPublicIPs {
		if net.ParseIP(strings.TrimSpace(raw)) == nil {
			return fmt.Errorf("SERVER_PUBLIC_IPS 里的 %q 不是 IP 地址", raw)
		}
	}
	// 只有一字不差的 dev 才算开发环境；不写就是 production，写错了直接拒绝启动，免得拼错时悄悄用上默认密钥。
	switch Cfg.AppEnv {
	case "production":
		return validateProductionConfig()
	case "dev":
	default:
		return fmt.Errorf("APP_ENV 只能是 dev 或 production，当前是 %q", Cfg.AppEnv)
	}
	if Cfg.AdminPassword == "" {
		Cfg.AdminPassword = defaultSecret
	}
	if strings.TrimSpace(Cfg.JWTSecret) == "" || Cfg.JWTSecret == defaultSecret {
		secret, err := randomSecret()
		if err != nil {
			return err
		}
		Cfg.JWTSecret = secret
	}
	return nil
}

func validateProductionConfig() error {
	if secret := strings.TrimSpace(Cfg.JWTSecret); secret == defaultSecret || len(secret) < 32 {
		return errors.New("APP_ENV=production 时 JWT_SECRET 必须是至少 32 字节的非默认值")
	}
	if strings.EqualFold(strings.TrimSpace(Cfg.AdminUsername), "admin") {
		return errors.New("APP_ENV=production 时 ADMIN_USERNAME 不能是 admin")
	}
	if Cfg.AdminPassword != "" && (Cfg.AdminPassword == defaultSecret || utf8.RuneCountInString(Cfg.AdminPassword) < 16) {
		return errors.New("APP_ENV=production 时 ADMIN_PASSWORD 必须是至少 16 位的非默认值（管理员已建好时可留空）")
	}
	// /api/proxy-image 靠这两项拦截绕回本站的请求，生产环境不能缺。
	if strings.TrimSpace(Cfg.PublicHost) == "" || len(Cfg.ServerPublicIPs) == 0 {
		return errors.New("APP_ENV=production 时必须设置 PUBLIC_HOST（本站域名）和 SERVER_PUBLIC_IPS（服务器公网 IP）")
	}
	// .env.example 生产段里的 <…> 占位符没换掉时拒绝启动（密码占位符不够 16 位，上面已经拦下）。
	for name, value := range map[string]string{"PUBLIC_HOST": Cfg.PublicHost, "ADMIN_USERNAME": Cfg.AdminUsername, "JWT_SECRET": Cfg.JWTSecret, "FIT_CONNECT_SECRET": Cfg.FitConnectSecret} {
		if strings.ContainsAny(value, "<>") {
			return fmt.Errorf("APP_ENV=production 时 %s 还是占位符，请换成真实值", name)
		}
	}
	if Cfg.FitConnectSecret != "" {
		if len(Cfg.FitConnectSecret) < 32 {
			return errors.New("APP_ENV=production 时 FIT_CONNECT_SECRET 要么不填（关闭 openai.fit 登录），要么至少 32 字节")
		}
		// 换取身份的请求带着共享密钥，不能明文发出去。
		if !strings.HasPrefix(Cfg.FitBaseURL, "https://") {
			return errors.New("开启 openai.fit 登录（FIT_CONNECT_SECRET）时 FIT_BASE_URL 必须是 https:// 地址")
		}
	}
	return nil
}

func normalizeDockerSQLiteDSN(appDataDir string) {
	driver := strings.ToLower(strings.TrimSpace(Cfg.StorageDriver))
	if driver != "" && driver != "sqlite" {
		return
	}
	dsn := strings.TrimSpace(Cfg.DatabaseDSN)
	if dsn == "" || dsn == ":memory:" || strings.HasPrefix(dsn, "file:") {
		return
	}
	pathPart, suffix := dsn, ""
	if index := strings.Index(dsn, "?"); index >= 0 {
		pathPart = dsn[:index]
		suffix = dsn[index:]
	}
	if filepath.IsAbs(pathPart) {
		return
	}
	slashPath := filepath.ToSlash(pathPart)
	if slashPath != "data" && !strings.HasPrefix(slashPath, "data/") {
		return
	}
	if _, err := os.Stat(appDataDir); err != nil {
		return
	}
	Cfg.DatabaseDSN = filepath.Join(filepath.Dir(appDataDir), filepath.FromSlash(slashPath)) + suffix
}

func randomSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
