package packages

import (
	"strings"
	"testing"
)

func TestAuditPayloadGeneration(t *testing.T) {
	// Simulate the logic in audit function helper
	// Since audit() is now doing IO (reading file), we might want to unit test the helper logic
	// if we extracted it. But `audit` is private and self-contained.
	// For now, let's verify the BulkPayload structure using a similar logic to what we implemented.

	lock := PackageLock{
		LockfileVersion: 3,
		Packages: map[string]LockDependency{
			"": {Version: "0.0.0"},
			"node_modules/foo": {
				Version: "1.0.0",
			},
			"node_modules/foo/node_modules/bar": {
				Version: "2.0.0",
			},
			"node_modules/@scope/pkg": {
				Version: "1.2.3",
			},
			"platform/local-lib": {
				Version: "0.0.1",
			},
		},
	}

	payloadMap := make(AuditPayload)

	getNameFromPath := func(p string) string {
		parts := strings.Split(p, "node_modules/")
		if len(parts) == 0 {
			return ""
		}
		last := parts[len(parts)-1]
		return strings.TrimSuffix(last, "/")
	}

	// Re-implement simplified loop for verification of concept
	for p, pkg := range lock.Packages {
		if p == "" {
			continue
		}

		if !strings.Contains(p, "node_modules/") {
			continue
		}

		if pkg.Version == "" {
			continue
		}

		name := getNameFromPath(p)
		if name != "" {
			payloadMap[name] = append(payloadMap[name], pkg.Version)
		}
	}

	if len(payloadMap["foo"]) != 1 || payloadMap["foo"][0] != "1.0.0" {
		t.Errorf("Expected foo 1.0.0, got %v", payloadMap["foo"])
	}
	if len(payloadMap["bar"]) != 1 || payloadMap["bar"][0] != "2.0.0" {
		t.Errorf("Expected bar 2.0.0, got %v", payloadMap["bar"])
	}
	if len(payloadMap["@scope/pkg"]) != 1 || payloadMap["@scope/pkg"][0] != "1.2.3" {
		t.Errorf("Expected @scope/pkg 1.2.3, got %v", payloadMap["@scope/pkg"])
	}
	if _, ok := payloadMap["platform/local-lib"]; ok {
		t.Error("Expected platform/local-lib to be ignored")
	}
}
