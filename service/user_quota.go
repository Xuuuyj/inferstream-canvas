package service

import (
	"fmt"
	"sync"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// 每个用户能存在服务端的数据上限。写成变量是为了测试。
var (
	canvasProjectMaxCount            = 200
	canvasProjectMaxBytes      int64 = 512 << 20
	userGenerationDataMaxBytes int64 = 256 << 20
	creativeWorkflowMaxCount         = 200
	creativeWorkflowMaxBytes   int64 = 1 << 20
	userAgentSkillMaxCount           = 200
)

// 同一个用户的「查配额 + 写入」要一个一个来，免得几个并发请求各自查到没超、合起来却超了。
// 只在本进程内有效（画布后端只跑一个进程）。users 是正在用或在等这把锁的请求数，归零就从表里删掉。
var (
	userQuotaMu    sync.Mutex
	userQuotaLocks = map[string]*userQuotaLock{}
)

type userQuotaLock struct {
	sync.Mutex
	users int
}

// lockUserQuota 锁住这个用户的配额检查和写入，返回解锁函数。不可重入，一次写入只加一次锁。
func lockUserQuota(userID string) func() {
	userQuotaMu.Lock()
	lock := userQuotaLocks[userID]
	if lock == nil {
		lock = &userQuotaLock{}
		userQuotaLocks[userID] = lock
	}
	lock.users++
	userQuotaMu.Unlock()
	lock.Lock()
	return func() {
		lock.Unlock()
		userQuotaMu.Lock()
		if lock.users--; lock.users == 0 {
			delete(userQuotaLocks, userID)
		}
		userQuotaMu.Unlock()
	}
}

// checkCanvasProjectQuota 检查保存这个画布项目后，用户的项目数不超过 200 个、项目数据合计不超过 512MB。
// 同 id 的旧项目会被覆盖，不重复计算。
func checkCanvasProjectQuota(project model.CanvasProject) error {
	count, size, err := repository.UserCanvasProjectUsage(project.UserID, project.ID)
	if err != nil {
		return err
	}
	if count+1 > int64(canvasProjectMaxCount) {
		return safeMessageError{message: fmt.Sprintf("每个账号最多保存 %d 个画布项目，请先删除不用的项目", canvasProjectMaxCount)}
	}
	if size+int64(len(project.ProjectData)) > canvasProjectMaxBytes {
		return safeMessageError{message: fmt.Sprintf("画布项目数据合计不能超过 %dMB，请先删除不用的项目", canvasProjectMaxBytes>>20)}
	}
	return nil
}

// checkCreativeWorkflowQuota 检查保存这个工作流后：单个数据不超过 1MB、用户的工作流不超过 200 个，
// 并且工作流数据算进用户数据合计。同 id 的旧工作流会被覆盖，不重复计算。
func checkCreativeWorkflowQuota(workflow model.CreativeWorkflow) error {
	size := int64(len(workflow.Data))
	if size > creativeWorkflowMaxBytes {
		return safeMessageError{message: fmt.Sprintf("单个工作流数据不能超过 %dMB", creativeWorkflowMaxBytes>>20)}
	}
	count, _, err := repository.UserCreativeWorkflowUsage(workflow.OwnerUserID, workflow.ID)
	if err != nil {
		return err
	}
	if count+1 > int64(creativeWorkflowMaxCount) {
		return safeMessageError{message: fmt.Sprintf("每个账号最多保存 %d 个工作流，请先删除不用的工作流", creativeWorkflowMaxCount)}
	}
	return checkUserDataQuota(workflow.OwnerUserID, nil, size, userDataExcept{workflowID: workflow.ID})
}

// checkUserAgentSkillQuota 检查新建一个 Skill 后，用户的 Skill 不超过 200 个。
func checkUserAgentSkillQuota(userID string) error {
	count, err := repository.UserAgentSkillCount(userID)
	if err != nil {
		return err
	}
	if count+1 > int64(userAgentSkillMaxCount) {
		return safeMessageError{message: fmt.Sprintf("每个账号最多保存 %d 个 Skill，请先删除不用的 Skill", userAgentSkillMaxCount)}
	}
	return nil
}

// userDataExcept 是这次写入要覆盖的旧数据，统计时不重复计算。
type userDataExcept struct {
	imageLogIDs []string
	videoLogIDs []string
	workflowID  string
}

// checkUserDataQuota 检查写入后用户的生成记录（图片+视频）、工作流、素材数据和旧版图片历史合计不超过 256MB。
// config 是写入后的用户配置，传 nil 就按库里现有的算；newBytes 是这次要写的生成记录或工作流的字节数。
func checkUserDataQuota(userID string, config *model.UserConfig, newBytes int64, except userDataExcept) error {
	if config == nil {
		saved, _, err := repository.GetUserConfig(userID)
		if err != nil {
			return err
		}
		config = &saved
	}
	logBytes, err := repository.UserGenerationLogBytes(userID, except.imageLogIDs, except.videoLogIDs)
	if err != nil {
		return err
	}
	_, workflowBytes, err := repository.UserCreativeWorkflowUsage(userID, except.workflowID)
	if err != nil {
		return err
	}
	if logBytes+workflowBytes+newBytes+int64(len(config.AssetData))+int64(len(config.ImageHistory)) > userGenerationDataMaxBytes {
		return safeMessageError{message: fmt.Sprintf("生成记录、工作流和素材数据合计不能超过 %dMB，请先删除不用的记录、工作流或素材", userGenerationDataMaxBytes>>20)}
	}
	return nil
}
