package config

import (
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"testing"
)

func TestConfigModule(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "fs-config-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	ctx := &types.Context{
		Directories: types.ContextDirectories{
			Root: tmpDir,
		},
	}

	// 1. Get non-existent key
	var resp types.CoreCallResponse
	err = Switch(ctx, types.CoreCallHeader{Fn: Get}, []types.DeserializedData{
		{Data: "initialDirectory", Type: types.STRING},
	}, &resp)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Data != nil {
		t.Errorf("expected nil for non-existent key, got %v", resp.Data)
	}

	// 2. Set key
	err = Switch(ctx, types.CoreCallHeader{Fn: Set}, []types.DeserializedData{
		{Data: "initialDirectory", Type: types.STRING},
		{Data: "/custom/path", Type: types.STRING},
	}, &resp)
	if err != nil {
		t.Fatalf("unexpected error on Set: %v", err)
	}

	// Verify file was written to /.git/config.json
	cfgFile := filepath.Join(tmpDir, ".git", "config.json")
	if _, err := os.Stat(cfgFile); os.IsNotExist(err) {
		t.Fatalf("config file was not created at %s", cfgFile)
	}

	// 3. Get key
	err = Switch(ctx, types.CoreCallHeader{Fn: Get}, []types.DeserializedData{
		{Data: "initialDirectory", Type: types.STRING},
	}, &resp)
	if err != nil {
		t.Fatalf("unexpected error on Get: %v", err)
	}
	if resp.Data != "/custom/path" {
		t.Errorf("expected %q, got %v", "/custom/path", resp.Data)
	}

	// 4. Load all
	err = Switch(ctx, types.CoreCallHeader{Fn: Load}, nil, &resp)
	if err != nil {
		t.Fatalf("unexpected error on Load: %v", err)
	}
	all, ok := resp.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected map[string]any, got %T", resp.Data)
	}
	if all["initialDirectory"] != "/custom/path" {
		t.Errorf("expected initialDirectory in load, got %v", all["initialDirectory"])
	}

	// 5. Delete key
	err = Switch(ctx, types.CoreCallHeader{Fn: Delete}, []types.DeserializedData{
		{Data: "initialDirectory", Type: types.STRING},
	}, &resp)
	if err != nil {
		t.Fatalf("unexpected error on Delete: %v", err)
	}

	// 6. Get deleted key
	err = Switch(ctx, types.CoreCallHeader{Fn: Get}, []types.DeserializedData{
		{Data: "initialDirectory", Type: types.STRING},
	}, &resp)
	if err != nil {
		t.Fatalf("unexpected error on Get: %v", err)
	}
	if resp.Data != nil {
		t.Errorf("expected nil after delete, got %v", resp.Data)
	}
}
