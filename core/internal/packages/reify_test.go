package packages

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// reifyRegistry serves <name>-<version>.tgz tarballs whose index.js reads "<name><version>"
// and counts the downloads; any path listed in missing answers 404.
type reifyRegistry struct {
	*httptest.Server
	mu   sync.Mutex
	hits map[string]int
}

func newReifyRegistry(t *testing.T, missing ...string) *reifyRegistry {
	r := &reifyRegistry{hits: map[string]int{}}
	r.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.hits[req.URL.Path]++
		r.mu.Unlock()
		for _, m := range missing {
			if req.URL.Path == m {
				http.NotFound(w, req)
				return
			}
		}
		name := strings.TrimSuffix(strings.TrimPrefix(req.URL.Path, "/"), ".tgz")
		parts := strings.SplitN(name, "-", 2)
		tb, _ := createMockTarball(map[string]string{"package/index.js": parts[0] + parts[1]})
		w.Write(tb)
	}))
	t.Cleanup(r.Close)
	origClient := httpClient
	httpClient = r.Client()
	t.Cleanup(func() { httpClient = origClient })
	return r
}

func (r *reifyRegistry) dep(name, version string) LockDependency {
	return LockDependency{
		Version:   version,
		Resolved:  r.URL + "/" + name + "-" + version + ".tgz",
		Integrity: "sha512-" + name + version,
	}
}

func (r *reifyRegistry) downloads(name, version string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.hits["/"+name+"-"+version+".tgz"]
}

func writeLock(t *testing.T, dir string, packages map[string]LockDependency) {
	t.Helper()
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"app"}`), 0644)
	lock := PackageLock{Name: "app", LockfileVersion: 3, Packages: packages}
	b, _ := json.Marshal(lock)
	if err := os.WriteFile(filepath.Join(dir, "package-lock.json"), b, 0644); err != nil {
		t.Fatal(err)
	}
}

func installLocked(t *testing.T, dir string) error {
	t.Helper()
	var failure error
	install(nil, dir, nil, false, 5, false, func(p Progress) {
		if p.Stage == "Error" {
			failure = &installError{p.Error}
		}
	})
	return failure
}

type installError struct{ msg string }

func (e *installError) Error() string { return e.msg }

func readIndex(t *testing.T, dir, loc string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, loc, "index.js"))
	if err != nil {
		return "<" + err.Error() + ">"
	}
	return string(b)
}

func TestReify_InterruptedInstallIsExtractedAgain(t *testing.T) {
	reg := newReifyRegistry(t)
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{"node_modules/a": reg.dep("a", "1.0.0")})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}

	// An install killed mid-extraction: the folder was written after the hidden lockfile
	os.WriteFile(filepath.Join(dir, "node_modules/a/index.js"), []byte("a1."), 0644)
	past := time.Now().Add(-time.Hour)
	os.Chtimes(filepath.Join(dir, "node_modules", hiddenLockfileName), past, past)

	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	if got := readIndex(t, dir, "node_modules/a"); got != "a1.0.0" {
		t.Fatalf("partial package not extracted again: %q", got)
	}
	if n := reg.downloads("a", "1.0.0"); n != 2 {
		t.Fatalf("downloads = %d, want 2", n)
	}
}

func TestReify_KeepsPackagesMatchingTheHiddenLockfile(t *testing.T) {
	reg := newReifyRegistry(t)
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a": reg.dep("a", "1.0.0"),
		// skipped on this platform: must not invalidate the hidden lockfile
		"node_modules/b": {Version: "1.0.0", OS: []string{"none"}},
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "node_modules/a/index.js"), []byte("kept"), 0644)

	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	if got := readIndex(t, dir, "node_modules/a"); got != "kept" {
		t.Fatalf("unchanged package extracted again: %q", got)
	}
	if n := reg.downloads("a", "1.0.0"); n != 1 {
		t.Fatalf("downloads = %d, want 1", n)
	}
}

func TestReify_FailedDownloadRollsBack(t *testing.T) {
	reg := newReifyRegistry(t, "/a-2.0.0.tgz")
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a": reg.dep("a", "1.0.0"),
		"node_modules/b": reg.dep("b", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	hidden, _ := os.ReadFile(filepath.Join(dir, "node_modules", hiddenLockfileName))

	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a": reg.dep("a", "2.0.0"),
		"node_modules/c": reg.dep("c", "1.0.0"),
	})
	if err := installLocked(t, dir); err == nil {
		t.Fatal("expected the install to fail")
	}

	if got := readIndex(t, dir, "node_modules/a"); got != "a1.0.0" {
		t.Fatalf("a not rolled back: %q", got)
	}
	if got := readIndex(t, dir, "node_modules/b"); got != "b1.0.0" {
		t.Fatalf("removed b not rolled back: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules/c")); !os.IsNotExist(err) {
		t.Fatal("added c left behind after the rollback")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "node_modules"))
	for _, e := range entries {
		if e.Name() != hiddenLockfileName && strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("retired folder left behind: %s", e.Name())
		}
	}
	if after, _ := os.ReadFile(filepath.Join(dir, "node_modules", hiddenLockfileName)); string(after) != string(hidden) {
		t.Fatal("hidden lockfile rewritten by a failed install")
	}
}

func TestReify_RemovesExtraneousFolders(t *testing.T) {
	reg := newReifyRegistry(t)
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a":        reg.dep("a", "1.0.0"),
		"node_modules/@s/b":     reg.dep("b", "1.0.0"),
		"node_modules/stale-np": reg.dep("x", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a":    reg.dep("a", "1.0.0"),
		"node_modules/@s/b": reg.dep("b", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules/stale-np")); !os.IsNotExist(err) {
		t.Fatal("extraneous folder not removed")
	}
	if got := readIndex(t, dir, "node_modules/@s/b"); got != "b1.0.0" {
		t.Fatalf("scoped package: %q", got)
	}
	if loadHiddenLockfile(dir) == nil {
		t.Fatal("hidden lockfile not trusted after a clean install")
	}
}

func TestReify_MovesBackUnchangedNestedPackages(t *testing.T) {
	reg := newReifyRegistry(t)
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a":                reg.dep("a", "1.0.0"),
		"node_modules/a/node_modules/c": reg.dep("c", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a":                reg.dep("a", "2.0.0"),
		"node_modules/a/node_modules/c": reg.dep("c", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	if got := readIndex(t, dir, "node_modules/a"); got != "a2.0.0" {
		t.Fatalf("a: %q", got)
	}
	if got := readIndex(t, dir, "node_modules/a/node_modules/c"); got != "c1.0.0" {
		t.Fatalf("nested c: %q", got)
	}
	if n := reg.downloads("c", "1.0.0"); n != 1 {
		t.Fatalf("unchanged nested c downloaded %d times, want 1", n)
	}
	if loadHiddenLockfile(dir) == nil {
		t.Fatal("hidden lockfile not trusted after the update")
	}
}

func TestRetirePath_MatchesNpm(t *testing.T) {
	// Values from @npmcli/arborist lib/retire-path.js
	cases := map[string]string{
		"/p/node_modules/react-dom":  "/p/node_modules/.react-dom-ggJtRVnn",
		"/p/node_modules/@scope/pkg": "/p/node_modules/@scope/.pkg-vv9K9hc2",
	}
	for from, want := range cases {
		if got := filepath.ToSlash(retirePath(filepath.FromSlash(from))); got != want {
			t.Errorf("retirePath(%s) = %s, want %s", from, got, want)
		}
	}
}

func TestReify_NodeModulesFolderInsideNodeModulesIsNotAPackage(t *testing.T) {
	reg := newReifyRegistry(t)
	dir := t.TempDir()
	writeLock(t, dir, map[string]LockDependency{
		"node_modules/a":              reg.dep("a", "1.0.0"),
		"node_modules/node_modules/b": reg.dep("b", "1.0.0"),
	})
	if err := installLocked(t, dir); err != nil {
		t.Fatal(err)
	}
	if loadHiddenLockfile(dir) == nil {
		t.Fatal("hidden lockfile rejected for node_modules/node_modules/b")
	}
}
