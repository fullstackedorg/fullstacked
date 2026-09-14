package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestInitialDirectoryRecursion(t *testing.T) {
	tempBase, err := os.MkdirTemp("", "fullstacked-store-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempBase)

	dirA := filepath.Join(tempBase, "dirA")
	dirB := filepath.Join(tempBase, "dirB")
	dirC := filepath.Join(tempBase, "dirC")

	if err := os.MkdirAll(filepath.Join(dirA, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dirB, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dirC, ".git"), 0755); err != nil {
		t.Fatal(err)
	}

	// dirA points to dirB (relative path)
	cfgA, _ := json.Marshal(map[string]string{"initialDirectory": "../dirB"})
	if err := os.WriteFile(filepath.Join(dirA, ".git", "config.json"), cfgA, 0644); err != nil {
		t.Fatal(err)
	}

	// dirB points to dirC (absolute path)
	cfgB, _ := json.Marshal(map[string]string{"initialDirectory": dirC})
	if err := os.WriteFile(filepath.Join(dirB, ".git", "config.json"), cfgB, 0644); err != nil {
		t.Fatal(err)
	}

	// dirC has no initialDirectory
	cfgC, _ := json.Marshal(map[string]string{"foo": "bar"})
	if err := os.WriteFile(filepath.Join(dirC, ".git", "config.json"), cfgC, 0644); err != nil {
		t.Fatal(err)
	}

	initialContextCount := len(Contexts)
	idA := NewContext(dirA, dirA)

	if _, ok := Contexts[idA]; !ok {
		t.Fatalf("expected context for dirA (id %d)", idA)
	}

	// Check that dirB and dirC contexts were also created recursively
	foundB := false
	foundC := false
	for _, ctx := range Contexts {
		if filepath.Clean(ctx.Directories.Root) == filepath.Clean(dirB) {
			foundB = true
		}
		if filepath.Clean(ctx.Directories.Root) == filepath.Clean(dirC) {
			foundC = true
		}
	}

	if !foundB {
		t.Fatalf("expected context for dirB to be created recursively, all contexts: %v", Contexts)
	}
	if !foundC {
		t.Fatalf("expected context for dirC to be created recursively, all contexts: %v", Contexts)
	}

	// Clean up created contexts
	for id, ctx := range Contexts {
		if id >= idA {
			_ = ctx
			EndContext(id)
		}
	}
	_ = initialContextCount
}
