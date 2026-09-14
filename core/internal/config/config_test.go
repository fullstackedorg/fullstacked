package config

import (
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"testing"
)

func TestConfig(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "fullstacked-config-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	ctx := &types.Context{
		Directories: types.ContextDirectories{
			Root: tempDir,
		},
	}

	header := types.CoreCallHeader{}
	resp := &types.CoreCallResponse{}

	// 1. Initial list should be empty
	header.Fn = List
	err = Switch(ctx, header, nil, resp)
	if err != nil {
		t.Fatal(err)
	}
	listMap, ok := resp.Data.(map[string]string)
	if !ok || len(listMap) != 0 {
		t.Fatalf("expected empty map, got %v", resp.Data)
	}

	// 2. Get non-existent key returns nil
	header.Fn = Get
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "nonexistent", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data != nil {
		t.Fatalf("expected nil, got %v", resp.Data)
	}

	// 3. Reject non-string values
	header.Fn = Set
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "numKey", Type: types.STRING},
		{Data: float64(123), Type: types.NUMBER},
	}, resp)
	if err == nil {
		t.Fatal("expected error when setting non-string value, got nil")
	}

	// 4. Set a key with string value
	header.Fn = Set
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "myKey", Type: types.STRING},
		{Data: "myValue", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}

	// Verify file was written to path.Join(Root, ".git/config.json")
	expectedPath := filepath.Join(tempDir, ".git", "config.json")
	content, err := os.ReadFile(expectedPath)
	if err != nil {
		t.Fatalf("failed to read %s: %v", expectedPath, err)
	}
	var savedJSON map[string]string
	if err := json.Unmarshal(content, &savedJSON); err != nil {
		t.Fatalf("failed to parse json: %v", err)
	}
	if savedJSON["myKey"] != "myValue" {
		t.Fatalf("expected myValue, got %v", savedJSON["myKey"])
	}

	// 5. Get the key
	header.Fn = Get
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "myKey", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data != "myValue" {
		t.Fatalf("expected myValue, got %v", resp.Data)
	}

	// 6. Set another key
	header.Fn = Set
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "secondKey", Type: types.STRING},
		{Data: "secondValue", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}

	// 7. List all keys
	header.Fn = List
	err = Switch(ctx, header, nil, resp)
	if err != nil {
		t.Fatal(err)
	}
	listMap = resp.Data.(map[string]string)
	if len(listMap) != 2 || listMap["myKey"] != "myValue" || listMap["secondKey"] != "secondValue" {
		t.Fatalf("unexpected list map: %v", listMap)
	}

	// 8. Delete key
	header.Fn = Delete
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "myKey", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}

	// Verify myKey is deleted
	header.Fn = Get
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "myKey", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data != nil {
		t.Fatalf("expected nil after delete, got %v", resp.Data)
	}

	// Verify secondKey still exists
	header.Fn = Get
	err = Switch(ctx, header, []types.DeserializedData{
		{Data: "secondKey", Type: types.STRING},
	}, resp)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Data != "secondValue" {
		t.Fatalf("expected secondValue, got %v", resp.Data)
	}
}
