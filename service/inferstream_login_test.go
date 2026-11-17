package service

import (
    "testing"

    "github.com/tigerowo/infinite-canvas/config"
    "github.com/tigerowo/infinite-canvas/model"
    "github.com/tigerowo/infinite-canvas/repository"
)

func TestInferStreamIdentityDoesNotReuseFitAccount(t *testing.T) {
    useMemoryDB(t)
    config.Cfg.JWTSecret = testFitSecret
    identity := fitIdentity{UserID: 42, Username: "same-name"}
    previous, err := createFitUser(identity)
    if err != nil {
        t.Fatal(err)
    }
    logIn := func() (model.AuthSession, error) {
        return loginWithLinkedIdentity(identity, repository.GetUserByInferStreamUserID, func(identity fitIdentity) (model.User, error) {
            return createLinkedUser(identity, repository.GetUserByInferStreamUserID, func(user *model.User, id int) {
                user.InferStreamUserID = &id
            })
        })
    }
    first, err := logIn()
    if err != nil {
        t.Fatal(err)
    }
    if first.User.ID == previous.ID || first.User.FitUserID != nil {
        t.Fatal("InferStream identity reused an openai.fit account")
    }
    second, err := logIn()
    if err != nil || second.User.ID != first.User.ID {
        t.Fatalf("next sign-in did not reuse the InferStream account: %v", err)
    }
}
