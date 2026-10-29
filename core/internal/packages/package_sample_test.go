package packages

import (
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestPackageSampleExactLockfileMatch(t *testing.T) {
	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = "https://registry.npmjs.org/"
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	// 1. Prepare temp directory for npm install --package-lock-only reference
	sampleBytes, err := os.ReadFile("test/package-sample.json")
	if err != nil {
		t.Fatalf("Failed to read test/package-sample.json: %v", err)
	}

	npmDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(npmDir, "package.json"), sampleBytes, 0644); err != nil {
		t.Fatalf("Failed to write npm package.json: %v", err)
	}

	npmStart := time.Now()
	npmCmd := exec.Command("npm", "install", "--package-lock-only")
	npmCmd.Dir = npmDir
	if out, err := npmCmd.CombinedOutput(); err != nil {
		t.Fatalf("npm install --package-lock-only failed: %v\nOutput: %s", err, string(out))
	}
	npmDuration := time.Since(npmStart)
	t.Logf("npm install --package-lock-only took: %v", npmDuration)

	npmLockBytes, err := os.ReadFile(filepath.Join(npmDir, "package-lock.json"))
	if err != nil {
		t.Fatalf("Failed to read npm package-lock.json: %v", err)
	}

	var npmLock map[string]interface{}
	if err := json.Unmarshal(npmLockBytes, &npmLock); err != nil {
		t.Fatalf("Failed to unmarshal npm package-lock.json: %v", err)
	}
	npmPackages, ok := npmLock["packages"].(map[string]interface{})
	if !ok {
		t.Fatalf("npm package-lock.json missing 'packages' map")
	}

	// 2. Run FullStacked install on sample (cold cache test - zero pre-existing cache)
	fsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(fsDir, "package.json"), sampleBytes, 0644); err != nil {
		t.Fatalf("Failed to write FullStacked package.json: %v", err)
	}

	packageMetaCache = sync.Map{} // Ensure zero caching (cold start)

	fsStart := time.Now()
	ctx := &types.Context{}
	install(ctx, fsDir, nil, false, 20, true, func(p Progress) {
		if p.Stage == "Error" {
			t.Logf("Install error: %s (%s)", p.Error, p.Name)
		}
	})
	fsDuration := time.Since(fsStart)
	t.Logf("FullStacked install took: %v", fsDuration)

	if fsDuration > 30*time.Second {
		t.Errorf("Performance failure: FullStacked install took %v, must be < 30s", fsDuration)
	}

	// Verify packages were extracted to disk in node_modules
	if _, err := os.Stat(filepath.Join(fsDir, "node_modules", "react", "package.json")); err != nil {
		t.Errorf("Expected node_modules/react/package.json on disk: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fsDir, "node_modules", "drizzle-orm", "package.json")); err != nil {
		t.Errorf("Expected node_modules/drizzle-orm/package.json on disk: %v", err)
	}

	fsLockBytes, err := os.ReadFile(filepath.Join(fsDir, "package-lock.json"))
	if err != nil {
		t.Fatalf("Failed to read FullStacked package-lock.json: %v", err)
	}

	var fsLock map[string]interface{}
	if err := json.Unmarshal(fsLockBytes, &fsLock); err != nil {
		t.Fatalf("Failed to unmarshal FullStacked package-lock.json: %v", err)
	}
	fsPackages, ok := fsLock["packages"].(map[string]interface{})
	if !ok {
		t.Fatalf("FullStacked package-lock.json missing 'packages' map")
	}

	// 3. Verify total package count
	if len(fsPackages) != len(npmPackages) {
		t.Errorf("Package count mismatch: FullStacked=%d, npm=%d", len(fsPackages), len(npmPackages))
	}

	// 4. Detailed field-by-field comparison
	diffCount := 0
	for k, npmVal := range npmPackages {
		fsVal, ok := fsPackages[k]
		if !ok {
			t.Errorf("Missing package in FullStacked: %s", k)
			diffCount++
			continue
		}

		fsPkgBytes, _ := json.Marshal(fsVal)
		var fsMap map[string]interface{}
		json.Unmarshal(fsPkgBytes, &fsMap)

		npmPkgBytes, _ := json.Marshal(npmVal)
		var npmMap map[string]interface{}
		json.Unmarshal(npmPkgBytes, &npmMap)

		for field, nVal := range npmMap {
			gVal, hasField := fsMap[field]
			if !hasField {
				t.Errorf("[%s] Missing field %s in FullStacked (expected: %v)", k, field, nVal)
				diffCount++
			} else {
				nStr, _ := json.Marshal(nVal)
				gStr, _ := json.Marshal(gVal)
				if string(nStr) != string(gStr) {
					t.Errorf("[%s] Field %s mismatch: FullStacked=%s, npm=%s", k, field, string(gStr), string(nStr))
					diffCount++
				}
			}
		}

		for field, gVal := range fsMap {
			if _, hasField := npmMap[field]; !hasField {
				t.Errorf("[%s] Extra field %s in FullStacked: %v", k, field, gVal)
				diffCount++
			}
		}
	}

	for k := range fsPackages {
		if _, ok := npmPackages[k]; !ok {
			t.Errorf("Extra package in FullStacked: %s", k)
			diffCount++
		}
	}

	if diffCount == 0 {
		t.Logf("Success! FullStacked generated identical package-lock.json to npm across all %d packages.", len(npmPackages))
	}
}
