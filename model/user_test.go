package model

import (
	"encoding/json"
	"strings"
	"testing"
)

// 用 openai.fit 登录建的账号，公开信息里带 fitUserId（前端用它判断 fit 那边是不是换了人）；其他账号不带这个字段。
func TestPublicUserCarriesFitUserIDOnlyForFitAccounts(t *testing.T) {
	fitID := 401
	raw, err := json.Marshal(PublicUser(User{ID: "user-1", Username: "yeyou", FitUserID: &fitID}))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"fitUserId":401`) {
		t.Fatalf("fit account = %s, want fitUserId 401", raw)
	}
	raw, err = json.Marshal(PublicUser(User{ID: "user-2", Username: "password-user"}))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "fitUserId") {
		t.Fatalf("password account = %s, want no fitUserId", raw)
	}
}
