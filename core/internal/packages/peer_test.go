package packages

import (
	"encoding/json"
	"fullstackedorg/fullstacked/internal/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"testing"
)

func TestInstall_PeerDependencyDeduplication(t *testing.T) {
	// Setup Mock Registry
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Mock Metadata
		if r.URL.Path == "/lib" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "lib",
				DistTags: map[string]string{"latest": "1.0.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "lib",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/lib.tgz"},
						PeerDependencies: map[string]string{
							"peer": "^1.0.0",
						},
					},
				},
			})
			return
		}
		if r.URL.Path == "/peer" {
			json.NewEncoder(w).Encode(PackageMetadata{
				Name:     "peer",
				DistTags: map[string]string{"latest": "1.1.0"},
				Versions: map[string]PackageVersion{
					"1.0.0": {
						Name:    "peer",
						Version: "1.0.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/peer-1.0.0.tgz"},
					},
					"1.1.0": {
						Name:    "peer",
						Version: "1.1.0",
						Dist:    PackageDist{Tarball: "http://" + r.Host + "/peer-1.1.0.tgz"},
					},
				},
			})
			return
		}

		// Mock Tarballs
		if r.URL.Path == "/lib.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "lib"})
			w.Write(tb)
			return
		}
		if r.URL.Path == "/peer-1.0.0.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "peer 1.0.0"})
			w.Write(tb)
			return
		}
		if r.URL.Path == "/peer-1.1.0.tgz" {
			tb, _ := createMockTarball(map[string]string{"package/index.js": "peer 1.1.0"})
			w.Write(tb)
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

	// ROOT depends on:
	// - lib@1.0.0 (which peer-depends on peer@^1.0.0)
	// - peer@1.0.0 (pinned)
	pkgJson := PackageJSON{
		Name:    "my-app",
		Version: "0.0.0",
		Dependencies: map[string]string{
			"lib":  "1.0.0",
			"peer": "1.0.0",
		},
	}
	pjBytes, _ := json.Marshal(pkgJson)
	os.WriteFile(path.Join(tmpDir, "package.json"), pjBytes, 0644)

	// Run Install
	install(tmpDir, nil, false, 5, nil)

	// Verify Structure
	// 1. Root peer should be 1.0.0
	peerPath := path.Join(tmpDir, "node_modules", "peer")
	if !fs.ExistsFn(peerPath) {
		t.Fatal("root peer not installed")
	}
	// We could check content to be sure, but let's check lockfile or existence of nested

	// 2. IMPORTANT: Nested peer should NOT exist
	// node_modules/lib/node_modules/peer
	nestedPeerPath := path.Join(tmpDir, "node_modules", "lib", "node_modules", "peer")
	if fs.ExistsFn(nestedPeerPath) {
		t.Errorf("Nested peer dependency installed at %s, but should have been deduplicated against root", nestedPeerPath)
	}
}
