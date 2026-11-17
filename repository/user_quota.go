package repository

import (
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

// UserCanvasProjectUsage 统计用户未删除的画布项目个数和 project_data 总字节数；exceptID 那一项不计（马上要被覆盖）。
func UserCanvasProjectUsage(userID string, exceptID string) (int64, int64, error) {
	db, err := DB()
	if err != nil {
		return 0, 0, err
	}
	var usage struct {
		ProjectCount int64
		ProjectBytes int64
	}
	err = db.Model(&model.CanvasProject{}).
		Select("COUNT(*) AS project_count, COALESCE(SUM(OCTET_LENGTH(project_data)), 0) AS project_bytes").
		Where("user_id = ? AND deleted_at = '' AND id <> ?", strings.TrimSpace(userID), strings.TrimSpace(exceptID)).
		Scan(&usage).Error
	return usage.ProjectCount, usage.ProjectBytes, err
}

// UserGenerationLogBytes 统计用户未删除的图片和视频生成记录的总字节数；except 里的 id 不计（马上要被覆盖）。
func UserGenerationLogBytes(userID string, exceptImageIDs []string, exceptVideoIDs []string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var total int64
	for _, item := range []struct {
		model  any
		except []string
	}{
		{&model.ImageGenerationLog{}, exceptImageIDs},
		{&model.VideoGenerationLog{}, exceptVideoIDs},
	} {
		query := db.Model(item.model).Where("user_id = ? AND deleted_at = ''", userID)
		if except := uniqueTrimmedValues(item.except...); len(except) > 0 {
			query = query.Where("id NOT IN ?", except)
		}
		var size int64
		if err := query.Select("COALESCE(SUM(OCTET_LENGTH(payload_json)), 0)").Scan(&size).Error; err != nil {
			return 0, err
		}
		total += size
	}
	return total, nil
}

// UserCreativeWorkflowUsage 统计用户自己的工作流个数和 data 总字节数；exceptID 那一项不计（马上要被覆盖）。
func UserCreativeWorkflowUsage(userID string, exceptID string) (int64, int64, error) {
	db, err := DB()
	if err != nil {
		return 0, 0, err
	}
	var usage struct {
		WorkflowCount int64
		WorkflowBytes int64
	}
	err = db.Model(&model.CreativeWorkflow{}).
		Select("COUNT(*) AS workflow_count, COALESCE(SUM(OCTET_LENGTH(data)), 0) AS workflow_bytes").
		Where("owner_user_id = ? AND id <> ?", userID, exceptID).
		Scan(&usage).Error
	return usage.WorkflowCount, usage.WorkflowBytes, err
}

// UserAgentSkillCount 统计用户自己的 Skill 个数。
func UserAgentSkillCount(userID string) (int64, error) {
	db, err := DB()
	if err != nil {
		return 0, err
	}
	var count int64
	err = db.Model(&model.AgentSkill{}).Where("source = ? AND owner_user_id = ?", model.AgentSkillSourceUser, userID).Count(&count).Error
	return count, err
}
