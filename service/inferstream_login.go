package service

import (
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func LoginWithInferStream(code, verifier, state string) (model.AuthSession, error) {
	if len(config.Cfg.InferStreamSSOSecret) < 32 {
		return model.AuthSession{}, safeMessageError{message: "InferStream 登录未开启"}
	}
	if !fitConnectCodePattern.MatchString(code) || !fitConnectCodePattern.MatchString(verifier) || !fitConnectCodePattern.MatchString(state) {
		return model.AuthSession{}, safeMessageError{message: "登录请求无效"}
	}
	identity, err := exchangeCanvasCode("https://www.inferstream.cn", config.Cfg.InferStreamSSOSecret, code, verifier, state)
	if err != nil {
		return model.AuthSession{}, safeMessageError{message: "InferStream 授权失败，请重新登录"}
	}
	return loginWithLinkedIdentity(identity, repository.GetUserByInferStreamUserID, func(identity fitIdentity) (model.User, error) {
		return createLinkedUser(identity, repository.GetUserByInferStreamUserID, func(user *model.User, id int) {
			user.InferStreamUserID = &id
		})
	})
}
