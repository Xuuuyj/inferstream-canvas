package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// useMemoryDB 让本包测试共用一个内存 SQLite（repository.DB 全进程只初始化一次）。
func useMemoryDB(t *testing.T) {
	t.Helper()
	previous := config.Cfg
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:"}
	t.Cleanup(func() { config.Cfg = previous })
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
}

func quotaUser(id string) context.Context {
	return WithUser(context.Background(), model.AuthUser{ID: id, Role: model.UserRoleUser})
}

func canvasProjectJSON(id string, padding int) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"id":%q,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z","pad":%q}`, id, strings.Repeat("x", padding)))
}

func TestCanvasProjectQuota(t *testing.T) {
	useMemoryDB(t)
	previousCount, previousBytes := canvasProjectMaxCount, canvasProjectMaxBytes
	canvasProjectMaxCount, canvasProjectMaxBytes = 2, 600
	t.Cleanup(func() { canvasProjectMaxCount, canvasProjectMaxBytes = previousCount, previousBytes })
	ctx := quotaUser("quota-canvas")

	for _, id := range []string{"p1", "p2"} {
		if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectJSON(id, 100)); err != nil {
			t.Fatalf("保存 %s：%v", id, err)
		}
	}
	_, err := SaveCurrentUserCanvasProject(ctx, canvasProjectJSON("p3", 10))
	if err == nil || !strings.Contains(err.Error(), "最多保存 2 个画布项目") {
		t.Fatalf("第 3 个项目应因个数上限被拒，实际 %v", err)
	}
	if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectJSON("p1", 150)); err != nil {
		t.Fatalf("覆盖已有项目不应算新项目：%v", err)
	}
	_, err = SaveCurrentUserCanvasProject(ctx, canvasProjectJSON("p2", 500))
	if err == nil || !strings.Contains(err.Error(), "合计不能超过") {
		t.Fatalf("项目数据合计超过上限应被拒，实际 %v", err)
	}
	_, err = SyncCurrentUserCanvasProjects(ctx, []json.RawMessage{canvasProjectJSON("p1", 120), canvasProjectJSON("p4", 10)})
	if err == nil || !strings.Contains(err.Error(), "最多保存 2 个画布项目") {
		t.Fatalf("同步时也要检查个数上限，实际 %v", err)
	}
	if _, err := SaveCurrentUserCanvasProject(quotaUser("quota-canvas-other"), canvasProjectJSON("p3", 10)); err != nil {
		t.Fatalf("配额按用户分开算：%v", err)
	}
}

func TestGenerationDataQuota(t *testing.T) {
	useMemoryDB(t)
	previous := userGenerationDataMaxBytes
	userGenerationDataMaxBytes = 400
	t.Cleanup(func() { userGenerationDataMaxBytes = previous })
	ctx := quotaUser("quota-generation")
	imageLog := func(id string, padding int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"id":%q,"status":"success","pad":%q}`, id, strings.Repeat("x", padding)))
	}

	if _, err := SaveCurrentUserAssetData(ctx, json.RawMessage(fmt.Sprintf(`{"assets":[%q]}`, strings.Repeat("a", 150)))); err != nil {
		t.Fatalf("素材数据：%v", err)
	}
	if _, err := SaveCurrentUserImageGenerationLogs(ctx, []json.RawMessage{imageLog("img-1", 100)}); err != nil {
		t.Fatalf("图片记录：%v", err)
	}
	if _, err := SaveCurrentUserImageGenerationLogs(ctx, []json.RawMessage{imageLog("img-1", 120)}); err != nil {
		t.Fatalf("覆盖同 id 的记录不应重复计算：%v", err)
	}
	_, err := SaveCurrentUserVideoGenerationLogs(ctx, []json.RawMessage{imageLog("video-1", 150)})
	if err == nil || !strings.Contains(err.Error(), "生成记录、工作流和素材数据合计不能超过") {
		t.Fatalf("视频记录让合计超限应被拒，实际 %v", err)
	}
	_, err = SaveCurrentUserAssetData(ctx, json.RawMessage(fmt.Sprintf(`{"assets":[%q]}`, strings.Repeat("a", 300))))
	if err == nil || !strings.Contains(err.Error(), "生成记录、工作流和素材数据合计不能超过") {
		t.Fatalf("素材数据让合计超限应被拒，实际 %v", err)
	}
	if _, err := SaveCurrentUserAssetData(ctx, json.RawMessage(`{"assets":[]}`)); err != nil {
		t.Fatalf("缩小素材数据应允许：%v", err)
	}
	if _, err := SaveCurrentUserVideoGenerationLogs(ctx, []json.RawMessage{imageLog("video-1", 150)}); err != nil {
		t.Fatalf("腾出空间后应允许：%v", err)
	}
}

func TestCreativeWorkflowQuota(t *testing.T) {
	useMemoryDB(t)
	previousCount, previousBytes, previousTotal := creativeWorkflowMaxCount, creativeWorkflowMaxBytes, userGenerationDataMaxBytes
	creativeWorkflowMaxCount, creativeWorkflowMaxBytes, userGenerationDataMaxBytes = 2, 100, 230
	t.Cleanup(func() {
		creativeWorkflowMaxCount, creativeWorkflowMaxBytes, userGenerationDataMaxBytes = previousCount, previousBytes, previousTotal
	})
	ctx := quotaUser("quota-workflow")
	// 数据是 {"pad":"xx…"}，字节数 = 10 + padding。
	workflow := func(id string, padding int) CreativeWorkflowPayload {
		return CreativeWorkflowPayload{ID: id, Name: "工作流", Data: json.RawMessage(fmt.Sprintf(`{"pad":%q}`, strings.Repeat("x", padding)))}
	}
	// 素材数据是 {"assets":["aa…"]}，字节数 = 15 + padding。
	assets := func(padding int) json.RawMessage {
		return json.RawMessage(fmt.Sprintf(`{"assets":[%q]}`, strings.Repeat("a", padding)))
	}

	for _, id := range []string{"wf-1", "wf-2"} {
		if _, err := SaveCreativeWorkflow(ctx, workflow(id, 50)); err != nil {
			t.Fatalf("保存 %s：%v", id, err)
		}
	}
	if _, err := SaveCreativeWorkflow(ctx, workflow("", 10)); err == nil || !strings.Contains(err.Error(), "最多保存 2 个工作流") {
		t.Fatalf("第 3 个工作流应因个数上限被拒，实际 %v", err)
	}
	if _, err := SaveCreativeWorkflow(ctx, workflow("wf-1", 80)); err != nil {
		t.Fatalf("覆盖已有工作流不应算新工作流：%v", err)
	}
	if _, err := SaveCreativeWorkflow(ctx, workflow("wf-2", 100)); err == nil || !strings.Contains(err.Error(), "单个工作流数据不能超过") {
		t.Fatalf("单个工作流超过大小上限应被拒，实际 %v", err)
	}
	// 工作流数据算进用户数据合计：现在工作流 90+60=150 字节。
	if _, err := SaveCurrentUserAssetData(ctx, assets(100)); err == nil || !strings.Contains(err.Error(), "生成记录、工作流和素材数据合计不能超过") {
		t.Fatalf("工作流 150 + 素材 115 超过 230 应被拒，实际 %v", err)
	}
	if _, err := SaveCurrentUserAssetData(ctx, assets(50)); err != nil {
		t.Fatalf("工作流 150 + 素材 65 没超：%v", err)
	}
	if _, err := SaveCreativeWorkflow(ctx, workflow("wf-2", 80)); err == nil || !strings.Contains(err.Error(), "生成记录、工作流和素材数据合计不能超过") {
		t.Fatalf("工作流 90+90 + 素材 65 超过 230 应被拒，实际 %v", err)
	}
	if _, err := SaveCreativeWorkflow(quotaUser("quota-workflow-other"), workflow("", 50)); err != nil {
		t.Fatalf("配额按用户分开算：%v", err)
	}
}

func TestUserAgentSkillQuota(t *testing.T) {
	useMemoryDB(t)
	previous := userAgentSkillMaxCount
	userAgentSkillMaxCount = 2
	t.Cleanup(func() { userAgentSkillMaxCount = previous })
	ctx := quotaUser("quota-skill")
	skill := func(id string) model.AgentSkill {
		return model.AgentSkill{ID: id, Name: "Skill", Content: "内容"}
	}

	var ids []string
	for i := 0; i < 2; i++ {
		saved, err := SaveCurrentUserAgentSkill(ctx, skill(""))
		if err != nil {
			t.Fatalf("保存第 %d 个 Skill：%v", i+1, err)
		}
		ids = append(ids, saved.ID)
	}
	if _, err := SaveCurrentUserAgentSkill(ctx, skill("")); err == nil || !strings.Contains(err.Error(), "最多保存 2 个 Skill") {
		t.Fatalf("第 3 个 Skill 应因个数上限被拒，实际 %v", err)
	}
	if _, err := SaveCurrentUserAgentSkill(ctx, skill(ids[0])); err != nil {
		t.Fatalf("修改已有 Skill 不应算新 Skill：%v", err)
	}
	if _, err := SaveCurrentUserAgentSkill(quotaUser("quota-skill-other"), skill("")); err != nil {
		t.Fatalf("配额按用户分开算：%v", err)
	}
	if _, err := SaveSystemAgentSkill(skill("")); err != nil {
		t.Fatalf("系统 Skill 不占用户名额：%v", err)
	}

	item := skill(ids[1])
	item.Description = strings.Repeat("字", 2001)
	if _, err := SaveCurrentUserAgentSkill(ctx, item); err == nil || !strings.Contains(err.Error(), "简介不能超过 2000 字") {
		t.Fatalf("简介超过 2000 字应被拒，实际 %v", err)
	}
	item.Description = strings.Repeat("字", 2000)
	prefix := "https://cdn.example/"
	item.CoverURL = prefix + strings.Repeat("a", 2049-len(prefix))
	if _, err := SaveCurrentUserAgentSkill(ctx, item); err == nil || !strings.Contains(err.Error(), "封面链接不能超过 2048") {
		t.Fatalf("封面链接超过 2048 字符应被拒，实际 %v", err)
	}
	item.CoverURL = prefix + strings.Repeat("a", 2048-len(prefix))
	if _, err := SaveCurrentUserAgentSkill(ctx, item); err != nil {
		t.Fatalf("简介 2000 字、封面链接 2048 字符正好在上限内：%v", err)
	}
}

// 同一用户并发写入时，「查配额 + 写入」要一个一个来，合起来也不能超过上限。
func TestUserQuotaChecksAreSerializedPerUser(t *testing.T) {
	useMemoryDB(t)
	previousProjects, previousWorkflows, previousSkills := canvasProjectMaxCount, creativeWorkflowMaxCount, userAgentSkillMaxCount
	canvasProjectMaxCount, creativeWorkflowMaxCount, userAgentSkillMaxCount = 3, 3, 3
	t.Cleanup(func() {
		canvasProjectMaxCount, creativeWorkflowMaxCount, userAgentSkillMaxCount = previousProjects, previousWorkflows, previousSkills
	})
	ctx := quotaUser("quota-concurrent")
	var projects, workflows, skills atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			if _, err := SaveCurrentUserCanvasProject(ctx, canvasProjectJSON(fmt.Sprintf("cp-%d", i), 10)); err == nil {
				projects.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := SaveCreativeWorkflow(ctx, CreativeWorkflowPayload{ID: fmt.Sprintf("cw-%d", i), Name: "工作流"}); err == nil {
				workflows.Add(1)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := SaveCurrentUserAgentSkill(ctx, model.AgentSkill{Name: "Skill", Content: "内容"}); err == nil {
				skills.Add(1)
			}
		}()
	}
	wg.Wait()
	if projects.Load() != 3 || workflows.Load() != 3 || skills.Load() != 3 {
		t.Fatalf("并发写入后保存成功的个数：画布 %d、工作流 %d、Skill %d，期望都是 3", projects.Load(), workflows.Load(), skills.Load())
	}
	userQuotaMu.Lock()
	defer userQuotaMu.Unlock()
	if len(userQuotaLocks) != 0 {
		t.Fatalf("写完后用户锁没有清理：%d 个", len(userQuotaLocks))
	}
}
