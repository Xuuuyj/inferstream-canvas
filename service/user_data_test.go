package service

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestStripModelConfigSecretsRemovesNestedSecrets(t *testing.T) {
	raw := json.RawMessage(`{
		"apiKey": "sk-top",
		"baseUrl": "https://openai.fit",
		"uploadApiKey": "sk-upload",
		"localChannels": [{"id": "openai-fit", "apiKey": "sk-local"}],
		"publicChannels": [{"id": "public"}],
		"channelTranslations": [{"channelId": "openai-fit"}],
		"fitKeys": {"video": {"tokenId": 7, "name": "无限画布-视频", "group": "", "apiKey": "sk-video"}},
		"fitManualKey": "sk-manual",
		"fitAccount": {"userId": 42, "displayName": "叶悠"},
		"defaultImageModel": "gpt-image-2",
		"syncStorageConfig": true,
		"maxTokens": 12345678901234567890,
		"workflowChannels": [{"id": "w1", "name": "工作流", "apiKey": "sk-workflow", "baseUrl": "https://example.com", "models": ["a", "b"]}],
		"nested": {"deeper": {"apiKey": "sk-deep", "keep": null, "list": [1, "two", {"uploadApiKey": "sk-list", "ok": false}]}}
	}`)

	cleaned, err := stripModelConfigSecrets(raw)
	if err != nil {
		t.Fatalf("stripModelConfigSecrets returned error: %v", err)
	}
	var got, want any
	if err := json.Unmarshal(cleaned, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{
		"defaultImageModel": "gpt-image-2",
		"syncStorageConfig": true,
		"maxTokens": 12345678901234567890,
		"workflowChannels": [{"id": "w1", "name": "工作流", "models": ["a", "b"]}],
		"nested": {"deeper": {"keep": null, "list": [1, "two", {"ok": false}]}}
	}`), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cleaned = %s", cleaned)
	}
	if !strings.Contains(string(cleaned), "12345678901234567890") {
		t.Fatalf("large number lost precision: %s", cleaned)
	}
	if strings.Contains(string(cleaned), "sk-") {
		t.Fatalf("secret left in cleaned config: %s", cleaned)
	}
}

func TestStripModelConfigSecretsRejectsInvalidJSON(t *testing.T) {
	if _, err := stripModelConfigSecrets(json.RawMessage(`{"apiKey":`)); err == nil {
		t.Fatal("expected invalid JSON error")
	}
}
