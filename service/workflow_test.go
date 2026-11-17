package service

import (
	"context"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestSaveCreativeWorkflowOnlyAdminPublishesPublic(t *testing.T) {
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

	cases := []struct {
		role model.UserRole
		want string
	}{
		{model.UserRoleUser, "private"},
		{model.UserRoleAdmin, "public"},
	}
	for _, item := range cases {
		ctx := WithUser(context.Background(), model.AuthUser{ID: "workflow-" + string(item.role), Role: item.role})
		saved, err := SaveCreativeWorkflow(ctx, CreativeWorkflowPayload{Scope: "public", Name: "工作流"})
		if err != nil {
			t.Fatal(err)
		}
		record, found, err := repository.GetCreativeWorkflow(saved.ID)
		if err != nil || !found || record.Scope != item.want {
			t.Fatalf("%s 提交 public，存下来是 %q，期望 %q（%v）", item.role, record.Scope, item.want, err)
		}
	}
}
