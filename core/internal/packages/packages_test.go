package packages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/types"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strings"
	"testing"
	"time"
)

func createMockTarball(content map[string]string) ([]byte, error) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	for name, body := range content {
		hdr := &tar.Header{
			Name:     name,
			Mode:     0600,
			Size:     int64(len(body)),
			Typeflag: tar.TypeReg,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func TestSwitch(t *testing.T) {
	// Test unknown function
	err := Switch(nil, types.CoreCallHeader{Fn: 99}, nil, nil)
	if err == nil || err.Error() != "unknown packages function" {
		t.Errorf("Expected unknown function error, got %v", err)
	}

	// Test Install call routing
	// We need to valid data to avoid panic in casting
	// Install expects data[0] to be directory string

	// Create a temp dir for the install test within switch to be safe
	tmpDir := t.TempDir()

	resp := &types.CoreCallResponse{}
	err = Switch(
		nil,
		types.CoreCallHeader{Fn: Install},
		[]types.DeserializedData{{Data: tmpDir}},
		resp,
	)
	if err != nil {
		t.Errorf("Switch Install failed: %v", err)
	}

	// Create dummy lockfile for security test
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), []byte("{}"), 0644)

	// Test Security call
	err = Switch(
		nil,
		types.CoreCallHeader{Fn: Security},
		[]types.DeserializedData{{Data: tmpDir}},
		resp,
	)
	if err != nil {
		t.Errorf("Switch Security failed: %v", err)
	}
}

func TestInstall_FullFlow(t *testing.T) {
	// Setup Mock Registry
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve tarball
		if r.URL.Path == "/test-pkg/-/test-pkg-1.0.0.tgz" {
			tb, _ := createMockTarball(map[string]string{
				"package/index.js": "console.log('hello')",
			})
			w.Write(tb)
			return
		}

		// Serve Metadata
		if r.URL.Path == "/test-pkg" {
			meta := PackageMetadata{
				Name:     "test-pkg",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "test-pkg",
						Version: "1.0.0",
						Dist: PackageDist{
							Tarball: r.Host, // Placeholder, will fix below
						},
					},
				},
			}
			// Fix up tarball URL to point to this server
			// We can't access ts.URL inside here easily if we define it inline?
			// Actually we can if we assign later or use relative if allowed?
			// No, client needs absolute.
			// Let's cheat: we already know the path structure.
			// The test running logic will fix the URL in the response mock.

			// Actually, just construct it here using the Request Host if possible?
			// r.Host is usually just host:port. Scheme missing.

			// Better: Assume test body sets up the URL correctly or we substitute it.
			// Let's use a simple approach: We will replace the URL in the returned JSON
			// by using a placeholder that we replace in the test string if we were writing bytes,
			// but here we are using structs.

			// We can define the server first?
			// Circular dependency.

			// Hack: use "http://" + r.Host + "/test-pkg/-/test-pkg-1.0.0.tgz"
			v := meta.Versions["1.0.0"]
			v.Dist.Tarball = "http://" + r.Host + "/test-pkg/-/test-pkg-1.0.0.tgz"
			v.Dist.Integrity = "sha512-mockintegrityhash"
			meta.Versions["1.0.0"] = v

			json.NewEncoder(w).Encode(meta)
			return
		}

		http.NotFound(w, r)
	}))
	defer ts.Close()

	// Override globals
	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	// Setup Workspace
	tmpDir := t.TempDir()

	// Write package.json
	pkgJson := PackageJSON{
		Name:    "my-app",
		Version: "0.0.0",
		Dependencies: map[string]string{
			"test-pkg": "^1.0.0",
		},
	}
	pjBytes, _ := json.Marshal(pkgJson)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	// Run Install
	install(tmpDir, nil, false, 5, nil)

	// Verify Check
	// 1. node_modules/test-pkg/index.js exists
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg/index.js")); os.IsNotExist(err) {
		t.Error("node_modules/test-pkg/index.js not found")
	}

	// 2. package-lock.json exists and contains correct info
	lockPath := path.Join(tmpDir, "package-lock.json")
	lockBytes, err := os.ReadFile(lockPath)
	if err != nil {
		t.Fatalf("package-lock.json not found: %v", err)
	}

	var lock PackageLock
	json.Unmarshal(lockBytes, &lock)

	if lock.Name != "my-app" {
		t.Errorf("Lockfile name mismatch: %s", lock.Name)
	}
	if dep, ok := lock.Packages["node_modules/test-pkg"]; !ok {
		t.Error("test-pkg missing in lockfile packages")
	} else {
		if dep.Version != "1.0.0" {
			t.Errorf("Expected version 1.0.0, got %s", dep.Version)
		}
		if dep.Integrity != "sha512-mockintegrityhash" {
			t.Errorf("Expected integrity sha512-mockintegrityhash, got %s", dep.Integrity)
		}
	}
}

func TestInstall_NoPackageJson(t *testing.T) {
	tmpDir := t.TempDir()
	// Should just return likely, or log error. Function has no return value.
	// We just ensure it doesn't panic.
	install(tmpDir, nil, false, 5, nil)
}

func TestInstall_WithLockfile(t *testing.T) {
	// Tests that we can load the lockfile.
	// To verify it *uses* the lockfile, we might check if it skips resolution?
	// Current implementation still resolves.
	// But let's at least ensure it parses it without crashing and preserves data if we were merging.

	tmpDir := t.TempDir()

	// package.json
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test"}`), 0644)

	// package-lock.json
	lock := PackageLock{
		Name:    "test",
		Version: "1.0.0",
		Packages: map[string]LockDependency{
			"node_modules/existing": {Version: "0.5.0"},
		},
	}
	lBytes, _ := json.Marshal(lock)
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), lBytes, 0644)

	install(tmpDir, nil, false, 5, nil)

	// Verify it survives
	// And verify the new lockfile contains the old entry?
	// Current implementation:
	// pkgLock.Packages = make(...) if nil
	// else keeps it?
	// The code:
	// if pkgLock == nil { ... }
	// for k,v := range resolvedTree { pkgLock.Packages[k] = v }

	// With reconciliation, if "existing" is not in package.json, it should be PRUNED.
	// So we expect it to be GONE.

	newLockBytes, _ := os.ReadFile(path.Join(tmpDir, "package-lock.json"))
	var newLock PackageLock
	json.Unmarshal(newLockBytes, &newLock)

	if _, ok := newLock.Packages["node_modules/existing"]; ok {
		t.Error("Expected existing lock entry to be pruned (reconciliation)")
	}
}

func TestFetchErrors(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	_, err := fetchPackageMetadata("non-existent")
	if err == nil {
		t.Error("Expected error for 404")
	}
}

func TestDownloadExtractErrors(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bad.tgz" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.URL.Path == "/notgzip.tgz" {
			w.Write([]byte("this is not gzip"))
			return
		}
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = ts.Client()
	defer func() { httpClient = origClient }()

	if err := downloadAndExtract(ts.URL+"/bad.tgz", t.TempDir(), nil); err == nil {
		t.Error("Expected error for 500")
	}

	if err := downloadAndExtract(ts.URL+"/notgzip.tgz", t.TempDir(), nil); err == nil {
		t.Error("Expected error for bad gzip")
	}
}

func TestInstall_CorruptFiles(t *testing.T) {
	tmpDir := t.TempDir()

	// Corrupt package.json
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{bad json`), 0644)
	install(tmpDir, nil, false, 5, nil)
	// Should return early

	// Corrupt package-lock.json
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), []byte(`{bad json`), 0644)
	install(tmpDir, nil, false, 5, nil)
	// Should ignore bad lockfile and continue
}

func TestInstall_DevDependencies(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dev-pkg/-/dev-pkg-1.0.0.tgz" {
			createMockTarball(map[string]string{"package/dev.js": "ok"})
			w.Write([]byte{}) // Empty body ok for extraction test? No, gzip reader will fail
			tb, _ := createMockTarball(map[string]string{"package/dev.js": "ok"})
			w.Write(tb)
			return
		}
		if r.URL.Path == "/dev-pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name: "dev-pkg",
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/dev-pkg/-/dev-pkg-1.0.0.tgz"},
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	pj := PackageJSON{
		Name:            "dev-test",
		DevDependencies: map[string]string{"dev-pkg": "1.0.0"},
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	// Run with devDependencies=true
	install(tmpDir, nil, true, 5, nil)

	if _, err := os.Stat(path.Join(tmpDir, "node_modules/dev-pkg/dev.js")); os.IsNotExist(err) {
		t.Error("dev-pkg not installed")
	}
}

func TestInstall_ResolutionFailures(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/good-pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name: "good-pkg",
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/good.tgz"},
					},
				},
			})
			return
		}
		if r.URL.Path == "/good.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		// others 404
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	pj := PackageJSON{
		Name: "mixed-test",
		Dependencies: map[string]string{
			"good-pkg":  "1.0.0",
			"bad-pkg":   "1.0.0",  // 404
			"weird-pkg": "^9.9.9", // Resolution failure (meta returns 404 too)
		},
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	install(tmpDir, nil, false, 5, nil)

	// good-pkg should be there
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/good-pkg/index.js")); os.IsNotExist(err) {
		t.Error("good-pkg not installed despite errors in other deps")
	}
}

func TestDownloadExtract_ZipSlip(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Create malicious tarball
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gw)

		hdr := &tar.Header{
			Name:     "../evil.txt",
			Mode:     0600,
			Size:     4,
			Typeflag: tar.TypeReg,
		}
		tw.WriteHeader(hdr)
		tw.Write([]byte("evil"))
		tw.Close()
		gw.Close()

		w.Write(buf.Bytes())
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = ts.Client()
	defer func() { httpClient = origClient }()

	err := downloadAndExtract(ts.URL, t.TempDir(), nil)
	if err == nil || err.Error() != "zip slip detected" {
		t.Errorf("Expected zip slip error, got %v", err)
	}
}

func TestResolveVersion_NoMatch(t *testing.T) {
	meta := PackageMetadata{
		Name: "test",
		Versions: map[string]PackageVersion{
			"1.0.0": {Version: "1.0.0"},
		},
	}

	if _, err := resolveVersion(meta, "^2.0.0"); err == nil {
		t.Error("Expected error for no matching version")
	}

	if _, err := resolveVersion(meta, "beta"); err == nil {
		t.Error("Expected error for unknown tag")
	}
}

func TestDownloadExtract_WithDir(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gw)

		// Directory
		hdr := &tar.Header{
			Name:     "subdir/",
			Mode:     0755,
			Typeflag: tar.TypeDir,
		}
		tw.WriteHeader(hdr)

		// File in directory
		hdr = &tar.Header{
			Name:     "subdir/file.txt",
			Mode:     0600,
			Size:     4,
			Typeflag: tar.TypeReg,
		}
		tw.WriteHeader(hdr)
		tw.Write([]byte("test"))

		tw.Close()
		gw.Close()
		w.Write(buf.Bytes())
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = ts.Client()
	defer func() { httpClient = origClient }()

	tmpDir := t.TempDir()
	if err := downloadAndExtract(ts.URL, tmpDir, nil); err != nil {
		t.Fatalf("Extraction failed: %v", err)
	}

	if info, err := os.Stat(path.Join(tmpDir, "subdir")); os.IsNotExist(err) || !info.IsDir() {
		t.Error("subdir not created properly")
	}
	if _, err := os.Stat(path.Join(tmpDir, "subdir/file.txt")); os.IsNotExist(err) {
		t.Error("file inside subdir not created")
	}
}

func TestResolveVersion_Tags(t *testing.T) {
	meta := PackageMetadata{
		Name: "test",
		DistTags: map[string]string{
			"next": "2.0.0-beta",
		},
		Versions: map[string]PackageVersion{
			"1.0.0":      {Version: "1.0.0"},
			"2.0.0-beta": {Version: "2.0.0-beta"},
		},
	}

	// Test tag resolution
	if v, err := resolveVersion(meta, "next"); err != nil || v.Version != "2.0.0-beta" {
		t.Errorf("Expected 2.0.0-beta for next tag, got %v, err: %v", v.Version, err)
	}

	// Test exact match of version that might fail constraint if interpreted wrong?
	// But mostly "next" triggers the fallback logic.
}

func TestFetch_InvalidJSON(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{bad json`))
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	if _, err := fetchPackageMetadata("pkg"); err == nil {
		t.Error("Expected error for invalid JSON")
	}
}

func TestResolveVersion_InvalidVersions(t *testing.T) {
	meta := PackageMetadata{
		Name: "test",
		Versions: map[string]PackageVersion{
			"1.0.0":      {Version: "1.0.0"},
			"not-semver": {Version: "junk"},
		},
	}

	// Should skip "not-semver" and match 1.0.0
	v, err := resolveVersion(meta, "^1.0.0")
	if err != nil {
		t.Errorf("Resolution failed: %v", err)
	}
	if v.Version != "1.0.0" {
		t.Errorf("Expected 1.0.0, got %s", v.Version)
	}

	// If only invalid versions exist?
	meta2 := PackageMetadata{
		Name: "test2",
		Versions: map[string]PackageVersion{
			"bad": {Version: "bad"},
		},
	}
	if _, err := resolveVersion(meta2, "*"); err == nil {
		t.Error("Expected error when no valid versions exist")
	}
}

func TestUninstall(t *testing.T) {
	tmpDir := t.TempDir()

	// Setup initial state
	pj := PackageJSON{
		Name: "test-app",
		Dependencies: map[string]string{
			"pkg-a": "1.0.0",
			"pkg-b": "1.0.0",
		},
		DevDependencies: map[string]string{
			"dev-pkg": "1.0.0",
		},
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	pl := PackageLock{
		Name: "test-app",
		Packages: map[string]LockDependency{
			"node_modules/pkg-a":   {Version: "1.0.0"},
			"node_modules/pkg-b":   {Version: "1.0.0"},
			"node_modules/dev-pkg": {Version: "1.0.0"},
		},
	}
	plBytes, _ := json.Marshal(pl)
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), plBytes, 0644)

	// Create directories
	os.MkdirAll(path.Join(tmpDir, "node_modules/pkg-a"), 0755)
	os.MkdirAll(path.Join(tmpDir, "node_modules/pkg-b"), 0755)
	os.MkdirAll(path.Join(tmpDir, "node_modules/dev-pkg"), 0755)

	// Uninstall pkg-a and dev-pkg
	uninstall(tmpDir, []string{"pkg-a", "dev-pkg"}, nil)

	// Verify pkg-a removed
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/pkg-a")); !os.IsNotExist(err) {
		t.Error("pkg-a should be removed from node_modules")
	}
	// Verify pkg-b remains
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/pkg-b")); os.IsNotExist(err) {
		t.Error("pkg-b should NOT be removed from node_modules")
	}

	// Verify package.json
	pjBytes, _ = os.ReadFile(path.Join(tmpDir, "package.json"))
	var pjCheck PackageJSON
	json.Unmarshal(pjBytes, &pjCheck)
	if _, ok := pjCheck.Dependencies["pkg-a"]; ok {
		t.Error("pkg-a should be removed from dependencies")
	}
	if _, ok := pjCheck.Dependencies["pkg-b"]; !ok {
		t.Error("pkg-b should remain in dependencies")
	}
	if _, ok := pjCheck.DevDependencies["dev-pkg"]; ok {
		t.Error("dev-pkg should be removed from devDependencies")
	}

	// Verify package-lock.json
	plBytes, _ = os.ReadFile(path.Join(tmpDir, "package-lock.json"))
	var plCheck PackageLock
	json.Unmarshal(plBytes, &plCheck)
	if _, ok := plCheck.Packages["node_modules/pkg-a"]; ok {
		t.Error("pkg-a should be removed from lockfile")
	}
	if _, ok := plCheck.Packages["node_modules/pkg-b"]; !ok {
		t.Error("pkg-b should remain in lockfile")
	}
}

func TestSwitch_Uninstall(t *testing.T) {
	tmpDir := t.TempDir()

	// Minimal setup
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte("{}"), 0644)
	os.MkdirAll(path.Join(tmpDir, "node_modules/target"), 0755)

	resp := &types.CoreCallResponse{}
	// Call Switch with Uninstall
	err := Switch(
		nil,
		types.CoreCallHeader{Fn: Uninstall},
		[]types.DeserializedData{
			{Data: tmpDir},
			{Data: "target"},
		},
		resp,
	)
	if err != nil {
		t.Errorf("Switch Uninstall failed: %v", err)
	}

	// Execute the stream
	if resp.Stream != nil {
		resp.Stream.Open(nil, 1)
	} else {
		t.Error("Expected ResponseStream in resp.Stream")
	}

	// Verify removal
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/target")); !os.IsNotExist(err) {
		t.Error("target should be removed via Switch")
	}

	// Test deserialization variant (interface{})
	os.MkdirAll(path.Join(tmpDir, "node_modules/target2"), 0755)
	err = Switch(
		nil,
		types.CoreCallHeader{Fn: Uninstall},
		[]types.DeserializedData{
			{Data: tmpDir},
			{Data: "target2"},
		},
		resp,
	)
	if err != nil {
		t.Errorf("Switch Uninstall interface{} failed: %v", err)
	}

	if resp.Stream != nil {
		resp.Stream.Open(nil, 2)
	} else {
		t.Error("Expected ResponseStream in resp.Stream")
	}

	if _, err := os.Stat(path.Join(tmpDir, "node_modules/target2")); !os.IsNotExist(err) {
		t.Error("target2 should be removed via Switch (interface{})")
	}
}

func TestUninstall_EdgeCases(t *testing.T) {
	tmpDir := t.TempDir()

	// Case 1: Empty list
	uninstall(tmpDir, []string{}, nil)

	// Case 2: Missing package.json
	uninstall(tmpDir, []string{"pkg"}, nil)

	// Verify it still tries to remove node_modules even if package.json missing
	os.MkdirAll(path.Join(tmpDir, "node_modules/pkg"), 0755)
	uninstall(tmpDir, []string{"pkg"}, nil)
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/pkg")); !os.IsNotExist(err) {
		t.Error("Should remove node_modules even if package.json missing")
	}

	os.WriteFile(path.Join(tmpDir, "package-lock.json"), []byte("{bad"), 0644)
	uninstall(tmpDir, []string{"pkg"}, nil)
}

func TestSwitch_EdgeCases(t *testing.T) {
	resp := &types.CoreCallResponse{}
	tmpDir := t.TempDir()
	// Test with minimal valid arguments to avoid panics
	// Install expects [directory (string), saveDev (bool), ...packages (string)]
	err := Switch(nil, types.CoreCallHeader{Fn: Install}, []types.DeserializedData{
		{Data: tmpDir},
		{Data: false},
	}, resp)
	if err != nil {
		t.Errorf("Switch Install failed: %v", err)
	}

	// Uninstall expects [directory (string), ...packages (string)]
	err = Switch(nil, types.CoreCallHeader{Fn: Uninstall}, []types.DeserializedData{
		{Data: tmpDir},
	}, resp)
	if err != nil {
		t.Errorf("Switch Uninstall failed: %v", err)
	}

	// Test unknown function
	err = Switch(nil, types.CoreCallHeader{Fn: 255}, []types.DeserializedData{}, resp)
	if err == nil || !strings.Contains(err.Error(), "unknown packages function") {
		t.Errorf("Expected unknown function error, got: %v", err)
	}
}

func TestInstall_SpecificPackage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/new-pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "new-pkg",
				DistTags: map[string]string{"latest": "2.0.0"},
				Versions: map[string]PackageVersion{
					"2.0.0": {
						Name:    "new-pkg",
						Version: "2.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/new.tgz"},
					},
				},
			})
			return
		}
		if r.URL.Path == "/new.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "new"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test"}`), 0644)

	// Install specific package
	install(tmpDir, []string{"new-pkg"}, false, 5, nil)

	// Verify package.json updated
	pjBytes, _ := os.ReadFile(path.Join(tmpDir, "package.json"))
	var pj PackageJSON
	json.Unmarshal(pjBytes, &pj)
	if v, ok := pj.Dependencies["new-pkg"]; !ok || v != "^2.0.0" {
		t.Errorf("Expected new-pkg ^2.0.0 in dependencies, got %v", v)
	}

	// Verify installed
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/new-pkg/index.js")); os.IsNotExist(err) {
		t.Error("new-pkg not installed")
	}
}

func TestInstall_SaveDev(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/dev-tool" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "dev-tool",
				DistTags: map[string]string{"latest": "1.5.0"},
				Versions: map[string]PackageVersion{
					"1.5.0": {
						Name:    "dev-tool",
						Version: "1.5.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/dev.tgz"},
					},
				},
			})
			return
		}
		if r.URL.Path == "/dev.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/bin.js": "bin"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test"}`), 0644)

	// Install with saveDev=true
	install(tmpDir, []string{"dev-tool"}, true, 5, nil)

	// Verify package.json updated
	pjBytes, _ := os.ReadFile(path.Join(tmpDir, "package.json"))
	var pj PackageJSON
	json.Unmarshal(pjBytes, &pj)
	if v, ok := pj.DevDependencies["dev-tool"]; !ok || v != "^1.5.0" {
		t.Errorf("Expected dev-tool ^1.5.0 in devDependencies, got %v", v)
	}
	if _, ok := pj.Dependencies["dev-tool"]; ok {
		t.Error("dev-tool should NOT be in dependencies")
	}

	// Verify installed
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/dev-tool/bin.js")); os.IsNotExist(err) {
		t.Error("dev-tool not installed")
	}
}

func TestResolveVersion(t *testing.T) {
	// dummy metadata
	meta := PackageMetadata{
		Name:     "test-pkg",
		DistTags: map[string]string{"latest": "1.2.0"},
		Versions: map[string]PackageVersion{
			"1.0.0": {Version: "1.0.0"},
			"1.1.0": {Version: "1.1.0"},
			"1.2.0": {Version: "1.2.0"},
			"2.0.0": {Version: "2.0.0"},
		},
	}

	tests := []struct {
		Range    string
		Expected string
	}{
		{"^1.0.0", "1.2.0"},
		{"latest", "1.2.0"},
		{"2.0.0", "2.0.0"},
	}

	for _, test := range tests {
		ver, err := resolveVersion(meta, test.Range)
		if err != nil {
			t.Errorf("Error resolving %s: %v", test.Range, err)
			continue
		}
		if ver.Version != test.Expected {
			t.Errorf("Expected %s for range %s, got %s", test.Expected, test.Range, ver.Version)
		}
	}
}

func TestFetchReact(t *testing.T) {
	meta, err := fetchPackageMetadata("react")
	if err != nil {
		t.Fatalf("Failed to fetch react metadata: %v", err)
	}

	if meta.Name != "react" {
		t.Errorf("Expected name 'react', got %s", meta.Name)
	}

	if _, ok := meta.DistTags["latest"]; !ok {
		t.Error("Expected 'latest' tag in dist-tags")
	}

	// Try resolving a known version
	ver, err := resolveVersion(meta, "^18.0.0")
	if err != nil {
		t.Errorf("Failed to resolve ^18.0.0: %v", err)
	}

	// basic check that it resolved to something 18.x
	if ver.Version == "" {
		t.Error("Resolved version is empty")
	}
}

func TestInstall_Flattening(t *testing.T) {
	// Scenario: A->C@1.0, B->C@1.0. Root -> A, B.
	// Expect: node_modules/A, node_modules/B, node_modules/C (hoisted)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pkgName := path.Base(r.URL.Path)
		if pkgName == "test-pkg-a" || r.URL.Path == "/test-pkg-a" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "test-pkg-a",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:         "test-pkg-a",
						Version:      "1.0.0",
						Dependencies: map[string]string{"test-pkg-c": "1.0.0"},
						Dist:         PackageDist{Tarball: "http://" + r.Host + "/a.tgz"},
					},
				},
			})
			return
		}
		if pkgName == "test-pkg-b" || r.URL.Path == "/test-pkg-b" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "test-pkg-b",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:         "test-pkg-b",
						Version:      "1.0.0",
						Dependencies: map[string]string{"test-pkg-c": "1.0.0"},
						Dist:         PackageDist{Tarball: "http://" + r.Host + "/b.tgz"},
					},
				},
			})
			return
		}
		if pkgName == "test-pkg-c" || r.URL.Path == "/test-pkg-c" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "test-pkg-c",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "test-pkg-c",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/c.tgz"},
					},
				},
			})
			return
		}

		// Tarballs
		if strings.HasSuffix(r.URL.Path, ".tgz") {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	pj := PackageJSON{
		Name: "flatten-test",
		Dependencies: map[string]string{
			"test-pkg-a": "1.0.0",
			"test-pkg-b": "1.0.0",
		},
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	install(tmpDir, nil, false, 5, nil)

	// Check flattening
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-c")); os.IsNotExist(err) {
		t.Error("test-pkg-c should be hoisted to top level")
	}
	// Check A and B exist
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-a")); os.IsNotExist(err) {
		t.Error("test-pkg-a missing")
	}
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-b")); os.IsNotExist(err) {
		t.Error("test-pkg-b missing")
	}
}

func TestInstall_Conflict(t *testing.T) {
	// Scenario: A->C@1.0. Root -> A, C@2.0.
	// C@2.0 installed at root. A needs C@1.0.
	// Expect: node_modules/C (2.0), node_modules/A, node_modules/A/node_modules/C (1.0)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/test-pkg-a" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "test-pkg-a",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:         "test-pkg-a",
						Version:      "1.0.0",
						Dependencies: map[string]string{"test-pkg-c": "1.0.0"},
						Dist:         PackageDist{Tarball: "http://" + r.Host + "/a.tgz"},
					},
				},
			})
			return
		}
		if r.URL.Path == "/test-pkg-c" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "test-pkg-c",
				DistTags: map[string]string{"latest": "2.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "test-pkg-c",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/c1.tgz"},
					},
					"2.0.0": {
						Name:    "test-pkg-c",
						Version: "2.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/c2.tgz"},
					},
				},
			})
			return
		}
		// Tarballs
		if strings.HasSuffix(r.URL.Path, ".tgz") {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	pj := PackageJSON{
		Name: "conflict-test",
		Dependencies: map[string]string{
			"test-pkg-a": "1.0.0",
			"test-pkg-c": "2.0.0",
		},
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	install(tmpDir, nil, false, 5, nil)

	// C@2.0 at root
	// We need to verify version but we didn't write checking logic in extraction mock.
	// But we can check if node_modules/test-pkg-c exists (it should).
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-c")); os.IsNotExist(err) {
		t.Error("test-pkg-c (root) missing")
	}

	// A at root
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-a")); os.IsNotExist(err) {
		t.Error("test-pkg-a missing")
	}

	// A/node_modules/C exists (nested)
	if _, err := os.Stat(path.Join(tmpDir, "node_modules/test-pkg-a/node_modules/test-pkg-c")); os.IsNotExist(err) {
		t.Error("nested test-pkg-c missing (should be nested due to conflict)")
	}
}

func TestSecurity(t *testing.T) {
	// Mock audit endpoint
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/-/npm/v1/security/audits/quick" {
			// Verify POST
			if r.Method != "POST" {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			// Return a dummy audit report
			json.NewEncoder(w).Encode(map[string]interface{}{
				"metadata": map[string]interface{}{
					"vulnerabilities": map[string]interface{}{
						"info":     0.0,
						"low":      1.0,
						"moderate": 0.0,
						"high":     0.0,
						"critical": 0.0,
					},
				},
				"advisories": map[string]interface{}{
					"123": map[string]interface{}{
						"title":       "Test Vulnerability",
						"module_name": "test-pkg",
					},
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()

	// Create dummy package-lock.json
	pl := PackageLock{
		Name:    "secure-app",
		Version: "1.0.0",
		Packages: map[string]LockDependency{
			"node_modules/test-pkg": {Version: "1.0.0"},
		},
	}
	plBytes, _ := json.Marshal(pl)
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), plBytes, 0644)

	// Test Main Success Case
	report, err := security(tmpDir)
	if err != nil {
		t.Fatalf("security failed: %v", err)
	}

	if advisories, ok := report["advisories"].(map[string]interface{}); ok {
		if _, ok := advisories["123"]; !ok {
			t.Error("Expected advisory 123 in report")
		}
	} else {
		t.Error("advisories not found in report")
	}
}

func TestSecurity_Errors(t *testing.T) {
	tmpDir := t.TempDir()

	t.Run("MissingLockfile", func(t *testing.T) {
		_, err := security(t.TempDir()) // empty dir
		if err == nil {
			t.Error("Expected error for missing lockfile")
		}
	})

	// Create valid lockfile for subsequent tests
	pl := PackageLock{Name: "test"}
	plBytes, _ := json.Marshal(pl)
	os.WriteFile(path.Join(tmpDir, "package-lock.json"), plBytes, 0644)

	t.Run("BadJSONResponse", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("bad json"))
		}))
		defer ts.Close()

		origUrl := registryBaseUrl
		origClient := httpClient
		registryBaseUrl = ts.URL + "/"
		httpClient = ts.Client()
		defer func() {
			registryBaseUrl = origUrl
			httpClient = origClient
		}()

		_, err := security(tmpDir)
		if err == nil {
			t.Error("Expected parsing error")
		}
	})

	t.Run("MissingMetadata", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("{}"))
		}))
		defer ts.Close()

		origUrl := registryBaseUrl
		origClient := httpClient
		registryBaseUrl = ts.URL + "/"
		httpClient = ts.Client()
		defer func() {
			registryBaseUrl = origUrl
			httpClient = origClient
		}()

		report, err := security(tmpDir)
		if err != nil {
			t.Fatalf("Expected no error, got %v", err)
		}
		if _, ok := report["metadata"]; ok {
			t.Error("Expected no metadata in this mock response")
		}
	})

	t.Run("RequestError", func(t *testing.T) {
		// To force Request creation error or Client Do error
		// Setting invalid URL for CreateRequest is hard because NewRequest parses
		// Setting Client to fail Do:

		mockClient := &http.Client{
			Transport: &mockTransport{
				RoundTripFunc: func(req *http.Request) (*http.Response, error) {
					return nil, errors.New("network failure")
				},
			},
		}

		origClient := httpClient
		httpClient = mockClient
		defer func() { httpClient = origClient }()

		_, err := security(tmpDir)
		if err == nil {
			t.Error("Expected network failure error")
		}
	})
}

func TestProgressReporting(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/prog-pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name: "prog-pkg",
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "prog-pkg",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/prog.tgz"},
					},
				},
			})
			return
		}
		if r.URL.Path == "/prog.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test","dependencies":{"prog-pkg":"1.0.0"}}`), 0644)

	var events []Progress
	cb := func(p Progress) {
		events = append(events, p)
	}

	install(tmpDir, nil, false, 5, cb)

	// Verify events
	// Expect: Initialization, Resolving, Pruning, Installing, Extracting, Finalizing, Done
	stages := []string{}
	for _, e := range events {
		stages = append(stages, e.Stage)
	}

	// Note: Resolving might happen multiple times.
	// Check for key stages.

	foundResolving := false
	foundExtracting := false
	foundPkgName := false

	for _, e := range events {
		if e.Stage == "Resolving" && e.Name == "prog-pkg" {
			foundResolving = true
		}
		if e.Stage == "Extracting" && e.Name == "prog-pkg" && e.Version == "1.0.0" {
			foundExtracting = true
			foundPkgName = true
		}
	}

	if !foundResolving {
		t.Error("Did not find Resolving event for prog-pkg")
	}
	if !foundExtracting {
		t.Error("Did not find Extracting event for prog-pkg")
	}
	if !foundPkgName {
		t.Error("Did not find event with Name='prog-pkg'")
	}
}

func TestInstall_VersionedPackage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v-pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "v-pkg",
				DistTags: map[string]string{"latest": "2.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {Version: "1.0.0", Dist: PackageDist{Tarball: "http://" + r.Host + "/v1.tgz"}},
					"2.0.0": {Version: "2.0.0", Dist: PackageDist{Tarball: "http://" + r.Host + "/v2.tgz"}},
				},
			})
			return
		}
		if strings.HasSuffix(r.URL.Path, ".tgz") {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test"}`), 0644)

	// Install specific version
	install(tmpDir, []string{"v-pkg@1.0.0"}, false, 5, nil)

	// Verify package-lock.json has v1.0.0
	lockBytes, _ := os.ReadFile(path.Join(tmpDir, "package-lock.json"))
	var lock PackageLock
	json.Unmarshal(lockBytes, &lock)
	if dep, ok := lock.Packages["node_modules/v-pkg"]; !ok || dep.Version != "1.0.0" {
		t.Errorf("Expected version 1.0.0 in lockfile, got %v", dep.Version)
	}

	// Verify package.json updated with correct version
	pjBytes, _ := os.ReadFile(path.Join(tmpDir, "package.json"))
	var pj PackageJSON
	json.Unmarshal(pjBytes, &pj)
	if v, ok := pj.Dependencies["v-pkg"]; !ok || v != "^1.0.0" {
		t.Errorf("Expected ^1.0.0 in package.json, got %v", v)
	}
}

func TestInstall_ScopedPackage(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/@scope/pkg" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "@scope/pkg",
				DistTags: map[string]string{"latest": "2.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {Version: "1.0.0", Dist: PackageDist{Tarball: "http://" + r.Host + "/v1.tgz"}},
					"2.0.0": {Version: "2.0.0", Dist: PackageDist{Tarball: "http://" + r.Host + "/v2.tgz"}},
				},
			})
			return
		}
		if r.URL.Path == "/v1.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "ok"})
			w.Write(tb)
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()
	os.WriteFile(path.Join(tmpDir, "package.json"), []byte(`{"name":"test"}`), 0644)

	// Install scoped version
	install(tmpDir, []string{"@scope/pkg@1.0.0"}, false, 5, nil)

	// Verify package-lock.json has v1.0.0
	lockBytes, _ := os.ReadFile(path.Join(tmpDir, "package-lock.json"))
	var lock PackageLock
	json.Unmarshal(lockBytes, &lock)
	if dep, ok := lock.Packages["node_modules/@scope/pkg"]; !ok || dep.Version != "1.0.0" {
		t.Errorf("Expected version 1.0.0 in lockfile for scoped package, got %v", dep.Version)
	}
}

type mockTransport struct {
	RoundTripFunc func(*http.Request) (*http.Response, error)
}

func (m *mockTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return m.RoundTripFunc(req)
}

func TestSwitch_InputErrors(t *testing.T) {
	resp := &types.CoreCallResponse{}

	tests := []struct {
		Name          string
		Fn            PackagesFn
		Data          []types.DeserializedData
		ExpectedError string
	}{
		{
			Name:          "Install_MissingDir",
			Fn:            Install,
			Data:          []types.DeserializedData{},
			ExpectedError: "missing directory argument",
		},
		{
			Name:          "Install_InvalidDirType",
			Fn:            Install,
			Data:          []types.DeserializedData{{Data: 123}},
			ExpectedError: "directory must be a string",
		},
		{
			Name:          "Uninstall_MissingDir",
			Fn:            Uninstall,
			Data:          []types.DeserializedData{},
			ExpectedError: "missing directory argument",
		},
		{
			Name:          "Uninstall_InvalidDirType",
			Fn:            Uninstall,
			Data:          []types.DeserializedData{{Data: 123}},
			ExpectedError: "directory must be a string",
		},
		{
			Name:          "Security_MissingDir",
			Fn:            Security,
			Data:          []types.DeserializedData{},
			ExpectedError: "missing directory argument",
		},
		{
			Name:          "Security_InvalidDirType",
			Fn:            Security,
			Data:          []types.DeserializedData{{Data: 123}},
			ExpectedError: "directory must be a string",
		},
	}

	for _, tc := range tests {
		t.Run(tc.Name, func(t *testing.T) {
			err := Switch(nil, types.CoreCallHeader{Fn: tc.Fn}, tc.Data, resp)
			if err == nil {
				t.Errorf("Expected error %q, got nil", tc.ExpectedError)
			} else if err.Error() != tc.ExpectedError {
				t.Errorf("Expected error %q, got %q", tc.ExpectedError, err.Error())
			}
		})
	}
}

func TestDownloadExtract_Permissions(t *testing.T) {
	// Setup a tarball server
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tb, _ := createMockTarball(map[string]string{"package/file.txt": "ok"})
		w.Write(tb)
	}))
	defer ts.Close()

	origClient := httpClient
	httpClient = ts.Client()
	defer func() { httpClient = origClient }()

	tmpDir := t.TempDir()

	// Create a file where we want a directory to be, to force MkdirAll to fail (or Create to fail)
	// downloadAndExtract will try to create "dest/file.txt"
	// if we make "dest" read-only, we might trigger error

	// Better: make dest read-only
	os.Chmod(tmpDir, 0500) // Read/Execute only, no Write
	defer os.Chmod(tmpDir, 0755)

	err := downloadAndExtract(ts.URL, tmpDir, nil)
	if err == nil {
		// Note: Root user (in docker?) might bypass this.
		// If running as normal user, this should fail.
		// If it doesn't fail, we might print a log.
		// But in typical CI environments this works.
		// Use t.Log check for skipping if running as root?
		if os.Getuid() != 0 {
			t.Error("Expected error when writing to read-only directory")
		}
	}
}

func TestInstall_Concurrency(t *testing.T) {
	// Server with delay
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond) // 50ms delay

		// Return valid metadata for any package
		if !strings.HasSuffix(r.URL.Path, ".tgz") {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name: "test",
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "test",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/file.tgz"},
					},
				},
				DistTags: map[string]string{"latest": "1.0.0"},
			})
			return
		}

		// Return valid tarball
		tb, _ := createMockTarball(map[string]string{"package/idx": "ok"})
		w.Write(tb)
	}))
	defer ts.Close()

	origUrl := registryBaseUrl
	origClient := httpClient
	registryBaseUrl = ts.URL + "/"
	httpClient = ts.Client()
	defer func() {
		registryBaseUrl = origUrl
		httpClient = origClient
	}()

	tmpDir := t.TempDir()

	// Create package with 5 dependencies
	deps := make(map[string]string)
	for i := 0; i < 5; i++ {
		// Generate unique name
		// use simple concat
		name := "pkg-" + string(rune('0'+i))
		deps[name] = "1.0.0"
	}

	pj := PackageJSON{
		Name:         "concurrency-test",
		Dependencies: deps,
	}
	pjBytes, _ := json.Marshal(pj)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	// Test 1: Sequential (MaxConcurrent=1)
	start := time.Now()
	install(tmpDir, nil, false, 1, nil)
	durationSeq := time.Since(start)

	// Reset
	os.RemoveAll(path.Join(tmpDir, "node_modules"))
	os.Remove(path.Join(tmpDir, "package-lock.json"))

	// Test 2: Concurrent (MaxConcurrent=5)
	start = time.Now()
	install(tmpDir, nil, false, 5, nil)
	durationConc := time.Since(start)

	t.Logf("Sequential: %v, Concurrent: %v", durationSeq, durationConc)

	if durationConc >= durationSeq {
		t.Error("Concurrent execution was not faster than sequential")
	}
}
